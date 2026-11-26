import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Pool } from 'pg';
import { AuthGuard, POOL, VERIFIER } from '../src/auth/auth.guard.js';
import { MEETINGS, MeetingsController } from '../src/meetings/meetings.controller.js';
import { MeetingsService } from '../src/meetings/meetings.service.js';
import { RecordingService, type MediaPort, type ObjectStore } from '../src/recording/recording.service.js';
import { loadConfig } from '../src/config.js';

// End-to-end encrypted meetings, server side: the flag is chosen at creation, is returned to the client, and can never
// change afterwards. The server never receives the meeting key (it lives in the link fragment), so there is nothing to
// store; what the API can and must do is refuse anything that looks like it is being sent.
const cfg = loadConfig();
const adminUrl = process.env.MIGRATE_DATABASE_URL;
if (!adminUrl) throw new Error('MIGRATE_DATABASE_URL is required for tests');
const pool = new Pool({ connectionString: cfg.DATABASE_URL, max: 4 });
const admin = new Pool({ connectionString: adminUrl, max: 2 });
const svc = new MeetingsService(pool, cfg);
const sfx = Math.random().toString(36).slice(2, 8);
const slug = `e2ee-${sfx}`;

const subs: Record<string, { email: string; role: 'org_admin' | 'member' }> = {
  [`host-${sfx}`]: { email: `host-${sfx}@t.local`, role: 'member' },
  [`mem-${sfx}`]: { email: `mem-${sfx}@t.local`, role: 'member' },
};

@Module({
  controllers: [MeetingsController],
  providers: [
    { provide: POOL, useValue: pool },
    {
      provide: VERIFIER,
      useValue: async (t: string) => {
        const sub = t.replace(/^tok-/, '');
        const s = subs[sub];
        if (!s) throw new Error('bad token');
        return { sub, email: s.email, name: sub, orgSlug: slug, role: s.role };
      },
    },
    { provide: MEETINGS, useValue: svc },
    AuthGuard,
  ],
})
class TestModule {}

let app: INestApplication;
let base = '';
const http = async (method: string, path: string, who: string | null, body?: unknown) => {
  const res = await fetch(base + path, {
    method,
    headers: { ...(who ? { authorization: `Bearer tok-${who}-${sfx}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json: json as Record<string, unknown> & unknown[], text };
};

let orgId = '';
beforeAll(async () => {
  app = await NestFactory.create(TestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  const host = await pool.query('SELECT org_id FROM provision_user($1,$2,$3,$4,$5,$6)', [slug, slug, `host-${sfx}`, `host-${sfx}@t.local`, 'host', 'member']);
  await pool.query('SELECT 1 FROM provision_user($1,$2,$3,$4,$5,$6)', [slug, slug, `mem-${sfx}`, `mem-${sfx}@t.local`, 'mem', 'member']);
  orgId = host.rows[0].org_id;
});
afterAll(async () => {
  await app.close();
  await admin.query('DELETE FROM organizations WHERE slug = $1', [slug]);
  await pool.end();
  await admin.end();
});

describe('E2EE meetings over HTTP', () => {
  it('e2ee defaults to false and is returned on create and in the list', async () => {
    const r = await http('POST', '/v1/meetings', 'host', { title: 'Plain', waitingRoom: false });
    expect(r.status).toBe(201);
    expect(r.json.e2ee).toBe(false);
    const list = await http('GET', '/v1/meetings', 'host');
    expect(list.json.find((m: unknown) => (m as { code: string }).code === r.json.code)).toMatchObject({ e2ee: false });
  });

  it('e2ee: true persists, is listed, and the join result says so', async () => {
    const r = await http('POST', '/v1/meetings', 'host', { title: 'Secret', waitingRoom: false, e2ee: true });
    expect(r.status).toBe(201);
    expect(r.json.e2ee).toBe(true);
    const list = await http('GET', '/v1/meetings', 'host');
    expect(list.json.find((m: unknown) => (m as { code: string }).code === r.json.code)).toMatchObject({ e2ee: true });
    const row = await admin.query('SELECT e2ee FROM meetings WHERE code = $1', [r.json.code]);
    expect(row.rows[0].e2ee).toBe(true);
    const j = await http('POST', `/v1/meetings/${r.json.code}/join`, 'mem', {});
    expect(j.status).toBe(200);
    expect(j.json.status).toBe('joined');
    expect(j.json.e2ee).toBe(true);
    const plain = await http('POST', '/v1/meetings', 'host', { title: 'P2', waitingRoom: false });
    const jp = await http('POST', `/v1/meetings/${plain.json.code}/join`, 'mem', {});
    expect(jp.json.e2ee).toBe(false);
  });

  it('e2ee must be a boolean', async () => {
    for (const bad of ['true', 1, null, {}]) {
      expect((await http('POST', '/v1/meetings', 'host', { title: 'Bad', e2ee: bad })).status).toBe(400);
    }
  });

  it('no endpoint changes e2ee after creation: PATCH is 409 whoever asks and whatever the value, and the row stays', async () => {
    const e = await http('POST', '/v1/meetings', 'host', { title: 'Locked in', waitingRoom: false, e2ee: true });
    const p = await http('POST', '/v1/meetings', 'host', { title: 'Locked out', waitingRoom: false });
    for (const [m, want] of [[e, false], [p, true], [e, true], [p, false]] as const) {
      const r = await http('PATCH', `/v1/meetings/${m.json.code}`, 'host', { e2ee: want });
      expect(r.status).toBe(409);
      expect(r.text).toMatch(/cannot be changed/);
    }
    expect((await admin.query('SELECT e2ee FROM meetings WHERE code = $1', [e.json.code])).rows[0].e2ee).toBe(true);
    expect((await admin.query('SELECT e2ee FROM meetings WHERE code = $1', [p.json.code])).rows[0].e2ee).toBe(false);
    // a plain member and an anonymous caller are refused before the 409 is even considered
    expect((await http('PATCH', `/v1/meetings/${e.json.code}`, 'mem', { e2ee: false })).status).toBe(403);
    expect((await http('PATCH', `/v1/meetings/${e.json.code}`, null, { e2ee: false })).status).toBe(401);
    // the refusal is audited
    const audit = await admin.query("SELECT count(*)::int AS n FROM audit_log WHERE org_id = $1 AND action = 'meeting.e2ee.change.denied'", [orgId]);
    expect(audit.rows[0].n).toBeGreaterThanOrEqual(4);
  });

  it('other fields cannot be patched either (there is nothing to update), and unknown meetings are 404', async () => {
    const m = await http('POST', '/v1/meetings', 'host', { title: 'Patch me', waitingRoom: false });
    expect((await http('PATCH', `/v1/meetings/${m.json.code}`, 'host', { title: 'x' })).status).toBe(400);
    expect((await http('PATCH', '/v1/meetings/99999999999', 'host', { e2ee: true })).status).toBe(404);
  });

  it('the meeting key is refused if a client ever sends it: unknown fields on create are a 400, never silently stored', async () => {
    const key = 'A'.repeat(43);
    for (const body of [{ title: 'K', e2ee: true, key }, { title: 'K', e2ee: true, e2eeKey: key }, { title: 'K', e2ee: true, k: key }]) {
      const r = await http('POST', '/v1/meetings', 'host', body);
      expect(r.status).toBe(400);
      expect(r.text).not.toContain(key);
    }
    // nothing with that key reached the database
    const leak = await admin.query('SELECT count(*)::int AS n FROM meetings WHERE title LIKE $1', [`%${key}%`]);
    expect(leak.rows[0].n).toBe(0);
  });

  it('the join result and the room carry no key material: only the documented fields', async () => {
    const m = await http('POST', '/v1/meetings', 'host', { title: 'Fields', waitingRoom: false, e2ee: true });
    const j = await http('POST', `/v1/meetings/${m.json.code}/join`, 'host', {});
    // guestMode (the host side's guest setting: off, waiting_room or open) is a setting, not key material.
    expect(Object.keys(j.json).sort()).toEqual(['e2ee', 'guestMode', 'isHost', 'meetingId', 'status', 'title', 'token', 'url']);
    expect(['off', 'waiting_room', 'open']).toContain(j.json.guestMode);
  });
});

describe('E2EE meetings and file sharing', () => {
  it('shared files pass through the server, so an upload into an E2EE meeting is refused (409) and nothing is stored', async () => {
    const { FilesService } = await import('../src/files/files.service.js');
    const files = new FilesService(pool, cfg);
    const u = await pool.query('SELECT org_id, user_id FROM provision_user($1,$2,$3,$4,$5,$6)', [slug, slug, `host-${sfx}`, `host-${sfx}@t.local`, 'host', 'member']);
    const user = { sub: 'h', email: 'h', name: 'h', orgSlug: slug, role: 'member' as const, orgId: u.rows[0].org_id, userId: u.rows[0].user_id };
    const m = await http('POST', '/v1/meetings', 'host', { title: 'No files', waitingRoom: false, e2ee: true });
    await expect(files.upload(user, m.json.code as unknown as string, 'plan.txt', Buffer.from('plain text'))).rejects.toMatchObject({ status: 409 });
    const n = await admin.query('SELECT count(*)::int AS n FROM meeting_files WHERE meeting_id = $1', [m.json.id]);
    expect(n.rows[0].n).toBe(0);
  });
});

describe('E2EE meetings and recording', () => {
  it('server-side recording is refused for an E2EE meeting created through the API (409)', async () => {
    const media: MediaPort = {
      setRecordingFlag: async () => undefined,
      startRoomComposite: async () => ({ egressId: 'EG' }),
      stop: async () => undefined,
      status: async () => ({ state: 'active' }),
    };
    const store: ObjectStore = { ensure: async () => undefined, get: async () => { throw new Error('unused'); }, put: async () => undefined, delete: async () => undefined };
    const rec = new RecordingService(pool, { media, store, master: Buffer.alloc(32, 7), settleDelayMs: 20 });
    const m = await http('POST', '/v1/meetings', 'host', { title: 'No rec', waitingRoom: false, e2ee: true });
    const u = await pool.query('SELECT org_id, user_id FROM provision_user($1,$2,$3,$4,$5,$6)', [slug, slug, `host-${sfx}`, `host-${sfx}@t.local`, 'host', 'member']);
    const user = { sub: 'h', email: 'h', name: 'h', orgSlug: slug, role: 'member' as const, orgId: u.rows[0].org_id, userId: u.rows[0].user_id };
    await expect(rec.start(user, m.json.code as unknown as string)).rejects.toMatchObject({ status: 409 });
  });
});
