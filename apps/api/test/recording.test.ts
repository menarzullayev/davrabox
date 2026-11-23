import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { loadConfig } from '../src/config.js';
import { MeetingError, MeetingsService } from '../src/meetings/meetings.service.js';
import { RecordingService, type EgressState, type MediaPort, type ObjectStore } from '../src/recording/recording.service.js';
import type { AuthedUser } from '../src/auth/auth.guard.js';

// Integration: the recording API against real Postgres (RLS). LiveKit Egress and the object store are faked, so no
// media server is touched; the fakes record every call, which is how the "nothing was started" cases are proven.
const cfg = loadConfig();
const adminUrl = process.env.MIGRATE_DATABASE_URL;
if (!adminUrl) throw new Error('MIGRATE_DATABASE_URL is required for tests');
const pool = new Pool({ connectionString: cfg.DATABASE_URL, max: 4 });
const admin = new Pool({ connectionString: adminUrl, max: 2 });
const meetings = new MeetingsService(pool, cfg);
const sfx = Math.random().toString(36).slice(2, 8);
const slugA = `rec-a-${sfx}`;
const slugB = `rec-b-${sfx}`;
const master = randomBytes(32);
const PLAIN = Buffer.concat([Buffer.from('RAW-MP4-MARKER-'), randomBytes(5000)]);

class MemStore implements ObjectStore {
  objects = new Map<string, Buffer>();
  async ensure(): Promise<void> {}
  async get(key: string): Promise<Readable> {
    const o = this.objects.get(key);
    if (!o) throw new Error('NoSuchKey');
    return Readable.from([o]);
  }
  async put(key: string, body: Readable, length: number): Promise<void> {
    const parts: Buffer[] = [];
    for await (const p of body) parts.push(p as Buffer);
    const all = Buffer.concat(parts);
    if (all.length !== length) throw new Error('length mismatch');
    this.objects.set(key, all);
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

class FakeMedia implements MediaPort {
  started: Array<{ room: string; key: string }> = [];
  stopped: string[] = [];
  meta: Array<{ room: string; on: boolean }> = [];
  failStart: Error | null = null;
  failMeta = false;
  state: EgressState = 'active';
  constructor(private readonly store: MemStore) {}
  async setRecordingFlag(room: string, on: boolean): Promise<void> {
    if (this.failMeta && on) throw new Error('metadata update failed');
    this.meta.push({ room, on });
  }
  async startRoomComposite(room: string, key: string): Promise<{ egressId: string }> {
    if (this.failStart) throw this.failStart;
    this.started.push({ room, key });
    return { egressId: `EG_${this.started.length}_${sfx}` };
  }
  async stop(): Promise<void> {
    this.stopped.push('x');
    this.state = 'complete';
    const last = this.started[this.started.length - 1]!;
    this.store.objects.set(last.key, Buffer.from(PLAIN)); // Egress uploads the finished file
  }
  async status(): Promise<{ state: EgressState }> {
    return { state: this.state };
  }
  reset() {
    this.started = [];
    this.stopped = [];
    this.meta = [];
    this.state = 'active';
  }
}

const store = new MemStore();
const media = new FakeMedia(store);
const rec = new RecordingService(pool, { media, store, master, settleDelayMs: 20 });

async function mkUser(slug: string, sub: string, role: 'org_admin' | 'member'): Promise<AuthedUser> {
  const r = await pool.query('SELECT org_id, user_id FROM provision_user($1,$2,$3,$4,$5,$6)', [slug, slug, sub, `${sub}@t.local`, sub, role]);
  return { sub, email: `${sub}@t.local`, name: sub, orgSlug: slug, role, orgId: r.rows[0].org_id, userId: r.rows[0].user_id };
}
async function status(p: Promise<unknown>): Promise<number> {
  try {
    await p;
    return 200;
  } catch (e) {
    if (e instanceof MeetingError) return e.status;
    throw e;
  }
}
async function audit(code: string): Promise<string[]> {
  const r = await admin.query('SELECT action FROM audit_log WHERE target LIKE $1 ORDER BY id', [`${code}%`]);
  return r.rows.map((x: { action: string }) => x.action);
}
async function drain(s: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const p of s) parts.push(p as Buffer);
  return Buffer.concat(parts);
}

let host: AuthedUser, co: AuthedUser, member: AuthedUser, orgAdmin: AuthedUser, outsider: AuthedUser;
beforeAll(async () => {
  host = await mkUser(slugA, `host-${sfx}`, 'member');
  co = await mkUser(slugA, `co-${sfx}`, 'member');
  member = await mkUser(slugA, `mem-${sfx}`, 'member');
  orgAdmin = await mkUser(slugA, `adm-${sfx}`, 'org_admin');
  outsider = await mkUser(slugB, `out-${sfx}`, 'org_admin');
});
afterAll(async () => {
  await admin.query('DELETE FROM organizations WHERE slug IN ($1,$2)', [slugA, slugB]);
  await pool.end();
  await admin.end();
});

const meeting = async (e2ee = false) => {
  const m = await meetings.create(host, { title: 'REC' });
  if (e2ee) await admin.query('UPDATE meetings SET e2ee = true WHERE id = $1', [m.id]);
  return m as { id: string; code: string };
};
const fresh = () => {
  media.reset();
  store.objects.clear();
};

describe('recording: who may record', () => {
  it('a plain member cannot start: 403, an audit row, and nothing is started or flagged', async () => {
    fresh();
    const m = await meeting();
    expect(await status(rec.start(member, m.code))).toBe(403);
    expect(media.started).toEqual([]);
    expect(media.meta).toEqual([]);
    expect(await audit(m.code)).toContain('recording.start.denied');
  });

  it('an E2EE meeting refuses to record: 409, an audit row, and nothing is started or flagged', async () => {
    fresh();
    const m = await meeting(true);
    expect(await status(rec.start(host, m.code))).toBe(409);
    expect(media.started).toEqual([]);
    expect(media.meta).toEqual([]);
    expect(await audit(m.code)).toContain('recording.start.denied');
    expect((await rec.status(host, m.code)).e2ee).toBe(true);
  });

  it('the host, a co-host and an org admin can start; the room is flagged before Egress starts', async () => {
    for (const who of ['host', 'cohost', 'admin'] as const) {
      fresh();
      const m = await meeting();
      let user = host;
      if (who === 'cohost') {
        await meetings.setCohost(host, m.code, co.userId, true);
        user = co;
      }
      if (who === 'admin') user = orgAdmin;
      const r = await rec.start(user, m.code);
      expect(r.status).toBe('active');
      expect(media.started.length).toBe(1);
      expect(media.started[0]!.room).toBe(m.id);
      expect(media.meta).toEqual([{ room: m.id, on: true }]);
    }
  });

  it('a second start while recording is 409 and starts nothing more', async () => {
    fresh();
    const m = await meeting();
    await rec.start(host, m.code);
    expect(await status(rec.start(host, m.code))).toBe(409);
    expect(media.started.length).toBe(1);
    expect(await audit(m.code)).toContain('recording.start.denied');
  });

  it('two simultaneous starts produce exactly one recording', async () => {
    fresh();
    const m = await meeting();
    const res = await Promise.all([status(rec.start(host, m.code)), status(rec.start(host, m.code))]);
    expect(res.sort()).toEqual([200, 409]);
    expect(media.started.length).toBe(1);
  });

  it('stop without a running recording is 404 and stops nothing', async () => {
    fresh();
    const m = await meeting();
    expect(await status(rec.stop(host, m.code))).toBe(404);
    expect(media.stopped).toEqual([]);
  });

  it('a member cannot stop a recording: 403, an audit row, Egress keeps running', async () => {
    fresh();
    const m = await meeting();
    await rec.start(host, m.code);
    expect(await status(rec.stop(member, m.code))).toBe(403);
    expect(media.stopped).toEqual([]);
    expect(await audit(m.code)).toContain('recording.stop.denied');
  });

  it('bad or foreign meeting codes are 404', async () => {
    fresh();
    const m = await meeting();
    for (const bad of ['', 'x', "1'; DROP TABLE recordings;--", '00000000000']) expect(await status(rec.start(host, bad))).toBe(404);
    expect(await status(rec.start(outsider, m.code))).toBe(404);
    expect(media.started).toEqual([]);
  });
});

describe('recording: failures never leave a recording without its consent flag', () => {
  it('if the room flag cannot be set, Egress is not started: 502 and the row is failed', async () => {
    fresh();
    const m = await meeting();
    media.failMeta = true;
    try {
      expect(await status(rec.start(host, m.code))).toBe(502);
    } finally {
      media.failMeta = false;
    }
    expect(media.started).toEqual([]);
    const r = await admin.query('SELECT status FROM recordings WHERE meeting_id = $1', [m.id]);
    expect(r.rows.map((x: { status: string }) => x.status)).toEqual(['failed']);
    expect((await rec.start(host, m.code)).status).toBe('active'); // not blocked by the failed row
  });

  it('if Egress refuses to start, the flag is cleared again and the row is failed', async () => {
    fresh();
    const m = await meeting();
    media.failStart = new Error('egress unavailable');
    try {
      expect(await status(rec.start(host, m.code))).toBe(502);
    } finally {
      media.failStart = null;
    }
    expect(media.meta).toEqual([
      { room: m.id, on: true },
      { room: m.id, on: false },
    ]);
    const r = await admin.query('SELECT status FROM recordings WHERE meeting_id = $1', [m.id]);
    expect(r.rows[0].status).toBe('failed');
  });

  it('a room that does not exist yet (nobody has joined) is a 409, not a server error', async () => {
    fresh();
    const m = await meeting();
    media.failStart = new Error('requested room does not exist');
    try {
      expect(await status(rec.start(host, m.code))).toBe(409);
    } finally {
      media.failStart = null;
    }
  });
});

describe('recording: stop, encrypt, list, download', () => {
  it('after stop the stored object is encrypted, the plaintext is gone, and download returns the original', async () => {
    fresh();
    const m = await meeting();
    const started = await rec.start(host, m.code);
    const stopped = await rec.stop(host, m.code);
    expect(stopped.id).toBe(started.id);
    expect(media.meta[media.meta.length - 1]).toEqual({ room: m.id, on: false });
    await rec.settleNow(host.orgId, started.id);

    const keys = [...store.objects.keys()];
    expect(keys.length).toBe(1);
    expect(keys[0]).not.toBe(media.started[0]!.key); // only the encrypted copy remains
    const blob = store.objects.get(keys[0]!)!;
    expect(blob.includes(Buffer.from('RAW-MP4-MARKER-'))).toBe(false);

    const row = await admin.query('SELECT status, size_bytes::int AS size, wrapped_key FROM recordings WHERE id = $1', [started.id]);
    expect(row.rows[0].status).toBe('ready');
    expect(row.rows[0].size).toBe(PLAIN.length);
    expect(row.rows[0].wrapped_key).toBeTruthy();

    const d = await rec.download(host, started.id);
    expect((await drain(d.stream)).equals(PLAIN)).toBe(true);
    expect(d.name).toMatch(/\.mp4$/);
  });

  it('a recording is not downloadable before it is processed: 409', async () => {
    fresh();
    const m = await meeting();
    const started = await rec.start(host, m.code);
    expect(await status(rec.download(host, started.id))).toBe(409);
  });

  it('records start, stop, list and download in the audit log', async () => {
    fresh();
    const m = await meeting();
    const s = await rec.start(host, m.code);
    await rec.stop(host, m.code);
    await rec.settleNow(host.orgId, s.id);
    await rec.list(host, m.code);
    await rec.download(host, s.id);
    const a = await audit(m.code);
    expect(a).toEqual(expect.arrayContaining(['recording.start', 'recording.stop', 'recording.list']));
    const d = await admin.query("SELECT action FROM audit_log WHERE target = $1 AND action = 'recording.download'", [`${m.code}:${s.id}`]);
    expect(d.rowCount).toBe(1);
  });

  it('download by a plain member is 403 with an audit row; by another organization it is 404', async () => {
    fresh();
    const m = await meeting();
    const s = await rec.start(host, m.code);
    await rec.stop(host, m.code);
    await rec.settleNow(host.orgId, s.id);
    expect(await status(rec.download(member, s.id))).toBe(403);
    expect(await status(rec.download(outsider, s.id))).toBe(404);
    expect(await audit(m.code)).toContain('recording.download.denied');
    for (const bad of ['', 'x', '00000000-0000-0000-0000-000000000000', "1'; DROP TABLE recordings;--"]) {
      expect(await status(rec.download(host, bad))).toBe(404);
    }
  });

  it('list is for managers only and never exposes object keys or wrapped keys', async () => {
    fresh();
    const m = await meeting();
    const s = await rec.start(host, m.code);
    await rec.stop(host, m.code);
    await rec.settleNow(host.orgId, s.id);
    expect(await status(rec.list(member, m.code))).toBe(403);
    expect(await status(rec.list(outsider, m.code))).toBe(404);
    const l = await rec.list(orgAdmin, m.code);
    expect(l.length).toBe(1);
    expect(l[0]!.status).toBe('ready');
    expect(Object.keys(l[0]!).sort()).toEqual(['endedAt', 'id', 'sizeBytes', 'startedAt', 'startedBy', 'status']);
  });

  it('a tampered or truncated stored object fails its integrity check instead of streaming garbage', async () => {
    fresh();
    const m = await meeting();
    const s = await rec.start(host, m.code);
    await rec.stop(host, m.code);
    await rec.settleNow(host.orgId, s.id);
    const key = [...store.objects.keys()][0]!;
    const good = store.objects.get(key)!;
    const bad = Buffer.from(good);
    bad.writeUInt8(bad.readUInt8(100) ^ 0xff, 100);
    store.objects.set(key, bad);
    await expect(drain((await rec.download(host, s.id)).stream)).rejects.toThrow();
    store.objects.set(key, good.subarray(0, good.length - 10));
    await expect(drain((await rec.download(host, s.id)).stream)).rejects.toThrow();
  });

  it('a recording whose Egress failed is marked failed and never downloadable', async () => {
    fresh();
    const m = await meeting();
    const s = await rec.start(host, m.code);
    media.state = 'failed';
    await rec.settleNow(host.orgId, s.id);
    const r = await admin.query('SELECT status FROM recordings WHERE id = $1', [s.id]);
    expect(r.rows[0].status).toBe('failed');
    expect(await status(rec.download(host, s.id))).toBe(409);
    expect((await rec.start(host, m.code)).status).toBe('active'); // a failed row does not block the next recording
  });

  it('a stale in-flight recording (Egress ended on its own) is reconciled so the next start works', async () => {
    fresh();
    const m = await meeting();
    await rec.start(host, m.code);
    media.state = 'complete';
    media.started[0] && store.objects.set(media.started[0].key, Buffer.from(PLAIN));
    expect((await rec.start(host, m.code)).status).toBe('active');
    expect(media.started.length).toBe(2);
  });
});

describe('recording: not configured', () => {
  it('answers 503 and touches nothing', async () => {
    const off = new RecordingService(pool, null);
    expect(off.enabled).toBe(false);
    const m = await meeting();
    expect(await status(off.start(host, m.code))).toBe(503);
    expect(await status(off.list(host, m.code))).toBe(503);
    expect(await status(off.download(host, '00000000-0000-0000-0000-000000000000'))).toBe(503);
  });
});
