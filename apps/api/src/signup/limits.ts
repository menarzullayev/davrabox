import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
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
  };
}

// Large public mailbox providers host many unrelated people: their per-hour domain limit is ten times higher.
const BIG_PROVIDERS = new Set([
  'gmail.com', 'googlemail.com', 'mail.ru', 'bk.ru', 'inbox.ru', 'list.ru', 'internet.ru', 'yandex.ru', 'yandex.com', 'ya.ru',
  'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com', 'proton.me', 'protonmail.com', 'rambler.ru', 'umail.uz',
]);
export const domainLimit = (domain: string, base: number): number => (BIG_PROVIDERS.has(domain) ? base * 10 : base);

interface ReqLike {
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
}

function clean(ip: string): string | null {
  const trimmed = ip.trim().slice(0, 100).replace(/^::ffff:/i, '');
  const zone = trimmed.indexOf('%');
  const v = zone === -1 ? trimmed : trimmed.slice(0, zone);
  return isIP(v) ? v : null;
}

/**
 * The client address as seen by the nearest trusted proxy: the `hops`-th entry from the RIGHT of X-Forwarded-For (entries
 * on the left are client-supplied and can be forged). Falls back to the socket address when the header is absent,
 * shorter than expected or not an address.
 */
export function clientIp(req: ReqLike, hops: number): string {
  const raw = req.headers['x-forwarded-for'];
  const header = Array.isArray(raw) ? raw.join(',') : raw ?? '';
  const parts = header.split(',').map((p) => p.trim()).filter(Boolean);
  if (hops >= 1 && parts.length >= hops) {
    const v = clean(parts[parts.length - hops]!);
    if (v) return v;
  }
  return clean(req.socket?.remoteAddress ?? '') ?? '0.0.0.0';
}

/** Rate-limit key of an address: IPv4 as is, IPv6 reduced to its /64 (one customer line owns a whole /64). */
export function ipKey(ip: string): string {
  if (isIP(ip) !== 6) return ip;
  const [head, tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const full = ip.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return full.slice(0, 4).map((x) => x.replace(/^0+(?=.)/, '').toLowerCase()).join(':') + '::/64';
}
