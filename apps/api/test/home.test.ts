import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { loadConfig } from '../src/config.js';
import { MeetingError, MeetingsService } from '../src/meetings/meetings.service.js';
import { PersonalRoomService } from '../src/meetings/personal-room.js';
import { ActivityTracker, countedIdentity, type ActivityRooms } from '../src/meetings/activity.js';
import { ensureSchema, patchSchema } from '../src/meetings/me.controller.js';
import { RecordingService } from '../src/recording/recording.service.js';
import type { AuthedUser } from '../src/auth/auth.guard.js';

// Integration against the real database (row-level security): personal rooms and "Recent activity" (owner decisions 3 and 7
// of 2026-11-27). The media server is a fake here; the real one is covered by the e2e suite.
const cfg = loadConfig();
const adminUrl = process.env.MIGRATE_DATABASE_URL;
if (!adminUrl) throw new Error('MIGRATE_DATABASE_URL is required for tests');
const pool = new Pool({ connectionString: cfg.DATABASE_URL, max: 4 });
const owner = new Pool({ connectionString: adminUrl, max: 2 });
const rooms = new PersonalRoomService(pool);
const meetings = new MeetingsService(pool, cfg);
const sfx = Math.random().toString(36).slice(2, 8);
const slugA = `hm-a-${sfx}`;
const slugB = `hm-b-${sfx}`;

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
const policy = (orgId: string, cols: Record<string, unknown>) =>
  owner.query(
    `INSERT INTO org_policies (org_id, ${Object.keys(cols).join(', ')}) VALUES ($1, ${Object.keys(cols).map((_, i) => `$${i + 2}`).join(', ')})
     ON CONFLICT (org_id) DO UPDATE SET ${Object.keys(cols).map((k) => `${k} = EXCLUDED.${k}`).join(', ')}`,
    [orgId, ...Object.values(cols)],
  );

let alice: AuthedUser, bob: AuthedUser, carol: AuthedUser, outsider: AuthedUser;
beforeAll(async () => {
  alice = await mkUser(slugA, `al-${sfx}`, 'org_admin');
  bob = await mkUser(slugA, `bo-${sfx}`, 'member');
  carol = await mkUser(slugA, `ca-${sfx}`, 'member');
  outsider = await mkUser(slugB, `ou-${sfx}`, 'org_admin');
});
afterAll(async () => {
  await owner.query('DELETE FROM organizations WHERE slug IN ($1,$2)', [slugA, slugB]);
  await pool.end();
  await owner.end();
});

describe('request shapes', () => {
  it.each([[{}], [{ title: '' }], [{ title: 'x', passcode: '123' }], [{ title: 'x', extra: 1 }]])('ensure refuses %j', (b) => {
    expect(ensureSchema.safeParse(b).success).toBe(false);
  });
  it.each([[{}], [{ guests: 'everyone' }], [{ waitingRoom: 'yes' }], [{ passcode: '12' }], [{ code: '12345678901' }]])('patch refuses %j', (b) => {
    expect(patchSchema.safeParse(b).success).toBe(false);
  });
  it('patch accepts removing the passcode and the other fields', () => {
    expect(patchSchema.safeParse({ passcode: null, waitingRoom: false, guests: 'open' }).success).toBe(true);
  });
});

describe('personal room', () => {
  it('does not exist until first use, then is created once (idempotent) with the waiting room on', async () => {
    expect((await rooms.get(alice)).room).toBeNull();
    const a = await rooms.ensure(alice, { title: 'Alice room' });
    expect(a.code).toMatch(/^[1-9][0-9]{10}$/);
    expect(a.waitingRoom).toBe(true);
    expect(a.hasPasscode).toBe(false);
    expect(a.guests).toBe('off'); // the organization allows no guests
    const again = await rooms.ensure(alice, { title: 'Other title' });
    expect(again.code).toBe(a.code);
    expect(again.title).toBe('Alice room');
    expect((await rooms.get(alice)).room?.code).toBe(a.code);
  });

  it('two parallel first uses still give one room', async () => {
    const [x, y] = await Promise.all([rooms.ensure(carol, { title: 'C' }), rooms.ensure(carol, { title: 'C' })]);
    expect(x.code).toBe(y.code);
    const n = await owner.query('SELECT count(*)::int AS n FROM meetings WHERE personal_owner = $1', [carol.userId]);
    expect(n.rows[0].n).toBe(1);
  });

  it('is not listed among the meetings, and another organization cannot see it', async () => {
    const code = (await rooms.get(alice)).room!.code;
    expect((await meetings.list(alice)).some((m: { code: string }) => m.code === code)).toBe(false);
    expect((await rooms.get(outsider)).room).toBeNull();
    expect(await status(meetings.join(outsider, code))).toBe(404);
  });

  it('a colleague waits in the lobby (waiting room by default)', async () => {
    const code = (await rooms.get(alice)).room!.code;
    const r = await meetings.join(bob, code);
    expect(r.status).toBe('waiting');
  });

  it('passcode on and off, waiting room and guests within the organization policy', async () => {
    let r = await rooms.update(alice, { passcode: 'room-pass-1' });
    expect(r.hasPasscode).toBe(true);
    const hash = await owner.query('SELECT passcode_hash FROM meetings WHERE personal_owner = $1', [alice.userId]);
    expect(hash.rows[0].passcode_hash).toMatch(/^\$argon2id\$/);
    expect(await status(meetings.join(bob, r.code, 'wrong-pass'))).toBe(403);
    r = await rooms.update(alice, { passcode: null, waitingRoom: false });
    expect(r.hasPasscode).toBe(false);
    expect(r.waitingRoom).toBe(false);
    expect(await status(rooms.update(alice, { guests: 'waiting_room' }))).toBe(400); // policy: off
    await policy(alice.orgId, { guest_policy: 'waiting_room' });
    expect((await rooms.update(alice, { guests: 'waiting_room' })).guests).toBe('waiting_room');
    expect(await status(rooms.update(alice, { guests: 'open' }))).toBe(400);
    await rooms.update(alice, { waitingRoom: true });
  });

  it('an organization that requires passcodes gets none removed and no room without one', async () => {
    await policy(outsider.orgId, { require_passcode: true });
    expect(await status(rooms.ensure(outsider, { title: 'O' }))).toBe(400);
    const r = await rooms.ensure(outsider, { title: 'O', passcode: 'outsider-1' });
    expect(r.hasPasscode).toBe(true);
    expect(await status(rooms.update(outsider, { passcode: null }))).toBe(400);
  });

  it('regenerate: a new code, the old one stops resolving, waiting requests through it are void', async () => {
    const before = (await rooms.get(alice)).room!;
    const pending = await owner.query("SELECT count(*)::int AS n FROM join_requests j JOIN meetings m ON m.id = j.meeting_id WHERE m.code = $1 AND j.status = 'pending'", [before.code]);
    expect(pending.rows[0].n).toBe(1); // bob, from above
    const after = await rooms.regenerate(alice);
    expect(after.code).not.toBe(before.code);
    expect(await status(meetings.join(bob, before.code))).toBe(404);
    const left = await owner.query("SELECT count(*)::int AS n FROM join_requests j JOIN meetings m ON m.id = j.meeting_id WHERE m.personal_owner = $1", [alice.userId]);
    expect(left.rows[0].n).toBe(0);
    // Bob can ask again through the new link (his old request did not turn into a refusal).
    expect((await meetings.join(bob, after.code)).status).toBe('waiting');
    const audit = await owner.query("SELECT target FROM audit_log WHERE org_id = $1 AND action = 'meeting.personal.regenerate'", [alice.orgId]);
    expect(audit.rows[0].target).toBe(`${before.code}->${after.code}`);
  });

  it('regenerate and update need a room first', async () => {
    expect(await status(rooms.regenerate(bob))).toBe(404);
    expect(await status(rooms.update(bob, { waitingRoom: false }))).toBe(404);
  });
});

class FakeRooms implements ActivityRooms {
  live: Array<{ name: string; sid: string; creationTime: number; people: Array<{ identity: string; joinedAt: number }> }> = [];
  down = false;
  async listRooms() {
    if (this.down) throw new Error('media server unreachable');
    return this.live.map(({ name, sid, creationTime }) => ({ name, sid, creationTime }));
  }
  async listParticipants(room: string) {
    return this.live.find((r) => r.name === room)?.people ?? [];
  }
}

describe('recent activity', () => {
  const fake = new FakeRooms();
  let clock = new Date('2026-11-27T10:00:00Z');
  const tracker = new ActivityTracker(pool, fake, () => clock);
  let meetingId = '';
  let code = '';
  const t0 = Date.parse('2026-11-27T09:58:00Z') / 1000;

  beforeAll(async () => {
    const m = await meetings.create(alice, { title: 'Weekly sync', waitingRoom: false });
    meetingId = m.id as string;
    code = m.code as string;
  });

  it('counts members and guests only (not the recording bot)', () => {
    expect(countedIdentity(alice.userId)).toBe('member');
    expect(countedIdentity('guest:0b6c3a5e-6f7e-4a1f-9a55-1b0e7a0f2d11')).toBe('guest');
    expect(countedIdentity('EG_abc')).toBeNull();
    expect(countedIdentity('conntest:' + alice.userId)).toBeNull();
  });

  it('an empty room makes no run; a room with people opens one from the first join time', async () => {
    fake.live = [{ name: meetingId, sid: `RM_${sfx}_1`, creationTime: t0 - 60, people: [] }];
    expect((await tracker.pollOnce()).opened).toBe(0);
    fake.live[0]!.people = [
      { identity: alice.userId, joinedAt: t0 },
      { identity: 'guest:0b6c3a5e-6f7e-4a1f-9a55-1b0e7a0f2d11', joinedAt: t0 + 30 },
      { identity: 'EG_recorder', joinedAt: t0 + 40 },
    ];
    expect((await tracker.pollOnce()).opened).toBe(1);
    expect((await tracker.pollOnce()).opened).toBe(0); // same run
    const s = await owner.query('SELECT started_at, ended_at, peak_participants FROM meeting_sessions WHERE meeting_id = $1', [meetingId]);
    expect(s.rows).toHaveLength(1);
    expect(new Date(s.rows[0].started_at).toISOString()).toBe('2026-11-27T09:58:00.000Z');
    expect(s.rows[0].ended_at).toBeNull();
    expect(s.rows[0].peak_participants).toBe(2);
  });

  it('a media-server outage closes nothing', async () => {
    fake.down = true;
    expect(await tracker.pollOnce()).toEqual({ opened: 0, closed: 0 });
    fake.down = false;
    const s = await owner.query('SELECT ended_at FROM meeting_sessions WHERE meeting_id = $1', [meetingId]);
    expect(s.rows[0].ended_at).toBeNull();
  });

  it('a webhook join is recorded at once; the run ends at the last moment someone was seen', async () => {
    clock = new Date('2026-11-27T10:20:00Z');
    await tracker.onEvent({ name: 'participant_joined', room: meetingId, roomSid: `RM_${sfx}_1`, identity: bob.userId, at: new Date('2026-11-27T10:05:00Z') });
    fake.live[0]!.people.push({ identity: bob.userId, joinedAt: Date.parse('2026-11-27T10:05:00Z') / 1000 });
    await tracker.pollOnce(); // last seen 10:20
    fake.live[0]!.people = []; // everybody left; the room lingers until its empty timeout
    clock = new Date('2026-11-27T10:24:00Z');
    await tracker.pollOnce();
    fake.live = []; // the room is gone
    expect((await tracker.pollOnce()).closed).toBe(1);
    const s = await owner.query('SELECT ended_at FROM meeting_sessions WHERE meeting_id = $1', [meetingId]);
    expect(new Date(s.rows[0].ended_at).toISOString()).toBe('2026-11-27T10:20:00.000Z');
  });

  it('the host and the people who were in it see the run; a colleague who was not there does not', async () => {
    const a = await tracker.recent(alice.orgId, alice.userId, 10);
    const item = a.find((x) => x.meetingCode === code)!;
    expect(item).toMatchObject({ title: 'Weekly sync', isHost: true, personal: false, participants: 3, guests: 1, peak: 3, files: 0, recordings: 0 });
    expect(item.durationSeconds).toBe(22 * 60);
    expect((await tracker.recent(bob.orgId, bob.userId, 10)).some((x) => x.meetingCode === code)).toBe(true);
    expect((await tracker.recent(carol.orgId, carol.userId, 10)).some((x) => x.meetingCode === code)).toBe(false);
    expect(await tracker.recent(outsider.orgId, alice.userId, 10)).toEqual([]); // RLS: another organization sees nothing
  });

  it('ending the meeting for everyone closes the run now; a room nobody was seen in is dropped', async () => {
    clock = new Date('2026-11-27T11:00:00Z');
    fake.live = [{ name: meetingId, sid: `RM_${sfx}_2`, creationTime: Date.parse('2026-11-27T10:50:00Z') / 1000, people: [{ identity: alice.userId, joinedAt: Date.parse('2026-11-27T10:50:00Z') / 1000 }] }];
    await tracker.pollOnce();
    clock = new Date('2026-11-27T11:10:00Z');
    await tracker.endedByHost(alice.orgId, meetingId);
    const s = await owner.query('SELECT ended_at FROM meeting_sessions WHERE room_sid = $1', [`RM_${sfx}_2`]);
    expect(new Date(s.rows[0].ended_at).toISOString()).toBe('2026-11-27T11:10:00.000Z');
    // A room created by a join token nobody used: the webhook says it finished, and nothing is kept.
    await tracker.onEvent({ name: 'participant_joined', room: meetingId, roomSid: `RM_${sfx}_3`, identity: 'EG_bot' });
    await tracker.onEvent({ name: 'room_finished', room: meetingId, roomSid: `RM_${sfx}_3` });
    const none = await owner.query('SELECT 1 FROM meeting_sessions WHERE room_sid = $1', [`RM_${sfx}_3`]);
    expect(none.rowCount).toBe(0);
  });

  it('a file shared during the run is counted', async () => {
    const run = await owner.query('SELECT started_at FROM meeting_sessions WHERE room_sid = $1', [`RM_${sfx}_2`]);
    await owner.query(
      `INSERT INTO meeting_files (org_id, meeting_id, uploader_id, name, mime, size_bytes, sha256, object_key, wrapped_key, created_at)
       VALUES ($1, $2, $3, 'notes.pdf', 'application/pdf', 10, repeat('a', 64), $4, 'x', $5)`,
      [alice.orgId, meetingId, alice.userId, `test/${sfx}`, new Date(new Date(run.rows[0].started_at).getTime() + 60_000)],
    );
    const a = await tracker.recent(alice.orgId, alice.userId, 10);
    expect(a.find((x) => x.endedAt === '2026-11-27T11:10:00.000Z')?.files).toBe(1);
  });
});

describe('recordings section', () => {
  it('answers while recording is switched off (enabled=false) instead of failing', async () => {
    const svc = new RecordingService(pool, null);
    const r = await svc.mine(alice);
    expect(r.enabled).toBe(false);
    expect(Array.isArray(r.items)).toBe(true);
  });
});
