import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';

/**
 * Baseline response headers for every API answer. In production Caddy adds some of them at the edge; the API sets its own
 * so that it is safe when reached directly (Kubernetes ingress, a second proxy, a developer's browser).
 *  - X-Content-Type-Options: nosniff (a JSON error body is never interpreted as HTML/script)
 *  - Cross-Origin-Resource-Policy: same-origin (no-cors cross-site embedding of API responses is refused; CORS-mode fetches
 *    from the allowed origins are not affected by this header)
 *  - Referrer-Policy: no-referrer
 */
export function applyApiHardening(app: INestApplication): void {
  // CVE-2026-111497 (Node2Shell, Brotli decoder out-of-bounds write, fixed in Node 22.23.4): never hand attacker-controlled
  // request bodies to a decompressor. body-parser inflates gzip/deflate/br by default; no client of this API compresses
  // requests, so a Content-Encoding on a request body is refused with 415. Must run before listen().
  const express = app as NestExpressApplication;
  express.useBodyParser('json', { inflate: false });
  express.useBodyParser('urlencoded', { extended: true, inflate: false });
  app.use((_req: unknown, res: { setHeader(name: string, value: string): void }, next: () => void) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
}
