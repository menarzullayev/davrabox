import 'reflect-metadata';
import { Controller, Get, Module, Post, UseGuards, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthGuard, POOL, VERIFIER } from '../src/auth/auth.guard.js';
import { clientIp as signupClientIp } from '../src/signup/limits.js';
import { clientIp, ipKey } from '../src/rate-limit/client-ip.js';
import { MemoryStore } from '../src/rate-limit/memory-store.js';
import { ResilientStore } from '../src/rate-limit/resilient-store.js';
import type { RateLimitStore } from '../src/rate-limit/store.js';
import { RateLimitService } from '../src/rate-limit/service.js';
import { loadRateLimitConfig } from '../src/rate-limit/config.js';
import { RateLimitModule } from '../src/rate-limit/rate-limit.module.js';
import { SkipRateLimit } from '../src/rate-limit/guard.js';

const cfgOf = (over: Record<string, string> = {}) => loadRateLimitConfig({ ...over });

function collectLog() {
  const lines: string[] = [];
  return { lines, log: { warn: (m: string) => lines.push(`warn ${m}`), log: (m: string) => lines.push(`log ${m}`) } };
}

describe('MemoryStore (fixed window)', () => {
  it('counts inside a window and starts a fresh one after it', async () => {
    let t = 1000;
    const s = new MemoryStore({ now: () => t });
    expect((await s.incr('k', 1000)).count).toBe(1);
    expect((await s.incr('k', 1000)).count).toBe(2);
    t += 999;
    expect((await s.peek('k')).count).toBe(2);
    t += 2;
    expect((await s.peek('k')).count).toBe(0);
    expect((await s.incr('k', 1000)).count).toBe(1);
  });
  it('reports the time left in the window and deletes keys', async () => {
    let t = 0;
    const s = new MemoryStore({ now: () => t });
    await s.incr('k', 10_000);
    t = 4000;
    expect((await s.peek('k')).ttlMs).toBe(6000);
    await s.del('k');
    expect((await s.peek('k')).count).toBe(0);
  });
  it('stays bounded under a flood of distinct keys', async () => {
    const s = new MemoryStore({ maxKeys: 100 });
    for (let i = 0; i < 1000; i++) await s.incr(`k${i}`, 60_000);
    expect(s.size()).toBeLessThanOrEqual(100);
    expect((await s.incr('k999', 60_000)).count).toBeGreaterThanOrEqual(1); // the newest keys survive
  });
});

describe('RateLimiter (same semantics as the old FailureLimiter)', () => {
  it('blocks after maxFailures in the window and releases afterwards', async () => {
    let t = 1000;
    const svc = RateLimitService.memory({ now: () => t });
    const l = svc.limiter({ name: 'fl', max: 3, windowMs: 60_000 });
    await l.recordFailure('k');
    await l.recordFailure('k');
    expect(await l.isBlocked('k')).toBe(false);
    await l.recordFailure('k');
    expect(await l.isBlocked('k')).toBe(true);
    t += 60_001;
    expect(await l.isBlocked('k')).toBe(false);
  });
  it('keys and limiter names are independent and reset clears', async () => {
    const svc = RateLimitService.memory();
    const a = svc.limiter({ name: 'a', max: 1, windowMs: 1000 });
    const b = svc.limiter({ name: 'b', max: 1, windowMs: 1000 });
    await a.recordFailure('x');
    expect(await a.isBlocked('x')).toBe(true);
    expect(await a.isBlocked('y')).toBe(false);
    expect(await b.isBlocked('x')).toBe(false);
    await a.reset('x');
    expect(await a.isBlocked('x')).toBe(false);
  });
  it('hit() allows max requests, then refuses with a Retry-After of at least one second', async () => {
    let t = 0;
    const svc = RateLimitService.memory({ now: () => t });
    const l = svc.limiter({ name: 'h', max: 3, windowMs: 10_000 });
    for (let i = 0; i < 3; i++) expect((await l.hit('k')).allowed).toBe(true);
    const d = await l.hit('k');
    expect(d.allowed).toBe(false);
    expect(d.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(d.retryAfterSec).toBeLessThanOrEqual(10);
    t = 10_001;
    expect((await l.hit('k')).allowed).toBe(true);
  });
});

describe('ResilientStore: a Redis outage degrades, never throws', () => {
  function flaky() {
    const state = { down: false };
    const inner: RateLimitStore = {
      async incr(): Promise<{ count: number; ttlMs: number }> { if (state.down) throw new Error('ECONNREFUSED'); return { count: 1, ttlMs: 1000 }; },
      async peek(): Promise<{ count: number; ttlMs: number }> { if (state.down) throw new Error('ECONNREFUSED'); return { count: 0, ttlMs: 0 }; },
      async del(): Promise<void> { if (state.down) throw new Error('ECONNREFUSED'); },
    };
    return { state, inner };
  }
  it('falls back to in-memory counting (limits still enforced), logs once per outage and recovers', async () => {
    const { state, inner } = flaky();
    const { lines, log } = collectLog();
    let t = 0;
    const store = new ResilientStore(inner, new MemoryStore({ now: () => t }), { retryMs: 5000, now: () => t, log });
    state.down = true;
    expect((await store.incr('k', 60_000)).count).toBe(1);
    expect((await store.incr('k', 60_000)).count).toBe(2);
    expect((await store.incr('k', 60_000)).count).toBe(3);
    expect(lines.filter((l) => l.includes('unavailable'))).toHaveLength(1);
    t += 5001;
    state.down = false;
    await store.incr('k', 60_000);
    expect(lines.some((l) => l.includes('recovered'))).toBe(true);
    state.down = true;
    t += 6000;
    await store.incr('k', 60_000);
    expect(lines.filter((l) => l.includes('unavailable'))).toHaveLength(2);
  });
  it('failure mode "open" allows without counting while Redis is down', async () => {
    const { state, inner } = flaky();
    const store = new ResilientStore(inner, new MemoryStore(), { retryMs: 5000, log: collectLog().log });
    state.down = true;
    const r = await store.incr('k', 1000, 'open');
    expect(r.count).toBe(0);
  });
  it('does not retry the primary on every request during an outage (no per-request timeout cost)', async () => {
    const { state, inner } = flaky();
    let calls = 0;
    const counting: RateLimitStore = { ...inner, incr: async (k, w) => { calls++; return inner.incr(k, w); } };
    let t = 0;
    const store = new ResilientStore(counting, new MemoryStore({ now: () => t }), { retryMs: 5000, now: () => t, log: collectLog().log });
    state.down = true;
    for (let i = 0; i < 20; i++) await store.incr('k', 1000);
    expect(calls).toBe(1);
  });
});

describe('RateLimitService without REDIS_URL', () => {
  it('uses memory and logs a single warning', async () => {
    const { lines, log } = collectLog();
    const svc = await RateLimitService.create(cfgOf(), { log });
    expect(svc.mode).toBe('memory');
    expect(lines.filter((l) => l.includes('REDIS_URL'))).toHaveLength(1);
    await svc.limiter({ name: 'x', max: 1, windowMs: 1000 }).hit('a');
    expect(lines.filter((l) => l.includes('REDIS_URL'))).toHaveLength(1);
    await svc.close();
  });
});

describe('client IP resolver (one rule for every limiter)', () => {
  const req = (xff: string | undefined, sock = '10.0.0.9') => ({ headers: xff === undefined ? {} : { 'x-forwarded-for': xff }, socket: { remoteAddress: sock } });
  it('is the very function the signup module uses', () => {
    expect(signupClientIp).toBe(clientIp);
  });
  it('takes the hops-th entry from the right; entries the client forged on the left are ignored', () => {
    expect(clientIp(req('6.6.6.6, 1.2.3.4'), 1)).toBe('1.2.3.4');
    expect(clientIp(req('7.7.7.7, 6.6.6.6, 1.2.3.4'), 1)).toBe('1.2.3.4');
    expect(clientIp(req('1.2.3.4, 10.1.1.1'), 2)).toBe('1.2.3.4');
  });
  it('falls back to the socket for zero hops, a missing header or garbage', () => {
    expect(clientIp(req('1.2.3.4'), 0)).toBe('10.0.0.9');
    expect(clientIp(req(undefined), 1)).toBe('10.0.0.9');
    expect(clientIp(req('not-an-ip'), 1)).toBe('10.0.0.9');
    expect(clientIp(req('::ffff:1.2.3.4'), 1)).toBe('1.2.3.4');
  });
  it('reduces IPv6 to its /64', () => {
    expect(ipKey('2001:db8:1:2:3:4:5:6')).toBe(ipKey('2001:db8:1:2:ffff::1'));
    expect(ipKey('1.2.3.4')).toBe('1.2.3.4');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// HTTP: global guard and interceptor over a real Nest app
const slow = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fakeVerifier = async (token: string) => {
  if (token === 'good') return { sub: 'u1', email: 'u1@t.local', name: 'U', orgSlug: 'acme', role: 'member' as const };
  throw new Error('bad token');
};
const fakePool = { query: async () => ({ rows: [{ org_id: 'o1', user_id: 'u1', role: 'member', disabled: false }] }) };

@Controller()
class ProbeController {
  @Get('ping') ping() { return { ok: true }; }
  @Get('healthz') @SkipRateLimit() health() { return { status: 'ok' }; }
  @Get('private') @UseGuards(AuthGuard) priv() { return { ok: true }; }
  @Post('slow') async slow() { await slow(5); return { ok: true }; }
}

function appModule(env: Record<string, string>) {
  @Module({
    imports: [RateLimitModule.forRoot(loadRateLimitConfig(env))],
    controllers: [ProbeController],
    providers: [{ provide: POOL, useValue: fakePool }, { provide: VERIFIER, useValue: fakeVerifier }, AuthGuard],
  })
  class M {}
  return M;
}

async function start(env: Record<string, string>): Promise<{ app: INestApplication; base: string }> {
  const app = await NestFactory.create(appModule(env), { logger: ["error"] });
  await app.listen(0, '127.0.0.1');
  return { app, base: `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}` };
}
const get = (base: string, path: string, headers: Record<string, string> = {}) => fetch(base + path, { headers });

describe('global per-IP ceiling', () => {
  let ctx: { app: INestApplication; base: string };
  beforeAll(async () => { ctx = await start({ RATE_LIMIT_IP_PER_MINUTE: '5', SIGNUP_TRUSTED_PROXY_HOPS: '1' }); });
  afterAll(async () => { await ctx.app.close(); });

  it('a burst of N requests gets 429 with Retry-After once the ceiling is crossed', async () => {
    const codes: number[] = [];
    let retry = '';
    for (let i = 0; i < 8; i++) {
      const r = await get(ctx.base, '/ping', { 'x-forwarded-for': '203.0.113.7' });
      codes.push(r.status);
      if (r.status === 429) retry = r.headers.get('retry-after') ?? '';
    }
    expect(codes.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(codes.slice(5)).toEqual([429, 429, 429]);
    expect(Number(retry)).toBeGreaterThanOrEqual(1);
    expect(Number(retry)).toBeLessThanOrEqual(60);
  });
  it('another client address is not affected', async () => {
    expect((await get(ctx.base, '/ping', { 'x-forwarded-for': '203.0.113.99' })).status).toBe(200);
  });
  it('rotating a forged left-hand X-Forwarded-For entry does not escape the limit (the proxy-appended entry is the key)', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await get(ctx.base, '/ping', { 'x-forwarded-for': `10.9.9.${i}, 198.51.100.5` })).status);
    expect(codes.filter((c) => c === 429).length).toBe(3);
  });
  it('the liveness path is exempt', async () => {
    for (let i = 0; i < 20; i++) expect((await get(ctx.base, '/healthz', { 'x-forwarded-for': '203.0.113.7' })).status).toBe(200);
  });
});

describe('failed authentication from one address is throttled before token verification', () => {
  let ctx: { app: INestApplication; base: string };
  beforeAll(async () => { ctx = await start({ RATE_LIMIT_AUTH_FAIL_MAX: '4', RATE_LIMIT_IP_PER_MINUTE: '1000', SIGNUP_TRUSTED_PROXY_HOPS: '1' }); });
  afterAll(async () => { await ctx.app.close(); });
  it('blocks the address after N bad tokens, even for a good token; other addresses are fine', async () => {
    const ip = { 'x-forwarded-for': '192.0.2.50' };
    for (let i = 0; i < 4; i++) expect((await get(ctx.base, '/private', { ...ip, authorization: 'Bearer bad' })).status).toBe(401);
    const blocked = await get(ctx.base, '/private', { ...ip, authorization: 'Bearer good' });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect((await get(ctx.base, '/private', { 'x-forwarded-for': '192.0.2.51', authorization: 'Bearer good' })).status).toBe(200);
  });
});

describe('per-user ceiling', () => {
  let ctx: { app: INestApplication; base: string };
  beforeAll(async () => { ctx = await start({ RATE_LIMIT_USER_PER_MINUTE: '3', RATE_LIMIT_IP_PER_MINUTE: '1000', SIGNUP_TRUSTED_PROXY_HOPS: '1' }); });
  afterAll(async () => { await ctx.app.close(); });
  it('limits an authenticated user across addresses', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await get(ctx.base, '/private', { 'x-forwarded-for': `198.18.0.${i}`, authorization: 'Bearer good' })).status);
    expect(codes).toEqual([200, 200, 200, 429, 429]);
  });
});
