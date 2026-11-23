/**
 * Pure security policy of the desktop shell (no Electron imports, so it is unit-tested directly).
 * The shell only ever shows the DavraBox web client; everything else is refused or handed to the system browser.
 */

export const DEFAULT_APP_URL = 'https://davrabox.bugvector.uz';
export const DEEP_LINK_SCHEME = 'davrabox';

/** Normalises the configured app URL to its origin; only https (or http on localhost for development) is accepted. */
export function appOriginFrom(raw: string | undefined): string {
  const value = raw && raw.trim() ? raw.trim() : DEFAULT_APP_URL;
  const u = new URL(value);
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) throw new Error('DAVRABOX_URL must be https');
  if (u.username || u.password) throw new Error('DAVRABOX_URL must not contain credentials');
  return u.origin;
}

/** In-app navigation is limited to the app origin (login, API and signalling are same-origin behind the edge proxy). */
export function isAllowedNavigation(target: string, appOrigin: string): boolean {
  try {
    const u = new URL(target);
    return u.origin === appOrigin && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** Links that may be opened in the user's default browser: plain https without embedded credentials. */
export function isSafeExternalUrl(target: string): boolean {
  try {
    const u = new URL(target);
    return u.protocol === 'https:' && !u.username && !u.password && u.hostname.length > 0;
  } catch {
    return false;
  }
}

/** davrabox://join/<11-12 digit meeting code>  ->  the code; anything else is rejected. */
export function parseDeepLink(raw: string): { code: string } | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== `${DEEP_LINK_SCHEME}:` || u.hostname !== 'join' || u.username || u.password || u.port || u.search || u.hash) return null;
  const m = /^\/([0-9]{11,12})\/?$/.exec(u.pathname);
  return m ? { code: m[1]! } : null;
}

const ALLOWED_PERMISSIONS = new Set(['media', 'display-capture', 'fullscreen', 'clipboard-sanitized-write']);

/** Camera, microphone and screen capture are granted to the app origin only; everything else is denied. */
export function isAllowedPermission(permission: string, requestingUrl: string, appOrigin: string): boolean {
  if (!ALLOWED_PERMISSIONS.has(permission)) return false;
  try {
    return new URL(requestingUrl).origin === appOrigin;
  } catch {
    return false;
  }
}
