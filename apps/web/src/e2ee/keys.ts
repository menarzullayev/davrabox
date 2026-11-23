// End-to-end encrypted meetings: the per-meeting key.
//
// The key is 32 random bytes made in the host's browser. It travels only in the URL fragment of the share link
// (`/app?join=<code>#k=<key>`): browsers never send the fragment to a server (not in the request line, not in
// `Referer`), so the server, the reverse proxy and the media server never see it. After the page has read it, it lives
// in sessionStorage (so a reload keeps working) and is removed from the address bar.
//
// Trade-off, stated plainly: a key in the address bar can be copied from there, shows up in screen shares of the browser
// window and is kept in browser history until we replace the entry. We replace it as soon as the page has loaded
// (history.replaceState), and sessionStorage dies with the tab, so the key is not written to disk by us. Browser sync
// or a synced "recently closed tab" may still hold the original URL: the share link is the trust root, treat it like
// a password (see docs/e2ee.md).

/** 32 bytes -> 43 base64url characters without padding. */
export const KEY_BYTES = 32;
export const KEY_CHARS = 43;

const B64URL = /^[A-Za-z0-9_-]+$/;
const CODE = /^[0-9]{11,12}$/;
const STORE_PREFIX = 'davra.e2ee.';

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decodes a base64url key; throws on anything that is not exactly 32 bytes in canonical form. */
export function keyToBytes(key: string): Uint8Array {
  if (!isValidKey(key)) throw new Error('invalid meeting key');
  const b64 = key.replace(/-/g, '+').replace(/_/g, '/') + '=';
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** True only for a canonical base64url encoding of exactly 32 bytes (the last character carries no stray bits). */
export function isValidKey(key: unknown): key is string {
  if (typeof key !== 'string' || key.length !== KEY_CHARS || !B64URL.test(key)) return false;
  try {
    const bin = atob(key.replace(/-/g, '+').replace(/_/g, '/') + '=');
    if (bin.length !== KEY_BYTES) return false;
    const bytes = new Uint8Array(KEY_BYTES);
    for (let i = 0; i < KEY_BYTES; i++) bytes[i] = bin.charCodeAt(i);
    return toBase64Url(bytes) === key;
  } catch {
    return false;
  }
}

/** A fresh meeting key from the browser CSPRNG. */
export function generateMeetingKey(): string {
  const bytes = new Uint8Array(KEY_BYTES);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

/**
 * Reads `k` from a URL fragment (`#k=<key>`, other parameters allowed). Returns null unless there is exactly one `k`
 * and it is a valid key. Linear in the input: split and compare, no backtracking pattern on user input.
 */
export function parseKeyFromHash(hash: string): string | null {
  const body = hash.startsWith('#') ? hash.slice(1) : hash;
  let found: string | null = null;
  for (const part of body.split('&')) {
    if (!part.startsWith('k=')) continue;
    if (found !== null) return null; // ambiguous
    found = part.slice(2);
  }
  return found !== null && isValidKey(found) ? found : null;
}

/** `https://host/app?join=<code>#k=<key>`; the key goes only after the `#`. */
export function buildShareLink(origin: string, code: string, key: string): string {
  if (!CODE.test(code)) throw new Error('invalid meeting code');
  if (!isValidKey(key)) throw new Error('invalid meeting key');
  return `${origin.replace(/\/+$/, '')}/app?join=${code}#k=${key}`;
}

export function storeKey(code: string, key: string): void {
  if (!CODE.test(code) || !isValidKey(key)) return;
  try {
    sessionStorage.setItem(STORE_PREFIX + code, key);
  } catch {
    /* storage unavailable: the key then lives only for this page load */
  }
}

export function loadStoredKey(code: string): string | null {
  if (!CODE.test(code)) return null;
  try {
    const v = sessionStorage.getItem(STORE_PREFIX + code);
    return isValidKey(v) ? v : null;
  } catch {
    return null;
  }
}

/** Every key this tab holds (used by the egress guard in api.ts). */
export function storedKeys(): string[] {
  const out: string[] = [];
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const name = sessionStorage.key(i);
      if (name?.startsWith(STORE_PREFIX)) {
        const v = sessionStorage.getItem(name);
        if (isValidKey(v)) out.push(v);
      }
    }
  } catch {
    /* ignore */
  }
  return out;
}

/**
 * If the address carries `?join=<code>#k=<key>`: keep the key in sessionStorage and replace the history entry with
 * the same address without the fragment. Returns the code the key belongs to, or null. A key fragment is removed from
 * the address even when it has no code next to it, so it never lingers in the address bar.
 */
export function takeKeyFromLocation(
  loc: { pathname: string; search: string; hash: string },
  hist: { replaceState(data: unknown, unused: string, url?: string | URL | null): void },
): string | null {
  const key = parseKeyFromHash(loc.hash);
  if (!key) return null;
  const q = new URLSearchParams(loc.search).get('join');
  const code = q !== null && CODE.test(q) ? q : null;
  if (code) storeKey(code, key);
  hist.replaceState({}, '', loc.pathname + loc.search);
  return code;
}
