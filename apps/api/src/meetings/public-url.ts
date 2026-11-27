/**
 * The application URL (https://<host>/app) on the host the browser used, when that host is an allowed origin; null otherwise.
 * Used as the landing page of links in emails, so a forged Host header cannot point a link elsewhere.
 */
export function appUrlFor(requestHost: string | undefined, allowedOrigins: string[]): string | null {
  if (!requestHost) return null;
  const host = requestHost.trim().toLowerCase();
  for (const origin of allowedOrigins) {
    let u: URL;
    try {
      u = new URL(origin.trim());
    } catch {
      continue;
    }
    if (u.protocol === 'https:' && u.host.toLowerCase() === host) return `https://${u.host}/app`;
  }
  return null;
}

/**
 * Picks the LiveKit signalling URL for the host the browser used to reach the API. The same deployment is
 * reachable by several public hosts (LAN address, public domain); each must get a wss URL on its own host.
 * Only hosts that are allowed origins are honoured, so a forged Host header cannot steer the client elsewhere.
 */
export function livekitUrlFor(requestHost: string | undefined, allowedOrigins: string[], fallback: string): string {
  if (!requestHost) return fallback;
  const host = requestHost.trim().toLowerCase();
  for (const origin of allowedOrigins) {
    let u: URL;
    try {
      u = new URL(origin);
    } catch {
      continue;
    }
    if (u.protocol === 'https:' && u.host.toLowerCase() === host) return `wss://${u.host}/livekit`;
  }
  return fallback;
}
