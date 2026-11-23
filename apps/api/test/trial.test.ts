import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { decodeJwt } from 'jose';
import { RoomServiceClient } from 'livekit-server-sdk';
import { loadConfig } from '../src/config.js';
import { MeetingError, MeetingsService, type JoinResult, type JoinedResult } from '../src/meetings/meetings.service.js';
import type { AuthedUser } from '../src/auth/auth.guard.js';
import { TrialLimits } from '../src/signup/trial.guard.js';
import { TrialRoomSweeper } from '../src/signup/room-sweeper.js';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { AuthGuard, POOL, VERIFIER } from '../src/auth/auth.guard.js';
import { TRIAL_LIMITS, TrialController } from '../src/signup/trial.controller.js';
import { RETENTION_LOCK, TrialRetentionJob } from '../src/signup/retention.job.js';

// Integration: trial enforcement against real Postgres (RLS) and the real LiveKit server. Rooms of the sweeper tests are
// fake (an injected media-server client) so no timing is involved.
const cfg = loadConfig();
const adminUrl = process.env.MIGRATE_DATABASE_URL;
if (!adminUrl) throw new Error('MIGRATE_DATABASE_URL is required for tests');
const pool = new Pool({ connectionString: cfg.DATABASE_URL, max: 4 });
const owner = new Pool({ connectionString: adminUrl, max: 2 });
const svc = new MeetingsService(pool, cfg);
const trial = new TrialLimits(pool);
const lk = new RoomServiceClient(cfg.LIVEKIT_API_URL, cfg.LIVEKIT_API_KEY, cfg.LIVEKIT_API_SECRET);
const sfx = Math.random().toString(36).slice(2, 8);
const slugs = { trial: `tr-t-${sfx}`, paid: `tr-p-${sfx}`, old: `tr-o-${sfx}`, fresh: `tr-f-${sfx}`, keep: `tr-k-${sfx}`, late: `tr-l-${sfx}` };

async function mkUser(slug: string, sub: string, role: 'org_admin' | 'member'): Promise<AuthedUser> {
  const r = await pool.query('SELECT org_id, user_id FROM provision_user($1,$2,$3,$4,$5,$6)', [slug, slug, sub, `${sub}@t.local`, sub, role]);
  return { sub, email: `${sub}@t.local`, name: sub, orgSlug: slug, role, orgId: r.rows[0].org_id, userId: r.rows[0].user_id };
}
const setLicence = (orgId: string, days: number, participants: number | null, minutes: number | null) =>
  owner.query(
    `INSERT INTO org_licenses (org_id, trial_ends_at, max_participants, max_meeting_minutes) VALUES ($1, now() + make_interval(days => $2), $3, $4)
     ON CONFLICT (org_id) DO UPDATE SET trial_ends_at = EXCLUDED.trial_ends_at, max_participants = EXCLUDED.max_participants, max_meeting_minutes = EXCLUDED.max_meeting_minutes`,
    [orgId, days, participants, minutes],
  );
const joined = (r: JoinResult): JoinedResult => {
  if (r.status !== 'joined') throw new Error('expected an immediate join');
  return r;
};
async function failure(p: Promise<unknown>): Promise<MeetingError | null> {
  try {
    await p;
    return null;
  } catch (e) {
    if (e instanceof MeetingError) return e;
    throw e;
  }
}
const fakeParticipants = (s: MeetingsService, ids: string[]) => {
  (s as unknown as { rooms: { listParticipants: () => Promise<Array<{ identity: string }>> } }).rooms.listParticipants = async () => ids.map((identity) => ({ identity }));
};

let tAdmin: AuthedUser, tMember: AuthedUser, pAdmin: AuthedUser;

beforeAll(async () => {
  tAdmin = await mkUser(slugs.trial, `ta-${sfx}`, 'org_admin');
  tMember = await mkUser(slugs.trial, `tm-${sfx}`, 'member');
  pAdmin = await mkUser(slugs.paid, `pa-${sfx}`, 'org_admin');
  await setLicence(tAdmin.orgId, 7, 10, 30);
});
afterAll(async () => {
  await owner.query('DELETE FROM organizations WHERE slug LIKE $1', [`tr-_-${sfx}`]);
  await owner.query('DELETE FROM signup_events WHERE org_slug LIKE $1', [`tr-_-${sfx}`]);
  await owner.query('DELETE FROM retired_slugs WHERE slug LIKE $1', [`tr-_-${sfx}`]);
  await pool.end();
  await owner.end();
});

describe('trial status and limits', () => {
  it('reports an active trial and a paid organization', async () => {
    const s = await trial.status(tAdmin.orgId);
    expect(s).toMatchObject({ trial: true, expired: false, maxParticipants: 10, maxMinutes: 30 });
    expect(new Date(s.endsAt!).getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    expect(await trial.status(pAdmin.orgId)).toEqual({ trial: false, expired: false, endsAt: null, maxParticipants: null, maxMinutes: null });
  });
  it('effective limits are the trial limits for a trial and the organization policy otherwise', async () => {
    expect(await trial.effectiveLimits(tAdmin.orgId)).toEqual({ trial: true, maxParticipants: 10, maxMinutes: 30 });
    expect(await trial.effectiveLimits(pAdmin.orgId)).toEqual({ trial: false, maxParticipants: 300, maxMinutes: null });
  });
  it('the trial can only lower the organization policy, never raise it', async () => {
    await owner.query('INSERT INTO org_policies (org_id, max_participants) VALUES ($1, 4) ON CONFLICT (org_id) DO UPDATE SET max_participants = 4', [tAdmin.orgId]);
    try {
      expect((await trial.effectiveLimits(tAdmin.orgId)).maxParticipants).toBe(4);
    } finally {
      await owner.query('DELETE FROM org_policies WHERE org_id = $1', [tAdmin.orgId]);
    }
  });
});

describe('GET /v1/trial', () => {
  it('answers with the organization of the caller only', async () => {
    const claims = (u: AuthedUser) => ({ sub: u.sub, email: u.email, name: u.name, orgSlug: u.orgSlug, role: u.role });
    const verifier = async (t: string) => claims(t === 'trial' ? tAdmin : pAdmin);
    @Module({ controllers: [TrialController], providers: [{ provide: POOL, useValue: pool }, { provide: VERIFIER, useValue: verifier }, { provide: TRIAL_LIMITS, useValue: trial }, AuthGuard] })
    class M {}
    const app = await NestFactory.create(M, { logger: false });
    await app.listen(0, '127.0.0.1');
    const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
    try {
      const get = (token?: string) => fetch(`${base}/v1/trial`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      expect((await get()).status).toBe(401);
      const t = (await (await get('trial')).json()) as Record<string, unknown>;
      expect(t).toMatchObject({ trial: true, expired: false, maxParticipants: 10, maxMinutes: 30 });
      expect((await (await get('paid')).json())).toEqual({ trial: false, expired: false, endsAt: null, maxParticipants: null, maxMinutes: null });
    } finally {
      await app.close();
    }
  });
});

describe('an expired trial', () => {
  it('blocks creating and joining meetings with 402 and a stable message', async () => {
    const m = await svc.create(tAdmin, { title: 'Before expiry', waitingRoom: false });
    await setLicence(tAdmin.orgId, -1, 10, 30);
    try {
      const create = await failure(svc.create(tAdmin, { title: 'After expiry' }));
      expect(create).toMatchObject({ status: 402, message: 'trial expired' });
      const join = await failure(svc.join(tAdmin, m.code));
      expect(join).toMatchObject({ status: 402, message: 'trial expired' });
      const joinMember = await failure(svc.join(tMember, m.code));
      expect(joinMember).toMatchObject({ status: 402, message: 'trial expired' });
      expect((await trial.status(tAdmin.orgId)).expired).toBe(true);
    } finally {
      await setLicence(tAdmin.orgId, 7, 10, 30);
    }
    expect(await failure(svc.join(tAdmin, m.code))).toBeNull(); // the licence is the only thing that changed
  });
  it('does not touch an organization without trial fields (paid)', async () => {
    const m = await svc.create(pAdmin, { title: 'Paid', waitingRoom: false });
    expect(joined(await svc.join(pAdmin, m.code)).status).toBe('joined');
  });
});

describe('trial limits at token issue', () => {
  it('creates the room with the trial participant cap', async () => {
    const m = await svc.create(tAdmin, { title: 'Cap', waitingRoom: false });
    joined(await svc.join(tAdmin, m.code));
    const rooms = await lk.listRooms([m.id]);
    expect(rooms[0]?.maxParticipants).toBe(10);
  });

  it('refuses the 11th participant, but lets someone who is already in rejoin', async () => {
    const own = new MeetingsService(pool, cfg);
    const m = await own.create(tAdmin, { title: 'Full', waitingRoom: false });
    const ten = Array.from({ length: 10 }, (_, i) => `00000000-0000-4000-8000-0000000000${String(10 + i)}`);
    fakeParticipants(own, ten);
    const full = await failure(own.join(tMember, m.code));
    expect(full).toMatchObject({ status: 403, message: 'meeting is full' });
    fakeParticipants(own, [...ten.slice(0, 9), tMember.userId]);
    expect(joined(await own.join(tMember, m.code)).status).toBe('joined'); // 10 inside, one of them is the caller
  });

  it('bounds the access token lifetime by the meeting time limit', async () => {
    await setLicence(tAdmin.orgId, 7, 10, 1);
    try {
      const m = await svc.create(tAdmin, { title: 'Short', waitingRoom: false });
      const claims = decodeJwt(joined(await svc.join(tAdmin, m.code)).token) as { exp: number; nbf: number };
      expect(claims.exp - claims.nbf).toBeLessThanOrEqual(60);
    } finally {
      await setLicence(tAdmin.orgId, 7, 10, 30);
    }
    const m2 = await svc.create(tAdmin, { title: 'Normal', waitingRoom: false });
    const c2 = decodeJwt(joined(await svc.join(tAdmin, m2.code)).token) as { exp: number; nbf: number };
    expect(c2.exp - c2.nbf).toBe(cfg.MEETING_TOKEN_TTL_SECONDS);
  });

  it('a paid organization keeps the policy cap, the normal token lifetime and no fullness check', async () => {
    const own = new MeetingsService(pool, cfg);
    const m = await own.create(pAdmin, { title: 'Paid big', waitingRoom: false });
    fakeParticipants(own, Array.from({ length: 50 }, (_, i) => `00000000-0000-4000-8000-0000000001${String(10 + i)}`));
    const j = joined(await own.join(pAdmin, m.code));
    expect((decodeJwt(j.token) as { exp: number; nbf: number }).exp - (decodeJwt(j.token) as { nbf: number }).nbf).toBe(cfg.MEETING_TOKEN_TTL_SECONDS);
    expect((await lk.listRooms([m.id]))[0]?.maxParticipants).toBe(300);
  });
});

describe('room time limit (watchdog)', () => {
  it('closes a trial room that ran longer than the limit and leaves other rooms alone', async () => {
    const old = await svc.create(tAdmin, { title: 'Old room', waitingRoom: false });
    const fresh = await svc.create(tAdmin, { title: 'Fresh room', waitingRoom: false });
    const paid = await svc.create(pAdmin, { title: 'Paid room', waitingRoom: false });
    const unknown = '11111111-2222-4333-8444-555555555555';
    const nowS = Math.floor(Date.now() / 1000);
    const deleted: string[] = [];
    const rooms = {
      listRooms: async () => [
        { name: old.id, creationTime: BigInt(nowS - 31 * 60) },
        { name: fresh.id, creationTime: BigInt(nowS - 5 * 60) },
        { name: paid.id, creationTime: BigInt(nowS - 600 * 60) },
        { name: unknown, creationTime: BigInt(nowS - 600 * 60) },
        { name: 'not-a-uuid', creationTime: BigInt(0) },
      ],
      deleteRoom: async (name: string) => {
        deleted.push(name);
      },
    };
    const sweeper = new TrialRoomSweeper(pool, rooms as never);
    expect(await sweeper.sweepOnce()).toEqual([old.id]);
    expect(deleted).toEqual([old.id]);
    const audit = await owner.query(`SELECT action, target FROM audit_log WHERE org_id = $1 AND action = 'meeting.time_limit'`, [tAdmin.orgId]);
    expect(audit.rows).toEqual([{ action: 'meeting.time_limit', target: old.code }]);
  });
  it('survives a media-server failure without throwing', async () => {
    const sweeper = new TrialRoomSweeper(pool, { listRooms: async () => { throw new Error('down'); }, deleteRoom: async () => undefined } as never);
    expect(await sweeper.sweepOnce()).toEqual([]);
  });
});

describe('retention', () => {
  it('purges a trial organization 30 days after the trial ended, with a platform record, and nothing else', async () => {
    const oldAdmin = await mkUser(slugs.old, `old-${sfx}`, 'org_admin');
    const freshAdmin = await mkUser(slugs.fresh, `fr-${sfx}`, 'org_admin');
    const keepAdmin = await mkUser(slugs.keep, `kp-${sfx}`, 'org_admin');
    await setLicence(oldAdmin.orgId, -31, 10, 30);
    await setLicence(freshAdmin.orgId, -29, 10, 30);
    await owner.query('INSERT INTO org_licenses (org_id, seats_limit) VALUES ($1, 50)', [keepAdmin.orgId]); // paid: no trial fields
    await owner.query('INSERT INTO trial_signups (org_id, email_hash, ip_hash) VALUES ($1, $2, $3)', [oldAdmin.orgId, `mb-${sfx}`, 'x']);

    const cleaned: string[] = [];
    const purged = await new TrialRetentionJob(pool, { deleteUsersByOrgSlug: async (s) => void cleaned.push(s) }).runOnce();
    expect(cleaned).toContain(slugs.old);
    expect(cleaned).not.toContain(slugs.fresh);
    expect(purged).toContain(slugs.old);
    expect(purged).not.toContain(slugs.fresh);
    expect(purged).not.toContain(slugs.keep);

    const left = (await owner.query('SELECT slug FROM organizations WHERE slug = ANY($1)', [[slugs.old, slugs.fresh, slugs.keep]])).rows.map((r) => r.slug).sort();
    expect(left).toEqual([slugs.fresh, slugs.keep].sort());
    expect((await owner.query(`SELECT 1 FROM signup_events WHERE kind = 'retention' AND org_slug = $1`, [slugs.old])).rowCount).toBe(1);
    // the mailbox record outlives the organization, so a purged trial cannot simply be restarted
    expect((await owner.query('SELECT org_id FROM trial_signups WHERE email_hash = $1', [`mb-${sfx}`])).rows).toEqual([{ org_id: null }]);
    await owner.query('DELETE FROM trial_signups WHERE email_hash = $1', [`mb-${sfx}`]);
  });
  it('retires the slug for good: it is never reused and provision_user will not re-create the organization', async () => {
    const retired = slugs.old;
    // the purge test above already removed it; a new sign-up with the same name gets a different slug
    const created = await pool.query('SELECT slug FROM create_trial_org($1, $2, $3, $4, 7, 10, 30)', [retired, 'Same name again', `hash2-${sfx}`, 'iphash']);
    expect(created.rows[0].slug).not.toBe(retired);
    await owner.query('DELETE FROM organizations WHERE slug = $1', [created.rows[0].slug]);
    await owner.query('DELETE FROM trial_signups WHERE email_hash = $1', [`hash2-${sfx}`]);
    // a leftover identity-provider user of the purged organization cannot resurrect it as a limit-free one
    await expect(pool.query('SELECT * FROM provision_user($1, $2, $3, $4, $5, $6)', [retired, retired, 'ghost', 'ghost@t.local', 'Ghost', 'org_admin'])).rejects.toMatchObject({ code: 'DB001' });
    expect((await owner.query('SELECT 1 FROM organizations WHERE slug = $1', [retired])).rowCount).toBe(0);
    const guard = new AuthGuard(async () => ({ sub: 'ghost', email: 'ghost@t.local', name: 'Ghost', orgSlug: retired, role: 'org_admin' }), pool);
    const ctx = { switchToHttp: () => ({ getRequest: () => ({ headers: { authorization: 'Bearer x' } }) }) } as unknown as ExecutionContext;
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('refuses a grace period shorter than one day', async () => {
    await expect(pool.query('SELECT * FROM purge_expired_trials(0, 10)')).rejects.toMatchObject({ code: '22023' });
  });
  it('does nothing while another instance holds the retention lock, and purges once it is released', async () => {
    const lateAdmin = await mkUser(slugs.late, `late-${sfx}`, 'org_admin');
    await setLicence(lateAdmin.orgId, -40, 10, 30);
    const other = await owner.connect();
    try {
      await other.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [RETENTION_LOCK]);
      expect(await new TrialRetentionJob(pool).runOnce()).toEqual([]);
      expect((await owner.query('SELECT 1 FROM organizations WHERE slug = $1', [slugs.late])).rowCount).toBe(1);
    } finally {
      await other.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [RETENTION_LOCK]);
      other.release();
    }
    expect(await new TrialRetentionJob(pool).runOnce()).toContain(slugs.late);
  });
});
