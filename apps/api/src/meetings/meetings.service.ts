import { randomInt } from 'node:crypto';
import argon2 from 'argon2';
import type { Pool, PoolClient } from 'pg';
import { AccessToken, RoomServiceClient, TrackType } from 'livekit-server-sdk';
import { withTenant } from '../db/tenant.js';
import { livekitClientOptions } from '../common/timeouts.js';
import type { RateLimiter } from '../rate-limit/limiter.js';
import { RateLimitService } from '../rate-limit/service.js';
import type { Config } from '../config.js';
import type { AuthedUser } from '../auth/auth.guard.js';
import { joinResults, meetingsCreated } from '../metrics.js';
import { livekitUrlFor } from './public-url.js';
import { loadPolicies } from '../admin/policies.js';
import { TrialLimits } from '../signup/trial.guard.js';
import { GUEST_IDENTITY_PREFIX, type GuestMode } from './guest-types.js';

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
  /** End-to-end encrypted meeting. Chosen at creation and never changed afterwards. */
  e2ee?: boolean;
  /** Guests (people without an account): the host's choice, never more than the organization's policy allows. Default off. */
  guests?: GuestMode;
}

export interface JoinedResult {
  status: 'joined';
  token: string;
  url: string;
  meetingId: string;
  title: string;
  isHost: boolean;
  /** The media is end-to-end encrypted with a key the server never sees; the client needs it from the link fragment. */
  e2ee: boolean;
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
  e2ee: boolean;
  is_cohost: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE_RE = /^[0-9]{11,12}$/;

/** A LiveKit participant identity this API manages: a member's user id or a guest's `guest:<id>`. */
function isParticipantIdentity(identity: string): boolean {
  return UUID_RE.test(identity) || (identity.startsWith(GUEST_IDENTITY_PREFIX) && UUID_RE.test(identity.slice(GUEST_IDENTITY_PREFIX.length)));
}

function newCode(): string {
  // 11 digits, first digit non-zero, from a CSPRNG.
  return String(randomInt(1, 10)) + String(randomInt(0, 10 ** 10)).padStart(10, '0');
}

export class MeetingsService {
  private readonly limiter: RateLimiter;
  private readonly rooms: RoomServiceClient;
  private readonly trial: TrialLimits;

  constructor(private readonly pool: Pool, private readonly cfg: Config, rate: RateLimitService = RateLimitService.memory()) {
    // Join/passcode failures: 5 per user and meeting code in 15 minutes, shared between API instances when Redis is configured.
    this.limiter = rate.limiter({ name: 'join', max: 5, windowMs: 15 * 60 * 1000 });
    this.rooms = new RoomServiceClient(cfg.LIVEKIT_API_URL, cfg.LIVEKIT_API_KEY, cfg.LIVEKIT_API_SECRET, livekitClientOptions());
    this.trial = new TrialLimits(pool);
  }

  async create(user: AuthedUser, input: CreateMeetingInput) {
    await this.trial.assertTrialActive(user.orgId); // 402 once the organization's trial is over
    // Organization policies (admin console): a required passcode is enforced, the waiting-room default applies when the client is silent.
    const policy = await withTenant(this.pool, user.orgId, (c) => loadPolicies(c));
    if (policy.requirePasscode && !input.passcode) throw new MeetingError(400, 'this organization requires a meeting passcode');
    const rank = { off: 0, waiting_room: 1, open: 2 };
    const guests: GuestMode = input.guests ?? 'off';
    if (rank[guests] > rank[policy.guestPolicy]) throw new MeetingError(400, 'this organization does not allow that guest setting');
    const passcodeHash = input.passcode ? await argon2.hash(input.passcode, { type: argon2.argon2id }) : null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = newCode();
      try {
        return await withTenant(this.pool, user.orgId, async (c) => {
          const r = await c.query(
            `INSERT INTO meetings (org_id, code, title, host_user_id, passcode_hash, scheduled_at, waiting_room, e2ee, guest_mode)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             RETURNING id, code, title, waiting_room, locked, scheduled_at, created_at, e2ee, guest_mode, (passcode_hash IS NOT NULL) AS has_passcode`,
            [user.orgId, code, input.title, user.userId, passcodeHash, input.scheduledAt ?? null, input.waitingRoom ?? policy.waitingRoomDefault, input.e2ee === true, guests],
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

  /** What the caller's organization allows hosts to choose (the new-meeting dialog shows only that much). */
  async settings(user: AuthedUser): Promise<{ guestPolicy: GuestMode }> {
    const p = await withTenant(this.pool, user.orgId, (c) => loadPolicies(c));
    return { guestPolicy: p.guestPolicy };
  }

  async list(user: AuthedUser) {
    return withTenant(this.pool, user.orgId, async (c) => {
      const r = await c.query(
        `SELECT id, code, title, waiting_room, locked, scheduled_at, created_at, e2ee, guest_mode, host_user_id = $1 AS is_host, (passcode_hash IS NOT NULL) AS has_passcode
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
    await this.trial.assertTrialActive(user.orgId);
    const key = `${user.userId}:${code}`;
    if (await this.limiter.isBlocked(key)) throw new MeetingError(429, 'too many attempts, try again later');

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
      // The attempt is counted atomically BEFORE the hash is checked. Checking "is blocked" first and recording the failure
      // afterwards leaves a gap in which any number of parallel guesses all pass the check (measured: 40 of 40).
      if (!(await this.limiter.hit(key)).allowed) throw new MeetingError(429, 'too many attempts, try again later');
      const ok = passcode ? await argon2.verify(meeting.passcode_hash, passcode) : false;
      if (!ok) throw new MeetingError(403, 'wrong passcode');
    }
    await this.limiter.reset(key);

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
    await this.trial.assertTrialActive(user.orgId);
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
      const members = await c.query(
        `SELECT jr.id, jr.user_id, u.display_name, u.email, jr.created_at, false AS guest
         FROM join_requests jr JOIN users u ON u.id = jr.user_id
         WHERE jr.meeting_id = $1 AND jr.status = 'pending' ORDER BY jr.created_at`,
        [meeting.id],
      );
      // Guests (no account): the id is the guest session id; the client labels them and the person decides.
      const guests = await c.query(
        `SELECT g.id, NULL::uuid AS user_id, g.display_name, NULL::text AS email, g.created_at, true AS guest
         FROM guest_sessions g WHERE g.meeting_id = $1 AND g.status = 'pending' ORDER BY g.created_at`,
        [meeting.id],
      );
      return [...members.rows, ...guests.rows].sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at));
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
      if (!r.rowCount) {
        // Not a member's request: it may be a guest's.
        const g = await c.query(
          `UPDATE guest_sessions SET status = $1, decided_at = now(), decided_by = $2
           WHERE id = $3 AND meeting_id = $4 AND status = 'pending' RETURNING id`,
          [admit ? 'admitted' : 'denied', user.userId, requestId, meeting.id],
        );
        if (!g.rowCount) throw new MeetingError(404, 'no pending request');
        await this.audit(c, user, admit ? 'guest.admit' : 'guest.deny', `${code}:${requestId}`);
        return { status: admit ? 'admitted' : 'denied' };
      }
      await this.audit(c, user, admit ? 'meeting.admit' : 'meeting.deny', `${code}:${r.rows[0].user_id}`);
      return { status: admit ? 'admitted' : 'denied' };
    });
  }

  /**
   * The only change a client can ask for here is turning E2EE on or off, and that is never allowed: a meeting that has
   * run unencrypted cannot be made private after the fact (the server cannot know who already holds recordings or
   * transcripts), and an encrypted one must not be downgraded. The attempt is audited.
   */
  async update(user: AuthedUser, code: string, patch: Record<string, unknown>): Promise<never> {
    // The audit row must be committed, so the refusal is thrown after the transaction, not inside it.
    const touchesE2ee = await withTenant(this.pool, user.orgId, async (c) => {
      const meeting = await this.meetingByCode(c, code, user.userId);
      this.mustManage(user, meeting);
      if (!Object.prototype.hasOwnProperty.call(patch, 'e2ee')) return false;
      await this.audit(c, user, 'meeting.e2ee.change.denied', code);
      return true;
    });
    if (touchesE2ee) throw new MeetingError(409, 'end-to-end encryption cannot be changed after the meeting is created');
    throw new MeetingError(400, 'nothing can be updated');
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
    if (!isParticipantIdentity(identity)) throw new MeetingError(404, 'participant not found');
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
    if (!isParticipantIdentity(identity)) throw new MeetingError(404, 'participant not found');
    const meeting = await this.managedMeeting(user, code);
    if (identity.startsWith(GUEST_IDENTITY_PREFIX)) return this.removeGuest(user, code, meeting, identity.slice(GUEST_IDENTITY_PREFIX.length));
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

  /**
   * Removes a guest: the session is closed, the room connection dropped and the guest's network address (keyed hash, this
   * meeting only) banned. A guest who changes address gets in again if the policy allows: the host can lock the meeting.
   */
  private async removeGuest(user: AuthedUser, code: string, meeting: MeetingRow, sessionId: string) {
    await withTenant(this.pool, user.orgId, async (c) => {
      const g = await c.query("UPDATE guest_sessions SET status = 'denied', decided_at = now(), decided_by = $1 WHERE id = $2 AND meeting_id = $3 RETURNING ip_hash", [
        user.userId,
        sessionId,
        meeting.id,
      ]);
      if (!g.rowCount) throw new MeetingError(404, 'participant not found');
      await c.query('INSERT INTO meeting_guest_bans (meeting_id, ip_hash, org_id, banned_by) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [
        meeting.id,
        (g.rows[0] as { ip_hash: string }).ip_hash,
        user.orgId,
        user.userId,
      ]);
      await this.audit(c, user, 'guest.remove', `${code}:${sessionId}`);
    });
    try {
      await this.rooms.removeParticipant(meeting.id, `${GUEST_IDENTITY_PREFIX}${sessionId}`);
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
      `SELECT m.id, m.title, m.host_user_id, m.passcode_hash, m.locked, m.waiting_room, m.e2ee,
              EXISTS (SELECT 1 FROM meeting_cohosts ch WHERE ch.meeting_id = m.id AND ch.user_id = $2) AS is_cohost
       FROM meetings m WHERE m.code = $1`,
      [code, userId],
    );
    if (!r.rows[0]) throw new MeetingError(404, 'meeting not found');
    return r.rows[0] as MeetingRow;
  }

  /** Friendly early refusal for a trial room that is full (the media server enforces the cap too, at connect time). */
  private async assertRoomNotFull(roomName: string, userId: string, max: number): Promise<void> {
    let present: Array<{ identity: string }> = [];
    try {
      present = await this.rooms.listParticipants(roomName);
    } catch {
      return; // the room does not exist yet (or the server is unreachable): nothing to count
    }
    if (present.length >= max && !present.some((p) => p.identity === userId)) throw new MeetingError(403, 'meeting is full');
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
    // Participant cap and (for trials) the meeting time limit: the room is closed by TrialRoomSweeper, and the token
    // never outlives the limit.
    const limits = await this.trial.effectiveLimits(user.orgId);
    if (limits.trial) await this.assertRoomNotFull(meeting.id, user.userId, limits.maxParticipants);
    await this.rooms.createRoom({ name: meeting.id, emptyTimeout: 300, maxParticipants: limits.maxParticipants });
    const at = new AccessToken(this.cfg.LIVEKIT_API_KEY, this.cfg.LIVEKIT_API_SECRET, {
      identity: user.userId,
      name: user.name,
      ttl: limits.maxMinutes ? Math.min(this.cfg.MEETING_TOKEN_TTL_SECONDS, limits.maxMinutes * 60) : this.cfg.MEETING_TOKEN_TTL_SECONDS,
    });
    at.addGrant({
      roomJoin: true,
      room: meeting.id,
      canSubscribe: true,
      canPublish: true,
      canPublishData: true,
      roomAdmin: manages,
    });
    const url = this.cfg.LIVEKIT_URL_FIXED ? this.cfg.LIVEKIT_URL : livekitUrlFor(requestHost, this.cfg.CORS_ORIGINS.split(',').map((o) => o.trim()), this.cfg.LIVEKIT_URL);
    return { status: 'joined', token: await at.toJwt(), url, meetingId: meeting.id, title: meeting.title, isHost: manages, e2ee: meeting.e2ee };
  }
}
