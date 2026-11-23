import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { RoomServiceClient } from 'livekit-server-sdk';
import { withTenant } from '../db/tenant.js';
import type { Config } from '../config.js';
import type { AuthedUser } from '../auth/auth.guard.js';
import { AdminError, decodeCursor, encodeCursor } from '../admin/admin.service.js';
import { MeetingError, type MeetingsService } from '../meetings/meetings.service.js';
import type { ApiPrincipal } from './api-keys.service.js';
import { ExtError } from './ext-config.js';
import type { ListQuery, MeetingCreateInput, MeetingItem } from './ext-schemas.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE_RE = /^[0-9]{11,12}$/;
const PENDING_STALE_SECONDS = 60; // a creation that did not finish within this long is considered abandoned

const MEETING_SELECT = `
  SELECT m.id, m.code, m.title, m.host_user_id, m.waiting_room, m.locked, m.scheduled_at, m.created_at,
         (m.passcode_hash IS NOT NULL) AS has_passcode,
         to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts
  FROM meetings m`;

interface MeetingRow {
  id: string;
  code: string;
  title: string;
  host_user_id: string;
  waiting_room: boolean;
  locked: boolean;
  scheduled_at: Date | null;
  created_at: Date;
  has_passcode: boolean;
  cursor_ts: string;
}

function toItem(r: MeetingRow): MeetingItem {
  return {
    id: r.id,
    code: r.code,
    title: r.title,
    hostUserId: r.host_user_id,
    waitingRoom: r.waiting_room,
    locked: r.locked,
    hasPasscode: r.has_passcode,
    scheduledAt: r.scheduled_at ? r.scheduled_at.toISOString() : null,
    createdAt: r.created_at.toISOString(),
  };
}

export function decodeExtCursor(cursor: string): { ts: string; id: string } {
  try {
    return decodeCursor(cursor);
  } catch (e) {
    if (e instanceof AdminError) throw new ExtError(400, 'invalid cursor');
    throw e;
  }
}

/** Deterministic text for a parsed request body, so the same JSON in a different key order hashes the same. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

export interface CreateResult {
  body: MeetingItem;
  replay: boolean;
}

export class ExtMeetingsService {
  private readonly rooms: RoomServiceClient;

  constructor(private readonly pool: Pool, private readonly meetings: MeetingsService, cfg: Config) {
    this.rooms = new RoomServiceClient(cfg.LIVEKIT_API_URL, cfg.LIVEKIT_API_KEY, cfg.LIVEKIT_API_SECRET);
  }

  async list(p: ApiPrincipal, q: ListQuery): Promise<{ items: MeetingItem[]; next: string | null }> {
    const cur = q.cursor ? decodeExtCursor(q.cursor) : null;
    return withTenant(this.pool, p.orgId, async (c) => {
      const r = await c.query(
        `${MEETING_SELECT}
         WHERE ($1::timestamptz IS NULL OR (m.created_at, m.id) < ($1::timestamptz, $2::uuid))
         ORDER BY m.created_at DESC, m.id DESC
         LIMIT $3`,
        [cur?.ts ?? null, cur?.id ?? null, q.limit + 1],
      );
      const rows = r.rows as MeetingRow[];
      const page = rows.slice(0, q.limit);
      const last = page[page.length - 1];
      return { items: page.map(toItem), next: rows.length > q.limit && last ? encodeCursor(last.cursor_ts, last.id) : null };
    });
  }

  /** `ref` is the meeting id (uuid) or its join code. */
  async get(p: ApiPrincipal, ref: string): Promise<MeetingItem> {
    return withTenant(this.pool, p.orgId, (c) => this.byRef(c, ref));
  }

  private async byRef(c: PoolClient, ref: string): Promise<MeetingItem> {
    const col = UUID_RE.test(ref) ? 'm.id = $1::uuid' : CODE_RE.test(ref) ? 'm.code = $1' : null;
    if (!col) throw new ExtError(404, 'meeting not found');
    const r = await c.query(`${MEETING_SELECT} WHERE ${col}`, [ref]); // RLS: own organization only
    if (!r.rows[0]) throw new ExtError(404, 'meeting not found');
    return toItem(r.rows[0] as MeetingRow);
  }

  /**
   * Creates a meeting hosted by the key owner. With an idempotency key the first request does the work and later
   * identical requests get its response; the same key with another body is refused. A creation that failed is not
   * remembered, so the caller can fix the request and reuse the key.
   */
  async create(p: ApiPrincipal, input: MeetingCreateInput, idemKey?: string): Promise<CreateResult> {
    if (!idemKey) return { body: await this.createNow(p, input), replay: false };
    const hash = createHash('sha256').update(canonical(input)).digest('hex');

    for (let round = 0; round < 3; round++) {
      const claim = await withTenant(this.pool, p.orgId, async (c) => {
        const ins = await c.query(
          `INSERT INTO ext_idempotency (key_id, idem_key, org_id, request_hash, response)
           VALUES ($1, $2, $3, $4, '{"state":"pending"}'::jsonb) ON CONFLICT DO NOTHING RETURNING 1`,
          [p.keyId, idemKey, p.orgId, hash],
        );
        if (ins.rowCount) return { kind: 'owner' as const };
        const ex = await c.query(
          `SELECT request_hash, response, created_at < now() - interval '24 hours' AS expired,
                  created_at < now() - make_interval(secs => $3) AS stale
             FROM ext_idempotency WHERE key_id = $1 AND idem_key = $2`,
          [p.keyId, idemKey, PENDING_STALE_SECONDS],
        );
        const row = ex.rows[0] as { request_hash: string; response: { state: string; body?: MeetingItem }; expired: boolean; stale: boolean } | undefined;
        if (!row) return { kind: 'retry' as const }; // deleted between the two statements
        if (row.expired) {
          await c.query('DELETE FROM ext_idempotency WHERE key_id = $1 AND idem_key = $2', [p.keyId, idemKey]);
          return { kind: 'retry' as const };
        }
        if (row.request_hash !== hash) throw new ExtError(422, 'Idempotency-Key was already used with a different request body');
        if (row.response.state === 'done' && row.response.body) return { kind: 'replay' as const, body: row.response.body };
        if (row.stale) {
          const take = await c.query(
            `UPDATE ext_idempotency SET created_at = now()
              WHERE key_id = $1 AND idem_key = $2 AND response->>'state' = 'pending' AND created_at < now() - make_interval(secs => $3)
              RETURNING 1`,
            [p.keyId, idemKey, PENDING_STALE_SECONDS],
          );
          if (take.rowCount) return { kind: 'owner' as const };
        }
        throw new ExtError(409, 'a request with this Idempotency-Key is still being processed, retry shortly');
      });
      if (claim.kind === 'replay') return { body: claim.body, replay: true };
      if (claim.kind === 'retry') continue;

      try {
        const body = await this.createNow(p, input);
        await withTenant(this.pool, p.orgId, (c) =>
          c.query(
            `UPDATE ext_idempotency SET response = jsonb_build_object('state', 'done', 'body', $3::jsonb) WHERE key_id = $1 AND idem_key = $2`,
            [p.keyId, idemKey, JSON.stringify(body)],
          ),
        );
        return { body, replay: false };
      } catch (e) {
        await withTenant(this.pool, p.orgId, (c) => c.query('DELETE FROM ext_idempotency WHERE key_id = $1 AND idem_key = $2', [p.keyId, idemKey])).catch(() => undefined);
        throw e;
      }
    }
    throw new ExtError(409, 'could not claim the Idempotency-Key, retry shortly');
  }

  private async hostFor(p: ApiPrincipal): Promise<AuthedUser> {
    const u = await withTenant(this.pool, p.orgId, (c) => c.query('SELECT id, email, display_name, role, disabled FROM users WHERE id = $1', [p.createdBy]));
    const row = u.rows[0] as { id: string; email: string; display_name: string; role: 'org_admin' | 'member'; disabled: boolean } | undefined;
    if (!row || row.disabled) throw new ExtError(403, 'the owner of this API key is no longer active');
    const org = await withTenant(this.pool, p.orgId, (c) => c.query('SELECT slug FROM organizations'));
    return { sub: row.id, email: row.email, name: row.display_name, orgSlug: org.rows[0].slug as string, role: row.role, orgId: p.orgId, userId: row.id };
  }

  private async createNow(p: ApiPrincipal, input: MeetingCreateInput): Promise<MeetingItem> {
    const host = await this.hostFor(p);
    let created: { id: string; code: string };
    try {
      created = await this.meetings.create(host, input);
    } catch (e) {
      if (e instanceof MeetingError) throw new ExtError(e.status, e.message);
      throw e;
    }
    return withTenant(this.pool, p.orgId, async (c) => {
      await c.query('INSERT INTO audit_log (org_id, actor_id, action, target) VALUES ($1, $2, $3, $4)', [p.orgId, host.userId, 'ext.meeting.create', `${created.code} via ${p.prefix}`]);
      return this.byRef(c, created.id);
    });
  }

  /** Deletes a meeting and closes its room. Meetings with shared files are refused: their stored objects would be orphaned. */
  async remove(p: ApiPrincipal, ref: string): Promise<void> {
    const meeting = await withTenant(this.pool, p.orgId, async (c) => {
      const m = await this.byRef(c, ref);
      const files = await c.query('SELECT 1 FROM meeting_files WHERE meeting_id = $1 LIMIT 1', [m.id]);
      if (files.rowCount) throw new ExtError(409, 'the meeting has shared files and cannot be deleted through the API');
      await c.query('DELETE FROM meetings WHERE id = $1', [m.id]);
      await c.query('INSERT INTO audit_log (org_id, actor_id, action, target) VALUES ($1, $2, $3, $4)', [p.orgId, p.createdBy, 'ext.meeting.delete', `${m.code} via ${p.prefix}`]);
      return m;
    });
    try {
      await this.rooms.deleteRoom(meeting.id);
    } catch {
      /* no active room: nothing to close */
    }
  }
}
