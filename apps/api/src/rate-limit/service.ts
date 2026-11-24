import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { clientIp, ipKey } from './client-ip.js';
import { loadRateLimitConfig, type RateLimitConfig } from './config.js';
import { RateLimiter, type LimiterOptions } from './limiter.js';
import { MemoryStore } from './memory-store.js';
import { RedisStore } from './redis-store.js';
import { ResilientStore, type ResilientLog } from './resilient-store.js';
import type { RateLimitStore } from './store.js';

export interface RateLimitDeps {
  log?: ResilientLog;
  now?: () => number;
}

const nestLog = (): ResilientLog => {
  const l = new Logger('RateLimit');
  return { warn: (m) => l.warn(m), log: (m) => l.log(m) };
};

/**
 * One place for every limiter in the API.
 *
 * Failure classes (decided here, documented in docs/security-testing.md and docs/api.md):
 *  - login-adjacent and sign-up (failed authentications, join/passcode attempts, uploads, sign-up requests): when Redis
 *    is down they are counted in memory per instance. They are never unlimited.
 *  - the global per-IP ceiling: same, in memory.
 *  - the global per-user ceiling: fails OPEN (a user is already authenticated and individually accountable; a Redis
 *    problem must not make the whole API refuse requests).
 */
@Injectable()
export class RateLimitService implements OnApplicationShutdown {
  readonly authFailures: RateLimiter;
  readonly ipCeiling: RateLimiter;
  readonly userCeiling: RateLimiter;

  private constructor(
    readonly cfg: RateLimitConfig,
    private readonly store: RateLimitStore,
    private readonly redis: RedisStore | null,
  ) {
    this.authFailures = this.limiter({ name: 'authfail', max: cfg.RATE_LIMIT_AUTH_FAIL_MAX, windowMs: 5 * 60_000 });
    this.ipCeiling = this.limiter({ name: 'ip', max: cfg.RATE_LIMIT_IP_PER_MINUTE, windowMs: 60_000 });
    this.userCeiling = this.limiter({ name: 'user', max: cfg.RATE_LIMIT_USER_PER_MINUTE, windowMs: 60_000, failure: 'open' });
  }

  /** 'redis' when REDIS_URL is set (counters are shared by all instances), otherwise 'memory'. */
  get mode(): 'redis' | 'memory' {
    return this.redis ? 'redis' : 'memory';
  }

  /** True while Redis is configured but unreachable and requests are counted in memory instead. */
  get degraded(): boolean {
    return this.store instanceof ResilientStore && this.store.isDegraded;
  }

  /** In-process limiters only (tests, and the default of services constructed without an injected service). */
  static memory(opts: RateLimitDeps & { cfg?: Partial<RateLimitConfig> } = {}): RateLimitService {
    const cfg = { ...loadRateLimitConfig({}), ...opts.cfg };
    return new RateLimitService(cfg, new MemoryStore({ now: opts.now }), null);
  }

  /** Production entry: Redis when REDIS_URL is set (with in-memory degradation), otherwise memory with one warning. */
  static async create(cfg: RateLimitConfig = loadRateLimitConfig(), deps: RateLimitDeps = {}): Promise<RateLimitService> {
    const log = deps.log ?? nestLog();
    const memory = new MemoryStore({ now: deps.now });
    if (!cfg.REDIS_URL) {
      log.warn('REDIS_URL is not set: rate limits are counted in memory per API instance and are NOT shared between instances (fine for a single instance)');
      return new RateLimitService(cfg, memory, null);
    }
    const redis = new RedisStore(cfg.REDIS_URL, { commandTimeoutMs: cfg.RATE_LIMIT_REDIS_TIMEOUT_MS });
    await redis.connect(); // false is fine: the resilient store serves from memory until Redis answers
    const store = new ResilientStore(redis, memory, { retryMs: cfg.RATE_LIMIT_REDIS_RETRY_MS, now: deps.now, log });
    return new RateLimitService(cfg, store, redis);
  }

  limiter(opts: LimiterOptions): RateLimiter {
    return new RateLimiter(this.store, opts);
  }

  /** The caller's address by the single trusted-proxy rule (see client-ip.ts). */
  clientIp(req: { headers: Record<string, string | string[] | undefined>; socket?: { remoteAddress?: string } }): string {
    return clientIp(req, this.cfg.SIGNUP_TRUSTED_PROXY_HOPS);
  }

  /** Rate-limit key of the caller's address (IPv6 reduced to /64). */
  clientKey(req: { headers: Record<string, string | string[] | undefined>; socket?: { remoteAddress?: string } }): string {
    return ipKey(this.clientIp(req));
  }

  /** null when Redis is not configured, otherwise whether it answered a PING within `timeoutMs`. */
  async redisReachable(timeoutMs: number): Promise<boolean | null> {
    if (!this.redis) return null;
    return this.redis.ping(timeoutMs);
  }

  async close(): Promise<void> {
    await this.redis?.close();
  }

  onApplicationShutdown(): Promise<void> {
    return this.close();
  }
}
