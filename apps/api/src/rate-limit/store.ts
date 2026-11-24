/** State of one fixed window: how many hits it holds and how long until it ends. `count` 0 means no window is open. */
export interface WindowState {
  count: number;
  ttlMs: number;
}

/**
 * What a limiter does when the shared store (Redis) is unreachable:
 *  - 'memory': keep counting in this process (the limit still holds per instance; never unlimited). Default; used for
 *    everything that guards credentials, passcodes, uploads and sign-up.
 *  - 'open': let the request through without counting. Only for coarse capacity ceilings where a stricter answer
 *    would turn a Redis problem into an API outage.
 */
export type FailureMode = 'memory' | 'open';

/** Fixed-window counters. Implementations: MemoryStore (one process), RedisStore (shared), ResilientStore (both). */
export interface RateLimitStore {
  /** Atomically adds one hit. The first hit opens a window of `windowMs`. */
  incr(key: string, windowMs: number, failure?: FailureMode): Promise<WindowState>;
  /** Reads the window without counting. */
  peek(key: string, failure?: FailureMode): Promise<WindowState>;
  del(key: string): Promise<void>;
}
