import type { FailureMode, RateLimitStore } from './store.js';

export interface LimiterOptions {
  /** Namespace of the counters (two limiters with different names never share a key). */
  name: string;
  /** Hits allowed inside one window. */
  max: number;
  windowMs: number;
  /** What to do while the shared store is down. See FailureMode. Default 'memory'. */
  failure?: FailureMode;
}

export interface Decision {
  allowed: boolean;
  count: number;
  remaining: number;
  /** Whole seconds until the window ends (at least 1): the value for a Retry-After header. */
  retryAfterSec: number;
}

const retrySeconds = (ttlMs: number): number => Math.max(1, Math.ceil(ttlMs / 1000));

/**
 * A named fixed-window limiter over a shared store. The API mirrors the old in-process FailureLimiter
 * (isBlocked / recordFailure / reset) and adds hit(), which counts and decides in one atomic step.
 */
export class RateLimiter {
  constructor(private readonly store: RateLimitStore, private readonly o: LimiterOptions) {}

  private k(key: string): string {
    return `${this.o.name}:${key}`;
  }

  /** Counts one hit and says whether it is within the limit. */
  async hit(key: string): Promise<Decision> {
    const s = await this.store.incr(this.k(key), this.o.windowMs, this.o.failure ?? 'memory');
    return { allowed: s.count <= this.o.max, count: s.count, remaining: Math.max(0, this.o.max - s.count), retryAfterSec: retrySeconds(s.ttlMs || this.o.windowMs) };
  }

  /** Where the key stands, without counting a hit. */
  async check(key: string): Promise<Decision> {
    const s = await this.store.peek(this.k(key), this.o.failure ?? 'memory');
    return { allowed: s.count < this.o.max, count: s.count, remaining: Math.max(0, this.o.max - s.count), retryAfterSec: retrySeconds(s.ttlMs) };
  }

  /** True once `max` failures were recorded in the window. */
  async isBlocked(key: string): Promise<boolean> {
    return !(await this.check(key)).allowed;
  }

  async recordFailure(key: string): Promise<void> {
    await this.store.incr(this.k(key), this.o.windowMs, this.o.failure ?? 'memory');
  }

  async reset(key: string): Promise<void> {
    await this.store.del(this.k(key));
  }
}
