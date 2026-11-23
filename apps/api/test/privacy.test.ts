import 'reflect-metadata';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Pool } from 'pg';
import { loadConfig } from '../src/config.js';
import { withTenant } from '../src/db/tenant.js';
import { AuthGuard, POOL, VERIFIER, type AuthedUser } from '../src/auth/auth.guard.js';
import type { Identity } from '../src/auth/jwt.js';
import { AdminGuard } from '../src/admin/admin.controller.js';
import { IdentityAdminError } from '../src/admin/identity-admin.js';
import { AdminPrivacyController, MePrivacyController, PRIVACY } from '../src/privacy/privacy.controller.js';
import { ERASED_DISPLAY_NAME, ERASED_EMAIL, PrivacyService } from '../src/privacy/privacy.service.js';
import type { CalendarRevoker, ObjectEraser, PrivacyIdentity } from '../src/privacy/ports.js';

// Integration: the privacy API over real HTTP (Nest app, real AuthGuard/AdminGuard) against real Postgres (RLS, the real
// audit hash chain). The identity provider, object storage and calendar providers are doubles that record their calls.
const cfg = loadConfig();
const adminUrl = process.env.MIGRATE_DATABASE_URL;
if (!adminUrl) throw new Error('MIGRATE_DATABASE_URL is required for tests');
const pool = new Pool({ connectionString: cfg.DATABASE_URL, max: 8 });
const owner = new Pool({ connectionString: adminUrl, max: 2 });
const sfx = Math.random().toString(36).slice(2, 8);
const slugs = { a: `prv-a-${sfx}`, b: `prv-b-${sfx}`, solo: `prv-s-${sfx}`, rate: `prv-r-${sfx}` };

class FakeIdp implements PrivacyIdentity {
  erased: Array<{ sub: string; orgSlug: string }> = [];
  fail: IdentityAdminError | null = null;
  async eraseUser(sub: string, orgSlug: string) {
    if (this.fail) throw this.fail;
    this.erased.push({ sub, orgSlug });
  }
}
class FakeObjects implements ObjectEraser {
  files: string[] = [];
  recordings: string[] = [];
  fail = false;
  async deleteFileObject(key: string) {
    if (this.fail) throw new Error('storage down');
    this.files.push(key);
  }
  async deleteRecordingObject(key: string) {
    if (this.fail) throw new Error('storage down');
    this.recordings.push(key);
  }
}
class FakeCalendar implements CalendarRevoker {
  revoked: string[] = [];
  async revokeAll(_orgId: string, userId: string) {
    this.revoked.push(userId);
  }
}
const idp = new FakeIdp();
const objects = new FakeObjects();
const calendar = new FakeCalendar();
let clock = Date.parse('2030-01-01T10:00:00Z');
const svc = new PrivacyService(pool, { idp, objects, calendar, now: () => clock, exportsPerHour: 3, erasuresPerHour: 50 });
const svcNoIdp = new PrivacyService(pool, { idp: null, objects, calendar });

const fakeVerifier = async (token: string): Promise<Identity> => {
  try {
    return JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as Identity;
  } catch {
    throw new Error('bad token');
  }
};

@Module({
  controllers: [MePrivacyController, AdminPrivacyController],
  providers: [{ provide: POOL, useValue: pool }, { provide: VERIFIER, useValue: fakeVerifier }, { provide: PRIVACY, useValue: svc }, AuthGuard, AdminGuard],
})
class TestModule {}

let app: INestApplication;
let base = '';

interface Actor extends AuthedUser {
  token: string;
}
async function mkUser(slug: string, sub: string, role: 'org_admin' | 'member', email = `${sub}@t.local`, name = `Name of ${sub}`): Promise<Actor> {
  const r = await pool.query('SELECT org_id, user_id FROM provision_user($1,$2,$3,$4,$5,$6)', [slug, slug, sub, email, name, role]);
  const identity: Identity = { sub, email, name, orgSlug: slug, role };
  return { ...identity, orgId: r.rows[0].org_id, userId: r.rows[0].user_id, token: Buffer.from(JSON.stringify(identity)).toString('base64url') };
}

async function call(method: string, path: string, token: string | null, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, json, text, headers: res.headers };
}

beforeAll(async () => {
  app = await NestFactory.create(TestModule, { logger: false });
  await app.listen(0);
  base = await app.getUrl();
  base = base.replace('[::1]', 'localhost');
});
afterAll(async () => {
  await app.close();
  await owner.query('DELETE FROM organizations WHERE slug = ANY($1)', [Object.values(slugs)]);
  await pool.end();
  await owner.end();
});

/** A user with data in every store the erasure has to reach. */
async function seed(user: Actor, other: Actor, tag: string) {
  const hosted = (await owner.query(
    `INSERT INTO meetings (org_id, code, title, host_user_id) VALUES ($1, $2, $3, $4) RETURNING id, code`,
    [user.orgId, String(30000000000 + Math.floor(Math.random() * 9e9)), `Hosted ${tag}`, user.userId],
  )).rows[0];
  const theirs = (await owner.query(
    `INSERT INTO meetings (org_id, code, title, host_user_id) VALUES ($1, $2, $3, $4) RETURNING id, code`,
    [user.orgId, String(40000000000 + Math.floor(Math.random() * 9e9)), `Theirs ${tag}`, other.userId],
  )).rows[0];
  await owner.query('INSERT INTO meeting_access (meeting_id, user_id, org_id) VALUES ($1,$2,$3)', [theirs.id, user.userId, user.orgId]);
  const mkFile = async (uploader: Actor, meetingId: string, name: string) => {
    const id = randomUUID();
    const key = `${user.orgId}/${meetingId}/${id}`;
    await owner.query(
      `INSERT INTO meeting_files (id, org_id, meeting_id, uploader_id, name, size_bytes, mime, sha256, object_key, wrapped_key)
       VALUES ($1,$2,$3,$4,$5,10,'application/octet-stream',$6,$7,'wrapped-secret')`,
      [id, user.orgId, meetingId, uploader.userId, name, createHash('sha256').update(id).digest('hex'), key],
    );
    return { id, key };
  };
  const ownFile = await mkFile(user, hosted.id, `mine-${tag}.pdf`);
  const otherFile = await mkFile(other, hosted.id, `other-${tag}.pdf`);
  const rec = async (starter: Actor, meetingId: string) => {
    const id = randomUUID();
    await owner.query(
      `INSERT INTO recordings (id, org_id, meeting_id, status, staging_key, object_key, wrapped_key, started_by, ended_at, size_bytes)
       VALUES ($1,$2,$3,'ready',$4,$5,'wrapped-secret',$6, now(), 5)`,
      [id, user.orgId, meetingId, `staging/${id}`, `final/${id}`, starter.userId],
    );
    return id;
  };
  const ownRec = await rec(user, hosted.id);
  await owner.query(`UPDATE recordings SET status = 'ready' WHERE id = $1`, [ownRec]);
  // a second meeting so that the other user's recording does not collide with the one-in-flight index (both are 'ready')
  const otherRec = await rec(other, hosted.id);
  await owner.query(
    `INSERT INTO calendar_connections (user_id, provider, org_id, refresh_token_enc, wrapped_key, scope) VALUES ($1,'google',$2,'REFRESH-TOKEN-CIPHERTEXT','WRAPPED-DATA-KEY','calendar.events')`,
    [user.userId, user.orgId],
  );
  await owner.query(
    `INSERT INTO calendar_oauth_states (state_hash, org_id, user_id, provider, verifier_enc, wrapped_key, expires_at) VALUES ($1,$2,$3,'google','v','w', now() + interval '5 minutes')`,
    [randomBytes(32).toString('hex'), user.orgId, user.userId],
  );
  const prefix = randomBytes(4).toString('hex');
  await owner.query(
    `INSERT INTO api_keys (org_id, name, prefix, secret_hash, scopes, created_by) VALUES ($1,$2,$3,$4,ARRAY['meetings:read'],$5)`,
    [user.orgId, `key-${tag}`, prefix, randomBytes(32), user.userId],
  );
  const hook = randomUUID();
  await owner.query(
    `INSERT INTO webhook_endpoints (id, org_id, url, events, secret_blob, secret_wrapped_key, created_by) VALUES ($1,$2,$3,ARRAY['meeting.created'],$4,'wk',$5)`,
    [hook, user.orgId, `https://hooks.example.com/secret-path-${tag}`, randomBytes(16), user.userId],
  );
  for (const [who, action, target] of [[user, 'meeting.create', hosted.code], [user, 'file.upload', `${hosted.code}:${ownFile.id}`], [other, 'meeting.create', theirs.code]] as const) {
    await withTenant(pool, user.orgId, (c) =>
      c.query('INSERT INTO audit_log (org_id, actor_id, action, target) VALUES ($1,$2,$3,$4)', [user.orgId, who.userId, action, target]),
    );
  }
  return { hosted, theirs, ownFile, otherFile, ownRec, otherRec, prefix, hook };
}

const verifyChain = async (orgId: string) => (await withTenant(pool, orgId, (c) => c.query('SELECT ok, checked FROM audit_verify_chain($1)', [orgId]))).rows[0] as { ok: boolean; checked: string };
const row = async (id: string) => (await owner.query('SELECT * FROM users WHERE id = $1', [id])).rows[0];
const actions = async (orgId: string) => (await owner.query('SELECT action, target, actor_id FROM audit_log WHERE org_id = $1 ORDER BY id', [orgId])).rows as Array<{ action: string; target: string; actor_id: string | null }>;

describe('access control', () => {
  it('refuses unauthenticated calls and keeps admin routes away from members', async () => {
    const m = await mkUser(slugs.a, `m-ac-${sfx}`, 'member');
    expect((await call('GET', '/v1/me/export', null)).status).toBe(401);
    expect((await call('DELETE', '/v1/me', null, { confirm: 'x' })).status).toBe(401);
    expect((await call('GET', `/v1/admin/users/${m.userId}/export`, m.token)).status).toBe(403);
    expect((await call('DELETE', `/v1/admin/users/${m.userId}`, m.token, { confirm: m.email })).status).toBe(403);
    expect((await row(m.userId)).erased_at).toBeNull();
  });
});

describe('export', () => {
  it('contains the person own data and nobody else, and never a secret', async () => {
    const admin = await mkUser(slugs.a, `adm-ex-${sfx}`, 'org_admin');
    const me = await mkUser(slugs.a, `me-ex-${sfx}`, 'member', `me-ex-${sfx}@t.local`, 'Me Export');
    const other = await mkUser(slugs.a, `ot-ex-${sfx}`, 'member', `ot-ex-${sfx}@t.local`, 'Other Person');
    const s = await seed(me, other, 'ex');
    const r = await call('GET', '/v1/me/export', me.token);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toContain('no-store');
    expect(r.headers.get('content-disposition')).toContain('attachment');
    const x = r.json;
    expect(x.profile).toMatchObject({ id: me.userId, email: me.email, displayName: 'Me Export', role: 'member' });
    expect(x.meetingsHosted.map((m: any) => m.code)).toEqual([s.hosted.code]);
    expect(x.meetingsJoined.map((m: any) => m.code)).toEqual([s.theirs.code]);
    expect(x.files.map((f: any) => f.id)).toEqual([s.ownFile.id]); // not the file somebody else uploaded
    expect(x.recordings.map((f: any) => f.id)).toEqual([s.ownRec]);
    expect(x.calendarConnections).toEqual([expect.objectContaining({ provider: 'google', connected: true })]);
    expect(x.apiKeys.map((k: any) => k.prefix)).toEqual([s.prefix]);
    expect(x.webhookEndpoints).toEqual([expect.objectContaining({ id: s.hook, host: 'hooks.example.com' })]);
    // audit rows as actor: this person's rows only
    expect(x.auditAsActor.every((a: any) => ['meeting.create', 'file.upload'].includes(a.action))).toBe(true);
    expect(x.auditAsActor.length).toBe(2);
    // negative: no secret material and no other person's identity anywhere in the document
    for (const forbidden of ['REFRESH-TOKEN-CIPHERTEXT', 'WRAPPED-DATA-KEY', 'wrapped-secret', 'secret_hash', 'secret-path', other.email, 'Other Person', s.otherFile.id, s.otherRec]) {
      expect(r.text).not.toContain(forbidden);
    }
    expect(r.text).not.toContain(s.ownFile.key); // object keys are internal
    // the export itself is audited
    expect((await actions(me.orgId)).some((a) => a.action === 'privacy.export' && a.actor_id === me.userId && a.target === me.userId)).toBe(true);
    // org admin: same scope for the same person, audited with the admin as actor
    const a = await call('GET', `/v1/admin/users/${me.userId}/export`, admin.token);
    expect(a.status).toBe(200);
    expect(a.json.profile.id).toBe(me.userId);
    expect(a.json.files.map((f: any) => f.id)).toEqual([s.ownFile.id]);
    expect((await actions(me.orgId)).some((x2) => x2.action === 'privacy.export' && x2.actor_id === admin.userId && x2.target === me.userId)).toBe(true);
  });

  it('is limited per person and answers 429 with Retry-After', async () => {
    const u = await mkUser(slugs.rate, `rt-${sfx}`, 'member');
    for (let i = 0; i < 3; i++) expect((await call('GET', '/v1/me/export', u.token)).status).toBe(200);
    const blocked = await call('GET', '/v1/me/export', u.token);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    clock += 3600_000 + 1; // the controllable clock moves the window
    expect((await call('GET', '/v1/me/export', u.token)).status).toBe(200);
  });

  it('an admin cannot export a person of another organization, a member cannot export a colleague', async () => {
    const adminA = await mkUser(slugs.a, `adm-x-${sfx}`, 'org_admin');
    const inB = await mkUser(slugs.b, `in-b-${sfx}`, 'member');
    expect((await call('GET', `/v1/admin/users/${inB.userId}/export`, adminA.token)).status).toBe(404);
    expect((await call('GET', '/v1/admin/users/not-a-uuid/export', adminA.token)).status).toBe(404);
    const m = await mkUser(slugs.a, `m-x-${sfx}`, 'member');
    await expect(svc.exportUser(m, adminA.userId)).rejects.toMatchObject({ status: 403 });
  });
});

describe('erasure', () => {
  it('refuses a wrong confirmation and changes nothing', async () => {
    const admin = await mkUser(slugs.a, `adm-cf-${sfx}`, 'org_admin');
    const u = await mkUser(slugs.a, `u-cf-${sfx}`, 'member');
    const before = idp.erased.length;
    for (const body of [{ confirm: 'wrong@t.local' }, { confirm: '' }, {}, { confirm: 5 }, { confirm: u.email, extra: 1 }]) {
      expect((await call('DELETE', '/v1/me', u.token, body)).status).toBe(400);
    }
    expect((await call('DELETE', `/v1/admin/users/${u.userId}`, admin.token, { confirm: admin.email })).status).toBe(400);
    const r = await row(u.userId);
    expect(r.email).toBe(u.email);
    expect(r.erasure_requested_at).toBeNull();
    expect(idp.erased.length).toBe(before);
  });

  it('refuses to erase the last organization admin with 409 and touches nothing', async () => {
    const only = await mkUser(slugs.solo, `only-${sfx}`, 'org_admin');
    const before = idp.erased.length;
    const r = await call('DELETE', '/v1/me', only.token, { confirm: only.email });
    expect(r.status).toBe(409);
    expect(r.json.message).toMatch(/last organization admin/);
    expect((await row(only.userId)).erasure_requested_at).toBeNull();
    expect(idp.erased.length).toBe(before);
    // an admin who is NOT the last one may be erased once another admin exists
    const second = await mkUser(slugs.solo, `second-${sfx}`, 'org_admin');
    expect((await call('DELETE', '/v1/me', second.token, { confirm: second.email })).status).toBe(200);
    expect((await row(second.userId)).erased_at).not.toBeNull();
    expect((await call('DELETE', '/v1/me', only.token, { confirm: only.email })).status).toBe(409); // the other one is gone again
  });

  it('anonymises the person, removes their data, keeps the audit chain verifiable and resolves actors to the tombstone', async () => {
    const admin = await mkUser(slugs.a, `adm-er-${sfx}`, 'org_admin');
    const me = await mkUser(slugs.a, `me-er-${sfx}`, 'member', `me-er-${sfx}@t.local`, 'Erika Mustermann');
    const other = await mkUser(slugs.a, `ot-er-${sfx}`, 'member', `ot-er-${sfx}@t.local`, 'Keeper');
    const s = await seed(me, other, 'er');
    await call('GET', '/v1/me/export', me.token); // one audit row more, written by the person
    const chainBefore = await verifyChain(me.orgId);
    expect(chainBefore.ok).toBe(true);
    const auditBefore = Number((await owner.query('SELECT count(*) FROM audit_log WHERE org_id = $1 AND actor_id = $2', [me.orgId, me.userId])).rows[0].count);
    expect(auditBefore).toBeGreaterThan(0);
    objects.files.length = 0;
    objects.recordings.length = 0;
    idp.erased.length = 0;

    const r = await call('DELETE', '/v1/me', me.token, { confirm: ` ${me.email.toUpperCase()} ` });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ status: 'erased', alreadyErased: false });

    // the tombstone holds no personal data
    const u = await row(me.userId);
    expect(u.email).toBe(ERASED_EMAIL);
    expect(u.display_name).toBe(ERASED_DISPLAY_NAME);
    expect(u.role).toBe('member');
    expect(u.disabled).toBe(true);
    expect(u.department_id).toBeNull();
    expect(u.erased_at).not.toBeNull();
    expect(`${u.email}${u.display_name}`).not.toMatch(/erika|mustermann|me-er/i);
    // identity provider: user removed in this organization only
    expect(idp.erased).toEqual([{ sub: me.sub, orgSlug: slugs.a }]);
    // own files, recordings (and the plaintext staging object), calendar, key, webhook and pending OAuth state are gone
    expect(objects.files).toEqual([s.ownFile.key]);
    expect(objects.recordings.sort()).toEqual([`final/${s.ownRec}`, `staging/${s.ownRec}`].sort());
    expect((await owner.query('SELECT 1 FROM meeting_files WHERE uploader_id = $1', [me.userId])).rowCount).toBe(0);
    expect((await owner.query('SELECT 1 FROM recordings WHERE started_by = $1', [me.userId])).rowCount).toBe(0);
    expect((await owner.query('SELECT 1 FROM calendar_connections WHERE user_id = $1', [me.userId])).rowCount).toBe(0);
    expect((await owner.query('SELECT 1 FROM calendar_oauth_states WHERE user_id = $1', [me.userId])).rowCount).toBe(0);
    expect((await owner.query('SELECT 1 FROM webhook_endpoints WHERE created_by = $1', [me.userId])).rowCount).toBe(0);
    expect((await owner.query('SELECT revoked_at FROM api_keys WHERE created_by = $1', [me.userId])).rows.every((k) => k.revoked_at !== null)).toBe(true);
    expect(calendar.revoked).toContain(me.userId);
    // somebody else's data is untouched
    expect((await owner.query('SELECT 1 FROM meeting_files WHERE id = $1', [s.otherFile.id])).rowCount).toBe(1);
    expect((await owner.query('SELECT 1 FROM recordings WHERE id = $1', [s.otherRec])).rowCount).toBe(1);
    expect((await row(other.userId)).email).toBe(other.email);
    // the meetings the person hosted stay (organization records); their host resolves to the tombstone
    expect((await owner.query('SELECT host_user_id FROM meetings WHERE id = $1', [s.hosted.id])).rows[0].host_user_id).toBe(me.userId);

    // THE AUDIT CHAIN STILL VERIFIES, and no audit row was deleted or rewritten
    const chainAfter = await verifyChain(me.orgId);
    expect(chainAfter.ok).toBe(true);
    expect(Number(chainAfter.checked)).toBeGreaterThan(Number(chainBefore.checked)); // the erasure itself was appended
    const auditAfter = Number((await owner.query('SELECT count(*) FROM audit_log WHERE org_id = $1 AND actor_id = $2', [me.orgId, me.userId])).rows[0].count);
    expect(auditAfter).toBeGreaterThanOrEqual(auditBefore);
    const joined = (await owner.query(
      `SELECT a.action, u.email, u.display_name FROM audit_log a JOIN users u ON u.id = a.actor_id WHERE a.org_id = $1 AND a.actor_id = $2`,
      [me.orgId, me.userId],
    )).rows as Array<{ email: string; display_name: string }>;
    expect(joined.length).toBeGreaterThan(0);
    expect(joined.every((j) => j.email === ERASED_EMAIL && j.display_name === ERASED_DISPLAY_NAME)).toBe(true);
    // the SIEM forwarder reads actor_email through the same join: no address leaves any more
    const fwd = (await owner.query('SELECT actor_email FROM audit_forward_batch(0, 0, 1000) WHERE actor_email = $1', [me.email])).rowCount;
    expect(fwd).toBe(0);
    // erasure is audited, with no personal data in the row
    const ev = (await actions(me.orgId)).filter((a) => a.action.startsWith('privacy.erasure'));
    expect(ev.map((e) => e.action)).toEqual(['privacy.erasure.requested', 'privacy.erasure.completed']);
    expect(ev.every((e) => e.actor_id === me.userId && e.target.startsWith(me.userId))).toBe(true);
    expect(JSON.stringify(ev)).not.toMatch(/mustermann|erika|@t\.local/i);

    // a token that is still valid cannot bring the person back: no new account, no new data
    const again = await call('GET', '/v1/me/export', me.token);
    expect(again.status).toBe(403);
    expect((await owner.query('SELECT count(*) FROM users WHERE org_id = $1 AND external_sub = $2', [me.orgId, me.sub])).rows[0].count).toBe('1');
    expect((await row(me.userId)).email).toBe(ERASED_EMAIL);

    // idempotent: the admin repeating it gets a clean answer and nothing is called twice
    idp.erased.length = 0;
    const rep = await call('DELETE', `/v1/admin/users/${me.userId}`, admin.token, { confirm: 'anything' });
    expect(rep.status).toBe(200);
    expect(rep.json).toMatchObject({ status: 'erased', alreadyErased: true });
    expect(idp.erased).toEqual([]);
  });

  it('an organization admin erases a member (confirmation = the member address), and may erase self when not the last admin', async () => {
    const admin = await mkUser(slugs.a, `adm-ae-${sfx}`, 'org_admin');
    const u = await mkUser(slugs.a, `u-ae-${sfx}`, 'member');
    const r = await call('DELETE', `/v1/admin/users/${u.userId}`, admin.token, { confirm: u.email });
    expect(r.status).toBe(200);
    expect((await row(u.userId)).erased_at).not.toBeNull();
    const ev = (await actions(admin.orgId)).filter((a) => a.action === 'privacy.erasure.requested' && a.target.startsWith(u.userId));
    expect(ev[0]!.actor_id).toBe(admin.userId); // the admin is the actor
    // other organization: not found, nothing changes
    const adminB = await mkUser(slugs.b, `adm-be-${sfx}`, 'org_admin');
    const victim = await mkUser(slugs.a, `v-ae-${sfx}`, 'member');
    expect((await call('DELETE', `/v1/admin/users/${victim.userId}`, adminB.token, { confirm: victim.email })).status).toBe(404);
    expect((await row(victim.userId)).erasure_requested_at).toBeNull();
  });

  it('a failed identity-provider call leaves a retryable request; the retry completes it', async () => {
    const admin = await mkUser(slugs.a, `adm-rt-${sfx}`, 'org_admin');
    const u = await mkUser(slugs.a, `u-rt-${sfx}`, 'member');
    idp.fail = new IdentityAdminError(502, 'identity provider is unreachable');
    const r1 = await call('DELETE', '/v1/me', u.token, { confirm: u.email });
    expect(r1.status).toBe(502);
    const mid = await row(u.userId);
    expect(mid.erasure_requested_at).not.toBeNull(); // recorded
    expect(mid.erased_at).toBeNull(); // but not finished: still the same person
    expect(mid.email).toBe(u.email);
    expect((await actions(u.orgId)).filter((a) => a.action === 'privacy.erasure.requested' && a.target.startsWith(u.userId)).length).toBe(1);
    idp.fail = null;
    const r2 = await call('DELETE', '/v1/me', u.token, { confirm: u.email });
    expect(r2.status).toBe(200);
    expect((await row(u.userId)).erased_at).not.toBeNull();
    // the request was recorded once, not once per attempt
    expect((await actions(u.orgId)).filter((a) => a.action === 'privacy.erasure.requested' && a.target.startsWith(u.userId)).length).toBe(1);
    // and the hourly job path completes a request nobody retried
    const w = await mkUser(slugs.a, `w-rt-${sfx}`, 'member');
    idp.fail = new IdentityAdminError(503, 'down');
    expect((await call('DELETE', `/v1/admin/users/${w.userId}`, admin.token, { confirm: w.email })).status).toBe(503);
    idp.fail = null;
    expect((await row(w.userId)).erased_at).toBeNull();
    await svc.completeErasure(w.orgId, w.userId);
    expect((await row(w.userId)).erased_at).not.toBeNull();
    expect((await row(w.userId)).email).toBe(ERASED_EMAIL);
  });

  it('a storage failure stops before the identity provider is touched, and the retry finishes', async () => {
    const me = await mkUser(slugs.a, `me-st-${sfx}`, 'member');
    const other = await mkUser(slugs.a, `ot-st-${sfx}`, 'member');
    const s = await seed(me, other, 'st');
    await mkUser(slugs.a, `adm-st-${sfx}`, 'org_admin');
    objects.fail = true;
    idp.erased.length = 0;
    expect((await call('DELETE', '/v1/me', me.token, { confirm: me.email })).status).toBe(502);
    expect(idp.erased).toEqual([]);
    expect((await owner.query('SELECT 1 FROM meeting_files WHERE id = $1', [s.ownFile.id])).rowCount).toBe(1); // row kept: the object may still exist
    objects.fail = false;
    expect((await call('DELETE', '/v1/me', me.token, { confirm: me.email })).status).toBe(200);
    expect((await owner.query('SELECT 1 FROM meeting_files WHERE id = $1', [s.ownFile.id])).rowCount).toBe(0);
    expect(idp.erased.length).toBe(1);
  });

  it('answers 503 and changes nothing when the identity provider is not configured', async () => {
    const u = await mkUser(slugs.a, `u-ni-${sfx}`, 'member');
    await expect(svcNoIdp.eraseUser(u, u.userId, u.email)).rejects.toMatchObject({ status: 503 });
    expect((await row(u.userId)).erasure_requested_at).toBeNull();
  });
});
