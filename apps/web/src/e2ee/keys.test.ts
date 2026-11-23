// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildShareLink, extractKeyFromText, generateMeetingKey, keyToBytes, loadStoredKey, parseKeyFromHash, storeKey, takeKeyFromLocation } from './keys';

const CODE = '12345678901';

beforeEach(() => sessionStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('generateMeetingKey', () => {
  it('is 43 base64url characters (32 random bytes) and differs on every call', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const k = generateMeetingKey();
      expect(k).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(keyToBytes(k)).toHaveLength(32);
      seen.add(k);
    }
    expect(seen.size).toBe(50);
  });

  it('draws from the CSPRNG, never Math.random', () => {
    const rnd = vi.spyOn(Math, 'random');
    const get = vi.spyOn(crypto, 'getRandomValues');
    generateMeetingKey();
    expect(get).toHaveBeenCalledTimes(1);
    expect(rnd).not.toHaveBeenCalled();
  });
});

describe('parseKeyFromHash', () => {
  const good = generateMeetingKey();
  it('accepts a well-formed fragment', () => {
    expect(parseKeyFromHash(`#k=${good}`)).toBe(good);
    expect(parseKeyFromHash(`k=${good}`)).toBe(good); // without the leading #
    expect(parseKeyFromHash(`#x=1&k=${good}`)).toBe(good);
  });
  it('rejects anything that is not exactly a 32-byte base64url key', () => {
    const bad = [
      '',
      '#',
      '#k=',
      '#k=abc',
      `#k=${good.slice(0, 42)}`, // too short
      `#k=${good}A`, // too long
      `#k=${good.slice(0, 42)}+`, // not base64url alphabet
      `#k=${good.slice(0, 42)}/`,
      `#k=${good.slice(0, 42)}=`,
      `#k=${good.slice(0, 41)} A`,
      `#k=${'A'.repeat(42)}B`, // 43 chars, but the last char has non-zero padding bits: not canonical
      `#K=${good}`, // the parameter name is case-sensitive
      `#key=${good}`,
      `#k=${good}&k=${good}`, // ambiguous
      `#k[]=${good}`,
    ];
    for (const b of bad) expect(parseKeyFromHash(b), b).toBeNull();
  });
  it('is linear on hostile input (no backtracking blow-up)', () => {
    const t0 = performance.now();
    parseKeyFromHash('#' + 'k=A&'.repeat(50_000));
    parseKeyFromHash('#k=' + 'A'.repeat(500_000));
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});

describe('buildShareLink', () => {
  it('puts the key only after the #, never in the path or query', () => {
    const k = generateMeetingKey();
    const link = buildShareLink('https://davra.example', CODE, k);
    expect(link).toBe(`https://davra.example/app?join=${CODE}#k=${k}`);
    const u = new URL(link);
    expect(u.search).toBe(`?join=${CODE}`);
    expect(u.pathname).toBe('/app');
    expect(link.split('#')[0]).not.toContain(k);
    expect(link.indexOf(k)).toBeGreaterThan(link.indexOf('#'));
  });
  it('tolerates a trailing slash on the origin and refuses malformed input', () => {
    const k = generateMeetingKey();
    expect(buildShareLink('https://d.example/', CODE, k)).toBe(`https://d.example/app?join=${CODE}#k=${k}`);
    expect(() => buildShareLink('https://d.example', 'abc', k)).toThrow();
    expect(() => buildShareLink('https://d.example', CODE, 'short')).toThrow();
    expect(() => buildShareLink('https://d.example', `${CODE}&x=1`, k)).toThrow();
  });
});

describe('session storage', () => {
  it('stores and loads the key per meeting, and validates what it loads', () => {
    const k = generateMeetingKey();
    expect(loadStoredKey(CODE)).toBeNull();
    storeKey(CODE, k);
    expect(loadStoredKey(CODE)).toBe(k);
    expect(loadStoredKey('99999999999')).toBeNull();
    sessionStorage.setItem(`davra.e2ee.${CODE}`, 'tampered');
    expect(loadStoredKey(CODE)).toBeNull();
  });
  it('uses sessionStorage only, never localStorage (the key must not outlive the tab)', () => {
    const k = generateMeetingKey();
    storeKey(CODE, k);
    expect(JSON.stringify({ ...localStorage })).not.toContain(k);
    expect(JSON.stringify({ ...sessionStorage })).toContain(k);
  });
  it('does not throw when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(() => storeKey(CODE, generateMeetingKey())).not.toThrow();
    expect(loadStoredKey(CODE)).toBeNull();
  });
});

describe('extractKeyFromText', () => {
  it('takes the key from a pasted full link, a fragment or the bare key, and nothing else', () => {
    const k = generateMeetingKey();
    expect(extractKeyFromText(`https://davra.example/app?join=${CODE}#k=${k}`)).toBe(k);
    expect(extractKeyFromText(`  #k=${k}  `)).toBe(k);
    expect(extractKeyFromText(k)).toBe(k);
    expect(extractKeyFromText(`https://davra.example/app?join=${CODE}`)).toBeNull();
    expect(extractKeyFromText(`https://davra.example/app?k=${k}`)).toBeNull(); // a key in the query is never accepted as a share link
    expect(extractKeyFromText('')).toBeNull();
    expect(extractKeyFromText('#'.repeat(100_000))).toBeNull();
  });
});

describe('takeKeyFromLocation', () => {
  it('moves the key from the address bar into sessionStorage and replaces history so it is not left in the URL', () => {
    const k = generateMeetingKey();
    const replace = vi.fn();
    const loc = { pathname: '/app', search: `?join=${CODE}`, hash: `#k=${k}` };
    expect(takeKeyFromLocation(loc, { replaceState: replace })).toBe(CODE);
    expect(loadStoredKey(CODE)).toBe(k);
    expect(replace).toHaveBeenCalledTimes(1);
    const url = replace.mock.calls[0]![2] as string;
    expect(url).toBe(`/app?join=${CODE}`);
    expect(url).not.toContain(k);
    expect(url).not.toContain('#');
  });
  it('does nothing without a valid key or a valid code', () => {
    const k = generateMeetingKey();
    const replace = vi.fn();
    expect(takeKeyFromLocation({ pathname: '/app', search: `?join=${CODE}`, hash: '' }, { replaceState: replace })).toBeNull();
    expect(takeKeyFromLocation({ pathname: '/app', search: '?join=abc', hash: `#k=${k}` }, { replaceState: replace })).toBeNull();
    expect(takeKeyFromLocation({ pathname: '/app', search: '', hash: `#k=${k}` }, { replaceState: replace })).toBeNull();
    expect(takeKeyFromLocation({ pathname: '/app', search: `?join=${CODE}`, hash: '#k=bad' }, { replaceState: replace })).toBeNull();
    expect(loadStoredKey(CODE)).toBeNull();
  });
  it('still removes a key fragment from the URL when no code accompanies it (a key must not linger in the address bar)', () => {
    const k = generateMeetingKey();
    const replace = vi.fn();
    takeKeyFromLocation({ pathname: '/app', search: '', hash: `#k=${k}` }, { replaceState: replace });
    expect(replace).toHaveBeenCalledTimes(1);
    expect(String(replace.mock.calls[0]![2])).not.toContain(k);
  });
});
