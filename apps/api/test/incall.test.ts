import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { decodeJwt } from 'jose';
import { RoomServiceClient } from 'livekit-server-sdk';
import { loadConfig } from '../src/config.js';
import { MeetingError, MeetingsService } from '../src/meetings/meetings.service.js';
import type { AuthedUser } from '../src/auth/auth.guard.js';
import { livekitClientOptions } from '../src/common/timeouts.js';

// Integration: in-call host controls (mute all, spotlight) and the server-set role attribute, against real Postgres and LiveKit.
const cfg = loadConfig();
const adminUrl = process.env.MIGRATE_DATABASE_URL;
if (!adminUrl) throw new Error('MIGRATE_DATABASE_URL is required for tests');
const pool = new Pool({ connectionString: cfg.DATABASE_URL, max: 4 });
const admin = new Pool({ connectionString: adminUrl, max: 2 });
const svc = new MeetingsService(pool, cfg);
const rooms = new RoomServiceClient(cfg.LIVEKIT_API_URL, cfg.LIVEKIT_API_KEY, cfg.LIVEKIT_API_SECRET, livekitClientOptions());
const sfx = Math.random().toString(36).slice(2, 8);
const slug = `ic-${sfx}`;

async function mkUser(sub: string, role: 'org_admin' | 'member'): Promise<AuthedUser> {
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
type Claims = { attributes?: Record<string, string>; video: { canUpdateOwnMetadata?: boolean } };
const claimsOf = (j: Awaited<ReturnType<MeetingsService['join']>>): Claims => {
  if (j.status !== 'joined') throw new Error('not joined');
  return decodeJwt(j.token) as Claims;
};

let host: AuthedUser, co: AuthedUser, member: AuthedUser;
beforeAll(async () => {
  host = await mkUser(`host-${sfx}`, 'member');
  co = await mkUser(`co-${sfx}`, 'member');
  member = await mkUser(`mem-${sfx}`, 'member');
});
afterAll(async () => {
  await admin.query('DELETE FROM organizations WHERE slug = $1', [slug]);
  await pool.end();
  await admin.end();
});

describe('role attribute in the join token', () => {
  it('host, co-host and member each get their role; nobody may update their own attributes', async () => {
    const m = await svc.create(host, { title: 'IC roles', waitingRoom: false });
    await svc.setCohost(host, m.code, co.userId, true);
    const h = claimsOf(await svc.join(host, m.code));
    const c = claimsOf(await svc.join(co, m.code));
    const p = claimsOf(await svc.join(member, m.code));
    expect(h.attributes?.role).toBe('host');
    expect(c.attributes?.role).toBe('cohost');
    expect(p.attributes?.role).toBe('member');
    for (const x of [h, c, p]) expect(x.video.canUpdateOwnMetadata).toBe(false);
  });
});

describe('mute all', () => {
  it('only a manager can mute everyone; the event is audited without content', async () => {
    const m = await svc.create(host, { title: 'IC mute all' });
    expect(await status(svc.muteAll(member, m.code))).toBe(403);
    await svc.join(host, m.code);
    expect(await svc.muteAll(host, m.code)).toEqual({ muted: 0 });
    await svc.setCohost(host, m.code, co.userId, true);
    expect(await status(svc.muteAll(co, m.code))).toBe(200);
    const r = await admin.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'meeting.mute_all' AND target = $1", [m.code]);
    expect(r.rows[0].n).toBe(2);
  });

  it('a wrong meeting code is not found', async () => {
    expect(await status(svc.muteAll(host, '00000000000'))).toBe(404);
  });
});

describe('spotlight', () => {
  it('members cannot spotlight; a participant who is not in the room cannot be spotlighted', async () => {
    const m = await svc.create(host, { title: 'IC spotlight' });
    await svc.join(host, m.code);
    expect(await status(svc.setSpotlight(member, m.code, null))).toBe(403);
    expect(await status(svc.setSpotlight(host, m.code, member.userId))).toBe(404);
    expect(await status(svc.setSpotlight(host, m.code, 'not-an-identity'))).toBe(404);
  });

  it('clearing writes the room metadata and keeps the recording flag', async () => {
    const m = await svc.create(host, { title: 'IC spotlight meta' });
    await svc.join(host, m.code); // creates the media room
    await rooms.updateRoomMetadata(m.id, JSON.stringify({ recording: true, spotlight: member.userId }));
    expect(await svc.setSpotlight(host, m.code, null)).toEqual({ spotlight: null });
    const [room] = await rooms.listRooms([m.id]);
    expect(JSON.parse(room!.metadata)).toEqual({ recording: true });
    const r = await admin.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'meeting.spotlight.clear' AND target = $1", [m.code]);
    expect(r.rows[0].n).toBe(1);
    await rooms.deleteRoom(m.id).catch(() => undefined);
  });
});
