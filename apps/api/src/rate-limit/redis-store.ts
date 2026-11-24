import { Redis } from 'ioredis';
import type { RateLimitStore, WindowState } from './store.js';

// One round trip, atomic: INCR, open the window on the first hit, return the count and the time left.
const INCR_SCRIPT = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local t = redis.call('PTTL', KEYS[1])
if t < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); t = tonumber(ARGV[1]) end
return {c, t}
`;

export interface RedisStoreOptions {
  /** Every key is prefixed so the limiter can share a Redis with other software (LiveKit uses the same instance in prod). */
  prefix?: string;
  commandTimeoutMs?: number;
  connectTimeoutMs?: number;
}

/**
 * Fixed-window counters in Redis, shared by every API instance. The client never queues commands while disconnected and
 * fails fast, so callers (ResilientStore) can degrade immediately instead of waiting.
 */
export class RedisStore implements RateLimitStore {
  readonly client: Redis;
  private readonly prefix: string;

  constructor(url: string, opts: RedisStoreOptions = {}) {
    this.prefix = opts.prefix ?? 'davra:rl:';
    this.client = new Redis(url, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      commandTimeout: opts.commandTimeoutMs ?? 250,
      connectTimeout: opts.connectTimeoutMs ?? 1000,
      retryStrategy: (n) => Math.min(n * 200, 2000),
    });
    // Errors surface through failed commands; a bare 'error' event would otherwise be an unhandled exception.
    this.client.on('error', () => undefined);
  }

  /** Initial connection; resolves false (never throws) when Redis cannot be reached in time. */
  async connect(): Promise<boolean> {
    try {
      await this.client.connect();
      return true;
    } catch {
      return false;
    }
  }

  async ping(timeoutMs: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const r = await Promise.race([
        this.client.ping(),
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(new Error('timeout')), timeoutMs);
        }),
      ]);
      return r === 'PONG';
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async incr(key: string, windowMs: number): Promise<WindowState> {
    const r = (await this.client.eval(INCR_SCRIPT, 1, this.prefix + key, String(windowMs))) as [number, number];
    return { count: Number(r[0]), ttlMs: Math.max(0, Number(r[1])) };
  }

  async peek(key: string): Promise<WindowState> {
    const res = await this.client.multi().get(this.prefix + key).pttl(this.prefix + key).exec();
    if (!res) throw new Error('redis transaction aborted');
    const [[e1, v], [e2, ttl]] = res as [[Error | null, string | null], [Error | null, number]];
    if (e1) throw e1;
    if (e2) throw e2;
    if (v === null || ttl < 0) return { count: 0, ttlMs: 0 };
    return { count: Number(v), ttlMs: ttl };
  }

  async del(key: string): Promise<void> {
    await this.client.del(this.prefix + key);
  }

  async close(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }
}
