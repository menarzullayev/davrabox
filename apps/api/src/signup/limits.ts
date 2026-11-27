import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { DEFAULT_MAX_NUMBER } from './altcha.js';

/** The trial every self-serve organization gets (user decision, spec section 2). */
export const TRIAL = { days: 7, participants: 10, minutes: 30 } as const;
/** An organization is deleted this long after its trial ended (spec section 7). */
export const TRIAL_GRACE_DAYS = 30;


const envSchema = z.object({
  SIGNUP_ENABLED: z.enum(['0', '1', 'true', 'false']).default('true').transform((v) => v === '1' || v === 'true'),
  // Dedicated secret for the ALTCHA HMAC; when unset a key is derived from the LiveKit API secret (same trust level).
  SIGNUP_CAPTCHA_SECRET: z.string().min(32).optional(),
  SIGNUP_DAILY_CAP: z.coerce.number().int().min(0).max(100_000).default(50),
  SIGNUP_IP_PER_HOUR: z.coerce.number().int().min(1).max(10_000).default(5),
  SIGNUP_DOMAIN_PER_HOUR: z.coerce.number().int().min(1).max(100_000).default(20),
  // How many proxies in front of the API append to X-Forwarded-For (Caddy alone = 1; Cloudflare tunnel + Caddy = 2).
  SIGNUP_TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),
  SIGNUP_BLOCKED_DOMAINS: z.string().default(''),
  SIGNUP_MAX_CONCURRENT: z.coerce.number().int().min(1).max(20).default(3),
  SIGNUP_ALTCHA_MAX_NUMBER: z.coerce.number().int().min(1000).max(5_000_000).default(DEFAULT_MAX_NUMBER),
  // The application's public origins (the same list the API allows for CORS): links in emails land only on one of them.
  CORS_ORIGINS: z.string().default(''),
});

export interface SignupSettings {
  enabled: boolean;
  captchaSecret: string;
  ipHashKey: string;
  dailyCap: number;
  ipPerHour: number;
  domainPerHour: number;
  trustedProxyHops: number;
  blockedDomains: string[];
  maxConcurrent: number;
  maxNumber: number;
  appOrigins: string[];
}

export function loadSignupSettings(env: NodeJS.ProcessEnv, fallbackSecret: string): SignupSettings {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid sign-up configuration: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
  const c = parsed.data;
  const base = c.SIGNUP_CAPTCHA_SECRET ?? createHmac('sha256', fallbackSecret).update('davrabox.signup.altcha.v1').digest('hex');
  return {
    enabled: c.SIGNUP_ENABLED,
    captchaSecret: base,
    ipHashKey: createHmac('sha256', base).update('davrabox.signup.iphash.v1').digest('hex'),
    dailyCap: c.SIGNUP_DAILY_CAP,
    ipPerHour: c.SIGNUP_IP_PER_HOUR,
    domainPerHour: c.SIGNUP_DOMAIN_PER_HOUR,
    trustedProxyHops: c.SIGNUP_TRUSTED_PROXY_HOPS,
    blockedDomains: c.SIGNUP_BLOCKED_DOMAINS.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean),
    maxConcurrent: c.SIGNUP_MAX_CONCURRENT,
    maxNumber: c.SIGNUP_ALTCHA_MAX_NUMBER,
    appOrigins: c.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean),
  };
}

// Large public mailbox providers host many unrelated people: their per-hour domain limit is ten times higher.
const BIG_PROVIDERS = new Set([
  'gmail.com', 'googlemail.com', 'mail.ru', 'bk.ru', 'inbox.ru', 'list.ru', 'internet.ru', 'yandex.ru', 'yandex.com', 'ya.ru',
  'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com', 'proton.me', 'protonmail.com', 'rambler.ru', 'umail.uz',
]);
export const domainLimit = (domain: string, base: number): number => (BIG_PROVIDERS.has(domain) ? base * 10 : base);

// One client-address rule for every limiter lives in rate-limit/client-ip.ts (same behaviour as before, now shared).
export { clientIp, ipKey } from '../rate-limit/client-ip.js';
