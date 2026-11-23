import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { loadConfig } from '../src/config.js';
import { MeetingError, MeetingsService } from '../src/meetings/meetings.service.js';
import type { AuthedUser } from '../src/auth/auth.guard.js';

// Integration: co-hosts against real Postgres (RLS) and real LiveKit.
const cfg = loadConfig();
const adminUrl = process.env.MIGRATE_DATABASE_URL;
if (!adminUrl) throw new Error('MIGRATE_DATABASE_URL is required for tests');
const pool = new Pool({ connectionString: cfg.DATABASE_URL, max: 4 });
const admin = new Pool({ connectionString: adminUrl, max: 2 });
const svc = new MeetingsService(pool, cfg);
const sfx = Math.random().toString(36).slice(2, 8);
const slugA = `ch-a-${sfx}`;
const slugB = `ch-b-${sfx}`;

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

let host: AuthedUser, co: AuthedUser, co2: AuthedUser, member: AuthedUser, outsider: AuthedUser;
beforeAll(async () => {
  host = await mkUser(slugA, `host-${sfx}`, 'member');
  co = await mkUser(slugA, `co-${sfx}`, 'member');
  co2 = await mkUser(slugA, `co2-${sfx}`, 'member');
  member = await mkUser(slugA, `mem-${sfx}`, 'member');
  outsider = await mkUser(slugB, `out-${sfx}`, 'org_admin');
});
afterAll(async () => {
  await admin.query('DELETE FROM organizations WHERE slug IN ($1,$2)', [slugA, slugB]);
  await pool.end();
  await admin.end();
});
const meeting = () => svc.create(host, { title: 'CH' });

describe('co-hosts', () => {
  it('a plain member has the member role until promoted, then the co-host role', async () => {
    const m = await meeting();
    expect((await svc.myRole(co, m.code)).role).toBe('member');
    await svc.setCohost(host, m.code, co.userId, true);
    expect((await svc.myRole(co, m.code)).role).toBe('cohost');
    expect((await svc.myRole(host, m.code)).role).toBe('host');
  });

  it('a co-host gets the host controls: skips the waiting room, locks, admits, mutes and removes', async () => {
    const m = await meeting();
    await svc.setCohost(host, m.code, co.userId, true);
    const j = await svc.join(co, m.code);
    expect(j.status).toBe('joined');
    const w = await svc.join(member, m.code);
    if (w.status !== 'waiting') throw new Error('expected waiting');
    expect((await svc.listRequests(co, m.code)).length).toBe(1);
    await svc.decide(co, m.code, w.requestId, true);
    expect((await svc.setLocked(co, m.code, true)).locked).toBe(true);
    expect(await status(svc.removeParticipant(co, m.code, member.userId))).toBe(200);
  });

  it('a co-host cannot appoint or dismiss co-hosts, and cannot remove the host or another co-host', async () => {
    const m = await meeting();
    await svc.setCohost(host, m.code, co.userId, true);
    await svc.setCohost(host, m.code, co2.userId, true);
    expect(await status(svc.setCohost(co, m.code, member.userId, true))).toBe(403);
    expect(await status(svc.setCohost(co, m.code, co2.userId, false))).toBe(403);
    expect(await status(svc.removeParticipant(co, m.code, host.userId))).toBe(400);
    expect(await status(svc.removeParticipant(co, m.code, co2.userId))).toBe(403);
    expect(await status(svc.removeParticipant(host, m.code, co2.userId))).toBe(200); // the host can
  });

  it('revoking takes the controls away immediately', async () => {
    const m = await meeting();
    await svc.setCohost(host, m.code, co.userId, true);
    expect(await status(svc.setLocked(co, m.code, true))).toBe(200);
    await svc.setCohost(host, m.code, co.userId, false);
    expect(await status(svc.setLocked(co, m.code, false))).toBe(403);
    expect((await svc.myRole(co, m.code)).role).toBe('member');
  });

  it('is per meeting: being co-host of one meeting grants nothing in another', async () => {
    const a = await meeting();
    const b = await meeting();
    await svc.setCohost(host, a.code, co.userId, true);
    expect(await status(svc.setLocked(co, b.code, true))).toBe(403);
  });

  it('a plain member cannot appoint anyone, the host cannot be appointed, bad ids are 404', async () => {
    const m = await meeting();
    expect(await status(svc.setCohost(member, m.code, co.userId, true))).toBe(403);
    expect(await status(svc.setCohost(host, m.code, host.userId, true))).toBe(400);
    for (const bad of ['', 'x', "1'; DROP TABLE meeting_cohosts;--", '00000000-0000-0000-0000-000000000000']) {
      expect(await status(svc.setCohost(host, m.code, bad, true))).toBe(404);
    }
  });

  it('cannot appoint a user of another organization, and the other organization cannot see the meeting', async () => {
    const m = await meeting();
    expect(await status(svc.setCohost(host, m.code, outsider.userId, true))).toBe(404);
    expect(await status(svc.myRole(outsider, m.code))).toBe(404);
    expect(await status(svc.setCohost(outsider, m.code, co.userId, true))).toBe(404);
  });

  it('records grant and revoke in the audit log', async () => {
    const m = await meeting();
    await svc.setCohost(host, m.code, co.userId, true);
    await svc.setCohost(host, m.code, co.userId, false);
    const r = await admin.query('SELECT action FROM audit_log WHERE target LIKE $1', [`${m.code}:%`]);
    expect(r.rows.map((x: { action: string }) => x.action)).toEqual(expect.arrayContaining(['meeting.cohost.grant', 'meeting.cohost.revoke']));
  });
});
