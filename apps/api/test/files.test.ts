import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { loadConfig } from '../src/config.js';
import { MeetingError, MeetingsService } from '../src/meetings/meetings.service.js';
import { FilesService } from '../src/files/files.service.js';
import { open, seal } from '../src/files/crypto.js';
import { isBlockedName, MAX_FILE_BYTES, sanitizeName } from '../src/files/policy.js';
import { scanBuffer } from '../src/files/clamav.js';
import type { AuthedUser } from '../src/auth/auth.guard.js';

// The EICAR antivirus test string, split so this source file itself is not flagged by scanners.
const EICAR = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$' + 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');

describe('envelope encryption', () => {
  const master = randomBytes(32);
  it('round-trips and the stored blob does not contain the plaintext', () => {
    const plain = Buffer.from('top secret meeting minutes '.repeat(20));
    const { blob, wrappedKey } = seal(master, 'file-1', plain);
    expect(blob.includes(Buffer.from('secret'))).toBe(false);
    expect(open(master, 'file-1', blob, wrappedKey).equals(plain)).toBe(true);
  });
  it('every file gets its own key and nonce', () => {
    const a = seal(master, 'f', Buffer.from('same'));
    const b = seal(master, 'f', Buffer.from('same'));
    expect(a.blob.equals(b.blob)).toBe(false);
    expect(a.wrappedKey).not.toBe(b.wrappedKey);
  });
  it('detects tampering, a wrong master key and a blob moved to another file id', () => {
    const { blob, wrappedKey } = seal(master, 'file-1', Buffer.from('data'));
    const bad = Buffer.from(blob);
    const i = bad.length - 20;
    bad.writeUInt8(bad.readUInt8(i) ^ 0xff, i);
    expect(() => open(master, 'file-1', bad, wrappedKey)).toThrow();
    expect(() => open(randomBytes(32), 'file-1', blob, wrappedKey)).toThrow();
    expect(() => open(master, 'file-2', blob, wrappedKey)).toThrow();
    expect(() => open(master, 'file-1', Buffer.alloc(5), wrappedKey)).toThrow();
  });
});

describe('file policy', () => {
  it('sanitizes names: no paths, no control characters, no hidden names, capped length', () => {
    expect(sanitizeName('../../etc/passwd')).not.toMatch(/[\\/]/);
    expect(sanitizeName('..\\..\\win.ini')).not.toMatch(/[\\/]/);
    expect(sanitizeName('a\u0000b\nc.txt')).toBe('abc.txt');
    expect(sanitizeName('.hidden')).toBe('hidden');
    expect(sanitizeName('   ')).toBeNull();
    expect(sanitizeName('x'.repeat(300) + '.pdf')!.length).toBeLessThanOrEqual(120);
    expect(sanitizeName('x'.repeat(300) + '.pdf')!.endsWith('.pdf')).toBe(true);
  });
  it.each(['setup.exe', 'run.BAT', 'a.js', 'x.ps1', 'report.pdf.exe', 'page.html', 'logo.svg', 'archive.exe.txt', 'tool.jar'])('blocks %s', (n) => {
    expect(isBlockedName(n)).toBe(true);
  });
  it.each(['report.pdf', 'photo.jpg', 'notes.txt', 'sheet.xlsx', 'archive.zip', 'README'])('allows %s', (n) => {
    expect(isBlockedName(n)).toBe(false);
  });
});

describe('clamd client (fake daemon)', () => {
  const fake = (answer: string) =>
    new Promise<{ port: number; close: () => void; received: () => Buffer }>((resolve) => {
      const got: Buffer[] = [];
      const srv = createServer((sock) => {
        sock.on('data', (d) => {
          got.push(typeof d === 'string' ? Buffer.from(d) : d);
          // the stream ends with four zero bytes
          if (Buffer.concat(got).subarray(-4).equals(Buffer.alloc(4))) sock.end(answer);
        });
      });
      srv.listen(0, '127.0.0.1', () => resolve({ port: (srv.address() as { port: number }).port, close: () => srv.close(), received: () => Buffer.concat(got) }));
    });
  it('reports clean, infected and rejects unexpected answers (fail closed)', async () => {
    const ok = await fake('stream: OK\0');
    expect(await scanBuffer(Buffer.from('hi'), '127.0.0.1', ok.port)).toEqual({ clean: true });
    expect(ok.received().subarray(0, 10).toString()).toBe('zINSTREAM\0');
    ok.close();
    const bad = await fake('stream: Eicar-Test-Signature FOUND\0');
    expect(await scanBuffer(Buffer.from('x'), '127.0.0.1', bad.port)).toEqual({ clean: false, signature: 'Eicar-Test-Signature' });
    bad.close();
    const weird = await fake('INSTREAM size limit exceeded. ERROR\0');
    await expect(scanBuffer(Buffer.from('x'), '127.0.0.1', weird.port)).rejects.toThrow(/unexpected/);
    weird.close();
  });
  it('rejects when nothing is listening', async () => {
    await expect(scanBuffer(Buffer.from('x'), '127.0.0.1', 1, 2000)).rejects.toThrow();
  });
});

// Integration: real Postgres (RLS), real LiveKit, real MinIO and real ClamAV.
const cfg = loadConfig();
const adminUrl = process.env.MIGRATE_DATABASE_URL;
if (!adminUrl) throw new Error('MIGRATE_DATABASE_URL is required for tests');
if (!cfg.S3_ENDPOINT || !cfg.CLAMAV_HOST) throw new Error('S3_ENDPOINT and CLAMAV_HOST are required for tests (source scripts/devenv.sh)');
const pool = new Pool({ connectionString: cfg.DATABASE_URL, max: 4 });
const admin = new Pool({ connectionString: adminUrl, max: 2 });
const meetings = new MeetingsService(pool, cfg);
const files = new FilesService(pool, cfg);
const { S3_ACCESS_KEY: accessKeyId, S3_SECRET_KEY: secretAccessKey } = cfg;
const s3 = new S3Client({ endpoint: cfg.S3_ENDPOINT, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey! } });
const sfx = Math.random().toString(36).slice(2, 8);
const slugA = `fl-a-${sfx}`;
const slugB = `fl-b-${sfx}`;

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

let host: AuthedUser, alice: AuthedUser, bob: AuthedUser, stranger: AuthedUser, outsider: AuthedUser;
beforeAll(async () => {
  host = await mkUser(slugA, `host-${sfx}`, 'member');
  alice = await mkUser(slugA, `alice-${sfx}`, 'member');
  bob = await mkUser(slugA, `bob-${sfx}`, 'member');
  stranger = await mkUser(slugA, `str-${sfx}`, 'member');
  outsider = await mkUser(slugB, `out-${sfx}`, 'org_admin');
});
afterAll(async () => {
  await admin.query('DELETE FROM organizations WHERE slug IN ($1,$2)', [slugA, slugB]);
  await pool.end();
  await admin.end();
});

async function openMeeting(passcode?: string) {
  const m = await meetings.create(host, { title: 'Files', waitingRoom: false, passcode });
  await meetings.join(host, m.code);
  await meetings.join(alice, m.code, passcode);
  return m;
}

describe('file sharing against real MinIO and ClamAV', () => {
  it('is enabled in this environment', () => expect(files.enabled).toBe(true));

  it('a participant uploads, another downloads identical bytes, and storage holds only ciphertext', async () => {
    const m = await openMeeting();
    await meetings.join(bob, m.code);
    const plain = Buffer.from('quarterly numbers: 1,2,3,4,5 '.repeat(100));
    const up = await files.upload(alice, m.code, 'Q3 report.txt', plain);
    expect(up).toMatchObject({ name: 'Q3 report.txt', size: plain.length });
    const dl = await files.download(bob, m.code, up.id);
    expect(dl.name).toBe('Q3 report.txt');
    expect(dl.data.equals(plain)).toBe(true);
    const row = (await admin.query('SELECT object_key FROM meeting_files WHERE id = $1', [up.id])).rows[0];
    const raw = Buffer.from(await (await s3.send(new GetObjectCommand({ Bucket: cfg.S3_BUCKET, Key: row.object_key }))).Body!.transformToByteArray());
    expect(raw.includes(Buffer.from('quarterly'))).toBe(false);
  });

  it('rejects a file with a virus (EICAR) and stores nothing', async () => {
    const m = await openMeeting();
    expect(await status(files.upload(alice, m.code, 'invoice.txt', EICAR))).toBe(422);
    const n = await admin.query('SELECT count(*)::int AS n FROM meeting_files WHERE meeting_id = $1', [m.id]);
    expect(n.rows[0].n).toBe(0);
  });

  it('enforces name, size and emptiness rules', async () => {
    const m = await openMeeting();
    expect(await status(files.upload(alice, m.code, 'setup.exe', Buffer.from('MZ')))).toBe(415);
    expect(await status(files.upload(alice, m.code, 'report.pdf.js', Buffer.from('x')))).toBe(415);
    expect(await status(files.upload(alice, m.code, '   ', Buffer.from('x')))).toBe(400);
    expect(await status(files.upload(alice, m.code, 'empty.txt', Buffer.alloc(0)))).toBe(400);
    expect(await status(files.upload(alice, m.code, 'big.bin', Buffer.alloc(MAX_FILE_BYTES + 1, 1)))).toBe(413);
    const traversal = await files.upload(alice, m.code, '../../etc/passwd', Buffer.from('x'));
    expect(traversal.name).not.toMatch(/[\\/]/);
  });

  it('only people who really entered the meeting can upload or download', async () => {
    const m = await openMeeting('secret-pass');
    const up = await files.upload(alice, m.code, 'a.txt', Buffer.from('hello'));
    // knows the code but never passed the passcode: no access
    expect(await status(files.upload(stranger, m.code, 'x.txt', Buffer.from('x')))).toBe(403);
    expect(await status(files.download(stranger, m.code, up.id))).toBe(403);
    // another organization cannot even see the meeting
    expect(await status(files.download(outsider, m.code, up.id))).toBe(404);
    expect(await status(files.upload(outsider, m.code, 'x.txt', Buffer.from('x')))).toBe(404);
  });

  it('a user waiting in the waiting room gets no file access until admitted', async () => {
    const m = await meetings.create(host, { title: 'WR files' });
    await meetings.join(host, m.code);
    const up = await files.upload(host, m.code, 'a.txt', Buffer.from('hello'));
    const w = await meetings.join(bob, m.code);
    if (w.status !== 'waiting') throw new Error('expected waiting');
    expect(await status(files.download(bob, m.code, up.id))).toBe(403);
    await meetings.decide(host, m.code, w.requestId, true);
    await meetings.requestStatus(bob, m.code, w.requestId); // collecting the token records the entry
    expect((await files.download(bob, m.code, up.id)).data.toString()).toBe('hello');
  });

  it('a removed (banned) participant loses file access', async () => {
    const m = await openMeeting();
    const up = await files.upload(host, m.code, 'a.txt', Buffer.from('hello'));
    expect((await files.download(alice, m.code, up.id)).data.toString()).toBe('hello');
    await meetings.removeParticipant(host, m.code, alice.userId);
    expect(await status(files.download(alice, m.code, up.id))).toBe(403);
  });

  it('a file id from another meeting is not downloadable through this one', async () => {
    const m1 = await openMeeting();
    const m2 = await openMeeting();
    const up = await files.upload(alice, m1.code, 'a.txt', Buffer.from('hello'));
    expect(await status(files.download(alice, m2.code, up.id))).toBe(404);
    for (const bad of ['', 'x', "1'; DROP TABLE meeting_files;--", '00000000-0000-0000-0000-000000000000']) {
      expect(await status(files.download(alice, m1.code, bad))).toBe(404);
    }
  });

  it('refuses to hand out a file whose stored bytes were tampered with', async () => {
    const m = await openMeeting();
    const up = await files.upload(alice, m.code, 'a.txt', Buffer.from('hello world'));
    const row = (await admin.query('SELECT object_key FROM meeting_files WHERE id = $1', [up.id])).rows[0];
    await s3.send(new PutObjectCommand({ Bucket: cfg.S3_BUCKET, Key: row.object_key, Body: randomBytes(64) }));
    expect(await status(files.download(alice, m.code, up.id))).toBe(500);
  });

  it('fails closed when the antivirus is unreachable', async () => {
    const m = await openMeeting();
    const broken = new FilesService(pool, { ...cfg, CLAMAV_PORT: 1 });
    expect(await status(broken.upload(alice, m.code, 'a.txt', Buffer.from('x')))).toBe(503);
  });

  it('answers 503 when file sharing is not configured', async () => {
    const m = await openMeeting();
    const off = new FilesService(pool, { ...cfg, FILE_MASTER_KEY: undefined });
    expect(off.enabled).toBe(false);
    expect(await status(off.upload(alice, m.code, 'a.txt', Buffer.from('x')))).toBe(503);
  });

  it('rate-limits uploads per user', async () => {
    const m = await openMeeting();
    const results: number[] = [];
    for (let i = 0; i < 22; i++) results.push(await status(files.upload(bob, m.code, `f${i}.txt`, Buffer.from('x'))));
    expect(results.slice(0, 3)).toEqual([403, 403, 403]); // bob never joined this meeting: authorization comes first
    await meetings.join(bob, m.code);
    const r2: number[] = [];
    for (let i = 0; i < 22; i++) r2.push(await status(files.upload(bob, m.code, `g${i}.txt`, Buffer.from('x'))));
    expect(r2.filter((x) => x === 200).length).toBe(20);
    expect(r2.slice(20)).toEqual([429, 429]);
  });

  it('writes upload and download to the audit log', async () => {
    const m = await openMeeting();
    const up = await files.upload(alice, m.code, 'a.txt', Buffer.from('hello'));
    await files.download(host, m.code, up.id);
    const r = await admin.query('SELECT action FROM audit_log WHERE target = $1', [`${m.code}:${up.id}`]);
    expect(r.rows.map((x: { action: string }) => x.action).sort()).toEqual(['file.download', 'file.upload']);
  });
});
