import 'reflect-metadata';
import net from 'node:net';
import { Controller, Get, Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadRateLimitConfig } from '../src/rate-limit/config.js';
import { RateLimitModule } from '../src/rate-limit/rate-limit.module.js';
import { RateLimitService } from '../src/rate-limit/service.js';

// These tests need a REAL Redis (a throw-away container on loopback, see docs/security-testing.md):
//   docker run -d --rm --name rl-redis -p 127.0.0.1:56391:6379 redis:7-alpine ; RATE_LIMIT_TEST_REDIS_URL=redis://127.0.0.1:56391
const REDIS = process.env.RATE_LIMIT_TEST_REDIS_URL;
if (!REDIS) throw new Error('RATE_LIMIT_TEST_REDIS_URL is required for tests (a throw-away redis:7-alpine on 127.0.0.1)');
const redisUrl = new URL(REDIS);

const run = Math.random().toString(36).slice(2, 8);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const logs = () => {
  const lines: string[] = [];
  return { lines, log: { warn: (m: string) => lines.push(`warn ${m}`), log: (m: string) => lines.push(`log ${m}`) } };
};
const cfg = (over: Record<string, string> = {}) => loadRateLimitConfig({ REDIS_URL: REDIS, RATE_LIMIT_REDIS_RETRY_MS: '200', ...over });

const services: RateLimitService[] = [];
async function svc(over: Record<string, string> = {}, deps = logs()) {
  const s = await RateLimitService.create(cfg(over), { log: deps.log });
  services.push(s);
  return { s, ...deps };
}
afterAll(async () => { await Promise.all(services.map((s) => s.close())); });

describe('Redis-backed limiter', () => {
  it('two limiter instances (two API instances) share one counter', async () => {
    const a = (await svc()).s.limiter({ name: `share-${run}`, max: 5, windowMs: 60_000 });
    const b = (await svc()).s.limiter({ name: `share-${run}`, max: 5, windowMs: 60_000 });
    const results: boolean[] = [];
    for (let i = 0; i < 6; i++) results.push((await (i % 2 ? a : b).hit('k')).allowed);
    expect(results).toEqual([true, true, true, true, true, false]);
    expect((await a.check('k')).count).toBe(6);
  });
  it('is atomic under concurrency: 50 parallel hits against a limit of 10 allow exactly 10', async () => {
    const l1 = (await svc()).s.limiter({ name: `conc-${run}`, max: 10, windowMs: 60_000 });
    const l2 = (await svc()).s.limiter({ name: `conc-${run}`, max: 10, windowMs: 60_000 });
    const all = await Promise.all(Array.from({ length: 50 }, (_, i) => (i % 2 ? l1 : l2).hit('k')));
    expect(all.filter((d) => d.allowed)).toHaveLength(10);
  });
  it('the window expires and counting starts again', async () => {
    const l = (await svc()).s.limiter({ name: `win-${run}`, max: 2, windowMs: 400 });
    expect((await l.hit('k')).allowed).toBe(true);
    expect((await l.hit('k')).allowed).toBe(true);
    const blocked = await l.hit('k');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBe(1);
    await sleep(500);
    expect((await l.hit('k')).allowed).toBe(true);
  });
  it('failure counting keeps the old semantics: block after N failures, reset clears, keys are independent', async () => {
    const l = (await svc()).s.limiter({ name: `fail-${run}`, max: 3, windowMs: 60_000 });
    for (let i = 0; i < 3; i++) await l.recordFailure('u:code');
    expect(await l.isBlocked('u:code')).toBe(true);
    expect(await l.isBlocked('other')).toBe(false);
    await l.reset('u:code');
    expect(await l.isBlocked('u:code')).toBe(false);
  });
  it('keys carry a TTL (no counter lives forever)', async () => {
    const { s } = await svc();
    await s.limiter({ name: `ttl-${run}`, max: 5, windowMs: 30_000 }).hit('k');
    const raw = (s as unknown as { redis: { client: { pttl(k: string): Promise<number> } } }).redis.client;
    const ttl = await raw.pttl(`davra:rl:ttl-${run}:k`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30_000);
  });
});

/** A TCP forwarder in front of Redis that the test can switch off and on: a real connection outage, not a mock. */
function proxy(port: number) {
  const sockets = new Set<net.Socket>();
  let server: net.Server | null = null;
  const start = () =>
    new Promise<void>((resolve) => {
      server = net.createServer((client) => {
        const upstream = net.connect(Number(redisUrl.port), redisUrl.hostname);
        sockets.add(client);
        sockets.add(upstream);
        client.pipe(upstream);
        upstream.pipe(client);
        const kill = () => { client.destroy(); upstream.destroy(); };
        client.on('error', kill); upstream.on('error', kill); client.on('close', kill); upstream.on('close', kill);
      });
      server.listen(port, '127.0.0.1', () => resolve());
    });
  const stop = () =>
    new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy();
      sockets.clear();
      if (!server) return resolve();
      server.close(() => resolve());
      server = null;
    });
  return { start, stop };
}
const freePort = () => new Promise<number>((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); });

describe('Redis outage', () => {
  it('degrades to in-memory counting with one log line, never throws, and recovers when Redis is back', async () => {
    const port = await freePort();
    const px = proxy(port);
    await px.start();
    const { s, lines } = await svc({ REDIS_URL: `redis://127.0.0.1:${port}` });
    const l = s.limiter({ name: `out-${run}`, max: 3, windowMs: 60_000 });
    expect(s.mode).toBe('redis');
    expect((await l.hit('k')).allowed).toBe(true); // via Redis

    await px.stop(); // the outage
    const during: boolean[] = [];
    for (let i = 0; i < 6; i++) during.push((await l.hit('during')).allowed); // must not throw
    expect(during).toEqual([true, true, true, false, false, false]); // still limited: in-memory, never unlimited
    expect(lines.filter((x) => x.includes('unavailable'))).toHaveLength(1);
    expect(s.degraded).toBe(true);
    expect(await l.isBlocked('during')).toBe(true);
    await l.reset('during'); // reset during an outage does not throw either
    expect(await s.redisReachable(200)).toBe(false);

    await px.start(); // Redis is back
    let back = false;
    for (let i = 0; i < 30 && !back; i++) {
      await sleep(250);
      await l.hit('after');
      back = lines.some((x) => x.includes('recovered'));
    }
    expect(back).toBe(true);
    expect(s.degraded).toBe(false);
    expect(await s.redisReachable(500)).toBe(true);
    await px.stop();
  }, 30_000);

  it('the per-user ceiling fails open during an outage (documented), the per-IP ceiling does not', async () => {
    const port = await freePort();
    const { s } = await svc({ REDIS_URL: `redis://127.0.0.1:${port}`, RATE_LIMIT_IP_PER_MINUTE: '2', RATE_LIMIT_USER_PER_MINUTE: '2' }); // nothing listens: Redis is down from the start
    const ip: boolean[] = [];
    const user: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      ip.push((await s.ipCeiling.hit('1.2.3.4')).allowed);
      user.push((await s.userCeiling.hit('u1')).allowed);
    }
    expect(ip).toEqual([true, true, false, false, false]);
    expect(user).toEqual([true, true, true, true, true]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
@Controller()
class PingController {
  @Get('ping') ping() { return { ok: true }; }
}
async function startApi(env: Record<string, string>): Promise<{ app: INestApplication; base: string }> {
  @Module({ imports: [RateLimitModule.forRoot(cfg(env))], controllers: [PingController] })
  class M {}
  const app = await NestFactory.create(M, { logger: false });
  await app.listen(0, '127.0.0.1');
  return { app, base: `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}` };
}

describe('HTTP over Redis: two API instances behind one address', () => {
  const apps: INestApplication[] = [];
  afterEach(async () => { await Promise.all(apps.splice(0).map((a) => a.close())); });

  it('a burst split across two instances hits ONE ceiling and gets 429 with Retry-After', async () => {
    const env = { RATE_LIMIT_IP_PER_MINUTE: '6', SIGNUP_TRUSTED_PROXY_HOPS: '1' };
    const a = await startApi(env);
    const b = await startApi(env);
    apps.push(a.app, b.app);
    const ip = `203.0.113.${100 + Math.floor(Math.random() * 100)}`; // unique per run so reruns do not collide
    const codes: number[] = [];
    let retry: string | null = null;
    for (let i = 0; i < 10; i++) {
      const r = await fetch(`${i % 2 ? a.base : b.base}/ping`, { headers: { 'x-forwarded-for': ip } });
      codes.push(r.status);
      if (r.status === 429) retry = r.headers.get('retry-after');
    }
    expect(codes.filter((c) => c === 200)).toHaveLength(6);
    expect(codes.filter((c) => c === 429)).toHaveLength(4);
    expect(Number(retry)).toBeGreaterThanOrEqual(1);
  });

  it('the API keeps answering while Redis is down (in-memory ceiling, no 500)', async () => {
    const port = await freePort();
    const { app, base } = await startApi({ REDIS_URL: `redis://127.0.0.1:${port}`, RATE_LIMIT_IP_PER_MINUTE: '3', SIGNUP_TRUSTED_PROXY_HOPS: '1' });
    apps.push(app);
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await fetch(`${base}/ping`, { headers: { 'x-forwarded-for': '198.51.100.20' } })).status);
    expect(codes).toEqual([200, 200, 200, 429, 429]);
  });
});

beforeAll(async () => {
  // fail early and clearly when the throw-away Redis is not running
  const probe = await svc();
  if (!(await probe.s.redisReachable(1000))) throw new Error(`Redis at ${redisUrl.host} is not reachable`);
});
