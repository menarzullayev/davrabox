import https from 'node:https';
import { isIP } from 'node:net';

export interface PostRequest {
  url: URL;
  /** The address vetted by url-guard. The connection goes to this IP, never to a fresh DNS answer. */
  address: string;
  body: string;
  headers: Record<string, string>;
  timeoutMs: number;
}
export interface PostResult {
  status: number;
}
export type Poster = (req: PostRequest) => Promise<PostResult>;

interface Transport {
  request: typeof https.request;
}

/**
 * One POST to a vetted address. Redirects are NOT followed: any 3xx is returned as the status and counts as a failed
 * attempt. The TLS server name and the Host header carry the original hostname (certificate validation works), while
 * the socket connects to the vetted IP, so the name cannot be re-pointed at an internal host between check and use.
 * The response body is drained to a small limit and thrown away. `transport` is injectable for tests only.
 */
export function createPoster(transport: Transport = https): Poster {
  return (req) =>
    new Promise<PostResult>((resolve, reject) => {
      const host = req.url.hostname.startsWith('[') ? req.url.hostname.slice(1, -1) : req.url.hostname;
      const options: https.RequestOptions = {
        host: req.address,
        port: req.url.port ? Number(req.url.port) : 443,
        path: `${req.url.pathname}${req.url.search}`,
        method: 'POST',
        agent: false, // no connection reuse across vetted addresses
        headers: { ...req.headers, Host: req.url.host, 'Content-Length': String(Buffer.byteLength(req.body)) },
        timeout: req.timeoutMs,
        ...(isIP(host) ? {} : { servername: host }),
      };
      let settled = false;
      const done = (fn: () => void) => {
        if (!settled) {
          settled = true;
          clearTimeout(hard);
          fn();
        }
      };
      const r = transport.request(options, (res) => {
        let drained = 0;
        res.on('data', (c: Buffer) => {
          drained += c.length;
          if (drained > 65_536) res.destroy(); // never buffer what a customer endpoint sends back
        });
        res.on('error', () => undefined);
        res.on('end', () => undefined);
        done(() => resolve({ status: res.statusCode ?? 0 }));
      });
      // `timeout` only covers socket inactivity; a hard deadline also bounds a slow trickle.
      const hard = setTimeout(() => {
        done(() => reject(new Error('request timed out')));
        r.destroy();
      }, req.timeoutMs);
      r.on('timeout', () => {
        done(() => reject(new Error('request timed out')));
        r.destroy();
      });
      r.on('error', (e: Error & { code?: string }) => done(() => reject(new Error(e.code ? `connection failed: ${e.code}` : 'connection failed'))));
      r.end(req.body);
    });
}
