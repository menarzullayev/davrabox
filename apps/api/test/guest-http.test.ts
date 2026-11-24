import 'reflect-metadata';
import type net from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyApiHardening } from '../src/security-headers.js';

// The public guest endpoints through the REAL application: no sign-in, so the protection is the policy, the limits and the
// shapes of what is accepted. Negative cases first.
const adminUrl = process.env.MIGRATE_DATABASE_URL;
if (!adminUrl) throw new Error('MIGRATE_DATABASE_URL is required for tests');
const owner = new Pool({ connectionString: adminUrl, max: 2 });
const sfx = Math.random().toString(36).slice(2, 8);
const slug = `gh-${sfx}`;
let app: INestApplication;
let base = '';
let hostId = '';
let orgId = '';
let openCode = '';
let closedCode = '';

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, raw?: string) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, body: json, text, headers: res.headers };
}
let n = 0;
const xff = () => ({ 'X-Forwarded-For': `203.0.113.7, 198.51.100.${(++n % 250) + 1}` }); // the last entry is the address the proxy saw

beforeAll(async () => {
  delete process.env['KEYCLOAK_ADMIN_URL'];
  delete process.env['KEYCLOAK_ADMIN_CLIENT_SECRET'];
  process.env['SIGNUP_TRUSTED_PROXY_HOPS'] = '1';
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const u = await pool.query('SELECT org_id, user_id FROM provision_user($1,$2,$3,$4,$5,$6)', [slug, slug, `h-${sfx}`, `h-${sfx}@t.local`, 'Host', 'member']);
  orgId = u.rows[0].org_id;
  hostId = u.rows[0].user_id;
  await pool.end();
  await owner.query('INSERT INTO org_policies (org_id, guest_policy) VALUES ($1, $2) ON CONFLICT (org_id) DO UPDATE SET guest_policy = EXCLUDED.guest_policy', [orgId, 'open']);
  const mk = async (code: string, mode: string) => {
    await owner.query("INSERT INTO meetings (org_id, code, title, host_user_id, guest_mode, waiting_room) VALUES ($1, $2, 'T', $3, $4, false)", [orgId, code, hostId, mode]);
    return code;
  };
  const base1 = 70000000000 + Math.floor(Math.random() * 9000000000);
  openCode = await mk(String(base1), 'open');
  closedCode = await mk(String(base1 + 1), 'off');
  const { AppModule } = await import('../src/app.module.js');
  app = await NestFactory.create(AppModule, { logger: ['error'], abortOnError: false });
  applyApiHardening(app);
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(app.getHttpServer().address() as net.AddressInfo).port}`;
});
afterAll(async () => {
  await app?.close();
  await owner.query('DELETE FROM organizations WHERE slug = $1', [slug]);
  await owner.end();
});

describe('guest endpoints over HTTP', () => {
  it('rejects unknown fields, wrong types, empty and oversized bodies', async () => {
    for (const body of [{ name: 'A', role: 'admin' }, { name: 5 }, {}, { name: 'A', passcode: 5 }, { name: 'x'.repeat(200) }, []] as unknown[]) {
      const r = await call('POST', `/v1/guest/meetings/${openCode}/join`, body, xff());
      expect(r.status, JSON.stringify(body).slice(0, 40)).toBe(400);
    }
    expect((await call('POST', `/v1/guest/meetings/${openCode}/join`, undefined, xff(), '{not json')).status).toBe(400);
    expect((await call('POST', `/v1/guest/meetings/${openCode}/join`, { name: 'A', pad: 'z'.repeat(200_000) }, xff())).status).toBe(413);
  });

  it('a closed meeting and an unknown code give the same answer', async () => {
    const a = await call('POST', `/v1/guest/meetings/${closedCode}/join`, { name: 'G' }, xff());
    const b = await call('POST', `/v1/guest/meetings/99999999998/join`, { name: 'G' }, xff());
    expect(a.status).toBe(404);
    expect(b.status).toBe(404);
    expect(a.text).toBe(b.text);
  });

  it('joins an open meeting with no Authorization header and returns a guest token, not an admin one', async () => {
    const r = await call('POST', `/v1/guest/meetings/${openCode}/join`, { name: 'Ali' }, xff());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'joined', guest: true, isHost: false });
    expect(typeof r.body.guestToken).toBe('string');
    expect(r.text).not.toMatch(/passcode_hash|org_id|host_user_id/);
  });

  it('the polling endpoint needs the guest token, and a guest token is not a member token', async () => {
    const j = await call('POST', `/v1/guest/meetings/${openCode}/join`, { name: 'Ali' }, xff());
    const tok: string = j.body.guestToken;
    const id = '00000000-0000-4000-8000-000000000000';
    expect((await call('GET', `/v1/guest/requests/${id}`)).status).toBe(401);
    expect((await call('GET', `/v1/guest/requests/${id}`, undefined, { Authorization: 'Basic abc' })).status).toBe(401);
    expect((await call('GET', `/v1/guest/requests/${id}`, undefined, { Authorization: `Bearer ${tok}`, ...xff() })).status).toBe(404); // not this token's request
    // The member endpoints (host controls, files, recordings, admin) never accept it.
    for (const [m, p] of [['GET', '/v1/meetings'], ['GET', `/v1/meetings/${openCode}/requests`], ['POST', `/v1/meetings/${openCode}/lock`], ['PUT', `/v1/meetings/${openCode}/files?name=a.txt`], ['GET', `/v1/meetings/${openCode}/recording`], ['GET', '/v1/admin/users'], ['PUT', '/v1/admin/policies']] as const) {
      const r = await call(m, p, m === 'GET' ? undefined : {}, { Authorization: `Bearer ${tok}`, ...xff() });
      expect(r.status, `${m} ${p}`).toBe(401);
    }
  });

  it('answers 429 with Retry-After once an address has missed ten codes', async () => {
    const h = { 'X-Forwarded-For': '203.0.113.7, 198.51.100.250' };
    let last = { status: 0, headers: new Headers() };
    for (let i = 0; i < 12; i++) last = await call('POST', `/v1/guest/meetings/${String(50000000000 + i)}/join`, { name: 'G' }, h);
    expect(last.status).toBe(429);
  });
});
