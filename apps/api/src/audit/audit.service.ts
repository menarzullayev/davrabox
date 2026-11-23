import { createHmac, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import type { Pool, PoolClient } from 'pg';
import type { AuthedUser } from '../auth/auth.guard.js';
import { withTenant } from '../db/tenant.js';
import { FORMATS, type AuditItem, type ExportFormat } from './format.js';

export class AuditError extends Error {
  constructor(public readonly status: number, message: string, public readonly headers: Record<string, string> = {}) {
    super(message);
  }
}

export const EXPORT_ROW_CAP = 1_000_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export interface AuditFilters {
  from?: string; // ISO instant, inclusive
  to?: string; // ISO instant, inclusive
  action?: string; // exact, or prefix when it ends with '*'
  actor?: string; // uuid, or email substring
  target?: string; // substring
}

export interface ListResult {
  items: AuditItem[];
  next: string | null;
}

export interface AuditOptions {
  exportCap?: number;
  exportsPerMinute?: number;
  exportChunk?: number;
  now?: () => number;
}

/** Sliding-window limiter: at most `max` hits per key within `windowMs` (in-memory, per API process). */
export class WindowLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly max: number, private readonly windowMs: number, private readonly now: () => number = Date.now) {}
  /** Records a hit and returns 0 when allowed, otherwise the number of milliseconds to wait. */
  hit(key: string): number {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return this.windowMs - (t - recent[0]!);
    }
    recent.push(t);
    this.hits.set(key, recent);
    return 0;
  }
}

function str(q: Record<string, unknown>, key: string, max: number): string | undefined {
  const v = q[key];
  if (v === undefined || v === '') return undefined;
  if (typeof v !== 'string') throw new AuditError(400, `invalid ${key}`);
  if (v.length > max || v.includes('\u0000')) throw new AuditError(400, `invalid ${key}`);
  return v;
}

function isoInstant(v: string, key: string): string {
  const m = ISO_RE.exec(v);
  if (!m) throw new AuditError(400, `invalid ${key}: use an ISO 8601 timestamp with a time zone, e.g. 2026-11-23T10:00:00Z`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) throw new AuditError(400, `invalid ${key}`);
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) throw new AuditError(400, `invalid ${key}`);
  return new Date(ms).toISOString();
}

export function parseFilters(q: Record<string, unknown>): AuditFilters {
  const f: AuditFilters = {};
  const from = str(q, 'from', 40);
  const to = str(q, 'to', 40);
  if (from) f.from = isoInstant(from, 'from');
  if (to) f.to = isoInstant(to, 'to');
  if (f.from && f.to && f.from > f.to) throw new AuditError(400, 'from must not be later than to');
  const action = str(q, 'action', 100);
  if (action) {
    const star = action.indexOf('*');
    if (star !== -1 && star !== action.length - 1) throw new AuditError(400, 'invalid action: * is allowed only as the last character');
    f.action = action;
  }
  const actor = str(q, 'actor', 200);
  if (actor) f.actor = actor;
  const target = str(q, 'target', 200);
  if (target) f.target = target;
  return f;
}

export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function where(f: AuditFilters, params: unknown[]): string {
  const c: string[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (f.from) c.push(`a.created_at >= ${p(f.from)}::timestamptz`);
  if (f.to) c.push(`a.created_at <= ${p(f.to)}::timestamptz`);
  if (f.action) {
    if (f.action.endsWith('*')) c.push(`a.action LIKE ${p(escapeLike(f.action.slice(0, -1)) + '%')} ESCAPE '\\'`);
    else c.push(`a.action = ${p(f.action)}`);
  }
  if (f.actor) {
    if (UUID_RE.test(f.actor)) c.push(`a.actor_id = ${p(f.actor)}::uuid`);
    else c.push(`u.email ILIKE ${p('%' + escapeLike(f.actor) + '%')} ESCAPE '\\'`);
  }
  if (f.target) c.push(`a.target ILIKE ${p('%' + escapeLike(f.target) + '%')} ESCAPE '\\'`);
  return c.length ? c.join(' AND ') : 'true';
}

interface Row {
  id: string;
  ts: string;
  actor_id: string | null;
  email: string | null;
  action: string;
  target: string | null;
}

const COLUMNS = `a.id, to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ts, a.actor_id, u.email, a.action, a.target`;
const FROM = 'FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id';

function toItem(r: Row): AuditItem {
  return { id: r.id, at: r.ts, actorId: r.actor_id, actorEmail: r.email, action: r.action, target: r.target };
}

export class AuditService {
  private readonly key: Buffer;
  private readonly limiter: WindowLimiter;
  readonly cap: number;
  private readonly chunk: number;

  /** secret: any server-side secret; the cursor MAC key is derived from it with a fixed label. */
  constructor(private readonly pool: Pool, secret: string, opts: AuditOptions = {}) {
    this.key = createHmac('sha256', secret).update('davrabox.audit.cursor.v1').digest();
    this.cap = opts.exportCap ?? EXPORT_ROW_CAP;
    this.chunk = opts.exportChunk ?? 1000;
    this.limiter = new WindowLimiter(opts.exportsPerMinute ?? 5, 60_000, opts.now);
  }

  private mac(orgId: string, payload: string): string {
    return createHmac('sha256', this.key).update(`${orgId}|${payload}`).digest('base64url');
  }

  private encodeCursor(orgId: string, ts: string, id: string): string {
    const payload = `${ts}|${id}`;
    return `${Buffer.from(payload).toString('base64url')}.${this.mac(orgId, payload)}`;
  }

  private decodeCursor(orgId: string, cursor: string): { ts: string; id: string } {
    const bad = () => new AuditError(400, 'invalid cursor');
    if (cursor.length > 300) throw bad();
    const [b, m, extra] = cursor.split('.');
    if (!b || !m || extra !== undefined) throw bad();
    const payload = Buffer.from(b, 'base64url').toString('utf8');
    const expected = Buffer.from(this.mac(orgId, payload));
    const given = Buffer.from(m);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw bad();
    const [ts, id, more] = payload.split('|');
    if (!ts || !id || more !== undefined || !TS_RE.test(ts) || !/^\d{1,18}$/.test(id)) throw bad();
    return { ts, id };
  }

  private async page(c: PoolClient, f: AuditFilters, after: { ts: string; id: string } | null, limit: number): Promise<Row[]> {
    const params: unknown[] = [];
    let w = where(f, params);
    if (after) {
      params.push(after.ts, after.id);
      w += ` AND (a.created_at, a.id) < ($${params.length - 1}::timestamptz, $${params.length}::bigint)`;
    }
    params.push(limit);
    const r = await c.query<Row>(`SELECT ${COLUMNS} ${FROM} WHERE ${w} ORDER BY a.created_at DESC, a.id DESC LIMIT $${params.length}`, params);
    return r.rows;
  }

  async list(user: AuthedUser, q: Record<string, unknown>): Promise<ListResult> {
    const f = parseFilters(q);
    let limit = 50;
    const rawLimit = q['limit'];
    if (rawLimit !== undefined && rawLimit !== '') {
      if (typeof rawLimit !== 'string' || !/^\d{1,4}$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 200) {
        throw new AuditError(400, 'limit must be an integer from 1 to 200');
      }
      limit = Number(rawLimit);
    }
    const rawCursor = q['cursor'];
    if (rawCursor !== undefined && typeof rawCursor !== 'string') throw new AuditError(400, 'invalid cursor');
    const after = rawCursor ? this.decodeCursor(user.orgId, rawCursor) : null;
    const rows = await withTenant(this.pool, user.orgId, (c) => this.page(c, f, after, limit + 1));
    const more = rows.length > limit;
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    return { items: items.map(toItem), next: more && last ? this.encodeCursor(user.orgId, last.ts, last.id) : null };
  }

  /**
   * Validates, rate-limits, checks the row cap and writes the audit.export row, then returns a stream that reads the
   * data in keyset chunks (one short transaction per chunk), so memory stays bounded for any export size.
   */
  async export(user: AuthedUser, formatRaw: unknown, q: Record<string, unknown>): Promise<{ stream: Readable; contentType: string; filename: string }> {
    if (typeof formatRaw !== 'string' || !(formatRaw in FORMATS)) throw new AuditError(400, 'format must be csv, json or cef');
    const format = formatRaw as ExportFormat;
    const f = parseFilters(q);
    const wait = this.limiter.hit(user.userId);
    if (wait > 0) {
      const secs = Math.ceil(wait / 1000);
      throw new AuditError(429, 'too many exports, try again later', { 'Retry-After': String(secs) });
    }
    const total = await withTenant(this.pool, user.orgId, async (c) => {
      const params: unknown[] = [];
      const w = where(f, params);
      params.push(this.cap + 1);
      const r = await c.query<{ n: string }>(`SELECT count(*) AS n FROM (SELECT 1 ${FROM} WHERE ${w} LIMIT $${params.length}) s`, params);
      return Number(r.rows[0]!.n);
    });
    if (total > this.cap) {
      throw new AuditError(413, `export exceeds the limit of ${this.cap} rows; narrow the time range or filters`);
    }
    const desc = [`format=${format}`, ...Object.entries(f).map(([k, v]) => `${k}=${v}`)].join(';');
    await withTenant(this.pool, user.orgId, (c) =>
      c.query('INSERT INTO audit_log (org_id, actor_id, action, target) VALUES ($1, $2, $3, $4)', [user.orgId, user.userId, 'audit.export', desc.slice(0, 1000)]),
    );
    const fmt = FORMATS[format];
    const self = this;
    async function* gen(): AsyncGenerator<string> {
      if (fmt.head) yield fmt.head;
      let after: { ts: string; id: string } | null = null;
      let sent = 0;
      for (;;) {
        const rows: Row[] = await withTenant(self.pool, user.orgId, (c) => self.page(c, f, after, self.chunk));
        if (rows.length === 0) return;
        let out = '';
        for (const r of rows) out += fmt.line(toItem(r));
        yield out;
        sent += rows.length;
        const last = rows[rows.length - 1]!;
        after = { ts: last.ts, id: last.id };
        if (rows.length < self.chunk || sent > self.cap) return;
      }
    }
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    return { stream: Readable.from(gen()), contentType: fmt.contentType, filename: `audit-${stamp}.${fmt.ext}` };
  }

  async verify(user: AuthedUser): Promise<{ ok: boolean; checked: number; firstBrokenId: string | null }> {
    const r = await withTenant(this.pool, user.orgId, (c) =>
      c.query<{ ok: boolean; checked: string; first_broken_id: string | null }>('SELECT ok, checked, first_broken_id FROM audit_verify_chain($1)', [user.orgId]),
    );
    const row = r.rows[0]!;
    return { ok: row.ok, checked: Number(row.checked), firstBrokenId: row.first_broken_id };
  }
}
