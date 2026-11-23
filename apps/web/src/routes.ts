// Route decisions of the single-page build: the landing page lives at "/", the application at "/app", the admin
// console at "/admin". Pure functions (no DOM) so they can be tested; main.tsx and auth.ts use them.

import { parseKeyFromHash } from './e2ee/keys';

const CODE = /^[0-9]{11,12}$/;

const trim = (p: string) => p.replace(/\/+$/, '');

/** True for /app and everything below it (not for look-alikes such as /application). */
export function isAppPath(pathname: string): boolean {
  const p = trim(pathname);
  return p === '/app' || p.startsWith('/app/');
}

export function isLandingPath(pathname: string): boolean {
  return trim(pathname) === '';
}

export function isSignupPath(pathname: string): boolean {
  return trim(pathname) === '/app/signup';
}

/** `appUrl()` -> "/app"; `appUrl('signup')` -> "/app/signup"; `appUrl('?join=1')` -> "/app?join=1". */
export function appUrl(path = ''): string {
  if (!path) return '/app';
  if (path.startsWith('?') || path.startsWith('#')) return `/app${path}`;
  return `/app/${path.replace(/^\/+/, '')}`;
}

/** The E2EE meeting key of a link survives the redirect (rebuilt from the validated key, so nothing else rides along). */
function withKey(hash: string | undefined): string {
  const key = hash ? parseKeyFromHash(hash) : null;
  return key ? `#k=${key}` : '';
}

/**
 * Old meeting links keep working: `/j/<code>`, `/?code=<code>` and the pre-/app `/?join=<code>` (also what the desktop
 * deep link opens) map to `/app?join=<code>`, the parameter the application already understands. Only well-formed
 * 11-12 digit codes are mapped, so the result can never be an open redirect. An OIDC callback (`code` together with
 * `state`) is never a join link.
 */
export function legacyJoinRedirect(loc: { pathname: string; search: string; hash?: string }): string | null {
  const p = trim(loc.pathname);
  const m = /^\/j\/([^/]+)$/.exec(p);
  const keep = withKey(loc.hash);
  if (m) return CODE.test(m[1]!) ? appUrl(`?join=${m[1]}`) + keep : null;
  if (p !== '') return null;
  const q = new URLSearchParams(loc.search);
  if (q.has('state')) return null;
  const code = q.get('join') ?? q.get('code');
  return code !== null && CODE.test(code) ? appUrl(`?join=${code}`) + keep : null;
}
