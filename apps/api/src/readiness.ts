import type { Pool } from 'pg';
import type { RateLimitService } from './rate-limit/service.js';

export const READINESS = Symbol('READINESS');

export interface ReadinessResult {
  /** ok: everything answers. degraded: only Redis is down (rate limits fall back to memory, the API still serves). unavailable: HTTP 503. */
  status: 'ok' | 'degraded' | 'unavailable';
  postgres: boolean;
  livekit: boolean;
  /** Present only when REDIS_URL is configured. */
  redis?: boolean;
}

export interface ReadinessOptions {
  rate?: RateLimitService | null;
  fetch?: typeof fetch;
  pgTimeoutMs?: number;
  livekitTimeoutMs?: number;
  redisTimeoutMs?: number;
  /** The answer is reused for this long, so a probe storm (or a public caller) cannot hammer the dependencies. */
  cacheMs?: number;
}

function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new Error('timeout')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * What /readyz answers: can this instance do its job right now? Postgres (SELECT 1, 1 s), the media server's API
 * (any HTTP answer within a short timeout) and, when configured, Redis. The result carries one boolean per dependency and
 * nothing else: no hostnames, versions or error text.
 */
export class ReadinessService {
  private cached: { at: number; value: Promise<ReadinessResult> } | null = null;
  private readonly o: Required<Omit<ReadinessOptions, 'rate'>> & { rate: RateLimitService | null };

  constructor(private readonly pool: Pick<Pool, 'query'>, private readonly cfg: { livekitApiUrl: string }, opts: ReadinessOptions = {}) {
    this.o = {
      rate: opts.rate ?? null,
      fetch: opts.fetch ?? fetch,
      pgTimeoutMs: opts.pgTimeoutMs ?? 1000,
      livekitTimeoutMs: opts.livekitTimeoutMs ?? 1500,
      redisTimeoutMs: opts.redisTimeoutMs ?? 500,
      cacheMs: opts.cacheMs ?? 2000,
    };
  }

  check(): Promise<ReadinessResult> {
    const now = Date.now();
    if (this.o.cacheMs > 0 && this.cached && now - this.cached.at < this.o.cacheMs) return this.cached.value;
    const value = this.run();
    this.cached = { at: now, value };
    return value;
  }

  // At most one probe query is ever in flight: a hung database must not make probes pile up and drain the pool.
  private pgInflight: Promise<void> | null = null;

  private async postgres(): Promise<boolean> {
    try {
      this.pgInflight ??= Promise.resolve(this.pool.query('SELECT 1')).then(() => undefined).finally(() => {
        this.pgInflight = null;
      });
      await within(this.pgInflight, this.o.pgTimeoutMs);
      return true;
    } catch {
      return false;
    }
  }

  private async livekit(): Promise<boolean> {
    try {
      // The media server answers its root path; any HTTP response (even 401/404) proves it is up and reachable.
      const res = await this.o.fetch(this.cfg.livekitApiUrl, { method: 'GET', signal: AbortSignal.timeout(this.o.livekitTimeoutMs), redirect: 'manual' });
      void res.body?.cancel().catch(() => undefined);
      return true;
    } catch {
      return false;
    }
  }

  private async run(): Promise<ReadinessResult> {
    const [postgres, livekit, redis] = await Promise.all([this.postgres(), this.livekit(), this.o.rate ? this.o.rate.redisReachable(this.o.redisTimeoutMs) : Promise.resolve(null)]);
    const result: ReadinessResult = { status: postgres && livekit ? (redis === false ? 'degraded' : 'ok') : 'unavailable', postgres, livekit };
    if (redis !== null) result.redis = redis;
    return result;
  }
}
