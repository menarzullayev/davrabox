import { describe, expect, it } from 'vitest';
import { appUrl, isAppPath, isLandingPath, isSignupPath, legacyJoinRedirect } from './routes';

const loc = (pathname: string, search = '', hash = '') => ({ pathname, search, hash });

describe('isAppPath', () => {
  it('accepts /app and /app/ and nested app paths', () => {
    expect(isAppPath('/app')).toBe(true);
    expect(isAppPath('/app/')).toBe(true);
    expect(isAppPath('/app/anything')).toBe(true);
  });
  it('rejects the landing, the admin console and look-alikes', () => {
    expect(isAppPath('/')).toBe(false);
    expect(isAppPath('/admin')).toBe(false);
    expect(isAppPath('/application')).toBe(false);
    expect(isAppPath('/apple')).toBe(false);
    expect(isAppPath('/x/app')).toBe(false);
  });
});

describe('isLandingPath / isSignupPath', () => {
  it('only the root is the landing page', () => {
    expect(isLandingPath('/')).toBe(true);
    expect(isLandingPath('')).toBe(true);
    expect(isLandingPath('/app')).toBe(false);
    expect(isLandingPath('/admin')).toBe(false);
  });
  it('signup lives at /app/signup (with or without a trailing slash)', () => {
    expect(isSignupPath('/app/signup')).toBe(true);
    expect(isSignupPath('/app/signup/')).toBe(true);
    expect(isSignupPath('/app')).toBe(false);
    expect(isSignupPath('/app/signup/x')).toBe(false);
  });
});

describe('appUrl', () => {
  it('builds paths under /app', () => {
    expect(appUrl()).toBe('/app');
    expect(appUrl('signup')).toBe('/app/signup');
    expect(appUrl('/signup')).toBe('/app/signup');
    expect(appUrl('?join=12345678901')).toBe('/app?join=12345678901');
  });
});

describe('legacyJoinRedirect', () => {
  it('maps /j/<code> to /app?join=<code>', () => {
    expect(legacyJoinRedirect(loc('/j/12345678901'))).toBe('/app?join=12345678901');
    expect(legacyJoinRedirect(loc('/j/123456789012/'))).toBe('/app?join=123456789012');
  });
  it('maps /?code=<code> and /?join=<code> to /app?join=<code>', () => {
    expect(legacyJoinRedirect(loc('/', '?code=12345678901'))).toBe('/app?join=12345678901');
    expect(legacyJoinRedirect(loc('/', '?join=12345678901'))).toBe('/app?join=12345678901');
  });
  it('leaves everything else alone', () => {
    expect(legacyJoinRedirect(loc('/'))).toBeNull();
    expect(legacyJoinRedirect(loc('/app', '?join=12345678901'))).toBeNull();
    expect(legacyJoinRedirect(loc('/admin'))).toBeNull();
  });
  it('refuses malformed codes (no open redirect, no injection)', () => {
    expect(legacyJoinRedirect(loc('/j/123'))).toBeNull();
    expect(legacyJoinRedirect(loc('/j/1234567890123'))).toBeNull();
    expect(legacyJoinRedirect(loc('/j/12345678901x'))).toBeNull();
    expect(legacyJoinRedirect(loc('/', '?code=abc'))).toBeNull();
    expect(legacyJoinRedirect(loc('/', '?join=//evil.example'))).toBeNull();
    expect(legacyJoinRedirect(loc('/', '?join=12345678901%26x=1'))).toBeNull();
  });
  it('does not treat an OIDC callback (code + state) as a join link', () => {
    expect(legacyJoinRedirect(loc('/', '?code=12345678901&state=abc'))).toBeNull();
  });
  it('keeps an E2EE meeting key (the #k= fragment) through the redirect, and only a valid one', () => {
    const k = 'A'.repeat(42) + 'A';
    expect(legacyJoinRedirect({ ...loc('/j/12345678901'), hash: '#k=' + k })).toBe('/app?join=12345678901#k=' + k);
    expect(legacyJoinRedirect({ ...loc('/', '?join=12345678901'), hash: '#k=' + k })).toBe('/app?join=12345678901#k=' + k);
    expect(legacyJoinRedirect({ ...loc('/j/12345678901'), hash: '#k=short' })).toBe('/app?join=12345678901');
    expect(legacyJoinRedirect({ ...loc('/j/12345678901'), hash: '#other=1' })).toBe('/app?join=12345678901');
    expect(legacyJoinRedirect({ ...loc('/j/12345678901'), hash: '#k=' + k + '&evil=//x.example' })).toBe('/app?join=12345678901#k=' + k);
  });
});
