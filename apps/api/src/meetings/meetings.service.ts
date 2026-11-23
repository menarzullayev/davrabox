import { randomInt } from 'node:crypto';
import argon2 from 'argon2';
import type { Pool } from 'pg';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { withTenant } from '../db/tenant.js';
import { FailureLimiter } from '../common/rate-limiter.js';
import type { Config } from '../config.js';
import type { AuthedUser } from '../auth/auth.guard.js';
import { joinResults, meetingsCreated } from '../metrics.js';
import { livekitUrlFor } from './public-url.js';

export class MeetingError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export interface CreateMeetingInput {
  title: string;
  passcode?: string;
  scheduledAt?: string;
}

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
    const passcodeHash = input.passcode ? await argon2.hash(input.passcode, { type: argon2.argon2id }) : null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = newCode();
      try {
        return await withTenant(this.pool, user.orgId, async (c) => {
          const r = await c.query(
            `INSERT INTO meetings (org_id, code, title, host_user_id, passcode_hash, scheduled_at)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id, code, title, waiting_room, locked, scheduled_at, (passcode_hash IS NOT NULL) AS has_passcode`,
            [user.orgId, code, input.title, user.userId, passcodeHash, input.scheduledAt ?? null],
          );
          await c.query('INSERT INTO audit_log (org_id, actor_id, action, target) VALUES ($1, $2, $3, $4)', [
            user.orgId,
            user.userId,
            'meeting.create',
            code,
          ]);
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
        `SELECT id, code, title, waiting_room, locked, scheduled_at, (passcode_hash IS NOT NULL) AS has_passcode
         FROM meetings ORDER BY created_at DESC LIMIT 100`,
      );
      return r.rows;
    });
  }

  /** Returns a short-lived LiveKit token. Same-organization members only; guests come in a later phase. */
  async join(user: AuthedUser, code: string, passcode?: string, requestHost?: string) {
    try {
      const result = await this.joinInner(user, code, passcode, requestHost);
      joinResults.inc({ outcome: 'ok' });
      return result;
    } catch (e) {
      joinResults.inc({ outcome: e instanceof MeetingError ? String(e.status) : 'error' });
      throw e;
    }
  }

  private async joinInner(user: AuthedUser, code: string, passcode?: string, requestHost?: string) {
    if (!/^[0-9]{11,12}$/.test(code)) throw new MeetingError(404, 'meeting not found');
    const key = `${user.userId}:${code}`;
    if (this.limiter.isBlocked(key)) throw new MeetingError(429, 'too many attempts, try again later');

    const meeting = await withTenant(this.pool, user.orgId, async (c) => {
      const r = await c.query('SELECT id, title, host_user_id, passcode_hash, locked FROM meetings WHERE code = $1', [code]);
      return r.rows[0] as
        | { id: string; title: string; host_user_id: string; passcode_hash: string | null; locked: boolean }
        | undefined;
    });
    if (!meeting) throw new MeetingError(404, 'meeting not found');

    const isHost = meeting.host_user_id === user.userId;
    if (meeting.locked && !isHost) throw new MeetingError(403, 'meeting is locked');
    if (meeting.passcode_hash && !isHost) {
      const ok = passcode ? await argon2.verify(meeting.passcode_hash, passcode) : false;
      if (!ok) {
        this.limiter.recordFailure(key);
        throw new MeetingError(403, 'wrong passcode');
      }
    }
    this.limiter.reset(key);

    await this.rooms.createRoom({ name: meeting.id, emptyTimeout: 300, maxParticipants: 300 });

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
      roomAdmin: isHost,
    });
    const url = livekitUrlFor(requestHost, this.cfg.CORS_ORIGINS.split(',').map((o) => o.trim()), this.cfg.LIVEKIT_URL);
    return { token: await at.toJwt(), url, meetingId: meeting.id, title: meeting.title, isHost };
  }
}
