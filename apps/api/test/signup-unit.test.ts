import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createChallenge, inspectSolution, verifySolution, CHALLENGE_TTL_SECONDS } from '../src/signup/altcha.js';
import { isDisposable } from '../src/signup/disposable-domains.js';
import { emailDomain, normalizeEmail } from '../src/signup/email-normalize.js';
import { RESERVED_SLUGS, slugify } from '../src/signup/slug.js';
import { clientIp, ipKey } from '../src/signup/limits.js';

const SECRET = 'unit-test-secret-unit-test-secret-0123456789';

/** What the browser solver does: find the number whose hash of salt+number equals the challenge. */
function solve(
  ch: { challenge: string; salt: string; maxnumber: number; algorithm: string; signature: string },
  tamper?: Partial<Record<string, unknown>>,
): string {
  for (let n = 0; n <= ch.maxnumber; n++) {
    if (createHash('sha256').update(ch.salt + n).digest('hex') === ch.challenge) {
      return Buffer.from(
        JSON.stringify({ algorithm: ch.algorithm, challenge: ch.challenge, number: n, salt: ch.salt, signature: ch.signature, ...tamper }),
      ).toString('base64');
    }
  }
  throw new Error('unsolvable');
}

describe('ALTCHA challenge', () => {
  const now = 1_800_000_000_000;
  it('has the documented shape and an expiry five minutes ahead', () => {
    const ch = createChallenge(SECRET, now);
    expect(ch.algorithm).toBe('SHA-256');
    expect(ch.challenge).toMatch(/^[0-9a-f]{64}$/);
    expect(ch.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(ch.maxnumber).toBeGreaterThan(1000);
    expect(new URLSearchParams(ch.salt.split('?')[1]).get('expires')).toBe(String(now / 1000 + CHALLENGE_TTL_SECONDS));
    expect(CHALLENGE_TTL_SECONDS).toBe(300);
  });
  it('accepts a correct solution', async () => {
    const ch = createChallenge(SECRET, now);
    expect(await verifySolution(solve(ch), SECRET, now + 1000)).toBe(true);
  });
  it('refuses an expired challenge', async () => {
    const ch = createChallenge(SECRET, now);
    expect(await verifySolution(solve(ch), SECRET, now + (CHALLENGE_TTL_SECONDS + 1) * 1000)).toBe(false);
    expect(inspectSolution(solve(ch), SECRET, now + 400_000)).toEqual({ ok: false, reason: 'expired' });
  });
  it('refuses a wrong signature, a wrong secret and a tampered number', () => {
    const ch = createChallenge(SECRET, now);
    expect(inspectSolution(solve(ch, { signature: 'a'.repeat(64) }), SECRET, now)).toEqual({ ok: false, reason: 'signature' });
    expect(inspectSolution(solve(ch), 'another-secret-another-secret-0123456789', now)).toEqual({ ok: false, reason: 'signature' });
    expect(inspectSolution(solve(ch, { number: 7 }), SECRET, now)).toEqual({ ok: false, reason: 'wrong' });
  });
  it('refuses a solution made for a challenge with a forged salt (longer expiry)', () => {
    const ch = createChallenge(SECRET, now);
    const forgedSalt = ch.salt.replace(/expires=\d+/, `expires=${now / 1000 + 10 ** 7}`);
    expect(inspectSolution(solve(ch, { salt: forgedSalt }), SECRET, now)).toEqual({ ok: false, reason: 'wrong' });
  });
  it('refuses malformed payloads without throwing', async () => {
    const bad = ['', 'not base64 !!!', Buffer.from('{}').toString('base64'), Buffer.from('[1]').toString('base64'), Buffer.from('{"algorithm":"SHA-1"}').toString('base64'), 'a'.repeat(5000)];
    for (const b of bad) expect(await verifySolution(b, SECRET, now), b.slice(0, 20)).toBe(false);
  });
});

describe('email normalization', () => {
  it('folds case, dots and +tag for gmail-style domains to one mailbox', () => {
    const same = ['John.Smith@gmail.com', 'johnsmith@gmail.com', 'j.o.h.n.s.m.i.t.h+promo@Gmail.com', 'johnsmith+x@googlemail.com', ' JohnSmith@GMAIL.COM '];
    expect(new Set(same.map(normalizeEmail)).size).toBe(1);
  });
  it('keeps dots for other domains but strips +tag where plus addressing is standard', () => {
    expect(normalizeEmail('a.b@example.com')).not.toBe(normalizeEmail('ab@example.com'));
    expect(normalizeEmail('A.B@Example.com')).toBe(normalizeEmail('a.b@example.com'));
    expect(normalizeEmail('ab+x@outlook.com')).toBe(normalizeEmail('ab@outlook.com'));
  });
  it('does not merge different mailboxes', () => {
    expect(normalizeEmail('ab@gmail.com')).not.toBe(normalizeEmail('abc@gmail.com'));
    expect(normalizeEmail('ab@gmail.com')).not.toBe(normalizeEmail('ab@outlook.com'));
  });
  it('extracts the domain', () => {
    expect(emailDomain('X@Mail.Example.COM')).toBe('mail.example.com');
  });
});

describe('disposable domains', () => {
  it('blocks known throwaway providers and their subdomains, case-insensitively', () => {
    for (const e of ['a@mailinator.com', 'a@MAILINATOR.com', 'a@x.mailinator.com', 'a@guerrillamail.com', 'a@yopmail.com']) expect(isDisposable(e), e).toBe(true);
  });
  it('lets ordinary providers through (and does not match on a mere suffix of the name)', () => {
    for (const e of ['a@gmail.com', 'a@mail.ru', 'a@company.uz', 'a@notmailinator.com', 'a@mailinator.com.example.org']) expect(isDisposable(e), e).toBe(false);
  });
  it('honours extra blocked domains', () => {
    expect(isDisposable('a@evil.test', ['evil.test'])).toBe(true);
  });
});

describe('slugify', () => {
  it('makes a url-safe slug that satisfies the database rule', () => {
    for (const n of ['Acme Corp', '  My   Firm!! ', 'O‘zbekiston Telekom', 'ООО «Ромашка»', 'Tashkent_City 2026', '---', 'x', '日本語']) {
      expect(slugify(n), n).toMatch(/^[a-z0-9][a-z0-9-]{1,47}$/);
    }
    expect(slugify('Acme Corp')).toBe('acme-corp');
    expect(slugify('ООО «Ромашка»')).toBe('ooo-romashka');
  });
  it('never returns a reserved word', () => {
    for (const r of RESERVED_SLUGS) expect(RESERVED_SLUGS.includes(slugify(r)), r).toBe(false);
    expect(slugify('Admin')).not.toBe('admin');
    expect(slugify('demo')).not.toBe('demo');
  });
  it('limits the length', () => {
    expect(slugify('a'.repeat(300)).length).toBeLessThanOrEqual(48);
  });
});

describe('client address', () => {
  const req = (xff: string | undefined, remote = '10.0.0.9') => ({ headers: xff === undefined ? {} : { 'x-forwarded-for': xff }, socket: { remoteAddress: remote } });
  it('takes the address the nearest trusted proxy appended, not what the client claims', () => {
    expect(clientIp(req('1.2.3.4, 203.0.113.7'), 1)).toBe('203.0.113.7');
    expect(clientIp(req('6.6.6.6, 203.0.113.7, 10.1.1.1'), 2)).toBe('203.0.113.7');
  });
  it('falls back to the socket and survives garbage', () => {
    expect(clientIp(req(undefined, '::ffff:198.51.100.2'), 1)).toBe('198.51.100.2');
    expect(clientIp(req('', '198.51.100.2'), 1)).toBe('198.51.100.2');
    expect(clientIp(req('not an ip', '198.51.100.2'), 1)).toBe('198.51.100.2');
  });
  it('treats an IPv6 /64 as one client', () => {
    expect(ipKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe(ipKey('2001:db8:1:2:1111:2222:3333:4444'));
    expect(ipKey('2001:db8:1:3::1')).not.toBe(ipKey('2001:db8:1:2::1'));
    expect(ipKey('203.0.113.7')).toBe('203.0.113.7');
  });
});
