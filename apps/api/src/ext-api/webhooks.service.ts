import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { withTenant } from '../db/tenant.js';
import type { AuthedUser } from '../auth/auth.guard.js';
import { seal } from '../files/crypto.js';
import { decodeCursor, encodeCursor, AdminError } from '../admin/admin.service.js';
import { ExtError } from './ext-config.js';
import { UrlRejectedError, resolvePublicHttpsUrl, defaultResolver, type Resolver } from './url-guard.js';

export const WEBHOOK_EVENTS = ['meeting.created', 'meeting.ended', 'participant.joined', 'participant.left'] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
export const MAX_ENDPOINTS_PER_ORG = 10;
export const DELIVERY_STATUSES = ['pending', 'delivered', 'dead'] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface EndpointItem {
  id: string;
  url: string;
  events: WebhookEvent[];
  createdAt: string;
}
export interface DeliveryItem {
  id: string;
  eventId: string;
  eventType: string;
  status: (typeof DELIVERY_STATUSES)[number];
  attempts: number;
  lastStatus: number | null;
  lastError: string | null;
  nextAttemptAt: string;
  createdAt: string;
  deliveredAt: string | null;
}

interface EndpointRow {
  id: string;
  url: string;
  events: WebhookEvent[];
  created_at: Date;
}
interface DeliveryRow {
  id: string;
  event_id: string;
  event_type: string;
  status: DeliveryItem['status'];
  attempts: number;
  last_status: number | null;
  last_error: string | null;
  next_attempt_at: Date;
  created_at: Date;
  delivered_at: Date | null;
  cursor_ts: string;
}

const toEndpoint = (r: EndpointRow): EndpointItem => ({ id: r.id, url: r.url, events: r.events, createdAt: r.created_at.toISOString() });
const toDelivery = (r: DeliveryRow): DeliveryItem => ({
  id: r.id,
  eventId: r.event_id,
  eventType: r.event_type,
  status: r.status,
  attempts: r.attempts,
  lastStatus: r.last_status,
  lastError: r.last_error,
  nextAttemptAt: r.next_attempt_at.toISOString(),
  createdAt: r.created_at.toISOString(),
  deliveredAt: r.delivered_at ? r.delivered_at.toISOString() : null,
});

function audit(c: PoolClient, user: AuthedUser, action: string, target: string) {
  return c.query('INSERT INTO audit_log (org_id, actor_id, action, target) VALUES ($1, $2, $3, $4)', [user.orgId, user.userId, action, target]);
}

/** A stable UUID derived from a media-server event id, so a retried event maps to the same webhook event id. */
export function uuidFromString(s: string): string {
  const h = createHash('sha256').update(s).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

const MEDIA_EVENTS: Record<string, WebhookEvent> = {
  participant_joined: 'participant.joined',
  participant_left: 'participant.left',
  room_finished: 'meeting.ended',
};

export interface MediaEvent {
  name: string; // LiveKit event name
  id: string; // LiveKit event id (stable across its own retries)
  room: string;
  identity?: string;
  participantName?: string;
  occurredAt?: Date;
}

export class WebhooksService {
  private readonly resolver: Resolver;
  private readonly master: Buffer | null;

  constructor(private readonly pool: Pool, opts: { master: Buffer | null; resolver?: Resolver }) {
    this.master = opts.master;
    this.resolver = opts.resolver ?? defaultResolver;
  }

  /** Registers an endpoint. The signing secret is generated here, returned once and stored envelope-encrypted. */
  async create(user: AuthedUser, input: { url: string; events: WebhookEvent[] }): Promise<EndpointItem & { secret: string }> {
    if (!this.master) throw new ExtError(503, 'webhooks are not configured on this server');
    let url: URL;
    try {
      ({ url } = await resolvePublicHttpsUrl(input.url, this.resolver));
    } catch (e) {
      if (e instanceof UrlRejectedError) {
        await withTenant(this.pool, user.orgId, (c) => audit(c, user, 'webhook.refused', e.code)).catch(() => undefined);
        throw new ExtError(400, e.message);
      }
      throw e;
    }
    const id = randomUUID();
    const secret = `whsec_${randomBytes(32).toString('base64url')}`;
    const { blob, wrappedKey } = seal(this.master, id, Buffer.from(secret, 'utf8'));
    return withTenant(this.pool, user.orgId, async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended('davrabox.webhooks:' || $1::text, 0))", [user.orgId]);
      const n = await c.query('SELECT count(*)::int AS n FROM webhook_endpoints');
      if ((n.rows[0].n as number) >= MAX_ENDPOINTS_PER_ORG) throw new ExtError(409, `at most ${MAX_ENDPOINTS_PER_ORG} webhook endpoints per organization`);
      try {
        const r = await c.query(
          `INSERT INTO webhook_endpoints (id, org_id, url, events, secret_blob, secret_wrapped_key, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, url, events, created_at`,
          [id, user.orgId, url.toString(), input.events, blob, wrappedKey, user.userId],
        );
        await audit(c, user, 'webhook.create', `${id} ${url.hostname}`);
        return { ...toEndpoint(r.rows[0] as EndpointRow), secret };
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw new ExtError(409, 'this URL is already registered');
        throw e;
      }
    });
  }

  list(user: AuthedUser): Promise<EndpointItem[]> {
    return withTenant(this.pool, user.orgId, async (c) => {
      const r = await c.query('SELECT id, url, events, created_at FROM webhook_endpoints ORDER BY created_at DESC, id DESC');
      return (r.rows as EndpointRow[]).map(toEndpoint);
    });
  }

  async remove(user: AuthedUser, id: string): Promise<void> {
    if (!UUID_RE.test(id)) throw new ExtError(404, 'webhook endpoint not found');
    await withTenant(this.pool, user.orgId, async (c) => {
      const r = await c.query('DELETE FROM webhook_endpoints WHERE id = $1 RETURNING url', [id]); // RLS: own organization only
      if (!r.rowCount) throw new ExtError(404, 'webhook endpoint not found');
      await audit(c, user, 'webhook.delete', `${id} ${new URL(r.rows[0].url as string).hostname}`);
    });
  }

  /** Delivery log of one endpoint, newest first; `status=dead` lists the dead letters. */
  async deliveries(user: AuthedUser, id: string, q: { status?: DeliveryItem['status']; limit: number; cursor?: string }) {
    if (!UUID_RE.test(id)) throw new ExtError(404, 'webhook endpoint not found');
    let cur: { ts: string; id: string } | null = null;
    if (q.cursor) {
      try {
        cur = decodeCursor(q.cursor);
      } catch (e) {
        if (e instanceof AdminError) throw new ExtError(400, 'invalid cursor');
        throw e;
      }
    }
    return withTenant(this.pool, user.orgId, async (c) => {
      const ep = await c.query('SELECT 1 FROM webhook_endpoints WHERE id = $1', [id]);
      if (!ep.rowCount) throw new ExtError(404, 'webhook endpoint not found');
      const r = await c.query(
        `SELECT id, event_id, event_type, status, attempts, last_status, last_error, next_attempt_at, created_at, delivered_at,
                to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts
           FROM webhook_deliveries
          WHERE endpoint_id = $1
            AND ($2::text IS NULL OR status = $2)
            AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::uuid))
          ORDER BY created_at DESC, id DESC
          LIMIT $5`,
        [id, q.status ?? null, cur?.ts ?? null, cur?.id ?? null, q.limit + 1],
      );
      const rows = r.rows as DeliveryRow[];
      const page = rows.slice(0, q.limit);
      const last = page[page.length - 1];
      return { items: page.map(toDelivery), next: rows.length > q.limit && last ? encodeCursor(last.cursor_ts, last.id) : null };
    });
  }

  /**
   * Queues the webhook event that corresponds to a signed media-server event. Returns false when the event is not
   * one we forward, the room is not one of our meetings, or the participant is not one of our users.
   */
  async ingestMediaEvent(ev: MediaEvent): Promise<boolean> {
    const type = MEDIA_EVENTS[ev.name];
    if (!type || !UUID_RE.test(ev.room)) return false;
    if (type !== 'meeting.ended' && !(ev.identity && UUID_RE.test(ev.identity))) return false; // e.g. the recording bot
    const m = await this.pool.query('SELECT org_id, code FROM webhook_meeting_lookup($1)', [ev.room]);
    if (!m.rows[0]) return false;
    const orgId = m.rows[0].org_id as string;
    const data: Record<string, unknown> = { meetingId: ev.room, meetingCode: m.rows[0].code as string, occurredAt: (ev.occurredAt ?? new Date()).toISOString() };
    if (type !== 'meeting.ended') data.participant = { identity: ev.identity, name: (ev.participantName ?? '').slice(0, 200) };
    const eventId = ev.id ? uuidFromString(`livekit:${ev.id}`) : randomUUID();
    await withTenant(this.pool, orgId, (c) => c.query('SELECT webhook_enqueue($1, $2, $3, $4::jsonb)', [orgId, eventId, type, JSON.stringify(data)]));
    return true;
  }
}
