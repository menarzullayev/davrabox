import { z } from 'zod';

const bool = z.enum(['0', '1', 'true', 'false']).transform((v) => v === '1' || v === 'true');

const schema = z.object({
  // Shared counters. Unset = in-memory limiters per API instance (fine for one instance; logged once as a warning).
  REDIS_URL: z.string().min(1).optional(),
  RATE_LIMIT_ENABLED: bool.default(true),
  // Global ceilings (requests per minute). An office behind one NAT shares one address, so the IP ceiling is generous.
  RATE_LIMIT_IP_PER_MINUTE: z.coerce.number().int().min(1).max(1_000_000).default(1200),
  RATE_LIMIT_USER_PER_MINUTE: z.coerce.number().int().min(1).max(1_000_000).default(300),
  // Failed authentications (bad/expired/forged tokens) tolerated per address in 5 minutes before it is blocked.
  RATE_LIMIT_AUTH_FAIL_MAX: z.coerce.number().int().min(1).max(100_000).default(60),
  RATE_LIMIT_REDIS_TIMEOUT_MS: z.coerce.number().int().min(20).max(5000).default(250),
  // After a Redis error, how long requests are served from memory before Redis is tried again.
  RATE_LIMIT_REDIS_RETRY_MS: z.coerce.number().int().min(100).max(300_000).default(5000),
  // Proxies in front of the API appending to X-Forwarded-For. Same variable and meaning as the sign-up module always had.
  SIGNUP_TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),
});

export type RateLimitConfig = z.infer<typeof schema>;

export function loadRateLimitConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): RateLimitConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid rate-limit configuration: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
  return parsed.data;
}
