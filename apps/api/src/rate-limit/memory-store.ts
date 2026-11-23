import type { RateLimitStore, WindowState } from './store.js';

interface Entry {
  count: number;
  resetAt: number;
}

export interface MemoryStoreOptions {
  now?: () => number;
  /** Upper bound on distinct live keys: a flood of distinct keys must not grow memory without limit. */
  maxKeys?: number;
}

/** Fixed-window counters in this process. Used on its own without REDIS_URL, and as the fallback during a Redis outage. */
export class MemoryStore implements RateLimitStore {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly maxKeys: number;

  constructor(opts: MemoryStoreOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.maxKeys = opts.maxKeys ?? 50_000;
  }

  size(): number {
    return this.entries.size;
  }

  async incr(key: string, windowMs: number): Promise<WindowState> {
    const t = this.now();
    const e = this.entries.get(key);
    if (e && t < e.resetAt) {
      e.count += 1;
      return { count: e.count, ttlMs: e.resetAt - t };
    }
    this.makeRoom(t);
    // Re-insert so Map order stays oldest-window-first (used for eviction).
    this.entries.delete(key);
    this.entries.set(key, { count: 1, resetAt: t + windowMs });
    return { count: 1, ttlMs: windowMs };
  }

  async peek(key: string): Promise<WindowState> {
    const e = this.entries.get(key);
    const t = this.now();
    if (!e || t >= e.resetAt) {
      if (e) this.entries.delete(key);
      return { count: 0, ttlMs: 0 };
    }
    return { count: e.count, ttlMs: e.resetAt - t };
  }

  async del(key: string): Promise<void> {
    this.entries.delete(key);
  }

  private makeRoom(t: number): void {
    if (this.entries.size < this.maxKeys) return;
    for (const [k, e] of this.entries) if (t >= e.resetAt) this.entries.delete(k);
    // Still full of live windows: drop the oldest ones (insertion order) so the newest keys keep being counted.
    for (const k of this.entries.keys()) {
      if (this.entries.size < this.maxKeys) break;
      this.entries.delete(k);
    }
  }
}
