// Egress guard for the meeting key. The key must never leave the browser, so every request made through the API client
// is checked against the keys this tab holds before it is sent. A bug that put a key into a URL, a header or a body
// then fails loudly in the page instead of leaking to the server, the proxy logs or the media server.
import { parseKeyFromHash, storedKeys } from './keys';

export class KeyEgressError extends Error {
  constructor() {
    super('refusing to send an end-to-end encryption key over the network');
  }
}

function hasKeyShape(url: string): boolean {
  const hash = url.indexOf('#');
  if (hash >= 0 && parseKeyFromHash(url.slice(hash)) !== null) return true;
  const q = url.indexOf('?');
  if (q < 0) return false;
  const end = hash > q ? hash : url.length;
  return parseKeyFromHash(url.slice(q + 1, end)) !== null; // `?k=<key>` is shaped like the fragment form
}

/** Throws KeyEgressError when the request carries a held meeting key (or something shaped like `k=<key>`). */
export function assertNoMeetingKey(req: { url: string; headers?: Record<string, string>; body?: unknown }): void {
  if (hasKeyShape(req.url)) throw new KeyEgressError();
  const keys = storedKeys();
  if (keys.length === 0) return;
  const hay: string[] = [req.url];
  for (const v of Object.values(req.headers ?? {})) hay.push(v);
  if (typeof req.body === 'string') hay.push(req.body);
  for (const h of hay) {
    for (const k of keys) {
      if (h.includes(k) || h.includes(encodeURIComponent(k))) throw new KeyEgressError();
    }
  }
}
