import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { decodeJwt } from 'jose';
import { RoomServiceClient } from 'livekit-server-sdk';
import { loadConfig } from '../src/config.js';
import { MeetingError, MeetingsService, type JoinResult, type JoinedResult } from '../src/meetings/meetings.service.js';
import type { AuthedUser } from '../src/auth/auth.guard.js';

// Integration: real Postgres (RLS) and real LiveKit server.
const cfg = loadConfig();
const adminUrl = process.env.MIGRATE_DATABASE_URL;
if (!adminUrl) throw new Error('MIGRATE_DATABASE_URL is required for tests');
const pool = new Pool({ connectionString: cfg.DATABASE_URL, max: 4 });
const admin = new Pool({ connectionString: adminUrl, max: 2 });
const svc = new MeetingsService(pool, cfg);
const sfx = Math.random().toString(36).slice(2, 8);

async function mkUser(slug: string, sub: string, role: 'org_admin' | 'member'): Promise<AuthedUser> {
  const r = await pool.query('SELECT org_id, user_id, role FROM provision_user($1,$2,$3,$4,$5,$6)', [
    slug, slug, sub, `${sub}@t.local`, sub, role,
  ]);
  return { sub, email: `${sub}@t.local`, name: sub, orgSlug: slug, role, orgId: r.rows[0].org_id, userId: r.rows[0].user_id };
}

function joined(r: JoinResult): JoinedResult {
  if (r.status !== 'joined') throw new Error('expected an immediate join');
  return r;
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

let host: AuthedUser, member: AuthedUser, outsider: AuthedUser;
const slugA = `mt-a-${sfx}`;
const slugB = `mt-b-${sfx}`;

beforeAll(async () => {
  host = await mkUser(slugA, `host-${sfx}`, 'org_admin');
  member = await mkUser(slugA, `member-${sfx}`, 'member');
  outsider = await mkUser(slugB, `out-${sfx}`, 'member');
});
afterAll(async () => {
  await admin.query('DELETE FROM organizations WHERE slug IN ($1,$2)', [slugA, slugB]);
  await pool.end();
  await admin.end();
});

describe('meetings against real Postgres and LiveKit', () => {
  it('creates a meeting with an 11-digit code and hides the passcode hash', async () => {
    const m = await svc.create(host, { waitingRoom: false, title: 'Standup', passcode: 'secret-pass' });
    expect(m.code).toMatch(/^[1-9][0-9]{10}$/);
    expect(m.has_passcode).toBe(true);
    expect(JSON.stringify(m)).not.toContain('argon2');
  });

  it('returns created_at on create and in the list, newest first', async () => {
    const before = Date.now() - 5000;
    const a = await svc.create(host, { waitingRoom: false, title: 'Created-a' });
    const b = await svc.create(host, { waitingRoom: false, title: 'Created-b', scheduledAt: '2031-01-01T10:00:00Z' });
    for (const m of [a, b]) {
      expect(m.created_at).toBeInstanceOf(Date);
      expect(m.created_at.getTime()).toBeGreaterThan(before);
    }
    const rows = await svc.list(host);
    const ra = rows.find((r) => r.id === a.id);
    expect(ra?.created_at.getTime()).toBe(a.created_at.getTime());
    expect(rows.findIndex((r) => r.id === b.id)).toBeLessThan(rows.findIndex((r) => r.id === a.id));
  });

  it('host joins and gets a short-lived, room-scoped admin token; the room exists in LiveKit', async () => {
    const m = await svc.create(host, { waitingRoom: false, title: 'Room test', passcode: 'secret-pass' });
    const j = joined(await svc.join(host, m.code));
    const claims = decodeJwt(j.token) as { exp: number; nbf: number; video: { room: string; roomAdmin: boolean; roomJoin: boolean } };
    expect(claims.exp - claims.nbf).toBeLessThanOrEqual(900);
    expect(claims.video.room).toBe(m.id);
    expect(claims.video.roomJoin).toBe(true);
    expect(claims.video.roomAdmin).toBe(true);
    const rooms = await new RoomServiceClient(cfg.LIVEKIT_API_URL, cfg.LIVEKIT_API_KEY, cfg.LIVEKIT_API_SECRET).listRooms([m.id]);
    expect(rooms.map((r) => r.name)).toContain(m.id);
  });

  it('a member needs the right passcode and is not an admin', async () => {
    const m = await svc.create(host, { waitingRoom: false, title: 'Pass', passcode: 'secret-pass' });
    expect(await status(svc.join(member, m.code))).toBe(403);
    expect(await status(svc.join(member, m.code, 'nope-nope'))).toBe(403);
    const j = joined(await svc.join(member, m.code, 'secret-pass'));
    expect((decodeJwt(j.token) as { video: { roomAdmin: boolean } }).video.roomAdmin).toBe(false);
  });

  it('blocks after repeated wrong passcodes, even with the right one', async () => {
    const m = await svc.create(host, { waitingRoom: false, title: 'Brute', passcode: 'secret-pass' });
    for (let i = 0; i < 5; i++) expect(await status(svc.join(member, m.code, `wrong-${i}-xx`))).toBe(403);
    expect(await status(svc.join(member, m.code, 'secret-pass'))).toBe(429);
  });

  it('a locked meeting refuses members but not the host', async () => {
    const m = await svc.create(host, { waitingRoom: false, title: 'Locked' });
    await admin.query('UPDATE meetings SET locked = true WHERE id = $1', [m.id]);
    expect(await status(svc.join(member, m.code))).toBe(403);
    expect(await status(svc.join(host, m.code))).toBe(200);
  });

  it('the host ends the meeting for everyone: the room closes; a member or another organization cannot', async () => {
    const m = await svc.create(host, { waitingRoom: false, title: 'End me' });
    joined(await svc.join(host, m.code));
    joined(await svc.join(member, m.code));
    expect(await status(svc.end(member, m.code))).toBe(403);
    expect(await status(svc.end(outsider, m.code))).toBe(404);
    expect(await svc.end(host, m.code)).toEqual({ ended: true });
    const rooms = await (svc as unknown as { rooms: { listRooms: (n: string[]) => Promise<unknown[]> } }).rooms.listRooms([m.id]);
    expect(rooms.length).toBe(0);
    const audit = await admin.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'meeting.end' AND target = $1", [m.code]);
    expect(audit.rows[0].n).toBe(1);
    expect(await svc.end(host, m.code)).toEqual({ ended: true }); // ending again (no room) is harmless
  });

  it('another organization cannot find the meeting at all', async () => {
    const m = await svc.create(host, { waitingRoom: false, title: 'Private' });
    expect(await status(svc.join(outsider, m.code))).toBe(404);
    expect((await svc.list(outsider)).some((x: { code: string }) => x.code === m.code)).toBe(false);
  });

  it('rejects malformed codes without a database lookup', async () => {
    for (const bad of ['', 'abc', '123', "1'; DROP TABLE meetings;--", '1'.repeat(30)]) {
      expect(await status(svc.join(member, bad))).toBe(404);
    }
  });

  it('writes an audit record when a meeting is created', async () => {
    const m = await svc.create(host, { waitingRoom: false, title: 'Audited' });
    const r = await admin.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'meeting.create' AND target = $1", [m.code]);
    expect(r.rows[0].n).toBe(1);
  });
});
