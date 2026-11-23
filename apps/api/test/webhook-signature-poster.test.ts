import { createHmac } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backoffSeconds, MAX_ATTEMPTS, signPayload, verifySignature, SIGNATURE_TOLERANCE_SECONDS } from '../src/ext-api/webhook-signature.js';
import { createPoster } from '../src/ext-api/http-poster.js';

describe('signature (documented algorithm)', () => {
  const secret = 'whsec_test_secret_value';
  const body = '{"id":"7e5d","type":"meeting.created","data":{"title":"Привет"}}';

  it('is X-Davra-Signature: t=<unix>,v1=<hex hmac-sha256(secret, t + "." + body)>', () => {
    const h = signPayload(secret, body, 1_700_000_000);
    expect(h).toBe(`t=1700000000,v1=${createHmac('sha256', secret).update(`1700000000.${body}`, 'utf8').digest('hex')}`);
    expect(h).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
  });

  it('verifies a good signature and refuses a tampered body, a wrong secret and a mangled header', () => {
    const now = 1_700_000_100;
    const h = signPayload(secret, body, 1_700_000_000);
    expect(verifySignature(secret, h, body, { now })).toBe(true);
    expect(verifySignature(secret, h, body.replace('Привет', 'Hello'), { now })).toBe(false);
    expect(verifySignature('whsec_other', h, body, { now })).toBe(false);
    for (const bad of ['', 'v1=abc', 't=1700000000', 't=abc,v1=00', `t=1700000000,v1=${'0'.repeat(64)}`, `t=1700000000,v1=${'0'.repeat(63)}`]) {
      expect(verifySignature(secret, bad, body, { now }), bad).toBe(false);
    }
  });

  it('enforces the replay window of 5 minutes in both directions', () => {
    expect(SIGNATURE_TOLERANCE_SECONDS).toBe(300);
    const t = 1_700_000_000;
    const h = signPayload(secret, body, t);
    expect(verifySignature(secret, h, body, { now: t + 300 })).toBe(true);
    expect(verifySignature(secret, h, body, { now: t + 301 })).toBe(false);
    expect(verifySignature(secret, h, body, { now: t - 300 })).toBe(true);
    expect(verifySignature(secret, h, body, { now: t - 301 })).toBe(false);
  });

  it('accepts a header carrying several v1 values (secret rotation) when any one matches', () => {
    const t = 1_700_000_000;
    const good = signPayload(secret, body, t).split(',v1=')[1]!;
    expect(verifySignature(secret, `t=${t},v1=${'a'.repeat(64)},v1=${good}`, body, { now: t })).toBe(true);
  });
});

describe('retry backoff', () => {
  it('doubles from 30 s with +-25 % jitter, is capped at 6 h and gives up after 8 attempts', () => {
    expect(MAX_ATTEMPTS).toBe(8);
    const mid = (a: number) => backoffSeconds(a, () => 0.5);
    expect([1, 2, 3, 4, 5, 6, 7].map(mid)).toEqual([30, 60, 120, 240, 480, 960, 1920]);
    expect(backoffSeconds(1, () => 0)).toBe(23); // 30 * 0.75 rounded
    expect(backoffSeconds(1, () => 0.999999)).toBe(38);
    expect(backoffSeconds(30, () => 0.5)).toBe(6 * 3600);
    expect(backoffSeconds(30, () => 0.999999)).toBeLessThanOrEqual(6 * 3600 * 1.25);
  });
});

describe('http poster (real sockets, plain http transport so a local server can answer)', () => {
  let server: http.Server;
  let other: http.Server;
  let port = 0;
  let otherHits = 0;
  const seen: Array<{ method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string }> = [];
  let behavior: 'ok' | 'redirect' | 'hang' | 'big' = 'ok';

  beforeAll(async () => {
    other = http.createServer((_req, res) => {
      otherHits++;
      res.end('internal');
    });
    await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
    const otherPort = (other.address() as AddressInfo).port;
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, headers: req.headers, body });
        if (behavior === 'redirect') {
          res.writeHead(302, { Location: `http://127.0.0.1:${otherPort}/internal` });
          res.end();
        } else if (behavior === 'hang') {
          /* never answer */
        } else if (behavior === 'big') {
          res.writeHead(200);
          res.end('x'.repeat(5_000_000));
        } else {
          res.writeHead(204);
          res.end();
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await new Promise((r) => other.close(r));
  });

  const post = createPoster(http);
  const req = (over: Partial<Parameters<typeof post>[0]> = {}) => ({
    url: new URL(`https://hooks.example.test:${port}/in/coming?x=1`),
    address: '127.0.0.1',
    body: '{"a":1}',
    headers: { 'Content-Type': 'application/json', 'X-Davra-Signature': 't=1,v1=ab' },
    timeoutMs: 2000,
    ...over,
  });

  it('connects to the vetted address (not by name), sends the Host header, the body and the headers', async () => {
    behavior = 'ok';
    seen.length = 0;
    const r = await post(req());
    expect(r.status).toBe(204);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe('POST');
    expect(seen[0]!.url).toBe('/in/coming?x=1');
    expect(seen[0]!.headers.host).toBe(`hooks.example.test:${port}`); // the name was never resolved: we dialled 127.0.0.1
    expect(seen[0]!.headers['x-davra-signature']).toBe('t=1,v1=ab');
    expect(seen[0]!.headers['content-length']).toBe(String(Buffer.byteLength('{"a":1}')));
    expect(seen[0]!.body).toBe('{"a":1}');
  });

  it('does not follow redirects: a 302 is returned as is and the target is never requested', async () => {
    behavior = 'redirect';
    otherHits = 0;
    const r = await post(req());
    expect(r.status).toBe(302);
    expect(otherHits).toBe(0);
  });

  it('times out on a server that never answers', async () => {
    behavior = 'hang';
    const t0 = Date.now();
    await expect(post(req({ timeoutMs: 300 }))).rejects.toThrow(/timed out/i);
    expect(Date.now() - t0).toBeLessThan(2500);
  });

  it('does not buffer a huge response body', async () => {
    behavior = 'big';
    const r = await post(req());
    expect(r.status).toBe(200);
  });

  it('reports a refused connection as an error', async () => {
    await expect(post(req({ url: new URL('https://hooks.example.test:1/x'), address: '127.0.0.1', timeoutMs: 1000 }))).rejects.toThrow();
  });
});
