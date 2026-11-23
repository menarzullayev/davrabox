import type { Pool } from 'pg';
import { open } from '../files/crypto.js';
import type { Poster } from './http-poster.js';
import { UrlRejectedError, defaultResolver, resolvePublicHttpsUrl, type Resolver } from './url-guard.js';
import { MAX_ATTEMPTS, backoffSeconds, signPayload } from './webhook-signature.js';

export interface DeliveryJobOptions {
  /** Without the master key a worker cannot decrypt signing secrets, so it claims nothing. */
  master: Buffer | null;
  poster: Poster;
  resolver?: Resolver;
  timeoutMs: number;
  /** Poll interval for the built-in timer (Nest lifecycle). 0 or unset = the timer is off and tick() is called by hand. */
  intervalMs?: number;
  now?: () => number; // epoch milliseconds
  random?: () => number;
}

interface Claimed {
  id: string;
  org_id: string;
  endpoint_id: string;
  event_id: string;
  event_type: string;
  body: string;
  attempts: number;
  url: string;
  secret_blob: Buffer;
  secret_wrapped_key: string;
}

type Outcome = { outcome: 'delivered' | 'retry' | 'dead'; status: number | null; error: string | null };

const CONCURRENCY = 5;
const PRUNE_EVERY_MS = 3_600_000;

/**
 * Delivery worker. Pending deliveries live in the database (an outbox), so they survive a restart; claiming leases a
 * row (FOR UPDATE SKIP LOCKED in webhook_claim_due) so several API instances can run it without sending twice. Each
 * attempt re-validates the target, signs the stored body with the endpoint secret and posts it without following
 * redirects. 2xx = delivered; anything else retries with exponential backoff until MAX_ATTEMPTS, then the row is
 * marked dead and stays visible in the admin API.
 */
export class WebhookDeliveryJob {
  private readonly resolver: Resolver;
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private lastPrune = 0;

  constructor(private readonly pool: Pool, private readonly opts: DeliveryJobOptions) {
    this.resolver = opts.resolver ?? defaultResolver;
  }

  /** Claims up to `limit` due deliveries and attempts them. Returns how many were attempted. */
  async tick(limit = 20): Promise<number> {
    if (!this.opts.master) return 0;
    const lease = Math.max(120, Math.ceil((this.opts.timeoutMs * 6) / 1000));
    const claimed = await this.pool.query('SELECT * FROM webhook_claim_due($1, $2)', [limit, lease]);
    const rows = claimed.rows as Claimed[];
    for (let i = 0; i < rows.length; i += CONCURRENCY) {
      await Promise.all(rows.slice(i, i + CONCURRENCY).map((r) => this.deliver(r)));
    }
    return rows.length;
  }

  private async deliver(row: Claimed): Promise<void> {
    let result: Outcome;
    try {
      result = await this.attempt(row);
    } catch {
      result = this.failed(row, null, 'delivery error'); // never let one bad row stop the batch
    }
    const retryIn = result.outcome === 'retry' ? backoffSeconds(row.attempts, this.opts.random) : 0;
    await this.pool.query('SELECT webhook_record_result($1, $2, $3, $4, $5)', [row.id, result.outcome, result.status, result.error, retryIn]);
  }

  private failed(row: Claimed, status: number | null, error: string): Outcome {
    return { outcome: row.attempts >= MAX_ATTEMPTS ? 'dead' : 'retry', status, error };
  }

  private async attempt(row: Claimed): Promise<Outcome> {
    let secret: string;
    try {
      secret = open(this.opts.master!, row.endpoint_id, row.secret_blob, row.secret_wrapped_key).toString('utf8');
    } catch {
      return { outcome: 'dead', status: null, error: 'signing secret unavailable' };
    }

    // The target is vetted again now: DNS may have changed since registration (rebinding).
    let vetted;
    try {
      vetted = await resolvePublicHttpsUrl(row.url, this.resolver);
    } catch (e) {
      if (e instanceof UrlRejectedError) {
        if (e.code === 'resolve') return this.failed(row, null, e.message); // possibly temporary: retry
        return { outcome: 'dead', status: null, error: `blocked: ${e.message}` }; // policy violation: never send
      }
      throw e;
    }

    const unix = Math.floor((this.opts.now ?? Date.now)() / 1000);
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'DavraBox-Webhooks/1',
      'X-Davra-Event': row.event_type,
      'X-Davra-Event-Id': row.event_id,
      'X-Davra-Delivery': row.id,
      'X-Davra-Signature': signPayload(secret, row.body, unix),
    };
    let lastErr = 'delivery error';
    for (const address of vetted.addresses.slice(0, 3)) {
      try {
        const res = await this.opts.poster({ url: vetted.url, address, body: row.body, headers, timeoutMs: this.opts.timeoutMs });
        if (res.status >= 200 && res.status < 300) return { outcome: 'delivered', status: res.status, error: null };
        return this.failed(row, res.status, `HTTP ${res.status}`); // includes 3xx: redirects are never followed
      } catch (e) {
        lastErr = e instanceof Error ? e.message.slice(0, 200) : 'delivery error'; // connection-level failure: try the next address
      }
    }
    return this.failed(row, null, lastErr);
  }

  // --- lifecycle -----------------------------------------------------------------------------------------------------

  start(intervalMs: number): void {
    if (!this.stopped || intervalMs <= 0 || !this.opts.master) return;
    this.stopped = false;
    const loop = async () => {
      try {
        await this.tick();
        if (Date.now() - this.lastPrune > PRUNE_EVERY_MS) {
          this.lastPrune = Date.now();
          await this.pool.query('SELECT ext_api_prune()');
        }
      } catch (e) {
        console.error('webhook delivery tick failed:', e instanceof Error ? e.message : 'unknown error'); // no payloads, no secrets
      }
      if (!this.stopped) {
        this.timer = setTimeout(loop, intervalMs);
        this.timer.unref();
      }
    };
    this.timer = setTimeout(loop, intervalMs);
    this.timer.unref();
  }

  onModuleInit(): void {
    this.start(this.opts.intervalMs ?? 0);
  }

  onModuleDestroy(): void {
    this.stop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
