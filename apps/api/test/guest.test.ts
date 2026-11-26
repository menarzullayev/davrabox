import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT, decodeJwt } from 'jose';
import { loadConfig } from '../src/config.js';
import { MeetingError, MeetingsService } from '../src/meetings/meetings.service.js';
import { GuestService, cleanName, type GuestJoined, type GuestWaiting } from '../src/meetings/guest.service.js';
import { effectiveGuestMode } from '../src/meetings/guest-types.js';
import type { AuthedUser } from '../src/auth/auth.guard.js';

// Integration: guest mode against real Postgres (RLS) and real LiveKit. Negative cases first.
const cfg = loadConfig();
const adminUrl = process.env.MIGRATE_DATABASE_URL;
if (!adminUrl) throw new Error('MIGRATE_DATABASE_URL is required for tests');
const pool = new Pool({ connectionString: cfg.DATABASE_URL, max: 6 });
const admin = new Pool({ connectionString: adminUrl, max: 2 });
const meetings = new MeetingsService(pool, cfg);
const guests = new GuestService(pool, cfg);
const sfx = Math.random().toString(36).slice(2, 8);
const slugA = `gu-a-${sfx}`;
const slugB = `gu-b-${sfx}`;
let ipN = 0;
const ip = () => `10.77.${Math.floor(++ipN / 250)}.${(ipN % 250) + 1}`; // a fresh address per call: limits never leak between tests

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
const setPolicy = (user: AuthedUser, policy: 'off' | 'waiting_room' | 'open') =>
  admin.query(
    `INSERT INTO org_policies (org_id, guest_policy) VALUES ($1, $2)
     ON CONFLICT (org_id) DO UPDATE SET guest_policy = EXCLUDED.guest_policy`,
    [user.orgId, policy],
  );
const join = (code: string, name = 'Guest One', passcode?: string, addr = ip()) => guests.join({ code, name, passcode }, { ipKey: addr });

let host: AuthedUser, orgAdmin: AuthedUser, outsider: AuthedUser;
beforeAll(async () => {
  host = await mkUser(slugA, `host-${sfx}`, 'member');
  orgAdmin = await mkUser(slugA, `adm-${sfx}`, 'org_admin');
  outsider = await mkUser(slugB, `out-${sfx}`, 'org_admin');
});
afterAll(async () => {
  await admin.query('DELETE FROM organizations WHERE slug IN ($1,$2)', [slugA, slugB]);
  await pool.end();
  await admin.end();
});

describe('guest mode: pure rules', () => {
  it('the effective mode is the stricter of the meeting and the policy', () => {
    expect(effectiveGuestMode('open', 'off')).toBe('off');
    expect(effectiveGuestMode('open', 'waiting_room')).toBe('waiting_room');
    expect(effectiveGuestMode('waiting_room', 'open')).toBe('waiting_room');
    expect(effectiveGuestMode('off', 'open')).toBe('off');
    expect(effectiveGuestMode('open', 'open')).toBe('open');
  });
  it.each([
    ['', null],
    ['   ', null],
    ['a'.repeat(61), null],
    ['Ali\u0000', null],
    ['Ali‮', null],
    ['Ali​', null],
    [42 as unknown as string, null],
    ['  Ali   Valiyev  ', 'Ali Valiyev'],
    ['a'.repeat(60), 'a'.repeat(60)],
  ])('cleanName(%j)', (raw, want) => {
    expect(cleanName(raw)).toBe(want);
  });
});

describe('guests refused', () => {
  it('guests off (the default) looks exactly like an unknown code', async () => {
    await setPolicy(orgAdmin, 'open');
    const m = await meetings.create(host, { title: 'Closed' }); // guest_mode defaults to off
    expect(m.guest_mode).toBe('off');
    const off = await guests.join({ code: m.code, name: 'G' }, { ipKey: ip() }).catch((e) => e as MeetingError);
    const unknown = await guests.join({ code: '99999999999', name: 'G' }, { ipKey: ip() }).catch((e) => e as MeetingError);
    expect(off).toBeInstanceOf(MeetingError);
    expect((off as MeetingError).status).toBe(404);
    expect((unknown as MeetingError).status).toBe(404);
    expect((off as MeetingError).message).toBe((unknown as MeetingError).message);
  });

  it('a host cannot ask for more than the organization allows', async () => {
    await setPolicy(orgAdmin, 'waiting_room');
    expect(await status(meetings.create(host, { title: 'x', guests: 'open' }))).toBe(400);
    expect(await status(meetings.create(host, { title: 'x', guests: 'waiting_room' }))).toBe(200);
    await setPolicy(orgAdmin, 'off');
    expect(await status(meetings.create(host, { title: 'x', guests: 'waiting_room' }))).toBe(400);
    expect(await status(meetings.create(host, { title: 'x', guests: 'off' }))).toBe(200);
  });

  it('lowering the policy after the meeting was made takes effect on the next join', async () => {
    await setPolicy(orgAdmin, 'open');
    const m = await meetings.create(host, { title: 'Policy drop', guests: 'open' });
    expect((await join(m.code)).status).toBe('joined');
    await setPolicy(orgAdmin, 'off');
    expect(await status(join(m.code))).toBe(404);
  });

  it('the host can open an existing meeting to guests later, never above the organization limit', async () => {
    await setPolicy(orgAdmin, 'off');
    const m = await meetings.create(host, { title: 'Made while guests were off' });
    await setPolicy(orgAdmin, 'waiting_room');
    expect(await status(join(m.code))).toBe(404); // still off until the host changes it
    expect(await status(meetings.update(host, m.code, { guests: 'open' }))).toBe(400); // above the policy
    expect(await meetings.update(host, m.code, { guests: 'waiting_room' })).toEqual({ guest_mode: 'waiting_room' });
    expect((await join(m.code)).status).toBe('waiting');
    expect(await meetings.join(host, m.code)).toMatchObject({ status: 'joined', guestMode: 'waiting_room' }); // the call screen shows it
    expect(await meetings.update(orgAdmin, m.code, { guests: 'off' })).toEqual({ guest_mode: 'off' }); // an organization admin may too
    expect(await status(join(m.code))).toBe(404);
  });

  it('only the host side can change it, and only the guest setting', async () => {
    await setPolicy(orgAdmin, 'open');
    const m = await meetings.create(host, { title: 'Guarded' });
    const member = await mkUser(slugA, `mem-${sfx}`, 'member');
    expect(await status(meetings.update(member, m.code, { guests: 'open' }))).toBe(403);
    expect(await status(meetings.update(outsider, m.code, { guests: 'open' }))).toBe(404);
    expect(await status(meetings.update(host, m.code, { guests: 'everyone' }))).toBe(400);
    expect(await status(meetings.update(host, m.code, { guests: 'open', title: 'x' }))).toBe(400);
    expect(await status(meetings.update(host, m.code, { title: 'x' }))).toBe(400);
    expect(await status(meetings.update(host, m.code, { e2ee: true, guests: 'open' }))).toBe(409);
    const row = await admin.query('SELECT guest_mode FROM meetings WHERE code = $1', [m.code]);
    expect(row.rows[0].guest_mode).toBe('off');
    await meetings.update(host, m.code, { guests: 'open' });
    const audit = await admin.query("SELECT target FROM audit_log WHERE org_id = $1 AND action = 'meeting.guests.change' ORDER BY id DESC LIMIT 1", [host.orgId]);
    expect(audit.rows[0]?.target).toBe(`${m.code}:open`);
  });

  it('refuses bad names, malformed codes and wrong types without touching the database', async () => {
    await setPolicy(orgAdmin, 'open');
    const m = await meetings.create(host, { title: 'Names', guests: 'open' });
    expect(await status(join(m.code, ''))).toBe(400);
    expect(await status(join(m.code, 'x'.repeat(61)))).toBe(400);
    expect(await status(join(m.code, 'Ali\u0007'))).toBe(400);
    expect(await status(join('abc'))).toBe(404);
    expect(await status(join("1' OR '1'='1"))).toBe(404);
    expect(await status(join('1234567890'))).toBe(404);
  });

  it('a locked meeting refuses guests', async () => {
    await setPolicy(orgAdmin, 'open');
    const m = await meetings.create(host, { title: 'Locked', guests: 'open' });
    await meetings.setLocked(host, m.code, true);
    expect(await status(join(m.code))).toBe(403);
  });

  it('the passcode applies to guests, and wrong guesses are limited per address and code', async () => {
    await setPolicy(orgAdmin, 'open');
    const m = await meetings.create(host, { title: 'Pass', guests: 'open', passcode: 'correct-horse' });
    const addr = ip();
    expect(await status(join(m.code, 'G', undefined, addr))).toBe(403);
    expect(await status(join(m.code, 'G', 'wrong-pass', addr))).toBe(403);
    expect((await join(m.code, 'G', 'correct-horse', ip())).status).toBe('joined');
    const hammer = ip();
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push(await status(join(m.code, 'G', `guess-${i}`, hammer)));
    expect(codes.slice(0, 5).every((c) => c === 403)).toBe(true);
    expect(codes.slice(5)).toEqual([429, 429]);
    // Even the right passcode is refused from the blocked address (the counter was taken before the hash check).
    expect(await status(join(m.code, 'G', 'correct-horse', hammer))).toBe(429);
  });

  it('guessing codes is limited: ten misses from one address and everything from it is refused', async () => {
    await setPolicy(orgAdmin, 'open');
    const real = await meetings.create(host, { title: 'Real', guests: 'open' });
    const addr = ip();
    const results: number[] = [];
    for (let i = 0; i < 12; i++) results.push(await status(join(String(30000000000 + i), 'G', undefined, addr)));
    expect(results.slice(0, 10).every((c) => c === 404)).toBe(true);
    expect(results.slice(10).every((c) => c === 429)).toBe(true);
    expect(await status(join(real.code, 'G', undefined, addr))).toBe(429); // a real code from the same address is refused too
    expect((await join(real.code)).status).toBe('joined'); // another address is fine
  });

  it('the waiting room has a ceiling per meeting', async () => {
    await setPolicy(orgAdmin, 'waiting_room');
    const m = await meetings.create(host, { title: 'Crowd', guests: 'waiting_room' });
    for (let i = 0; i < 50; i++) expect((await join(m.code, `G${i}`)).status).toBe('waiting');
    expect(await status(join(m.code, 'one too many'))).toBe(429);
  });
});

describe('guests admitted', () => {
  it('open mode: a token without admin rights, labelled as a guest', async () => {
    await setPolicy(orgAdmin, 'open');
    const m = await meetings.create(host, { title: 'Open', guests: 'open' });
    const r = (await join(m.code, '  Ali   Valiyev ')) as GuestJoined;
    expect(r.status).toBe('joined');
    expect(r.guest).toBe(true);
    expect(r.isHost).toBe(false);
    const claims = decodeJwt(r.token) as { sub?: string; name?: string; metadata?: string; video?: { roomAdmin?: boolean; roomJoin?: boolean; room?: string; canPublish?: boolean; canPublishData?: boolean; recorder?: boolean; canUpdateOwnMetadata?: boolean } };
    expect(claims.sub).toMatch(/^guest:[0-9a-f-]{36}$/);
    expect(claims.name).toBe('Ali Valiyev');
    expect(JSON.parse(claims.metadata ?? '{}')).toEqual({ guest: true });
    expect(claims.video?.roomJoin).toBe(true);
    expect(claims.video?.room).toBe(m.id);
    expect(claims.video?.canPublish).toBe(true);
    expect(claims.video?.canPublishData).toBe(true);
    expect(claims.video?.roomAdmin ?? false).toBe(false);
    expect(claims.video?.recorder ?? false).toBe(false);
    expect(claims.video?.canUpdateOwnMetadata ?? false).toBe(false);
  });

  it('waiting room: the host sees the guest, admits, and the guest then gets a token; denial is final', async () => {
    await setPolicy(orgAdmin, 'waiting_room');
    const m = await meetings.create(host, { title: 'WR', guests: 'waiting_room' });
    const ctx = { ipKey: ip() };
    const w = (await guests.join({ code: m.code, name: 'Waiting Wendy' }, ctx)) as GuestWaiting;
    expect(w.status).toBe('waiting');
    expect(w).not.toHaveProperty('token');
    expect((await guests.requestStatus(w.guestToken, w.requestId, ctx)).status).toBe('waiting');

    const list = (await meetings.listRequests(host, m.code)) as Array<{ id: string; guest: boolean; display_name: string; user_id: string | null }>;
    const mine = list.find((x) => x.id === w.requestId);
    expect(mine).toMatchObject({ guest: true, display_name: 'Waiting Wendy', user_id: null });

    await meetings.decide(host, m.code, w.requestId, true);
    const ok = (await guests.requestStatus(w.guestToken, w.requestId, ctx)) as GuestJoined;
    expect(ok.status).toBe('joined');
    expect(ok.guest).toBe(true);

    const d = (await guests.join({ code: m.code, name: 'Denied Dan' }, { ipKey: ip() })) as GuestWaiting;
    await meetings.decide(host, m.code, d.requestId, false);
    expect(await status(guests.requestStatus(d.guestToken, d.requestId, { ipKey: ip() }))).toBe(403);
  });

  it('organization waiting_room beats a host who chose open: the guest still waits', async () => {
    await setPolicy(orgAdmin, 'open');
    const m = await meetings.create(host, { title: 'Capped', guests: 'open' });
    await setPolicy(orgAdmin, 'waiting_room');
    expect((await join(m.code)).status).toBe('waiting');
  });

  it('only the host side can decide; a guest or an outsider cannot admit', async () => {
    await setPolicy(orgAdmin, 'waiting_room');
    const m = await meetings.create(host, { title: 'Who decides', guests: 'waiting_room' });
    const w = (await join(m.code)) as GuestWaiting;
    expect(await status(meetings.decide(outsider, m.code, w.requestId, true))).toBe(404); // another organization: the meeting is not even visible
    const stranger = await mkUser(slugA, `str-${sfx}`, 'member');
    expect(await status(meetings.decide(stranger, m.code, w.requestId, true))).toBe(403);
  });
});

describe('guest session token', () => {
  it('is bound to its own request, rejects forgeries and foreign audiences', async () => {
    await setPolicy(orgAdmin, 'waiting_room');
    const m = await meetings.create(host, { title: 'Tokens', guests: 'waiting_room' });
    const a = (await join(m.code, 'A')) as GuestWaiting;
    const b = (await join(m.code, 'B')) as GuestWaiting;
    const ctx = () => ({ ipKey: ip() });
    expect(await status(guests.requestStatus(a.guestToken, b.requestId, ctx()))).toBe(404); // A's token cannot read B's request
    expect(await status(guests.requestStatus('not-a-jwt', a.requestId, ctx()))).toBe(401);
    expect(await status(guests.requestStatus(a.guestToken, 'not-a-uuid', ctx()))).toBe(404);
    const forged = await new SignJWT({ sid: a.requestId, mid: m.id, org: host.orgId })
      .setProtectedHeader({ alg: 'HS256' })
      .setAudience('davrabox-guest')
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('some other secret'));
    expect(await status(guests.requestStatus(forged, a.requestId, ctx()))).toBe(401);
    const wrongAudience = await new SignJWT({ sid: a.requestId, mid: m.id, org: host.orgId })
      .setProtectedHeader({ alg: 'HS256' })
      .setAudience('somebody-else')
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(cfg.LIVEKIT_API_SECRET));
    expect(await status(guests.requestStatus(wrongAudience, a.requestId, ctx()))).toBe(401);
    const noneAlg = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sid: a.requestId, mid: m.id, org: host.orgId, aud: 'davrabox-guest' })).toString('base64url')}.`;
    expect(await status(guests.requestStatus(noneAlg, a.requestId, ctx()))).toBe(401);
  });
});

describe('removing a guest', () => {
  it('closes the session and bans the address for this meeting only', async () => {
    await setPolicy(orgAdmin, 'open');
    const m = await meetings.create(host, { title: 'Remove', guests: 'open' });
    const other = await meetings.create(host, { title: 'Other', guests: 'open' });
    const addr = ip();
    const g = (await join(m.code, 'Troll', undefined, addr)) as GuestJoined;
    const id = (decodeJwt(g.token) as { sub: string }).sub;
    expect(await meetings.removeParticipant(host, m.code, id)).toEqual({ removed: true });
    expect(await status(join(m.code, 'Troll again', undefined, addr))).toBe(403);
    expect((await join(m.code, 'Someone else', undefined, ip())).status).toBe('joined'); // another address
    expect((await join(other.code, 'Troll', undefined, addr)).status).toBe('joined'); // another meeting
  });

  it('a guest identity that does not exist, or a malformed one, is a 404', async () => {
    await setPolicy(orgAdmin, 'open');
    const m = await meetings.create(host, { title: 'Ghosts', guests: 'open' });
    expect(await status(meetings.removeParticipant(host, m.code, 'guest:00000000-0000-4000-8000-000000000000'))).toBe(404);
    expect(await status(meetings.removeParticipant(host, m.code, 'guest:not-a-uuid'))).toBe(404);
    expect(await status(meetings.removeParticipant(host, m.code, 'guest:'))).toBe(404);
  });

  it('a stranger in the same organization cannot remove a guest', async () => {
    await setPolicy(orgAdmin, 'open');
    const m = await meetings.create(host, { title: 'No mod', guests: 'open' });
    const g = (await join(m.code)) as GuestJoined;
    const id = (decodeJwt(g.token) as { sub: string }).sub;
    const stranger = await mkUser(slugA, `str2-${sfx}`, 'member');
    expect(await status(meetings.removeParticipant(stranger, m.code, id))).toBe(403);
  });
});

describe('tenant isolation and audit', () => {
  it('guest rows are invisible to another organization', async () => {
    await setPolicy(orgAdmin, 'open');
    const m = await meetings.create(host, { title: 'Isolation', guests: 'open' });
    await join(m.code, 'Seen by A only');
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.current_org', $1, true)", [outsider.orgId]);
      const rows = await c.query('SELECT 1 FROM guest_sessions');
      expect(rows.rowCount).toBe(0);
      const bans = await c.query('SELECT 1 FROM meeting_guest_bans');
      expect(bans.rowCount).toBe(0);
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  });

  it('with no tenant set the guest tables show nothing, and the lookup returns only ids', async () => {
    const r = await pool.query('SELECT count(*)::int AS n FROM guest_sessions');
    expect(r.rows[0].n).toBe(0);
    const m = await meetings.create(host, { title: 'Lookup', guests: 'off' });
    const l = await pool.query('SELECT * FROM guest_meeting_lookup($1)', [m.code]);
    expect(Object.keys(l.rows[0]).sort()).toEqual(['meeting_id', 'org_id']);
    expect((await pool.query('SELECT * FROM guest_meeting_lookup($1)', ["1'; DROP TABLE meetings;--"])).rowCount).toBe(0);
  });

  it('joins, decisions and removals are audited without a user id for the guest', async () => {
    await setPolicy(orgAdmin, 'waiting_room');
    const m = await meetings.create(host, { title: 'Audit', guests: 'waiting_room' });
    const w = (await join(m.code)) as GuestWaiting;
    await meetings.decide(host, m.code, w.requestId, true);
    const rows = await admin.query("SELECT action, actor_id, target FROM audit_log WHERE org_id = $1 AND target LIKE $2 ORDER BY id", [host.orgId, `${m.code}:%`]);
    const actions = rows.rows.map((r: { action: string }) => r.action);
    expect(actions).toContain('guest.join');
    expect(actions).toContain('guest.admit');
    expect(rows.rows.find((r: { action: string }) => r.action === 'guest.join').actor_id).toBeNull();
  });
});
