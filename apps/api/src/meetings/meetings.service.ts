import { randomInt } from 'node:crypto';
import argon2 from 'argon2';
import type { Pool, PoolClient } from 'pg';
import { AccessToken, RoomServiceClient, TrackType } from 'livekit-server-sdk';
import { withTenant } from '../db/tenant.js';
import { FailureLimiter } from '../common/rate-limiter.js';
import type { Config } from '../config.js';
import type { AuthedUser } from '../auth/auth.guard.js';
import { joinResults, meetingsCreated } from '../metrics.js';
import { livekitUrlFor } from './public-url.js';
import { loadPolicies } from '../admin/policies.js';

export class MeetingError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export interface CreateMeetingInput {
  title: string;
  passcode?: string;
  scheduledAt?: string;
  waitingRoom?: boolean;
}

export interface JoinedResult {
  status: 'joined';
  token: string;
  url: string;
  meetingId: string;
  title: string;
  isHost: boolean;
}
export interface WaitingResult {
  status: 'waiting';
  requestId: string;
}
export type JoinResult = JoinedResult | WaitingResult;

interface MeetingRow {
  id: string;
  title: string;
  host_user_id: string;
  passcode_hash: string | null;
  locked: boolean;
  waiting_room: boolean;
  is_cohost: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE_RE = /^[0-9]{11,12}$/;

function newCode(): string {
  // 11 digits, first digit non-zero, from a CSPRNG.
  return String(randomInt(1, 10)) + String(randomInt(0, 10 ** 10)).padStart(10, '0');
}

export class MeetingsService {
  private readonly limiter = new FailureLimiter(5, 15 * 60 * 1000);
  private readonly rooms: RoomServiceClient;

  constructor(private readonly pool: Pool, private readonly cfg: Config) {
    this.rooms = new RoomServiceClient(cfg.LIVEKIT_API_URL, cfg.LIVEKIT_API_KEY, cfg.LIVEKIT_API_SECRET);
  }

  async create(user: AuthedUser, input: CreateMeetingInput) {
    // Organization policies (admin console): a required passcode is enforced, the waiting-room default applies when the client is silent.
    const policy = await withTenant(this.pool, user.orgId, (c) => loadPolicies(c));
    if (policy.requirePasscode && !input.passcode) throw new MeetingError(400, 'this organization requires a meeting passcode');
    const passcodeHash = input.passcode ? await argon2.hash(input.passcode, { type: argon2.argon2id }) : null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = newCode();
      try {
        return await withTenant(this.pool, user.orgId, async (c) => {
          const r = await c.query(
            `INSERT INTO meetings (org_id, code, title, host_user_id, passcode_hash, scheduled_at, waiting_room)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING id, code, title, waiting_room, locked, scheduled_at, (passcode_hash IS NOT NULL) AS has_passcode`,
            [user.orgId, code, input.title, user.userId, passcodeHash, input.scheduledAt ?? null, input.waitingRoom ?? policy.waitingRoomDefault],
          );
          await this.audit(c, user, 'meeting.create', code);
          meetingsCreated.inc();
          return r.rows[0];
        });
      } catch (err) {
        if ((err as { code?: string }).code === '23505') continue; // code collision, retry
        throw err;
      }
    }
    throw new MeetingError(503, 'could not allocate a meeting code');
  }

  async list(user: AuthedUser) {
    return withTenant(this.pool, user.orgId, async (c) => {
      const r = await c.query(
        `SELECT id, code, title, waiting_room, locked, scheduled_at, host_user_id = $1 AS is_host, (passcode_hash IS NOT NULL) AS has_passcode
         FROM meetings ORDER BY created_at DESC LIMIT 100`,
        [user.userId],
      );
      return r.rows;
    });
  }

  /**
   * Joins a meeting. Same-organization members only; guests come in a later phase. Hosts and organization admins
   * manage the meeting; everybody else is subject to ban, lock, passcode and waiting room, in that order.
   */
  async join(user: AuthedUser, code: string, passcode?: string, requestHost?: string): Promise<JoinResult> {
    try {
      const result = await this.joinInner(user, code, passcode, requestHost);
      joinResults.inc({ outcome: result.status === 'joined' ? 'ok' : 'waiting' });
      return result;
    } catch (e) {
      joinResults.inc({ outcome: e instanceof MeetingError ? String(e.status) : 'error' });
      throw e;
    }
  }

  private async joinInner(user: AuthedUser, code: string, passcode?: string, requestHost?: string): Promise<JoinResult> {
    if (!CODE_RE.test(code)) throw new MeetingError(404, 'meeting not found');
    const key = `${user.userId}:${code}`;
    if (this.limiter.isBlocked(key)) throw new MeetingError(429, 'too many attempts, try again later');

    const decision = await withTenant(this.pool, user.orgId, async (c) => {
      const meeting = await this.meetingByCode(c, code, user.userId);
      const banned = await c.query('SELECT 1 FROM meeting_bans WHERE meeting_id = $1 AND user_id = $2', [meeting.id, user.userId]);
      return { meeting, banned: (banned.rowCount ?? 0) > 0 };
    });
    const { meeting } = decision;
    const manages = this.canManage(user, meeting);

    if (decision.banned && !manages) throw new MeetingError(403, 'removed from this meeting');
    if (meeting.locked && !manages) throw new MeetingError(403, 'meeting is locked');
    if (meeting.passcode_hash && !manages) {
      const ok = passcode ? await argon2.verify(meeting.passcode_hash, passcode) : false;
      if (!ok) {
        this.limiter.recordFailure(key);
        throw new MeetingError(403, 'wrong passcode');
      }
    }
    this.limiter.reset(key);

    if (meeting.waiting_room && !manages) {
      const state = await withTenant(this.pool, user.orgId, async (c) => {
        const r = await c.query(
          `INSERT INTO join_requests (org_id, meeting_id, user_id) VALUES ($1, $2, $3)
           ON CONFLICT (meeting_id, user_id) DO UPDATE SET meeting_id = EXCLUDED.meeting_id
           RETURNING id, status`,
          [user.orgId, meeting.id, user.userId],
        );
        return r.rows[0] as { id: string; status: string };
      });
      if (state.status === 'denied') throw new MeetingError(403, 'the host declined your request');
      if (state.status === 'pending') return { status: 'waiting', requestId: state.id };
      // admitted earlier: fall through and issue a token
    }
    return this.issueToken(user, meeting, manages, requestHost);
  }

  /** The waiting participant polls this until the host decides; an admission returns the token. */
  async requestStatus(user: AuthedUser, code: string, requestId: string, requestHost?: string) {
    if (!CODE_RE.test(code) || !UUID_RE.test(requestId)) throw new MeetingError(404, 'not found');
    const found = await withTenant(this.pool, user.orgId, async (c) => {
      const meeting = await this.meetingByCode(c, code, user.userId);
      const r = await c.query('SELECT status FROM join_requests WHERE id = $1 AND meeting_id = $2 AND user_id = $3', [
        requestId,
        meeting.id,
        user.userId,
      ]);
      const banned = await c.query('SELECT 1 FROM meeting_bans WHERE meeting_id = $1 AND user_id = $2', [meeting.id, user.userId]);
      return { meeting, status: r.rows[0]?.status as string | undefined, banned: (banned.rowCount ?? 0) > 0 };
    });
    if (!found.status) throw new MeetingError(404, 'not found');
    if (found.banned) throw new MeetingError(403, 'removed from this meeting');
    if (found.status === 'pending') return { status: 'waiting' as const };
    if (found.status === 'denied') throw new MeetingError(403, 'the host declined your request');
    if (found.meeting.locked && !this.canManage(user, found.meeting)) throw new MeetingError(403, 'meeting is locked');
    return this.issueToken(user, found.meeting, false, requestHost);
  }

  async listRequests(user: AuthedUser, code: string) {
    return withTenant(this.pool, user.orgId, async (c) => {
      const meeting = await this.meetingByCode(c, code, user.userId);
      this.mustManage(user, meeting);
      const r = await c.query(
        `SELECT jr.id, jr.user_id, u.display_name, u.email, jr.created_at
         FROM join_requests jr JOIN users u ON u.id = jr.user_id
         WHERE jr.meeting_id = $1 AND jr.status = 'pending' ORDER BY jr.created_at`,
        [meeting.id],
      );
      return r.rows;
    });
  }

  async decide(user: AuthedUser, code: string, requestId: string, admit: boolean) {
    if (!UUID_RE.test(requestId)) throw new MeetingError(404, 'not found');
    return withTenant(this.pool, user.orgId, async (c) => {
      const meeting = await this.meetingByCode(c, code, user.userId);
      this.mustManage(user, meeting);
      const r = await c.query(
        `UPDATE join_requests SET status = $1, decided_at = now(), decided_by = $2
         WHERE id = $3 AND meeting_id = $4 AND status = 'pending' RETURNING user_id`,
        [admit ? 'admitted' : 'denied', user.userId, requestId, meeting.id],
      );
      if (!r.rowCount) throw new MeetingError(404, 'no pending request');
      await this.audit(c, user, admit ? 'meeting.admit' : 'meeting.deny', `${code}:${r.rows[0].user_id}`);
      return { status: admit ? 'admitted' : 'denied' };
    });
  }

  async setLocked(user: AuthedUser, code: string, locked: boolean) {
    return withTenant(this.pool, user.orgId, async (c) => {
      const meeting = await this.meetingByCode(c, code, user.userId);
      this.mustManage(user, meeting);
      await c.query('UPDATE meetings SET locked = $1 WHERE id = $2', [locked, meeting.id]);
      await this.audit(c, user, locked ? 'meeting.lock' : 'meeting.unlock', code);
      return { locked };
    });
  }

  /** Mutes every published microphone track of a participant. The participant can unmute themselves later. */
  async muteParticipant(user: AuthedUser, code: string, identity: string) {
    const meeting = await this.managedMeeting(user, code);
    if (!UUID_RE.test(identity)) throw new MeetingError(404, 'participant not found');
    let participant;
    try {
      participant = await this.rooms.getParticipant(meeting.id, identity);
    } catch {
      throw new MeetingError(404, 'participant not found');
    }
    const audio = participant.tracks.filter((t) => t.type === TrackType.AUDIO && !t.muted);
    for (const t of audio) await this.rooms.mutePublishedTrack(meeting.id, identity, t.sid, true);
    await withTenant(this.pool, user.orgId, (c) => this.audit(c, user, 'meeting.mute', `${code}:${identity}`));
    return { muted: audio.length };
  }

  /** Removes a participant and bans them from rejoining this meeting. The host cannot be removed. */
  async removeParticipant(user: AuthedUser, code: string, identity: string) {
    if (!UUID_RE.test(identity)) throw new MeetingError(404, 'participant not found');
    const meeting = await this.managedMeeting(user, code);
    if (identity === meeting.host_user_id || identity === user.userId) throw new MeetingError(400, 'cannot remove the host or yourself');
    await withTenant(this.pool, user.orgId, async (c) => {
      const target = await c.query('SELECT 1 FROM users WHERE id = $1', [identity]); // RLS: same organization only
      if (!target.rowCount) throw new MeetingError(404, 'participant not found');
      const targetIsCohost = await c.query('SELECT 1 FROM meeting_cohosts WHERE meeting_id = $1 AND user_id = $2', [meeting.id, identity]);
      const callerIsHostOrAdmin = meeting.host_user_id === user.userId || user.role === 'org_admin';
      if (targetIsCohost.rowCount && !callerIsHostOrAdmin) throw new MeetingError(403, 'only the host can remove a co-host');
      await c.query(
        'INSERT INTO meeting_bans (meeting_id, user_id, org_id, banned_by) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
        [meeting.id, identity, user.orgId, user.userId],
      );
      await this.audit(c, user, 'meeting.remove', `${code}:${identity}`);
    });
    try {
      await this.rooms.removeParticipant(meeting.id, identity);
    } catch {
      /* not connected right now: the ban still applies */
    }
    return { removed: true };
  }

  /** The caller's role in this meeting, so a client can follow promotions and demotions while connected. */
  async myRole(user: AuthedUser, code: string): Promise<{ role: 'host' | 'cohost' | 'member' }> {
    return withTenant(this.pool, user.orgId, async (c) => {
      const m = await this.meetingByCode(c, code, user.userId);
      if (m.host_user_id === user.userId || user.role === 'org_admin') return { role: 'host' as const };
      return { role: m.is_cohost ? ('cohost' as const) : ('member' as const) };
    });
  }

  async listCohosts(user: AuthedUser, code: string): Promise<string[]> {
    return withTenant(this.pool, user.orgId, async (c) => {
      const m = await this.meetingByCode(c, code, user.userId);
      this.mustManage(user, m);
      const r = await c.query('SELECT user_id FROM meeting_cohosts WHERE meeting_id = $1', [m.id]);
      return r.rows.map((x: { user_id: string }) => x.user_id);
    });
  }

  /** Only the host or an org admin can appoint or dismiss co-hosts; a co-host cannot promote anyone. */
  async setCohost(user: AuthedUser, code: string, identity: string, grant: boolean) {
    if (!UUID_RE.test(identity)) throw new MeetingError(404, 'participant not found');
    return withTenant(this.pool, user.orgId, async (c) => {
      const meeting = await this.meetingByCode(c, code, user.userId);
      if (!(meeting.host_user_id === user.userId || user.role === 'org_admin')) throw new MeetingError(403, 'only the host can do this');
      if (identity === meeting.host_user_id) throw new MeetingError(400, 'the host is already in charge');
      const target = await c.query('SELECT 1 FROM users WHERE id = $1', [identity]); // RLS: same organization only
      if (!target.rowCount) throw new MeetingError(404, 'participant not found');
      if (grant) {
        await c.query('INSERT INTO meeting_cohosts (meeting_id, user_id, org_id, granted_by) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [
          meeting.id,
          identity,
          user.orgId,
          user.userId,
        ]);
      } else {
        await c.query('DELETE FROM meeting_cohosts WHERE meeting_id = $1 AND user_id = $2', [meeting.id, identity]);
      }
      await this.audit(c, user, grant ? 'meeting.cohost.grant' : 'meeting.cohost.revoke', `${code}:${identity}`);
      return { cohost: grant };
    });
  }

  // --- helpers -----------------------------------------------------------------------------------------------

  private canManage(user: AuthedUser, m: MeetingRow): boolean {
    return m.host_user_id === user.userId || user.role === 'org_admin' || m.is_cohost;
  }

  private mustManage(user: AuthedUser, m: MeetingRow): void {
    if (!this.canManage(user, m)) throw new MeetingError(403, 'only the host can do this');
  }

  private async managedMeeting(user: AuthedUser, code: string): Promise<MeetingRow> {
    if (!CODE_RE.test(code)) throw new MeetingError(404, 'meeting not found');
    const meeting = await withTenant(this.pool, user.orgId, (c) => this.meetingByCode(c, code, user.userId));
    this.mustManage(user, meeting);
    return meeting;
  }

  private async meetingByCode(c: PoolClient, code: string, userId: string): Promise<MeetingRow> {
    if (!CODE_RE.test(code)) throw new MeetingError(404, 'meeting not found');
    const r = await c.query(
      `SELECT m.id, m.title, m.host_user_id, m.passcode_hash, m.locked, m.waiting_room,
              EXISTS (SELECT 1 FROM meeting_cohosts ch WHERE ch.meeting_id = m.id AND ch.user_id = $2) AS is_cohost
       FROM meetings m WHERE m.code = $1`,
      [code, userId],
    );
    if (!r.rows[0]) throw new MeetingError(404, 'meeting not found');
    return r.rows[0] as MeetingRow;
  }

  private audit(c: PoolClient, user: AuthedUser, action: string, target: string) {
    return c.query('INSERT INTO audit_log (org_id, actor_id, action, target) VALUES ($1, $2, $3, $4)', [
      user.orgId,
      user.userId,
      action,
      target,
    ]);
  }

  private async issueToken(user: AuthedUser, meeting: MeetingRow, manages: boolean, requestHost?: string): Promise<JoinedResult> {
    // Record that this user really passed passcode, lock and waiting room: shared files are tied to this record.
    await withTenant(this.pool, user.orgId, (c) =>
      c.query('INSERT INTO meeting_access (meeting_id, user_id, org_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [meeting.id, user.userId, user.orgId]),
    );
    const { maxParticipants } = await withTenant(this.pool, user.orgId, (c) => loadPolicies(c));
    await this.rooms.createRoom({ name: meeting.id, emptyTimeout: 300, maxParticipants });
    const at = new AccessToken(this.cfg.LIVEKIT_API_KEY, this.cfg.LIVEKIT_API_SECRET, {
      identity: user.userId,
      name: user.name,
      ttl: this.cfg.MEETING_TOKEN_TTL_SECONDS,
    });
    at.addGrant({
      roomJoin: true,
      room: meeting.id,
      canSubscribe: true,
      canPublish: true,
      canPublishData: true,
      roomAdmin: manages,
    });
    const url = livekitUrlFor(requestHost, this.cfg.CORS_ORIGINS.split(',').map((o) => o.trim()), this.cfg.LIVEKIT_URL);
    return { status: 'joined', token: await at.toJwt(), url, meetingId: meeting.id, title: meeting.title, isHost: manages };
  }
}
