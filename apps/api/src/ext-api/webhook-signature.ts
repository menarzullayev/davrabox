import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Webhook signature, as documented in docs/api.md:
 *   X-Davra-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, t + "." + body)>
 * The receiver recomputes the HMAC over the exact bytes it received and rejects a timestamp more than 5 minutes
 * away from its own clock (replay protection). Several v1 values may be present while a secret is being rotated.
 */
export const SIGNATURE_TOLERANCE_SECONDS = 300;
export const MAX_ATTEMPTS = 8;

export function signPayload(secret: string, body: string, unixSeconds: number): string {
  const mac = createHmac('sha256', secret).update(`${unixSeconds}.${body}`, 'utf8').digest('hex');
  return `t=${unixSeconds},v1=${mac}`;
}

export function verifySignature(secret: string, header: string, body: string, opts: { now?: number; toleranceSeconds?: number } = {}): boolean {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const tolerance = opts.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS;
  let t: number | null = null;
  const candidates: string[] = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't' && /^[0-9]{1,12}$/.test(v)) t = Number(v);
    else if (k === 'v1' && /^[0-9a-f]{64}$/.test(v)) candidates.push(v);
  }
  if (t === null || candidates.length === 0) return false;
  if (Math.abs(now - t) > tolerance) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${body}`, 'utf8').digest();
  let ok = false;
  for (const c of candidates) {
    if (timingSafeEqual(expected, Buffer.from(c, 'hex'))) ok = true; // no early exit: every candidate is compared
  }
  return ok;
}

const BACKOFF_BASE_SECONDS = 30;
const BACKOFF_CAP_SECONDS = 6 * 3600;

/** Delay before the next attempt after `attempt` failed attempts: 30 s doubling, capped at 6 h, +-25 % jitter. */
export function backoffSeconds(attempt: number, random: () => number = Math.random): number {
  const exp = Math.min(Math.max(attempt - 1, 0), 20);
  const delay = Math.min(BACKOFF_BASE_SECONDS * 2 ** exp, BACKOFF_CAP_SECONDS);
  return Math.ceil(delay * (0.75 + random() * 0.5));
}
