import { createServer, type Server } from 'node:http';
import { collectDefaultMetrics, Counter, Gauge, Histogram, register } from 'prom-client';

collectDefaultMetrics({ prefix: 'davra_' });

export const meetingsCreated = new Counter({ name: 'davra_meetings_created_total', help: 'Meetings created' });
export const joinResults = new Counter({
  name: 'davra_meeting_join_total',
  help: 'Meeting join attempts by outcome',
  labelNames: ['outcome'] as const,
});

export const httpRequestDuration = new Histogram({
  name: 'davra_http_request_duration_seconds',
  help: 'HTTP request duration by route template, method and status code',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 1.5, 2.5, 5, 10],
});

/** Sign-up outcomes. `reason` is a stable code from the sign-up service (bounded set), never user input. */
export const signupSuccess = new Counter({ name: 'davra_signup_success_total', help: 'Trial sign-ups completed' });
export const signupRefusals = new Counter({
  name: 'davra_signup_refusals_total',
  help: 'Trial sign-ups refused, by reason code',
  labelNames: ['reason'] as const,
});

/** Outbound customer webhooks: delivered, retry (will be tried again) or dead (given up). */
export const webhookDeliveries = new Counter({
  name: 'davra_webhook_deliveries_total',
  help: 'Webhook delivery attempts by outcome',
  labelNames: ['outcome'] as const,
});

// --- database pool ---------------------------------------------------------------------------------------------------
export interface PoolStats {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
  options: { max?: number };
}
let poolSource: PoolStats | null = null;
new Gauge({
  name: 'davra_db_pool_connections',
  help: 'Database pool connections by state (total, idle, waiting)',
  labelNames: ['state'] as const,
  collect() {
    if (!poolSource) return;
    this.set({ state: 'total' }, poolSource.totalCount);
    this.set({ state: 'idle' }, poolSource.idleCount);
    this.set({ state: 'waiting' }, poolSource.waitingCount);
  },
});
new Gauge({
  name: 'davra_db_pool_max_connections',
  help: 'Configured maximum size of the database pool',
  collect() {
    if (poolSource) this.set(poolSource.options.max ?? 10);
  },
});
export function registerPoolMetrics(pool: PoolStats): void {
  poolSource = pool;
}

// --- meetings in progress (from the media server) ----------------------------------------------------------------------
export interface RoomLister {
  listRooms(): Promise<Array<{ numParticipants: number }>>;
}
let roomSource: { client: RoomLister; ttlMs: number } | null = null;
let roomCache: { at: number; rooms: number; participants: number } | null = null;
const roomGauges = {
  rooms: new Gauge({
    name: 'davra_active_rooms',
    help: 'Rooms currently open on the media server',
    async collect() {
      const v = await readRooms();
      if (v) this.set(v.rooms);
    },
  }),
  participants: new Gauge({
    name: 'davra_active_participants',
    help: 'Participants currently connected to the media server',
    async collect() {
      const v = await readRooms();
      if (v) this.set(v.participants);
    },
  }),
};
void roomGauges;
let roomInflight: Promise<{ rooms: number; participants: number } | null> | null = null;
function readRooms(): Promise<{ rooms: number; participants: number } | null> {
  if (!roomSource) return Promise.resolve(null);
  if (roomCache && Date.now() - roomCache.at < roomSource.ttlMs) return Promise.resolve(roomCache);
  const src = roomSource;
  roomInflight ??= (async () => {
    try {
      const rooms = await Promise.race([
        src.client.listRooms(),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 2000).unref()),
      ]);
      roomCache = { at: Date.now(), rooms: rooms.length, participants: rooms.reduce((n, r) => n + r.numParticipants, 0) };
    } catch {
      /* keep the last value; a media-server outage is alerted on by its own probe */
    } finally {
      roomInflight = null;
    }
    return roomCache;
  })();
  return roomInflight;
}
/** The room list is cached for `ttlMs` so that several scrapers or a slow media server cannot add load. */
export function registerRoomMetrics(client: RoomLister, ttlMs = 10_000): void {
  roomSource = { client, ttlMs };
  roomCache = null;
  roomInflight = null;
}

/**
 * Metrics are served on a separate internal port, never on the public API port, so the edge proxy
 * cannot expose them by accident. Bind address and port come from configuration.
 */
export function startMetricsServer(port: number, host: string): Server {
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/metrics') {
      res.writeHead(200, { 'Content-Type': register.contentType });
      res.end(await register.metrics());
    } else {
      res.writeHead(404).end();
    }
  });
  server.listen(port, host);
  return server;
}
