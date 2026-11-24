import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Body, Controller, Get, HttpException, Module, Post, Req } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { register } from 'prom-client';
import type { INestApplication } from '@nestjs/common';
import { AllExceptionsFilter } from '../src/observability/exception.filter.js';
import { createRequestLogger } from '../src/observability/request-logger.js';
import { acceptRequestId } from '../src/observability/request-id.js';
import { redactText } from '../src/observability/redact.js';
import { registerPoolMetrics, registerRoomMetrics, signupRefusals, webhookDeliveries } from '../src/metrics.js';

const SECRETS = ['SECRETTOKEN123', 'SECRETCOOKIE', 'hunter2', 'passcode-424242', 'secret-plan.pdf', 'API-KEY-VALUE', 'dbpassword9'];

@Controller()
class ProbeController {
  @Get('echo/:id')
  echo() {
    return { ok: true };
  }
  @Post('submit')
  submit(@Body() body: unknown) {
    void body;
    return { ok: true };
  }
  @Get('who')
  who(@Req() req: { user?: unknown }) {
    req.user = { orgId: 'org-1', userId: 'user-1' };
    return { ok: true };
  }
  @Get('bad')
  bad() {
    throw new HttpException('invalid input', 400);
  }
  @Get('coded')
  coded() {
    throw new HttpException({ statusCode: 429, code: 'rate_limited', message: 'slow down', internal: 'x' }, 429);
  }
  @Get('boom')
  boom() {
    throw new Error('connect failed postgres://davra_app:dbpassword9@db:5432/davra with Authorization: Bearer SECRETTOKEN123');
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

const lines: string[] = [];
let app: INestApplication;
let base: string;

beforeAll(async () => {
  app = await NestFactory.create(ProbeModule, { logger: false });
  const sink = (l: string) => void lines.push(l);
  app.use(createRequestLogger({ sink }));
  app.useGlobalFilters(new AllExceptionsFilter({ sink }));
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
});
afterAll(async () => {
  await app.close();
});

const parsed = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);
const lastRequestLine = () => [...parsed()].reverse().find((l) => l.msg === 'request')!;

describe('request logging', () => {
  it('writes one JSON line per request with route template, status and latency', async () => {
    lines.length = 0;
    const res = await fetch(`${base}/echo/4242424242?q=1`);
    expect(res.status).toBe(200);
    const reqLines = parsed().filter((l) => l.msg === 'request');
    expect(reqLines).toHaveLength(1);
    const l = reqLines[0]!;
    expect(l).toMatchObject({ level: 'info', method: 'GET', route: '/echo/:id', status: 200 });
    expect(typeof l.latencyMs).toBe('number');
    expect(l.requestId).toBe(res.headers.get('x-request-id'));
    expect(JSON.stringify(l)).not.toContain('4242424242'); // path parameters (meeting codes) are logged as a template only
    expect(JSON.stringify(l)).not.toContain('q=1');
  });

  it('includes org and user id when the request was authenticated', async () => {
    lines.length = 0;
    await fetch(`${base}/who`);
    expect(lastRequestLine()).toMatchObject({ orgId: 'org-1', userId: 'user-1' });
  });

  it('never logs tokens, cookies, bodies, passcodes or file names, even when they are hostile', async () => {
    lines.length = 0;
    await fetch(`${base}/submit?token=SECRETTOKEN123&name=secret-plan.pdf`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer SECRETTOKEN123',
        Cookie: 'session=SECRETCOOKIE',
        'X-Api-Key': 'API-KEY-VALUE',
        'X-Request-Id': 'hunter2 <script>alert(1)</script>',
        Referer: 'https://x.test/?passcode=passcode-424242',
        'User-Agent': 'agent hunter2',
      },
      body: JSON.stringify({ password: 'hunter2', passcode: 'passcode-424242', fileName: 'secret-plan.pdf' }),
    });
    await fetch(`${base}/boom`, { headers: { Authorization: 'Bearer SECRETTOKEN123' } });
    const all = lines.join('\n');
    for (const s of SECRETS) expect(all, `log output leaked ${s}`).not.toContain(s);
    for (const l of lines.map((x) => JSON.parse(x) as Record<string, unknown>).filter((x) => x.msg === 'request')) {
      expect(Object.keys(l).sort()).toEqual(['latencyMs', 'level', 'method', 'msg', 'requestId', 'route', 'status', 'ts']); // allow-list: no headers, no query, no body
    }
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow(); // one JSON object per line
  });

  it('accepts a sane X-Request-Id and returns it', async () => {
    const res = await fetch(`${base}/echo/1`, { headers: { 'X-Request-Id': 'trace-abc_123.xyz' } });
    expect(res.headers.get('x-request-id')).toBe('trace-abc_123.xyz');
  });

  it('replaces a malformed X-Request-Id with a generated one', async () => {
    const res = await fetch(`${base}/echo/1`, { headers: { 'X-Request-Id': 'bad id with spaces <script>' } });
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('records the HTTP duration histogram by route and status', async () => {
    await fetch(`${base}/echo/7`);
    await fetch(`${base}/bad`);
    const text = await register.metrics();
    expect(text).toMatch(/davra_http_request_duration_seconds_count\{[^}]*route="\/echo\/:id"[^}]*status="200"[^}]*\} [1-9]/);
    expect(text).toMatch(/davra_http_request_duration_seconds_count\{[^}]*route="\/bad"[^}]*status="400"[^}]*\} [1-9]/);
  });
});

describe('exception filter', () => {
  it('turns an unexpected error into a safe body and logs the stack server-side, redacted', async () => {
    lines.length = 0;
    const res = await fetch(`${base}/boom`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(500);
    expect(Object.keys(body).sort()).toEqual(['message', 'requestId', 'statusCode']);
    expect(body).toMatchObject({ statusCode: 500, message: 'Internal server error', requestId: res.headers.get('x-request-id') });
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/postgres|stack|dbpassword9|SECRETTOKEN|node_modules|at \w/i);

    const errLine = parsed().find((l) => l.msg === 'unhandled_exception')!;
    expect(errLine).toBeDefined();
    expect(errLine).toMatchObject({ level: 'error', status: 500, route: '/boom', requestId: body.requestId });
    const err = errLine.err as { name: string; message: string; stack: string };
    expect(err.name).toBe('Error');
    expect(err.stack).toContain('boom'); // the stack is kept for operators
    expect(err.stack + err.message).not.toMatch(/dbpassword9|SECRETTOKEN123/);
  });

  it('keeps the message and stable code of an application error and adds the request id', async () => {
    const res = await fetch(`${base}/bad`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ statusCode: 400, message: 'invalid input', requestId: res.headers.get('x-request-id') });
    const coded = await fetch(`${base}/coded`);
    expect(await coded.json()).toEqual({ statusCode: 429, code: 'rate_limited', message: 'slow down', requestId: coded.headers.get('x-request-id') });
  });

  it('answers an unknown route with a plain 404 carrying the request id', async () => {
    const res = await fetch(`${base}/nope/at/all`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ statusCode: 404, requestId: res.headers.get('x-request-id') });
    expect(JSON.stringify(body)).not.toContain('Cannot GET'); // framework wording is not echoed with the path
  });

  it('does not echo a malformed JSON body back', async () => {
    const res = await fetch(`${base}/submit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"password":"hunter2",' });
    expect(res.status).toBe(400);
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain('hunter2');
    expect(text).not.toMatch(/Unexpected|JSON/);
  });

  it('reports 5xx errors to the error tracker and never 4xx', async () => {
    const seen: unknown[] = [];
    const filter = new AllExceptionsFilter({ sink: () => undefined, report: (e) => void seen.push(e) });
    const mk = () => ({
      switchToHttp: () => ({
        getRequest: () => ({ method: 'GET', headers: {}, requestId: 'r1' }),
        getResponse: () => ({ headersSent: false, status() { return this; }, json() { return this; } }),
      }),
    });
    filter.catch(new Error('x'), mk() as never);
    filter.catch(new HttpException('nope', 403), mk() as never);
    expect(seen).toHaveLength(1);
  });
});

describe('helpers', () => {
  it('acceptRequestId keeps valid ids and rejects the rest', () => {
    expect(acceptRequestId('abcDEF12-34_56.7')).toBe('abcDEF12-34_56.7');
    for (const bad of [undefined, '', 'short', 'a'.repeat(65), 'has space1234', 'new\nline1234', ['a-b-c-d-e-f-g-h', 'x']]) {
      expect(acceptRequestId(bad as never)).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('redactText removes bearer tokens, JWTs, URL credentials and key=value secrets', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.c2lnbmF0dXJlMTIzNDU2';
    const out = redactText(`Bearer abc.DEF-123 ${jwt} postgres://u:pw1234@h:5432/d password=hunter2 token: tok123 "secret":"s3cr3t" api_key=K1`);
    for (const s of ['abc.DEF-123', jwt, 'pw1234', 'hunter2', 'tok123', 's3cr3t', 'K1']) expect(out).not.toContain(s);
    expect(out).toContain('postgres://');
  });

  it('redactText is fast on hostile input', () => {
    const t = Date.now();
    redactText('Bearer ' + 'a'.repeat(100_000) + ' ://' + 'b:'.repeat(50_000) + ' password' + ' '.repeat(50_000));
    expect(Date.now() - t).toBeLessThan(1000);
  });
});

describe('business metrics', () => {
  it('exposes database pool gauges', async () => {
    registerPoolMetrics('main', { totalCount: 7, idleCount: 2, waitingCount: 3, options: { max: 10 } });
    registerPoolMetrics('signup', { totalCount: 1, idleCount: 1, waitingCount: 0, options: { max: 4 } });
    const text = await register.metrics();
    expect(text).toContain('davra_db_pool_connections{pool="main",state="total"} 7');
    expect(text).toContain('davra_db_pool_connections{pool="main",state="idle"} 2');
    expect(text).toContain('davra_db_pool_connections{pool="main",state="waiting"} 3');
    expect(text).toContain('davra_db_pool_max_connections{pool="main"} 10');
    expect(text).toContain('davra_db_pool_max_connections{pool="signup"} 4');
  });

  it('exposes active rooms and participants from the media server, cached between scrapes', async () => {
    let calls = 0;
    registerRoomMetrics({ listRooms: async () => (calls++, [{ numParticipants: 2 }, { numParticipants: 5 }]) }, 60_000);
    const a = await register.metrics();
    const b = await register.metrics();
    expect(a).toContain('davra_active_rooms 2');
    expect(a).toContain('davra_active_participants 7');
    expect(b).toContain('davra_active_participants 7');
    expect(calls).toBe(1);
  });

  it('keeps the last room value when the media server fails', async () => {
    let fail = false;
    registerRoomMetrics({ listRooms: async () => { if (fail) throw new Error('down'); return [{ numParticipants: 4 }]; } }, 0);
    await register.metrics();
    fail = true;
    expect(await register.metrics()).toContain('davra_active_participants 4');
  });

  it('counts sign-up refusals by reason and webhook deliveries by outcome', async () => {
    signupRefusals.inc({ reason: 'daily_cap' });
    webhookDeliveries.inc({ outcome: 'dead' });
    const text = await register.metrics();
    expect(text).toMatch(/davra_signup_refusals_total\{reason="daily_cap"\} [1-9]/);
    expect(text).toMatch(/davra_webhook_deliveries_total\{outcome="dead"\} [1-9]/);
  });
});
