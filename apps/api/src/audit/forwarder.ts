import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { signBody } from './signature.js';

export interface ForwardEvent {
  id: string;
  orgSlug: string;
  at: string;
  actorEmail: string | null;
  action: string;
  target: string | null;
  hash: string;
}

export interface ForwarderOptions {
  url: string;
  secret: string;
  intervalMs?: number;
  batchSize?: number; // max 500
  maxBackoffMs?: number;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
}

interface Batch {
  deliveryId: string;
  events: ForwardEvent[];
  txid: string;
  id: string;
}

const FORWARD_LOCK_KEY = 7_203_994_211; // session advisory lock: one forwarder at a time across API replicas

/**
 * Ships new audit rows of ALL organizations to a SIEM webhook, at least once and in order.
 * Position is persisted in audit_forward_state (advanced only after a 2xx answer), so a crash or a failing endpoint
 * re-sends the same batch instead of losing it. Receivers should de-duplicate on event id.
 */
export class AuditForwarder {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = true;
  private failures = 0;
  private pending: Batch | null = null;
  private readonly opts: Required<Omit<ForwarderOptions, 'fetchImpl' | 'log'>> & { fetchImpl: typeof fetch; log: (m: string) => void };

  constructor(private readonly pool: Pool, o: ForwarderOptions) {
    this.opts = {
      intervalMs: 5000,
      batchSize: 500,
      maxBackoffMs: 300_000,
      requestTimeoutMs: 10_000,
      fetchImpl: fetch,
      log: (m) => console.warn(m),
      ...o,
    };
    this.opts.batchSize = Math.max(1, Math.min(500, this.opts.batchSize));
  }

  /** Delay before the next attempt after `failures` consecutive failures: interval * 2^(n-1), capped. */
  static backoff(failures: number, intervalMs: number, capMs: number): number {
    if (failures <= 0) return intervalMs;
    return Math.min(capMs, intervalMs * 2 ** Math.min(failures - 1, 30));
  }

  /** Non-blocking: schedules the first run and returns immediately. Never throws. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  onModuleDestroy(): void {
    this.stop();
  }

  get consecutiveFailures(): number {
    return this.failures;
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.loop(), ms);
    this.timer.unref?.();
  }

  private async loop(): Promise<void> {
    let next = this.opts.intervalMs;
    try {
      const sent = await this.tick();
      next = sent >= this.opts.batchSize ? 0 : this.opts.intervalMs; // more probably waiting: do not idle
    } catch (e) {
      next = AuditForwarder.backoff(this.failures, this.opts.intervalMs, this.opts.maxBackoffMs);
      this.opts.log(`audit forwarder: ${(e as Error).message}; retry in ${Math.round(next / 1000)}s`);
    }
    this.schedule(next);
  }

  /**
   * One forwarding round: delivers at most one batch. Returns the number of events delivered (0 = nothing to do or
   * another instance holds the lock). Throws when delivery or the database fails; the failure counter then grows.
   */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let client: PoolClient | null = null;
    let locked = false;
    try {
      client = await this.pool.connect();
      const lock = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [FORWARD_LOCK_KEY]);
      locked = lock.rows[0]!.ok;
      if (!locked) return 0;
      let batch = this.pending;
      if (!batch) {
        const st = await client.query<{ last_txid: string; last_id: string }>('SELECT last_txid, last_id FROM audit_forward_state_get()');
        const s = st.rows[0]!;
        const rows = await client.query<{ id: string; txid: string; org_slug: string; created_at: Date; actor_email: string | null; action: string; target: string | null; row_hash: string }>(
          'SELECT id, txid, org_slug, created_at, actor_email, action, target, row_hash FROM audit_forward_batch($1, $2, $3)',
          [s.last_txid, s.last_id, this.opts.batchSize],
        );
        if (rows.rows.length === 0) return 0;
        const last = rows.rows[rows.rows.length - 1]!;
        batch = {
          deliveryId: randomUUID(),
          txid: last.txid,
          id: last.id,
          events: rows.rows.map((r) => ({
            id: r.id,
            orgSlug: r.org_slug,
            at: r.created_at.toISOString(),
            actorEmail: r.actor_email,
            action: r.action,
            target: r.target,
            hash: r.row_hash,
          })),
        };
        this.pending = batch;
      }
      await this.deliver(batch);
      await client.query('SELECT audit_forward_state_advance($1, $2)', [batch.txid, batch.id]);
      this.pending = null;
      this.failures = 0;
      return batch.events.length;
    } catch (e) {
      this.failures += 1;
      throw e;
    } finally {
      if (client) {
        if (locked) await client.query('SELECT pg_advisory_unlock($1)', [FORWARD_LOCK_KEY]).catch(() => undefined);
        client.release();
      }
      this.running = false;
    }
  }

  private async deliver(batch: Batch): Promise<void> {
    const body = JSON.stringify({ events: batch.events });
    const res = await this.opts.fetchImpl(this.opts.url, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        'X-DavraBox-Signature': signBody(body, this.opts.secret),
        'X-DavraBox-Delivery': batch.deliveryId,
      },
      body,
      signal: AbortSignal.timeout(this.opts.requestTimeoutMs),
    });
    await res.arrayBuffer().catch(() => undefined);
    if (res.status < 200 || res.status >= 300) throw new Error(`webhook answered HTTP ${res.status}`);
  }
}
