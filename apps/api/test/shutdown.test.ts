import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { Controller, Get, Inject, Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { createPool, ManagedPool } from '../src/db/pool.js';
import { loadConfig } from '../src/config.js';
import { armShutdownWatchdog } from '../src/shutdown.js';
import { AppModule } from '../src/app.module.js';

// What a SIGTERM does is: Nest's shutdown hook calls app.close(). That must (1) let the request that is already being
// served finish, (2) refuse new connections, (3) close every pool so Postgres sees the connections go. The real SIGTERM
// on the real container image is checked by scripts/check-graceful-shutdown.sh (Windows cannot deliver SIGTERM to a
// node process, so it cannot be done in this suite).
const cfg = loadConfig();
const adminUrl = process.env.MIGRATE_DATABASE_URL;
if (!adminUrl) throw new Error('MIGRATE_DATABASE_URL is required for tests');
const owner = new Pool({ connectionString: adminUrl, max: 1 });
afterAll(() => owner.end());

const connectionsOf = async (appName: string): Promise<number> =>
  Number((await owner.query('SELECT count(*) AS n FROM pg_stat_activity WHERE application_name = $1', [appName])).rows[0].n);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('graceful shutdown', () => {
  it('app.close() lets an in-flight request finish, refuses new ones and closes the pool', async () => {
    const appName = `shutdown-${randomBytes(4).toString('hex')}`;
    process.env['PGAPPNAME'] = appName;
    const pool = createPool(cfg.DATABASE_URL, 3);
    delete process.env['PGAPPNAME'];
    const started: { at: number }[] = [];

    @Controller()
    class SlowController {
      constructor(@Inject('POOL') private readonly p: Pool) {}
      @Get('slow')
      async slow() {
        started.push({ at: Date.now() });
        await this.p.query('SELECT pg_sleep(1.0)'); // a request that is mid-query when the signal arrives
        return { done: true };
      }
    }
    @Module({ controllers: [SlowController], providers: [{ provide: 'POOL', useValue: pool }] })
    class M {}

    const app: INestApplication = await NestFactory.create(M, { logger: false });
    await app.listen(0, '127.0.0.1');
    const port = (app.getHttpServer().address() as { port: number }).port;

    const inflight = fetch(`http://127.0.0.1:${port}/slow`).then(async (r) => ({ status: r.status, body: await r.json() }));
    while (started.length === 0) await sleep(10);
    expect(await connectionsOf(appName)).toBeGreaterThan(0);

    const closing = app.close(); // the SIGTERM path
    await sleep(100);
    // new connections are refused while the old request is still running
    await expect(fetch(`http://127.0.0.1:${port}/slow`, { signal: AbortSignal.timeout(1000) })).rejects.toBeDefined();

    expect(await inflight).toEqual({ status: 200, body: { done: true } }); // drained, not cut off
    await closing;
    expect(pool.ended).toBe(true);
    await sleep(200);
    expect(await connectionsOf(appName)).toBe(0); // Postgres no longer sees the connections
  }, 20_000);

  it('the real AppModule closes all of its pools (app, external API, sign-up) on shutdown', async () => {
    const appName = `shutdown-app-${randomBytes(4).toString('hex')}`;
    process.env['PGAPPNAME'] = appName;
    process.env['SIGNUP_BACKGROUND_JOBS'] = '0';
    const app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(0, '127.0.0.1');
    const port = (app.getHttpServer().address() as { port: number }).port;
    // touch each pool so a connection really exists: readiness uses the main pool; the trial status and sign-up use theirs
    const rr = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect([200, 503]).toContain(rr.status);
    expect(await connectionsOf(appName)).toBeGreaterThan(0);

    await app.close();
    await sleep(300);
    expect(await connectionsOf(appName)).toBe(0);
    delete process.env['PGAPPNAME'];
    delete process.env['SIGNUP_BACKGROUND_JOBS'];
  }, 30_000);

  it('ManagedPool ends once and tolerates a second end', async () => {
    const pool = createPool(cfg.DATABASE_URL, 1);
    expect(pool).toBeInstanceOf(ManagedPool);
    await pool.query('SELECT 1');
    await pool.onApplicationShutdown();
    await pool.onApplicationShutdown(); // idempotent: does not throw "end called more than once"
    expect(pool.ended).toBe(true);
  });
});

describe('shutdown watchdog', () => {
  it('force-exits with code 1 when the drain takes longer than the limit, and only after a signal', async () => {
    const handlers = new Map<string, () => void>();
    const exits: number[] = [];
    const proc = { once: (sig: string, fn: () => void) => void handlers.set(sig, fn), exit: (c: number) => void exits.push(c) };
    armShutdownWatchdog(proc as never, 150, () => undefined);
    await sleep(250);
    expect(exits).toEqual([]); // nothing happens until a signal arrives
    handlers.get('SIGTERM')!();
    await sleep(100);
    expect(exits).toEqual([]);
    await sleep(150);
    expect(exits).toEqual([1]);
  });
});
