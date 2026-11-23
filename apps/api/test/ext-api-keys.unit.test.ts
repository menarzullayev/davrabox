import { beforeEach, describe, expect, it, vi } from 'vitest';

// The comparison of a presented secret with the stored hash must go through crypto.timingSafeEqual. The mock keeps the
// real behaviour and only records the calls.
const tse = vi.hoisted(() => ({ calls: [] as Array<[number, number]> }));
vi.mock('node:crypto', async (orig) => {
  const real = await orig<typeof import('node:crypto')>();
  return {
    ...real,
    timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
      tse.calls.push([a.byteLength, b.byteLength]);
      return real.timingSafeEqual(a, b);
    },
  };
});

import { createHmac } from 'node:crypto';
import { generateApiKey, hashSecret, parseApiKey, secretMatches, DUMMY_HASH } from '../src/ext-api/api-keys.service.js';

beforeEach(() => {
  tse.calls.length = 0;
});

describe('api key format', () => {
  it('generates dbx_<8 hex>_<43 base64url> and the hash is SHA-256 of the secret part', () => {
    const k = generateApiKey();
    expect(k.token).toMatch(/^dbx_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/);
    expect(k.token).toBe(`dbx_${k.prefix}_${k.secret}`);
    expect(k.hash.equals(createHmac('sha256', 'davrabox.ext-api.key.v1').update(k.secret).digest())).toBe(true);
    expect(generateApiKey().token).not.toBe(k.token);
  });

  it('parseApiKey accepts the exact format only', () => {
    const k = generateApiKey();
    expect(parseApiKey(k.token)).toEqual({ prefix: k.prefix, secret: k.secret });
    for (const bad of [
      '',
      'dbx_',
      `dbx_${k.prefix}`,
      `dbx_${k.prefix}_${k.secret}x`,
      `dbx_${k.prefix}_${k.secret.slice(1)}`,
      `DBX_${k.prefix}_${k.secret}`,
      `dbx_ABCDEF12_${k.secret}`,
      `dbx_${k.prefix}_${k.secret.slice(0, 42)}!`,
      ` ${k.token}`,
      `${k.token}\n`,
    ]) {
      expect(parseApiKey(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('constant-time comparison', () => {
  it('uses timingSafeEqual on two 32-byte buffers for a match and for a mismatch', () => {
    const k = generateApiKey();
    expect(secretMatches(k.secret, k.hash)).toBe(true);
    expect(secretMatches(`${k.secret.slice(0, 42)}${k.secret.endsWith('A') ? 'B' : 'A'}`, k.hash)).toBe(false);
    expect(tse.calls).toEqual([
      [32, 32],
      [32, 32],
    ]);
  });

  it('still performs a comparison when the prefix is unknown (dummy hash), so timing does not reveal prefixes', () => {
    expect(secretMatches(generateApiKey().secret, DUMMY_HASH)).toBe(false);
    expect(tse.calls).toEqual([[32, 32]]);
  });

  it('hashSecret is a deterministic keyed SHA-256 (HMAC) and differs from the plain hash', () => {
    expect(hashSecret('abc').toString('hex')).toBe('728b20329eea9277f89d3ca6395c7b9403fdbd01fb005de1201cdf4a43786ed6');
    expect(hashSecret('abc').toString('hex')).not.toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
