import { isIP } from 'node:net';

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
 * THE client-address rule for every limiter (global ceiling, authentication failures, sign-up, join attempts).
 * The client address as seen by the nearest trusted proxy: the `hops`-th entry from the RIGHT of X-Forwarded-For
 * (entries on the left are client-supplied and can be forged). Falls back to the socket address when the header is
 * absent, shorter than expected or not an address. `hops` comes from SIGNUP_TRUSTED_PROXY_HOPS (Caddy alone = 1;
 * Cloudflare tunnel + Caddy = 2; 0 = no proxy, trust only the socket).
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
