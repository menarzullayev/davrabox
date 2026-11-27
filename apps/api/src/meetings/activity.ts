import type { Pool, PoolClient } from 'pg';
import { withTenant } from '../db/tenant.js';
import { GUEST_IDENTITY_PREFIX } from './guest-types.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The part of the media-server API the tracker uses (RoomServiceClient in production, a fake in tests). */
export interface ActivityRooms {
  listRooms(names?: string[]): Promise<Array<{ name: string; sid: string; creationTime?: bigint | number | string }>>;
  listParticipants(room: string): Promise<Array<{ identity: string; joinedAt?: bigint | number | string }>>;
}

/** A signed media-server event (LiveKit webhook) as far as the tracker cares. */
export interface ActivityEvent {
  name: string;
  room: string;
  roomSid?: string;
  identity?: string;
  at?: Date;
}

/** Ended runs of meetings shown in "Recent activity" (only what the server really saw). */
export interface ActivityItem {
  id: string;
  meetingCode: string;
  title: string;
  personal: boolean;
  isHost: boolean;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  /** Distinct people connected at some point (members and guests). */
  participants: number;
  guests: number;
  peak: number;
  /** Files shared in the meeting during this run. */
  files: number;
  /** Finished recordings of this run. */
  recordings: number;
}

/** Members are user ids, guests `guest:<session id>`; the recording bot and anything else is not counted. */
export function countedIdentity(identity: string): 'member' | 'guest' | null {
  if (UUID_RE.test(identity)) return 'member';
  if (identity.startsWith(GUEST_IDENTITY_PREFIX) && UUID_RE.test(identity.slice(GUEST_IDENTITY_PREFIX.length))) return 'guest';
  return null;
}

const toDate = (v: bigint | number | string | undefined, fallback: Date): Date => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : fallback;
};

/**
 * Records real runs of meetings for the "Recent activity" block (owner decision 7). It asks the media server which rooms are
 * live and who is connected (works with a self-hosted LiveKit and with LiveKit Cloud, no extra configuration), and also takes
 * the signed webhook events when the media server sends them (exact join and end times). Never throws: a media-server
 * outage must neither crash the API nor close runs that are still going on.
 */
export class ActivityTracker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly pool: Pool,
    private readonly rooms: ActivityRooms,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** One pass over the live rooms; returns how many runs were opened and closed. */
  async pollOnce(): Promise<{ opened: number; closed: number }> {
    let live: Awaited<ReturnType<ActivityRooms['listRooms']>>;
    try {
      live = (await this.rooms.listRooms()).filter((r) => UUID_RE.test(r.name) && r.sid);
    } catch {
      return { opened: 0, closed: 0 }; // unknown state: close nothing
    }
    let opened = 0;
    let closed = 0;
    try {
      const orgs = new Map<string, string>();
      if (live.length) {
        const r = await this.pool.query('SELECT meeting_id, org_id FROM activity_room_lookup($1::uuid[])', [live.map((x) => x.name)]);
        for (const row of r.rows as Array<{ meeting_id: string; org_id: string }>) orgs.set(row.meeting_id, row.org_id);
      }
      for (const room of live) {
        const orgId = orgs.get(room.name);
        if (!orgId) continue;
        let people: Awaited<ReturnType<ActivityRooms['listParticipants']>>;
        try {
          people = (await this.rooms.listParticipants(room.name)).filter((p) => countedIdentity(p.identity));
        } catch {
          continue;
        }
        if (people.length === 0) continue; // an empty room (created by a join token nobody used yet, or waiting to close)
        const now = this.now();
        const first = people.reduce((min, p) => Math.min(min, toDate(p.joinedAt, now).getTime()), now.getTime());
        const created = await withTenant(this.pool, orgId, async (c) => {
          const s = await this.ensureSession(c, orgId, room.name, room.sid, new Date(first));
          await c.query('UPDATE meeting_sessions SET last_active_at = $2, peak_participants = greatest(peak_participants, $3) WHERE id = $1', [s.id, now, people.length]);
          for (const p of people) await this.addParticipant(c, orgId, s.id, p.identity, toDate(p.joinedAt, now));
          return s.created;
        });
        if (created) opened++;
      }
      // Runs whose room is gone have ended: at the last moment somebody was seen connected.
      const sids = new Set(live.map((x) => x.sid));
      const open = await this.pool.query('SELECT session_id, org_id, room_sid FROM activity_open_sessions()');
      for (const s of open.rows as Array<{ session_id: string; org_id: string; room_sid: string }>) {
        if (sids.has(s.room_sid)) continue;
        await withTenant(this.pool, s.org_id, (c) => this.close(c, s.session_id, null));
        closed++;
      }
    } catch {
      /* database hiccup: the next pass catches up */
    }
    return { opened, closed };
  }

  /** A verified webhook event: exact times for joins and ends (the poll fills any gap). */
  async onEvent(ev: ActivityEvent): Promise<void> {
    if (!UUID_RE.test(ev.room) || !ev.roomSid) return;
    try {
      const at = ev.at ?? this.now();
      const r = await this.pool.query('SELECT meeting_id, org_id FROM activity_room_lookup($1::uuid[])', [[ev.room]]);
      const orgId = (r.rows[0] as { org_id: string } | undefined)?.org_id;
      if (!orgId) return;
      await withTenant(this.pool, orgId, async (c) => {
        if (ev.name === 'participant_joined' && ev.identity && countedIdentity(ev.identity)) {
          const s = await this.ensureSession(c, orgId, ev.room, ev.roomSid!, at);
          await this.addParticipant(c, orgId, s.id, ev.identity, at);
          await c.query('UPDATE meeting_sessions SET last_active_at = greatest(coalesce(last_active_at, $2), $2), peak_participants = greatest(peak_participants, 1) WHERE id = $1', [s.id, at]);
        } else if (ev.name === 'participant_left' && ev.identity && countedIdentity(ev.identity)) {
          await c.query('UPDATE meeting_sessions SET last_active_at = greatest(coalesce(last_active_at, $2), $2) WHERE room_sid = $1 AND ended_at IS NULL', [ev.roomSid, at]);
        } else if (ev.name === 'room_finished') {
          const s = await c.query('SELECT id FROM meeting_sessions WHERE room_sid = $1 AND ended_at IS NULL', [ev.roomSid]);
          if (s.rows[0]) await this.close(c, (s.rows[0] as { id: string }).id, null);
        }
      });
    } catch {
      /* the poll catches up */
    }
  }

  /** The host ended the meeting for everyone: the run ends now (the media server closes the room right after). */
  async endedByHost(orgId: string, meetingId: string): Promise<void> {
    try {
      await withTenant(this.pool, orgId, async (c) => {
        const open = await c.query('SELECT id, last_active_at FROM meeting_sessions WHERE meeting_id = $1 AND ended_at IS NULL', [meetingId]);
        for (const s of open.rows as Array<{ id: string; last_active_at: Date | null }>) await this.close(c, s.id, s.last_active_at ? this.now() : null);
      });
    } catch {
      /* the poll closes it */
    }
  }

  /** Ended runs the person hosted or was connected in, newest first. */
  async recent(orgId: string, userId: string, limit: number): Promise<ActivityItem[]> {
    return withTenant(this.pool, orgId, async (c) => {
      const r = await c.query(
        `SELECT s.id, m.code, m.title, (m.personal_owner IS NOT NULL) AS personal, (m.host_user_id = $1) AS is_host,
                s.started_at, s.ended_at, s.peak_participants,
                (SELECT count(*)::int FROM meeting_session_participants p WHERE p.session_id = s.id) AS participants,
                (SELECT count(*)::int FROM meeting_session_participants p WHERE p.session_id = s.id AND p.guest) AS guests,
                (SELECT count(*)::int FROM meeting_files f WHERE f.meeting_id = s.meeting_id AND f.created_at BETWEEN s.started_at AND s.ended_at + interval '1 minute') AS files,
                (SELECT count(*)::int FROM recordings x WHERE x.meeting_id = s.meeting_id AND x.status = 'ready' AND x.started_at BETWEEN s.started_at - interval '1 minute' AND s.ended_at) AS recordings
           FROM meeting_sessions s JOIN meetings m ON m.id = s.meeting_id
          WHERE s.ended_at IS NOT NULL
            AND (m.host_user_id = $1 OR EXISTS (SELECT 1 FROM meeting_session_participants p WHERE p.session_id = s.id AND p.user_id = $1))
          ORDER BY s.ended_at DESC
          LIMIT $2`,
        [userId, limit],
      );
      return (r.rows as Array<Record<string, unknown>>).map((x) => {
        const started = x['started_at'] as Date;
        const ended = x['ended_at'] as Date;
        return {
          id: x['id'] as string,
          meetingCode: x['code'] as string,
          title: x['title'] as string,
          personal: x['personal'] as boolean,
          isHost: x['is_host'] as boolean,
          startedAt: started.toISOString(),
          endedAt: ended.toISOString(),
          durationSeconds: Math.max(0, Math.round((ended.getTime() - started.getTime()) / 1000)),
          participants: x['participants'] as number,
          guests: x['guests'] as number,
          peak: x['peak_participants'] as number,
          files: x['files'] as number,
          recordings: x['recordings'] as number,
        };
      });
    });
  }

  start(intervalMs = 15_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      void this.pollOnce().finally(() => {
        this.running = false;
      });
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // --- helpers ---------------------------------------------------------------------------------------------------

  private async ensureSession(c: PoolClient, orgId: string, meetingId: string, sid: string, startedAt: Date): Promise<{ id: string; created: boolean }> {
    const ins = await c.query(
      `INSERT INTO meeting_sessions (org_id, meeting_id, room_sid, started_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (room_sid) DO NOTHING RETURNING id`,
      [orgId, meetingId, sid, startedAt],
    );
    if (ins.rows[0]) return { id: (ins.rows[0] as { id: string }).id, created: true };
    // An earlier first join (webhook or a participant's joinedAt) moves the start back, never forward.
    const r = await c.query('UPDATE meeting_sessions SET started_at = least(started_at, $2) WHERE room_sid = $1 RETURNING id', [sid, startedAt]);
    return { id: (r.rows[0] as { id: string }).id, created: false };
  }

  private async addParticipant(c: PoolClient, orgId: string, sessionId: string, identity: string, at: Date): Promise<void> {
    const kind = countedIdentity(identity);
    if (!kind) return;
    // A member's identity is their user id; the row links to it only when that user belongs to this organization (RLS).
    await c.query(
      `INSERT INTO meeting_session_participants (session_id, org_id, identity, user_id, guest, first_seen_at)
       VALUES ($1, $2, $3, (SELECT id FROM users WHERE id::text = $3 AND $4 = false), $4, $5)
       ON CONFLICT (session_id, identity) DO UPDATE SET first_seen_at = least(meeting_session_participants.first_seen_at, EXCLUDED.first_seen_at)`,
      [sessionId, orgId, identity, kind === 'guest', at],
    );
  }

  /** Ends a run: at `at`, else at the last moment somebody was seen. A run nobody was ever seen in is dropped. */
  private async close(c: PoolClient, sessionId: string, at: Date | null): Promise<void> {
    const s = await c.query('SELECT last_active_at, started_at FROM meeting_sessions WHERE id = $1', [sessionId]);
    const row = s.rows[0] as { last_active_at: Date | null; started_at: Date } | undefined;
    if (!row) return;
    if (!row.last_active_at && !at) {
      await c.query('DELETE FROM meeting_sessions WHERE id = $1', [sessionId]);
      return;
    }
    const end = at ?? row.last_active_at!;
    await c.query('UPDATE meeting_sessions SET ended_at = greatest($2, started_at), last_active_at = greatest(coalesce(last_active_at, $2), $2) WHERE id = $1 AND ended_at IS NULL', [sessionId, end]);
  }
}
