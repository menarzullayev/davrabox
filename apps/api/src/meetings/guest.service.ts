import { createHmac } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { SignJWT, jwtVerify } from 'jose';
import { withTenant } from '../db/tenant.js';
import { livekitClientOptions } from '../common/timeouts.js';
import type { RateLimiter } from '../rate-limit/limiter.js';
import { RateLimitService } from '../rate-limit/service.js';
import type { Config } from '../config.js';
import { joinResults } from '../metrics.js';
import { livekitUrlFor } from './public-url.js';
import { TrialLimits } from '../signup/trial.guard.js';
import { MeetingError } from './meetings.service.js';
import { effectiveGuestMode, GUEST_IDENTITY_PREFIX, type GuestMode } from './guest-types.js';
import argon2 from 'argon2';

export { effectiveGuestMode, GUEST_IDENTITY_PREFIX, type GuestMode } from './guest-types.js';
const CODE_RE = /^[0-9]{11,12}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PENDING_PER_MEETING = 50;
const GUEST_SESSION_SECONDS = 2 * 60 * 60;

export interface GuestJoinInput {
  code: string;
  name: string;
  passcode?: string;
}
export interface GuestRequestContext {
  /** Rate-limit key of the caller's address. */
  ipKey: string;
  requestHost?: string;
}
export interface GuestJoined {
  status: 'joined';
  token: string;
  url: string;
  meetingId: string;
  title: string;
  isHost: false;
  e2ee: boolean;
  guest: true;
  guestToken: string;
}
export interface GuestWaiting {
  status: 'waiting';
  requestId: string;
  guestToken: string;
}
export type GuestJoinResult = GuestJoined | GuestWaiting;

interface GuestMeetingRow {
  id: string;
  title: string;
  passcode_hash: string | null;
  locked: boolean;
  e2ee: boolean;
  guest_mode: GuestMode;
  policy: GuestMode;
}

const NOT_FOUND = 'meeting not found';

export class GuestService {
  private readonly rooms: RoomServiceClient;
  private readonly trial: TrialLimits;
  private readonly attempts: RateLimiter;
  private readonly misses: RateLimiter;
  private readonly passcodeFails: RateLimiter;
  private readonly polls: RateLimiter;
  private readonly signingKey: Uint8Array;
  private readonly ipSecret: string;

  constructor(private readonly pool: Pool, private readonly cfg: Config, rate: RateLimitService = RateLimitService.memory()) {
    this.rooms = new RoomServiceClient(cfg.LIVEKIT_API_URL, cfg.LIVEKIT_API_KEY, cfg.LIVEKIT_API_SECRET, livekitClientOptions());
    this.trial = new TrialLimits(pool);
    // Every attempt from one address, then the attempts that named a code that does not exist (or does not take guests), then wrong passcodes.
    this.attempts = rate.limiter({ name: 'guest-attempt', max: 60, windowMs: 15 * 60_000 });
    this.misses = rate.limiter({ name: 'guest-miss', max: 10, windowMs: 15 * 60_000 });
    this.passcodeFails = rate.limiter({ name: 'guest-pass', max: 5, windowMs: 15 * 60_000 });
    this.polls = rate.limiter({ name: 'guest-poll', max: 240, windowMs: 60_000 });
    this.signingKey = createHmac('sha256', cfg.LIVEKIT_API_SECRET).update('davrabox guest session v1').digest();
    this.ipSecret = createHmac('sha256', cfg.LIVEKIT_API_SECRET).update('davrabox guest ip hash v1').digest('hex');
  }

  /** Keyed hash of the caller's address key: what a ban stores, never the address. */
  ipHash(ipKey: string): string {
    return createHmac('sha256', this.ipSecret).update(ipKey).digest('hex');
  }

  async join(input: GuestJoinInput, ctx: GuestRequestContext): Promise<GuestJoinResult> {
    try {
      const r = await this.joinInner(input, ctx);
      joinResults.inc({ outcome: r.status === 'joined' ? 'guest_ok' : 'guest_waiting' });
      return r;
    } catch (e) {
      joinResults.inc({ outcome: e instanceof MeetingError ? `guest_${e.status}` : 'guest_error' });
      throw e;
    }
  }

  private async joinInner(input: GuestJoinInput, ctx: GuestRequestContext): Promise<GuestJoinResult> {
    const name = cleanName(input.name);
    if (!name) throw new MeetingError(400, 'enter a name of 1 to 60 characters');
    if (!(await this.attempts.hit(ctx.ipKey)).allowed) throw new MeetingError(429, 'too many attempts, try again later');
    if (await this.misses.isBlocked(ctx.ipKey)) throw new MeetingError(429, 'too many attempts, try again later');

    const miss = async (): Promise<never> => {
      await this.misses.hit(ctx.ipKey);
      throw new MeetingError(404, NOT_FOUND);
    };
    if (!CODE_RE.test(input.code)) return miss();
    const found = await this.pool.query('SELECT org_id, meeting_id FROM guest_meeting_lookup($1)', [input.code]);
    const loc = found.rows[0] as { org_id: string; meeting_id: string } | undefined;
    if (!loc) return miss();

    await this.trial.assertTrialActive(loc.org_id);
    const ipHash = this.ipHash(ctx.ipKey);
    const state = await withTenant(this.pool, loc.org_id, async (c) => {
      const meeting = await this.meetingRow(c, loc.meeting_id);
      const banned = await c.query('SELECT 1 FROM meeting_guest_bans WHERE meeting_id = $1 AND ip_hash = $2', [loc.meeting_id, ipHash]);
      const pending = await c.query("SELECT count(*)::int AS n FROM guest_sessions WHERE meeting_id = $1 AND status = 'pending'", [loc.meeting_id]);
      return { meeting, banned: (banned.rowCount ?? 0) > 0, pending: (pending.rows[0] as { n: number }).n };
    });
    const { meeting } = state;
    const mode = effectiveGuestMode(meeting.guest_mode, meeting.policy);
    // Guests off looks exactly like an unknown code: nobody learns which codes exist from here.
    if (mode === 'off') return miss();
    if (state.banned) throw new MeetingError(403, 'removed from this meeting');
    if (meeting.locked) throw new MeetingError(403, 'meeting is locked');

    if (meeting.passcode_hash) {
      const key = `${ctx.ipKey}:${input.code}`;
      // Counted before the hash is checked, atomically (see MeetingsService.joinInner for why).
      if (!(await this.passcodeFails.hit(key)).allowed) throw new MeetingError(429, 'too many attempts, try again later');
      // Always verified (an empty guess simply fails): the cost does not depend on whether a passcode was sent.
      const ok = await argon2.verify(meeting.passcode_hash, input.passcode ?? '');
      if (!ok) throw new MeetingError(403, 'wrong passcode');
      await this.passcodeFails.reset(key);
    }
    if (mode === 'waiting_room' && state.pending >= MAX_PENDING_PER_MEETING) throw new MeetingError(429, 'the waiting room is full');

    const session = await withTenant(this.pool, loc.org_id, async (c) => {
      const r = await c.query(
        `INSERT INTO guest_sessions (org_id, meeting_id, display_name, status, ip_hash) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [loc.org_id, loc.meeting_id, name, mode === 'open' ? 'joined' : 'pending', ipHash],
      );
      const id = (r.rows[0] as { id: string }).id;
      await this.audit(c, loc.org_id, null, 'guest.join', `${input.code}:${id}:${mode}`);
      return id;
    });
    const guestToken = await this.signSession(session, loc.meeting_id, loc.org_id);
    if (mode === 'waiting_room') return { status: 'waiting', requestId: session, guestToken };
    return this.issue(session, name, loc.org_id, meeting, guestToken, ctx.requestHost);
  }

  /** A waiting guest polls this until a host decides. Re-checks the policy: lowering it ends the guest's chance at once. */
  async requestStatus(guestToken: string, requestId: string, ctx: GuestRequestContext): Promise<{ status: 'waiting' } | GuestJoined> {
    if (!UUID_RE.test(requestId)) throw new MeetingError(404, 'not found');
    if (!(await this.polls.hit(ctx.ipKey)).allowed) throw new MeetingError(429, 'too many requests');
    const claims = await this.verifySession(guestToken);
    if (claims.sid !== requestId) throw new MeetingError(404, 'not found');
    const res = await withTenant(this.pool, claims.org, async (c) => {
      const s = await c.query('SELECT status, display_name, ip_hash FROM guest_sessions WHERE id = $1 AND meeting_id = $2', [requestId, claims.mid]);
      if (!s.rows[0]) throw new MeetingError(404, 'not found');
      const meeting = await this.meetingRow(c, claims.mid);
      const banned = await c.query('SELECT 1 FROM meeting_guest_bans WHERE meeting_id = $1 AND ip_hash = $2', [claims.mid, (s.rows[0] as { ip_hash: string }).ip_hash]);
      return { row: s.rows[0] as { status: string; display_name: string }, meeting, banned: (banned.rowCount ?? 0) > 0 };
    });
    if (res.banned) throw new MeetingError(403, 'removed from this meeting');
    if (res.row.status === 'denied') throw new MeetingError(403, 'the host declined your request');
    if (res.row.status === 'pending') return { status: 'waiting' };
    if (effectiveGuestMode(res.meeting.guest_mode, res.meeting.policy) === 'off') throw new MeetingError(403, 'guests are no longer allowed in this meeting');
    if (res.meeting.locked) throw new MeetingError(403, 'meeting is locked');
    return this.issue(requestId, res.row.display_name, claims.org, res.meeting, guestToken, ctx.requestHost);
  }

  // --- helpers -----------------------------------------------------------------------------------------------

  private async meetingRow(c: PoolClient, meetingId: string): Promise<GuestMeetingRow> {
    const r = await c.query(
      `SELECT m.id, m.title, m.passcode_hash, m.locked, m.e2ee, m.guest_mode,
              coalesce((SELECT p.guest_policy FROM org_policies p WHERE p.org_id = m.org_id), 'off') AS policy
       FROM meetings m WHERE m.id = $1`,
      [meetingId],
    );
    if (!r.rows[0]) throw new MeetingError(404, NOT_FOUND);
    return r.rows[0] as GuestMeetingRow;
  }

  private async issue(sessionId: string, name: string, orgId: string, meeting: GuestMeetingRow, guestToken: string, requestHost?: string): Promise<GuestJoined> {
    const limits = await this.trial.effectiveLimits(orgId);
    const identity = `${GUEST_IDENTITY_PREFIX}${sessionId}`;
    if (limits.trial) {
      let present: Array<{ identity: string }> = [];
      try {
        present = await this.rooms.listParticipants(meeting.id);
      } catch {
        /* the room does not exist yet */
      }
      if (present.length >= limits.maxParticipants && !present.some((p) => p.identity === identity)) throw new MeetingError(403, 'meeting is full');
    }
    await this.rooms.createRoom({ name: meeting.id, emptyTimeout: 300, maxParticipants: limits.maxParticipants });
    const at = new AccessToken(this.cfg.LIVEKIT_API_KEY, this.cfg.LIVEKIT_API_SECRET, {
      identity,
      name,
      metadata: JSON.stringify({ guest: true }),
      attributes: { role: 'guest' },
      ttl: limits.maxMinutes ? Math.min(this.cfg.MEETING_TOKEN_TTL_SECONDS, limits.maxMinutes * 60) : this.cfg.MEETING_TOKEN_TTL_SECONDS,
    });
    // Guests talk and show themselves; they never administer the room (no roomAdmin, no recorder rights).
    at.addGrant({ roomJoin: true, room: meeting.id, canSubscribe: true, canPublish: true, canPublishData: true, roomAdmin: false, canUpdateOwnMetadata: false });
    const url = this.cfg.LIVEKIT_URL_FIXED ? this.cfg.LIVEKIT_URL : livekitUrlFor(requestHost, this.cfg.CORS_ORIGINS.split(',').map((o) => o.trim()), this.cfg.LIVEKIT_URL);
    return { status: 'joined', token: await at.toJwt(), url, meetingId: meeting.id, title: meeting.title, isHost: false, e2ee: meeting.e2ee, guest: true, guestToken };
  }

  private signSession(sid: string, mid: string, org: string): Promise<string> {
    return new SignJWT({ sid, mid, org })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setAudience('davrabox-guest')
      .setExpirationTime(`${GUEST_SESSION_SECONDS}s`)
      .sign(this.signingKey);
  }

  private async verifySession(token: string): Promise<{ sid: string; mid: string; org: string }> {
    try {
      const { payload } = await jwtVerify(token, this.signingKey, { algorithms: ['HS256'], audience: 'davrabox-guest' });
      const { sid, mid, org } = payload as { sid?: unknown; mid?: unknown; org?: unknown };
      if (typeof sid !== 'string' || typeof mid !== 'string' || typeof org !== 'string' || !UUID_RE.test(sid) || !UUID_RE.test(mid) || !UUID_RE.test(org)) throw new Error('claims');
      return { sid, mid, org };
    } catch {
      throw new MeetingError(401, 'invalid guest session');
    }
  }

  private audit(c: PoolClient, orgId: string, actor: string | null, action: string, target: string) {
    return c.query('INSERT INTO audit_log (org_id, actor_id, action, target) VALUES ($1, $2, $3, $4)', [orgId, actor, action, target]);
  }
}

/** 1-60 characters after trimming, no control characters; internal whitespace collapsed. */
export function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/.test(raw)) return null;
  const s = raw.trim().replace(/\s+/g, ' ');
  return s.length >= 1 && s.length <= 60 ? s : null;
}
