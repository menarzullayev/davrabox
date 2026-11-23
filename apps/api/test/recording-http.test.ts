import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Pool } from 'pg';
import { AuthGuard, POOL, VERIFIER } from '../src/auth/auth.guard.js';
import { RECORDING, RecordingController } from '../src/recording/recording.controller.js';
import { RecordingService, type MediaPort, type ObjectStore } from '../src/recording/recording.service.js';
import { loadConfig } from '../src/config.js';
import { MeetingsService } from '../src/meetings/meetings.service.js';

// The HTTP layer: routes, status codes, the download stream and headers. Auth is a fake verifier (tokens "tok-<sub>").
const cfg = loadConfig();
const adminUrl = process.env.MIGRATE_DATABASE_URL!;
const pool = new Pool({ connectionString: cfg.DATABASE_URL, max: 4 });
const admin = new Pool({ connectionString: adminUrl, max: 2 });
const sfx = Math.random().toString(36).slice(2, 8);
const slug = `rech-${sfx}`;
const PLAIN = Buffer.concat([Buffer.from('HTTP-MP4-'), randomBytes(2000)]);

const objects = new Map<string, Buffer>();
const store: ObjectStore = {
  ensure: async () => undefined,
  get: async (k) => Readable.from([objects.get(k)!]),
  put: async (k, body, len) => {
    const parts: Buffer[] = [];
    for await (const p of body) parts.push(p as Buffer);
    const b = Buffer.concat(parts);
    if (b.length !== len) throw new Error('length');
    objects.set(k, b);
  },
  delete: async (k) => void objects.delete(k),
};
let lastKey = '';
let ended = false;
const media: MediaPort = {
  setRecordingFlag: async () => undefined,
  startRoomComposite: async (_r, key) => {
    lastKey = key;
    return { egressId: 'EG_http' };
  },
  stop: async () => {
    ended = true;
    objects.set(lastKey, Buffer.from(PLAIN));
  },
  status: async () => ({ state: ended ? 'complete' : 'active' }),
};
const svc = new RecordingService(pool, { media, store, master: randomBytes(32), settleDelayMs: 20 });

const subs: Record<string, { email: string; role: 'org_admin' | 'member' }> = {
  [`host-${sfx}`]: { email: `host-${sfx}@t.local`, role: 'member' },
  [`mem-${sfx}`]: { email: `mem-${sfx}@t.local`, role: 'member' },
};

@Module({
  controllers: [RecordingController],
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
    { provide: RECORDING, useValue: svc },
    AuthGuard,
  ],
})
class TestModule {}

let app: INestApplication;
let base = '';
const call = (path: string, who: string | null, method = 'GET') =>
  fetch(base + path, { method, headers: who ? { authorization: `Bearer tok-${who}-${sfx}` } : {} });

let code = '';
let orgId = '';
beforeAll(async () => {
  app = await NestFactory.create(TestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  const host = await pool.query('SELECT org_id, user_id FROM provision_user($1,$2,$3,$4,$5,$6)', [slug, slug, `host-${sfx}`, `host-${sfx}@t.local`, 'host', 'member']);
  await pool.query('SELECT 1 FROM provision_user($1,$2,$3,$4,$5,$6)', [slug, slug, `mem-${sfx}`, `mem-${sfx}@t.local`, 'mem', 'member']);
  const m = await new MeetingsService(pool, cfg).create(
    { sub: 'h', email: 'h', name: 'h', orgSlug: slug, role: 'member', orgId: host.rows[0].org_id, userId: host.rows[0].user_id },
    { title: 'HTTP' },
  );
  code = m.code;
  orgId = host.rows[0].org_id;
});
afterAll(async () => {
  await app.close();
  await admin.query('DELETE FROM organizations WHERE slug = $1', [slug]);
  await pool.end();
  await admin.end();
});

describe('recording HTTP', () => {
  it('every route needs a bearer token', async () => {
    for (const [path, method] of [[`/v1/meetings/${code}/recording`, 'GET'], [`/v1/meetings/${code}/recording/start`, 'POST'], [`/v1/meetings/${code}/recording/stop`, 'POST'], [`/v1/meetings/${code}/recordings`, 'GET'], ['/v1/recordings/00000000-0000-0000-0000-000000000000/download', 'GET']] as const) {
      expect((await call(path, null, method)).status).toBe(401);
    }
  });

  it('a member gets 403 on start, stop, list; a stranger meeting code is 404; the body leaks no stack', async () => {
    expect((await call(`/v1/meetings/${code}/recording/start`, 'mem', 'POST')).status).toBe(403);
    expect((await call(`/v1/meetings/${code}/recording/stop`, 'mem', 'POST')).status).toBe(403);
    const list = await call(`/v1/meetings/${code}/recordings`, 'mem');
    expect(list.status).toBe(403);
    expect(await list.text()).not.toMatch(/at .*\.ts|node_modules/);
    expect((await call('/v1/meetings/99999999999/recording/start', 'host', 'POST')).status).toBe(404);
  });

  it('the host starts, a second start is 409, stop, then the file downloads as an attachment with the original bytes', async () => {
    const start = await call(`/v1/meetings/${code}/recording/start`, 'host', 'POST');
    expect(start.status).toBe(200);
    const { id } = (await start.json()) as { id: string };
    expect((await call(`/v1/meetings/${code}/recording/start`, 'host', 'POST')).status).toBe(409);
    expect(((await (await call(`/v1/meetings/${code}/recording`, 'host')).json()) as { active: boolean }).active).toBe(true);
    expect((await call(`/v1/meetings/${code}/recording/stop`, 'host', 'POST')).status).toBe(200);
    await svc.settleNow(orgId, id);
    const dl = await call(`/v1/recordings/${id}/download`, 'host');
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-disposition')).toMatch(/^attachment; filename=".*\.mp4"/);
    expect(dl.headers.get('x-content-type-options')).toBe('nosniff');
    expect(dl.headers.get('cache-control')).toMatch(/no-store/);
    expect(Buffer.from(await dl.arrayBuffer()).equals(PLAIN)).toBe(true);
    expect((await call(`/v1/recordings/${id}/download`, 'mem')).status).toBe(403);
  });
});
