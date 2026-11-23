import type { Pool } from 'pg';
import { withTenant } from '../db/tenant.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The part of the media-server client the watchdog uses (RoomServiceClient implements it; tests inject a fake). */
export interface RoomsApi {
  listRooms(names?: string[]): Promise<Array<{ name: string; creationTime: bigint }>>;
  deleteRoom(name: string): Promise<unknown>;
}

/**
 * Trial meetings are limited in length (org_licenses.max_meeting_minutes). The media server has no maximum duration, so
 * this watchdog lists its rooms and deletes the ones of a limited organization that have been open longer than the limit.
 * Stateless on purpose: the age comes from the room's own creation time, so an API restart loses nothing. Accuracy is the
 * sweep interval (30 s by default). The access-token lifetime is bounded too (see MeetingsService), so nobody can
 * reconnect with an old token into a room that has just been closed.
 */
export class TrialRoomSweeper {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly pool: Pool,
    private readonly rooms: RoomsApi,
    private readonly now: () => number = Date.now,
  ) {}

  /** One pass; returns the names of the rooms it closed. Never throws (a media-server outage must not crash the API). */
  async sweepOnce(): Promise<string[]> {
    try {
      const rooms = (await this.rooms.listRooms()).filter((r) => UUID_RE.test(r.name));
      if (rooms.length === 0) return [];
      const limits = await this.pool.query('SELECT meeting_id, org_id, code, max_minutes FROM trial_room_limits($1::uuid[])', [rooms.map((r) => r.name)]);
      const byId = new Map<string, { org_id: string; code: string; max_minutes: number }>(limits.rows.map((r) => [r.meeting_id as string, r]));
      const closed: string[] = [];
      for (const room of rooms) {
        const lim = byId.get(room.name);
        if (!lim) continue;
        const startedMs = Number(room.creationTime) * 1000;
        if (this.now() < startedMs + lim.max_minutes * 60_000) continue;
        await this.rooms.deleteRoom(room.name);
        closed.push(room.name);
        await withTenant(this.pool, lim.org_id, (c) =>
          c.query('INSERT INTO audit_log (org_id, actor_id, action, target) VALUES ($1, NULL, $2, $3)', [lim.org_id, 'meeting.time_limit', lim.code]),
        ).catch(() => undefined);
      }
      return closed;
    } catch {
      return [];
    }
  }

  start(intervalMs = 30_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      void this.sweepOnce().finally(() => {
        this.running = false;
      });
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
