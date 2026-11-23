import { describe, expect, it } from 'vitest';
import { FailureLimiter } from '../src/common/rate-limiter.js';
import { identityFromClaims } from '../src/auth/jwt.js';
import { loadConfig } from '../src/config.js';

describe('FailureLimiter', () => {
  it('blocks after the limit and releases after the window', () => {
    let t = 1000;
    const l = new FailureLimiter(3, 60_000, () => t);
    l.recordFailure('k'); l.recordFailure('k');
    expect(l.isBlocked('k')).toBe(false);
    l.recordFailure('k');
    expect(l.isBlocked('k')).toBe(true);
    t += 60_001;
    expect(l.isBlocked('k')).toBe(false);
  });
  it('keys are independent and reset clears', () => {
    const l = new FailureLimiter(1, 1000);
    l.recordFailure('a');
    expect(l.isBlocked('a')).toBe(true);
    expect(l.isBlocked('b')).toBe(false);
    l.reset('a');
    expect(l.isBlocked('a')).toBe(false);
  });
});

describe('identityFromClaims', () => {
  const ok = { sub: 's1', email: 'a@b.c', name: 'A', org_slug: 'acme', realm_access: { roles: ['member'] } };
  it('maps valid claims', () => {
    expect(identityFromClaims(ok)).toEqual({ sub: 's1', email: 'a@b.c', name: 'A', orgSlug: 'acme', role: 'member' });
  });
  it('org_admin wins over member', () => {
    expect(identityFromClaims({ ...ok, realm_access: { roles: ['member', 'org_admin'] } }).role).toBe('org_admin');
  });
  it.each([
    ['missing sub', { ...ok, sub: undefined }],
    ['missing email', { ...ok, email: undefined }],
    ['missing org', { ...ok, org_slug: undefined }],
    ['hostile org slug', { ...ok, org_slug: "x'; DROP--" }],
    ['uppercase org slug', { ...ok, org_slug: 'ACME' }],
    ['no roles', { ...ok, realm_access: { roles: [] } }],
    ['unknown role only', { ...ok, realm_access: { roles: ['superadmin'] } }],
    ['roles not an array', { ...ok, realm_access: { roles: 'org_admin' } }],
  ])('rejects %s', (_n, claims) => {
    expect(() => identityFromClaims(claims as never)).toThrow();
  });
});

describe('loadConfig', () => {
  it('rejects a short LiveKit secret and missing values', () => {
    expect(() => loadConfig({ DATABASE_URL: 'x' } as never)).toThrow(/Invalid configuration/);
  });
  const base = {
    DATABASE_URL: 'postgres://u:p@h/d',
    KEYCLOAK_ISSUER: 'https://k.example/auth/realms/r',
    LIVEKIT_URL: 'wss://p.livekit.cloud',
    LIVEKIT_API_URL: 'https://p.livekit.cloud',
    LIVEKIT_API_KEY: 'key',
    LIVEKIT_API_SECRET: 'x'.repeat(32),
  };
  it('LIVEKIT_URL_FIXED defaults to off and accepts 1/true/0/false only', () => {
    expect(loadConfig(base as never).LIVEKIT_URL_FIXED).toBe(false);
    expect(loadConfig({ ...base, LIVEKIT_URL_FIXED: '1' } as never).LIVEKIT_URL_FIXED).toBe(true);
    expect(loadConfig({ ...base, LIVEKIT_URL_FIXED: 'true' } as never).LIVEKIT_URL_FIXED).toBe(true);
    expect(loadConfig({ ...base, LIVEKIT_URL_FIXED: '0' } as never).LIVEKIT_URL_FIXED).toBe(false);
    expect(() => loadConfig({ ...base, LIVEKIT_URL_FIXED: 'yes' } as never)).toThrow(/LIVEKIT_URL_FIXED/);
  });
});
