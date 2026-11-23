import 'reflect-metadata';
import net from 'node:net';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createPool, loadPoolSettings } from '../src/db/pool.js';
import { HealthController } from '../src/health.controller.js';
import { READINESS, ReadinessService } from '../src/readiness.js';
import { RateLimitService } from '../src/rate-limit/service.js';

const cfg = loadConfig();
const servers: net.Server[] = [];
function listen(handler?: (s: net.Socket) => void): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer((sock) => {
      sock.on('error', () => undefined);
      handler?.(sock);
    });
    servers.push(s);
    s.listen(0, '127.0.0.1', () => resolve((s.address() as net.AddressInfo).port));
  });
}
afterAll(() => servers.forEach((s) => s.close()));

const okPool = { query: async () => ({ rows: [{ ok: 1 }] }) };
const hungPool = { query: () => new Promise(() => undefined) };
const brokenPool = { query: async () => { throw new Error('password authentication failed for user "davra_app" at 10.0.0.5'); } };
const okFetch = (async () => new Response('OK')) as typeof fetch;
const hungFetch = ((_u: unknown, init?: { signal?: AbortSignal }) => new Promise((_r, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))))) as unknown as typeof fetch;

const svc = (pool: unknown, o: Partial<ConstructorParameters<typeof ReadinessService>[2]> = {}, rate: RateLimitService | null = null) =>
  new ReadinessService(pool as never, { livekitApiUrl: 'http://livekit.invalid:7880' }, { rate, fetch: okFetch, cacheMs: 0, ...o });

async function timed<T>(fn: () => Promise<T>): Promise<{ r: T; ms: number }> {
  const t = Date.now();
  const r = await fn();
  return { r, ms: Date.now() - t };
}

describe('ReadinessService', () => {
  it('reports ok with a boolean per dependency (no Redis configured: no redis key)', async () => {
    const r = await svc(okPool).check();
    expect(r).toEqual({ status: 'ok', postgres: true, livekit: true });
  });

  it('Postgres failure: unavailable, and nothing from the error leaks into the answer', async () => {
    const r = await svc(brokenPool).check();
    expect(r.status).toBe('unavailable');
    expect(r.postgres).toBe(false);
    expect(JSON.stringify(r)).not.toMatch(/password|davra_app|10\.0\.0\.5|Error/i);
    expect(Object.keys(r).sort()).toEqual(['livekit', 'postgres', 'status']);
  });

  it('a hung Postgres is reported down within about one second', async () => {
    const { r, ms } = await timed(() => svc(hungPool, { pgTimeoutMs: 300 }).check());
    expect(r.postgres).toBe(false);
    expect(ms).toBeLessThan(1500);
  });

  it('a hung LiveKit API is reported down within its short timeout', async () => {
    const { r, ms } = await timed(() => svc(okPool, { fetch: hungFetch, livekitTimeoutMs: 300 }).check());
    expect(r.livekit).toBe(false);
    expect(r.status).toBe('unavailable');
    expect(ms).toBeLessThan(1500);
  });

  it('any HTTP answer from LiveKit (even 401/404) counts as reachable; a refused connection does not', async () => {
    const r401 = await svc(okPool, { fetch: (async () => new Response('no', { status: 401 })) as typeof fetch }).check();
    expect(r401.livekit).toBe(true);
    const refused = await svc(okPool, { fetch: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch }).check();
    expect(refused.livekit).toBe(false);
  });

  it('Redis down is reported but only degrades: the limiter falls back to memory, so the API stays ready', async () => {
    const dead = await RateLimitService.create({ ...(await import('../src/rate-limit/config.js')).loadRateLimitConfig({}), REDIS_URL: 'redis://127.0.0.1:1' }, { log: { warn: () => undefined, log: () => undefined } });
    const r = await svc(okPool, { redisTimeoutMs: 300 }, dead).check();
    expect(r).toEqual({ status: 'degraded', postgres: true, livekit: true, redis: false });
    await dead.close();
  });

  it('caches the answer briefly so a probe storm does not hammer the dependencies', async () => {
    let calls = 0;
    const counting = { query: async () => { calls++; return { rows: [] }; } };
    const s = svc(counting, { cacheMs: 5_000 });
    await Promise.all([s.check(), s.check(), s.check()]);
    await s.check();
    expect(calls).toBe(1);
  });
});

describe('GET /readyz and GET /healthz', () => {
  let app: INestApplication;
  let base = '';
  const apps: INestApplication[] = [];
  afterEach(async () => { await Promise.all(apps.splice(0).map((a) => a.close())); });
  beforeAll(() => undefined);

  async function boot(pool: unknown, livekitApiUrl: string) {
    @Module({ controllers: [HealthController], providers: [{ provide: READINESS, useValue: new ReadinessService(pool as never, { livekitApiUrl }, { cacheMs: 0, pgTimeoutMs: 500, livekitTimeoutMs: 500 }) }] })
    class M {}
    app = await NestFactory.create(M, { logger: false });
    await app.listen(0, '127.0.0.1');
    apps.push(app);
    base = `http://127.0.0.1:${(app.getHttpServer().address() as net.AddressInfo).port}`;
  }

  it('200 with all booleans true against the real Postgres and a reachable media server', async () => {
    const lk = await listen((s) => s.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK'));
    const pool = createPool(cfg.DATABASE_URL, 2);
    await boot(pool, `http://127.0.0.1:${lk}`);
    const r = await fetch(`${base}/readyz`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: 'ok', postgres: true, livekit: true });
    expect(r.headers.get('cache-control')).toBe('no-store');
    await pool.end();
  });

  it('503 when Postgres is unreachable, while /healthz (liveness) still answers 200', async () => {
    const lk = await listen((s) => s.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK'));
    const pool = createPool('postgres://u:p@127.0.0.1:1/db', 1, loadPoolSettings({ DB_CONNECT_TIMEOUT_MS: '300' }));
    await boot(pool, `http://127.0.0.1:${lk}`);
    const r = await fetch(`${base}/readyz`);
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ status: 'unavailable', postgres: false, livekit: true });
    const h = await fetch(`${base}/healthz`);
    expect(h.status).toBe(200);
    expect(await h.json()).toEqual({ status: 'ok' });
    await pool.end().catch(() => undefined);
  });

  it('503 within the timeout when the media server accepts connections but never answers', async () => {
    const lk = await listen(); // silent
    const pool = createPool(cfg.DATABASE_URL, 2);
    await boot(pool, `http://127.0.0.1:${lk}`);
    const { r, ms } = await timed(() => fetch(`${base}/readyz`));
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ status: 'unavailable', postgres: true, livekit: false });
    expect(ms).toBeLessThan(2500);
    await pool.end();
  });
});
