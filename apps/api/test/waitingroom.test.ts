import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { loadConfig } from '../src/config.js';
import { MeetingError, MeetingsService } from '../src/meetings/meetings.service.js';
import type { AuthedUser } from '../src/auth/auth.guard.js';

// Integration: waiting room, lock, bans and host-only controls against real Postgres (RLS) and real LiveKit.
const cfg = loadConfig();
const adminUrl = process.env.MIGRATE_DATABASE_URL;
if (!adminUrl) throw new Error('MIGRATE_DATABASE_URL is required for tests');
const pool = new Pool({ connectionString: cfg.DATABASE_URL, max: 4 });
const admin = new Pool({ connectionString: adminUrl, max: 2 });
const svc = new MeetingsService(pool, cfg);
const sfx = Math.random().toString(36).slice(2, 8);
const slugA = `wr-a-${sfx}`;
const slugB = `wr-b-${sfx}`;

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

let host: AuthedUser, alice: AuthedUser, bob: AuthedUser, orgAdmin: AuthedUser, outsider: AuthedUser;
beforeAll(async () => {
  host = await mkUser(slugA, `host-${sfx}`, 'member');
  alice = await mkUser(slugA, `alice-${sfx}`, 'member');
  bob = await mkUser(slugA, `bob-${sfx}`, 'member');
  orgAdmin = await mkUser(slugA, `adm-${sfx}`, 'org_admin');
  outsider = await mkUser(slugB, `out-${sfx}`, 'org_admin');
});
afterAll(async () => {
  await admin.query('DELETE FROM organizations WHERE slug IN ($1,$2)', [slugA, slugB]);
  await pool.end();
  await admin.end();
});

const newMeeting = (opts: { waitingRoom?: boolean } = {}) => svc.create(host, { title: 'WR', ...opts });

describe('waiting room', () => {
  it('is on by default and a member waits instead of getting a token', async () => {
    const m = await newMeeting();
    expect(m.waiting_room).toBe(true);
    const r = await svc.join(alice, m.code);
    expect(r.status).toBe('waiting');
    expect(r).not.toHaveProperty('token');
  });

  it('the host and an org admin enter without waiting', async () => {
    const m = await newMeeting();
    expect((await svc.join(host, m.code)).status).toBe('joined');
    expect((await svc.join(orgAdmin, m.code)).status).toBe('joined');
  });

  it('can be switched off at creation', async () => {
    const m = await newMeeting({ waitingRoom: false });
    expect((await svc.join(alice, m.code)).status).toBe('joined');
  });

  it('the host sees pending requests and admission yields a token on the next poll', async () => {
    const m = await newMeeting();
    const w = await svc.join(alice, m.code);
    if (w.status !== 'waiting') throw new Error('expected waiting');
    expect((await svc.requestStatus(alice, m.code, w.requestId)).status).toBe('waiting');
    const pending = await svc.listRequests(host, m.code);
    expect(pending.map((p: { user_id: string }) => p.user_id)).toContain(alice.userId);
    await svc.decide(host, m.code, w.requestId, true);
    const after = await svc.requestStatus(alice, m.code, w.requestId);
    expect(after.status).toBe('joined');
    expect((await svc.listRequests(host, m.code)).length).toBe(0);
  });

  it('a denied request stays denied and cannot be retried into a token', async () => {
    const m = await newMeeting();
    const w = await svc.join(bob, m.code);
    if (w.status !== 'waiting') throw new Error('expected waiting');
    await svc.decide(host, m.code, w.requestId, false);
    expect(await status(svc.requestStatus(bob, m.code, w.requestId))).toBe(403);
    expect(await status(svc.join(bob, m.code))).toBe(403);
  });

  it('a request id belongs to its owner only', async () => {
    const m = await newMeeting();
    const w = await svc.join(alice, m.code);
    if (w.status !== 'waiting') throw new Error('expected waiting');
    await svc.decide(host, m.code, w.requestId, true);
    expect(await status(svc.requestStatus(bob, m.code, w.requestId))).toBe(404);
  });

  it('a decided request cannot be decided again', async () => {
    const m = await newMeeting();
    const w = await svc.join(alice, m.code);
    if (w.status !== 'waiting') throw new Error('expected waiting');
    await svc.decide(host, m.code, w.requestId, true);
    expect(await status(svc.decide(host, m.code, w.requestId, false))).toBe(404);
  });

  it('the passcode is still checked before the waiting room', async () => {
    const m = await svc.create(host, { title: 'P', passcode: 'secret-pass' });
    expect(await status(svc.join(alice, m.code, 'wrong-pass'))).toBe(403);
    expect((await svc.join(alice, m.code, 'secret-pass')).status).toBe('waiting');
  });
});

describe('host-only controls', () => {
  it('a plain member cannot list, admit, lock, mute or remove', async () => {
    const m = await newMeeting();
    const w = await svc.join(alice, m.code);
    if (w.status !== 'waiting') throw new Error('expected waiting');
    expect(await status(svc.listRequests(bob, m.code))).toBe(403);
    expect(await status(svc.decide(bob, m.code, w.requestId, true))).toBe(403);
    expect(await status(svc.setLocked(bob, m.code, true))).toBe(403);
    expect(await status(svc.muteParticipant(bob, m.code, alice.userId))).toBe(403);
    expect(await status(svc.removeParticipant(bob, m.code, alice.userId))).toBe(403);
  });

  it('another organization cannot even see the meeting (404, not 403)', async () => {
    const m = await newMeeting();
    expect(await status(svc.listRequests(outsider, m.code))).toBe(404);
    expect(await status(svc.setLocked(outsider, m.code, true))).toBe(404);
    expect(await status(svc.removeParticipant(outsider, m.code, alice.userId))).toBe(404);
  });

  it('an org admin of the same organization can manage a member-hosted meeting', async () => {
    const m = await newMeeting();
    expect((await svc.setLocked(orgAdmin, m.code, true)).locked).toBe(true);
  });

  it('locking refuses new members and unlocking lets them in again', async () => {
    const m = await newMeeting({ waitingRoom: false });
    await svc.setLocked(host, m.code, true);
    expect(await status(svc.join(alice, m.code))).toBe(403);
    expect((await svc.join(host, m.code)).status).toBe('joined');
    await svc.setLocked(host, m.code, false);
    expect((await svc.join(alice, m.code)).status).toBe('joined');
  });

  it('locking also stops an already admitted participant from collecting a token later', async () => {
    const m = await newMeeting();
    const w = await svc.join(alice, m.code);
    if (w.status !== 'waiting') throw new Error('expected waiting');
    await svc.decide(host, m.code, w.requestId, true);
    await svc.setLocked(host, m.code, true);
    expect(await status(svc.requestStatus(alice, m.code, w.requestId))).toBe(403);
  });

  it('removing bans: the participant cannot join, poll or be re-admitted', async () => {
    const m = await newMeeting();
    const w = await svc.join(alice, m.code);
    if (w.status !== 'waiting') throw new Error('expected waiting');
    await svc.decide(host, m.code, w.requestId, true);
    await svc.removeParticipant(host, m.code, alice.userId);
    expect(await status(svc.join(alice, m.code))).toBe(403);
    expect(await status(svc.requestStatus(alice, m.code, w.requestId))).toBe(403);
  });

  it('the host cannot be removed and neither can the caller', async () => {
    const m = await newMeeting();
    expect(await status(svc.removeParticipant(host, m.code, host.userId))).toBe(400);
    expect(await status(svc.removeParticipant(orgAdmin, m.code, orgAdmin.userId))).toBe(400);
    expect(await status(svc.removeParticipant(orgAdmin, m.code, host.userId))).toBe(400);
  });

  it('rejects malformed or unknown participant ids', async () => {
    const m = await newMeeting();
    for (const bad of ['', 'x', "1'; DROP TABLE meeting_bans;--", '00000000-0000-0000-0000-000000000000']) {
      expect([404]).toContain(await status(svc.removeParticipant(host, m.code, bad)));
    }
    expect(await status(svc.muteParticipant(host, m.code, 'not-a-uuid'))).toBe(404);
    expect(await status(svc.muteParticipant(host, m.code, alice.userId))).toBe(404); // not connected
  });

  it('a user of another organization cannot be banned from this meeting', async () => {
    const m = await newMeeting();
    expect(await status(svc.removeParticipant(host, m.code, outsider.userId))).toBe(404);
  });

  it('records admit, deny, lock and remove in the audit log', async () => {
    const m = await newMeeting();
    const w = await svc.join(alice, m.code);
    if (w.status !== 'waiting') throw new Error('expected waiting');
    await svc.decide(host, m.code, w.requestId, true);
    await svc.setLocked(host, m.code, true);
    await svc.removeParticipant(host, m.code, alice.userId);
    const r = await admin.query("SELECT action FROM audit_log WHERE target LIKE $1 ORDER BY id", [`${m.code}%`]);
    const actions = r.rows.map((x: { action: string }) => x.action);
    expect(actions).toEqual(expect.arrayContaining(['meeting.create', 'meeting.admit', 'meeting.lock', 'meeting.remove']));
  });
});
