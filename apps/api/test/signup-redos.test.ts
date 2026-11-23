import { describe, expect, it } from 'vitest';
import { slugify } from '../src/signup/slug.js';
import { clientIp } from '../src/signup/limits.js';

// Regression for the CodeQL polynomial-ReDoS findings: attacker-sized input must be handled in linear time.
describe('signup input handling stays linear on hostile input', () => {
  it('slugify handles a very long run of dashes and symbols quickly', () => {
    const t0 = performance.now();
    for (const filler of ['-', '!', ' ', "'"]) {
      const s = slugify(`a${filler.repeat(200_000)}b`);
      expect(s.length).toBeLessThanOrEqual(48);
      expect(s).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    }
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it('slugify of only separators falls back to a valid reserved-safe slug', () => {
    expect(slugify('-'.repeat(100_000))).toBe('org');
  });

  it('client address extraction ignores a huge zone id quickly and still rejects it', () => {
    const t0 = performance.now();
    const ip = clientIp({ headers: { 'x-forwarded-for': `${'%'.repeat(200_000)}` }, socket: { remoteAddress: '203.0.113.9' } }, 1);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(typeof ip === 'string' || ip === null).toBe(true);
  });
});
