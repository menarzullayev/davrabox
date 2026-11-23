import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

// ALTCHA proof of work, protocol v1 (SHA-256), implemented on node:crypto with no dependency:
//   challenge  = hex(SHA-256(salt + number))     number is secret, 0..maxnumber
//   signature  = hex(HMAC-SHA-256(secret, challenge))
//   salt       = <24 hex chars>?expires=<unix seconds>
// The client brute-forces `number`, then sends base64(JSON {algorithm, challenge, number, salt, signature}).
// The server checks the HMAC (it issued this challenge), recomputes the hash (the number is right, so the salt and its
// expiry were not altered) and the expiry. Single use is enforced by the caller (table altcha_used, see SignupService).
// Reference: the ALTCHA documentation and altcha-lib v1 (challenge = hash(salt + number), signature = HMAC(challenge)).

export const CHALLENGE_TTL_SECONDS = 300;
/** Upper bound of the secret number: about 125k SHA-256 evaluations on average, 1-3 s in a browser worker. */
export const DEFAULT_MAX_NUMBER = 250_000;
const HARD_MAX_NUMBER = 5_000_000;
const MAX_PAYLOAD_CHARS = 2000;
const HEX64 = /^[0-9a-f]{64}$/;

export interface AltchaChallenge {
  algorithm: 'SHA-256';
  challenge: string;
  salt: string;
  signature: string;
  maxnumber: number;
}

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');
const hmacHex = (secret: string, msg: string) => createHmac('sha256', secret).update(msg).digest('hex');

function equalHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

export function createChallenge(secret: string, now: number = Date.now(), maxnumber: number = DEFAULT_MAX_NUMBER): AltchaChallenge {
  if (!secret) throw new Error('ALTCHA secret is empty');
  const salt = `${randomBytes(12).toString('hex')}?expires=${Math.floor(now / 1000) + CHALLENGE_TTL_SECONDS}`;
  const number = randomInt(0, maxnumber + 1);
  const challenge = sha256hex(salt + number);
  return { algorithm: 'SHA-256', challenge, salt, signature: hmacHex(secret, challenge), maxnumber };
}

export type SolutionCheck = { ok: true; challenge: string } | { ok: false; reason: 'malformed' | 'signature' | 'wrong' | 'expired' };

/** Pure verification (no replay protection). Never throws on bad input. */
export function inspectSolution(payload: unknown, secret: string, now: number = Date.now()): SolutionCheck {
  if (typeof payload !== 'string' || payload.length === 0 || payload.length > MAX_PAYLOAD_CHARS) return { ok: false, reason: 'malformed' };
  let p: unknown;
  try {
    p = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof p !== 'object' || p === null || Array.isArray(p)) return { ok: false, reason: 'malformed' };
  const { algorithm, challenge, number, salt, signature } = p as Record<string, unknown>;
  if (
    algorithm !== 'SHA-256' ||
    typeof challenge !== 'string' || !HEX64.test(challenge) ||
    typeof signature !== 'string' || !HEX64.test(signature) ||
    typeof salt !== 'string' || salt.length > 200 ||
    typeof number !== 'number' || !Number.isInteger(number) || number < 0 || number > HARD_MAX_NUMBER
  ) {
    return { ok: false, reason: 'malformed' };
  }
  if (!equalHex(signature, hmacHex(secret, challenge))) return { ok: false, reason: 'signature' };
  if (!equalHex(sha256hex(salt + number), challenge)) return { ok: false, reason: 'wrong' };
  const expires = Number(new URLSearchParams(salt.split('?')[1] ?? '').get('expires'));
  if (!Number.isFinite(expires) || expires <= 0 || now / 1000 > expires) return { ok: false, reason: 'expired' };
  return { ok: true, challenge };
}

/** True when the payload is a correct, unexpired solution of a challenge this server issued. */
export async function verifySolution(payload: string, secret: string, now: number = Date.now()): Promise<boolean> {
  return inspectSolution(payload, secret, now).ok;
}
