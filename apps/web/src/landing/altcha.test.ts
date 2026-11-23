// @vitest-environment node
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildPayload, solveChallenge, solveWithTimeout, SolveTimeoutError, type AltchaChallenge } from './altcha';

const make = (number: number, max = 4000): AltchaChallenge => {
  const salt = `abcdef0123456789abcdef01?expires=${Math.floor(Date.now() / 1000) + 300}`;
  return { algorithm: 'SHA-256', challenge: createHash('sha256').update(salt + number).digest('hex'), salt, signature: 'f'.repeat(64), maxnumber: max };
};

describe('ALTCHA client solver', () => {
  it('finds the secret number (including the first, a middle and the last candidate)', async () => {
    for (const n of [0, 1, 777, 4000]) expect(await solveChallenge(make(n))).toBe(n);
  });

  it('builds the payload the server expects: base64 JSON with the challenge fields and the number', async () => {
    const ch = make(321);
    const payload = JSON.parse(Buffer.from(buildPayload(ch, 321), 'base64').toString('utf8'));
    expect(payload).toEqual({ algorithm: 'SHA-256', challenge: ch.challenge, number: 321, salt: ch.salt, signature: ch.signature });
  });

  it('returns null when the number is outside the announced range', async () => {
    const ch = { ...make(3000), maxnumber: 1000 };
    expect(await solveChallenge(ch)).toBeNull();
  });

  it('stops promptly when aborted', async () => {
    const ctl = new AbortController();
    const ch = { ...make(1_900_000), maxnumber: 2_000_000 };
    const started = Date.now();
    const p = solveChallenge(ch, { signal: ctl.signal });
    setTimeout(() => ctl.abort(), 30);
    expect(await p).toBeNull();
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('reports progress between 0 and 1', async () => {
    const seen: number[] = [];
    await solveChallenge(make(3500), { onProgress: (f) => seen.push(f) });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((f) => f >= 0 && f <= 1)).toBe(true);
  });

  it('gives up after the time limit with SolveTimeoutError', async () => {
    const hang = (_ch: AltchaChallenge, o: { signal: AbortSignal }) => new Promise<string>((_, reject) => o.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    await expect(solveWithTimeout(make(1), hang, 40)).rejects.toBeInstanceOf(SolveTimeoutError);
  });

  it('passes the payload through when the solver is fast enough', async () => {
    await expect(solveWithTimeout(make(1), async () => 'payload', 1000)).resolves.toBe('payload');
  });
});
