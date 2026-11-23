import { describe, expect, it } from 'vitest';
import { DEFAULT_APP_URL, appOriginFrom, isAllowedNavigation, isAllowedPermission, isSafeExternalUrl, parseDeepLink } from '../src/security';

const ORIGIN = 'https://davrabox.example.com';

describe('appOriginFrom', () => {
  it('defaults to the production host and reduces to an origin', () => {
    expect(appOriginFrom(undefined)).toBe(new URL(DEFAULT_APP_URL).origin);
    expect(appOriginFrom('https://davrabox.example.com/some/path?x=1')).toBe(ORIGIN);
  });
  it('allows plain http only on localhost', () => {
    expect(appOriginFrom('http://localhost:5173')).toBe('http://localhost:5173');
    expect(() => appOriginFrom('http://davrabox.example.com')).toThrow();
  });
  it.each(['ftp://x.example.com', 'file:///etc/passwd', 'javascript:alert(1)', 'https://user:pw@x.example.com', 'not a url'])('rejects %s', (v) => {
    expect(() => appOriginFrom(v)).toThrow();
  });
});

describe('isAllowedNavigation', () => {
  it('allows same-origin pages only', () => {
    expect(isAllowedNavigation(`${ORIGIN}/`, ORIGIN)).toBe(true);
    expect(isAllowedNavigation(`${ORIGIN}/auth/realms/davrabox/protocol/openid-connect/auth?x=1`, ORIGIN)).toBe(true);
  });
  it.each([
    'https://evil.example.org/',
    'https://davrabox.example.com.evil.org/',
    'http://davrabox.example.com/',
    'https://davrabox.example.com:8443/',
    'https://user:pw@davrabox.example.com/',
    'file:///C:/Windows/win.ini',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'about:blank',
    '',
  ])('blocks %s', (u) => expect(isAllowedNavigation(u, ORIGIN)).toBe(false));
});

describe('isSafeExternalUrl', () => {
  it('accepts https', () => expect(isSafeExternalUrl('https://example.org/page?a=1')).toBe(true));
  it.each(['http://example.org', 'file:///etc/passwd', 'javascript:alert(1)', 'smb://host/share', 'https://u:p@example.org', 'ms-msdt:/id', '//example.org', ''])('refuses %s', (u) => {
    expect(isSafeExternalUrl(u)).toBe(false);
  });
});

describe('parseDeepLink', () => {
  it('extracts a meeting code', () => {
    expect(parseDeepLink('davrabox://join/12345678901')).toEqual({ code: '12345678901' });
    expect(parseDeepLink('davrabox://join/123456789012/')).toEqual({ code: '123456789012' });
  });
  it.each([
    'davrabox://join/123',
    'davrabox://join/12345678901x',
    'davrabox://join/../../etc/passwd',
    'davrabox://join/12345678901?next=https://evil.example',
    'davrabox://join/12345678901#frag',
    'davrabox://open/12345678901',
    'davrabox://user@join/12345678901',
    'davrabox://join:99/12345678901',
    'https://join/12345678901',
    'davrabox:join/12345678901',
    '',
  ])('rejects %s', (u) => expect(parseDeepLink(u)).toBeNull());
});

describe('isAllowedPermission', () => {
  it('grants media and screen capture to the app origin only', () => {
    expect(isAllowedPermission('media', `${ORIGIN}/`, ORIGIN)).toBe(true);
    expect(isAllowedPermission('display-capture', `${ORIGIN}/x`, ORIGIN)).toBe(true);
    expect(isAllowedPermission('media', 'https://evil.example.org/', ORIGIN)).toBe(false);
    expect(isAllowedPermission('media', 'not a url', ORIGIN)).toBe(false);
  });
  it.each(['geolocation', 'notifications', 'midi', 'hid', 'serial', 'usb', 'openExternal', 'clipboard-read', 'pointerLock', 'unknown'])('denies %s even for the app origin', (p) => {
    expect(isAllowedPermission(p, `${ORIGIN}/`, ORIGIN)).toBe(false);
  });
});
