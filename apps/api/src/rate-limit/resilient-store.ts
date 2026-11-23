import type { FailureMode, RateLimitStore, WindowState } from './store.js';

export interface ResilientLog {
  warn(message: string): void;
  log(message: string): void;
}

export interface ResilientOptions {
  /** After an error the primary is not tried again for this long (requests are served from the fallback meanwhile). */
  retryMs?: number;
  now?: () => number;
  log: ResilientLog;
}

/**
 * Primary (Redis) with an in-memory fallback. It NEVER throws to the caller: an outage is logged once, requests are
 * counted in this process until the primary answers again, and recovery is logged once.
 */
export class ResilientStore implements RateLimitStore {
  private downUntil = 0;
  private degraded = false;
  private readonly retryMs: number;
  private readonly now: () => number;

  constructor(private readonly primary: RateLimitStore, private readonly fallback: RateLimitStore, private readonly opts: ResilientOptions) {
    this.retryMs = opts.retryMs ?? 5000;
    this.now = opts.now ?? Date.now;
  }

  get isDegraded(): boolean {
    return this.degraded;
  }

  private async run<T>(op: (s: RateLimitStore) => Promise<T>, failure: FailureMode, open: T): Promise<T> {
    if (this.now() >= this.downUntil) {
      try {
        const r = await op(this.primary);
        if (this.degraded) {
          this.degraded = false;
          this.opts.log.log('rate limiter: shared store recovered, counters are shared again');
        }
        return r;
      } catch (e) {
        this.downUntil = this.now() + this.retryMs;
        if (!this.degraded) {
          this.degraded = true;
          this.opts.log.warn(`rate limiter: shared store unavailable (${(e as Error).message}); counting in memory per instance until it answers again`);
        }
      }
    }
    if (failure === 'open') return open;
    try {
      return await op(this.fallback);
    } catch {
      return open; // the in-memory store cannot fail in practice; never turn a limiter problem into an error
    }
  }

  incr(key: string, windowMs: number, failure: FailureMode = 'memory'): Promise<WindowState> {
    return this.run((s) => s.incr(key, windowMs), failure, { count: 0, ttlMs: 0 });
  }

  peek(key: string, failure: FailureMode = 'memory'): Promise<WindowState> {
    return this.run((s) => s.peek(key), failure, { count: 0, ttlMs: 0 });
  }

  async del(key: string): Promise<void> {
    // Clear both: the counter may live in either place depending on when the outage happened.
    await this.fallback.del(key).catch(() => undefined);
    if (this.now() >= this.downUntil) {
      await this.primary.del(key).catch(() => {
        this.downUntil = this.now() + this.retryMs;
      });
    }
  }
}
