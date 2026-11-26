import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Pool } from 'pg';
import { RoomServiceClient } from 'livekit-server-sdk';
import { loadConfig } from '../src/config.js';
import { AuthGuard, POOL, VERIFIER, type AuthedUser } from '../src/auth/auth.guard.js';
import type { Identity } from '../src/auth/jwt.js';
import { ADMIN, AdminController, AdminGuard } from '../src/admin/admin.controller.js';
import { AdminError, AdminService, decodeCursor, encodeCursor, escapeLike } from '../src/admin/admin.service.js';
import { IdentityAdminError, type IdentityAdmin, type NewIdentityUser, type OrgRole } from '../src/admin/identity-admin.js';
import { MEETINGS, MeetingsController } from '../src/meetings/meetings.controller.js';
import { MeetingsService } from '../src/meetings/meetings.service.js';

// Integration: the admin API over real HTTP (Nest app, real AuthGuard/AdminGuard) against real Postgres (RLS) and
// real LiveKit. Only the identity provider is a fake here; the real Keycloak is covered in keycloak-admin.test.ts.
const cfg = loadConfig();
const adminUrl = process.env.MIGRATE_DATABASE_URL;
if (!adminUrl) throw new Error('MIGRATE_DATABASE_URL is required for tests');
const pool = new Pool({ connectionString: cfg.DATABASE_URL, max: 6 });
const owner = new Pool({ connectionString: adminUrl, max: 2 });
const sfx = Math.random().toString(36).slice(2, 8);
const slugs = {
  a: `adm-a-${sfx}`,
  b: `adm-b-${sfx}`,
  page: `adm-p-${sfx}`,
  seat: `adm-s-${sfx}`,
  last: `adm-l-${sfx}`,
  pol: `adm-o-${sfx}`,
};

class FakeIdp implements IdentityAdmin {
  created: NewIdentityUser[] = [];
  updates: Array<{ sub: string; orgSlug: string; patch: { role?: OrgRole; enabled?: boolean } }> = [];
  deleted: string[] = [];
  failCreate: IdentityAdminError | null = null;
  async createUser(u: NewIdentityUser) {
    if (this.failCreate) throw this.failCreate;
    this.created.push(u);
    return { id: crypto.randomUUID() };
  }
  async updateUser(sub: string, orgSlug: string, patch: { role?: OrgRole; enabled?: boolean }) {
    this.updates.push({ sub, orgSlug, patch });
    return true;
  }
  async deleteUser(sub: string) {
    this.deleted.push(sub);
  }
}
const idp = new FakeIdp();

const fakeVerifier = async (token: string): Promise<Identity> => {
  try {
    return JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as Identity;
  } catch {
    throw new Error('bad token');
  }
};

@Module({
  controllers: [AdminController, MeetingsController],
  providers: [
    { provide: POOL, useValue: pool },
    { provide: VERIFIER, useValue: fakeVerifier },
    { provide: MEETINGS, useValue: new MeetingsService(pool, cfg) },
    { provide: ADMIN, useValue: new AdminService(pool, idp) },
    AuthGuard,
    AdminGuard,
  ],
})
class TestModule {}

@Module({
  controllers: [AdminController],
  providers: [
    { provide: POOL, useValue: pool },
    { provide: VERIFIER, useValue: fakeVerifier },
    { provide: ADMIN, useValue: new AdminService(pool, null) },
    AuthGuard,
    AdminGuard,
  ],
})
class NoIdpModule {}

let app: INestApplication;
let appNoIdp: INestApplication;
let base = '';
let baseNoIdp = '';

interface Actor extends AuthedUser {
  token: string;
}
async function mkUser(slug: string, sub: string, role: 'org_admin' | 'member', name = sub, email = `${sub}@t.local`): Promise<Actor> {
  const r = await pool.query('SELECT org_id, user_id FROM provision_user($1,$2,$3,$4,$5,$6)', [slug, slug, sub, email, name, role]);
  const identity: Identity = { sub, email, name, orgSlug: slug, role };
  return {
    ...identity,
    orgId: r.rows[0].org_id,
    userId: r.rows[0].user_id,
    token: Buffer.from(JSON.stringify(identity)).toString('base64url'),
  };
}

async function call(url: string, method: string, path: string, token: string | null, body?: unknown) {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* empty body */
  }
  return { status: res.status, body: json, text };
}
const api = (method: string, path: string, token: string | null, body?: unknown) => call(base, method, path, token, body);

let adminA: Actor, adminA2: Actor, memberA: Actor, adminB: Actor, memberB: Actor;

beforeAll(async () => {
  app = await NestFactory.create(TestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
  appNoIdp = await NestFactory.create(NoIdpModule, { logger: false });
  await appNoIdp.listen(0, '127.0.0.1');
  baseNoIdp = `http://127.0.0.1:${(appNoIdp.getHttpServer().address() as { port: number }).port}`;

  adminA = await mkUser(slugs.a, `adma-${sfx}`, 'org_admin', 'Admin A');
  adminA2 = await mkUser(slugs.a, `adma2-${sfx}`, 'org_admin', 'Admin A2');
  memberA = await mkUser(slugs.a, `mema-${sfx}`, 'member', 'Member A');
  adminB = await mkUser(slugs.b, `admb-${sfx}`, 'org_admin', 'Admin B');
  memberB = await mkUser(slugs.b, `memb-${sfx}`, 'member', 'Member B');
});
afterAll(async () => {
  await app.close();
  await appNoIdp.close();
  await owner.query('DELETE FROM organizations WHERE slug = ANY($1)', [Object.values(slugs)]);
  await pool.end();
  await owner.end();
});

const auditActions = async (orgId: string) =>
  (await owner.query('SELECT action, target FROM audit_log WHERE org_id = $1 ORDER BY id', [orgId])).rows as Array<{ action: string; target: string }>;

describe('access control', () => {
  const routes: Array<[string, string, unknown?]> = [
    ['GET', '/v1/admin/overview'],
    ['GET', '/v1/admin/users'],
    ['POST', '/v1/admin/users', { email: 'x@t.local', firstName: 'X', lastName: 'Y', role: 'member' }],
    ['PATCH', '/v1/admin/users/00000000-0000-4000-8000-000000000000', { disabled: true }],
    ['GET', '/v1/admin/departments'],
    ['POST', '/v1/admin/departments', { name: 'Nope' }],
    ['PATCH', '/v1/admin/departments/00000000-0000-4000-8000-000000000000', { name: 'Nope' }],
    ['DELETE', '/v1/admin/departments/00000000-0000-4000-8000-000000000000'],
    ['GET', '/v1/admin/policies'],
    ['PUT', '/v1/admin/policies', { requirePasscode: true, waitingRoomDefault: true, maxParticipants: 10, requireTotp: false }],
  ];

  it.each(routes)('a member gets 403 on %s %s', async (method, path, body) => {
    expect((await api(method, path, memberA.token, body)).status).toBe(403);
  });

  it.each(routes)('no token / garbage token gets 401 on %s %s', async (method, path, body) => {
    expect((await api(method, path, null, body)).status).toBe(401);
    expect((await api(method, path, 'garbage', body)).status).toBe(401);
  });

  it('a member cannot reach the data even though the guard order matters (no side effects happened)', async () => {
    const before = (await auditActions(memberA.orgId)).length;
    await api('POST', '/v1/admin/departments', memberA.token, { name: 'Sneaky' });
    expect((await auditActions(memberA.orgId)).length).toBe(before);
    expect((await owner.query("SELECT 1 FROM departments WHERE name = 'Sneaky'")).rowCount).toBe(0);
  });

  it('an admin passes', async () => {
    const r = await api('GET', '/v1/admin/overview', adminA.token);
    expect(r.status).toBe(200);
  });
});

describe('overview', () => {
  it('returns the documented shape for the caller organization only', async () => {
    const r = await api('GET', '/v1/admin/overview', adminA.token);
    expect(r.body).toEqual({ org: { name: slugs.a, slug: slugs.a }, users: 3, seatsLimit: null, meetingsLast30d: 0 });
    const b = await api('GET', '/v1/admin/overview', adminB.token);
    expect(b.body.org.slug).toBe(slugs.b);
    expect(b.body.users).toBe(2);
  });
});

describe('users: list, search, pagination', () => {
  it('lists items in the documented shape', async () => {
    const r = await api('GET', '/v1/admin/users', adminA.token);
    expect(r.status).toBe(200);
    expect(r.body.next).toBeNull();
    const item = r.body.items.find((i: { id: string }) => i.id === memberA.userId);
    expect(item).toEqual({
      id: memberA.userId,
      email: memberA.email,
      displayName: 'Member A',
      role: 'member',
      department: null,
      disabled: false,
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
  });

  it('keyset pagination walks every user exactly once and never leaks another organization', async () => {
    const created: string[] = [];
    for (let i = 0; i < 7; i++) created.push((await mkUser(slugs.page, `pg${i}-${sfx}`, 'member')).userId);
    const root = await mkUser(slugs.page, `pgadm-${sfx}`, 'org_admin');
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r: { status: number; body: { items: Array<{ id: string }>; next: string | null } } = await api(
        'GET',
        `/v1/admin/users?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        root.token,
      );
      expect(r.status).toBe(200);
      expect(r.body.items.length).toBeLessThanOrEqual(3);
      seen.push(...r.body.items.map((i) => i.id));
      cursor = r.body.next;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(8);
    expect(seen.sort()).toEqual([...created, root.userId].sort());
  });

  it.each([
    ['not base64', '!!!!'],
    ['valid base64 of junk', Buffer.from('hello').toString('base64url')],
    ['sql in the id slot', encodeCursor('2026-01-01T00:00:00.000000Z', "x'; DROP TABLE users;--")],
    ['impossible date', encodeCursor('2026-13-45T00:00:00.000000Z', '00000000-0000-4000-8000-000000000000')],
    ['padded (non canonical) base64', Buffer.from('2026-01-01T00:00:00.000000Z|00000000-0000-4000-8000-000000000000').toString('base64')],
    ['extra field', Buffer.from('2026-01-01T00:00:00.000000Z|00000000-0000-4000-8000-000000000000|x').toString('base64url')],
    ['oversized', 'A'.repeat(500)],
  ])('rejects a tampered cursor: %s', async (_n, cursor) => {
    expect((await api('GET', `/v1/admin/users?cursor=${encodeURIComponent(cursor)}`, adminA.token)).status).toBe(400);
  });

  it.each(['0', '101', '-1', 'abc', '1.5'])('rejects limit=%s', async (limit) => {
    expect((await api('GET', `/v1/admin/users?limit=${limit}`, adminA.token)).status).toBe(400);
  });

  it('accepts limit=100', async () => {
    expect((await api('GET', '/v1/admin/users?limit=100', adminA.token)).status).toBe(200);
  });

  it('search is case-insensitive on email and name and treats LIKE wildcards literally', async () => {
    const org = slugs.a;
    const u1 = await mkUser(org, `s1-${sfx}`, 'member', 'Rate 100% Done', `a_b-${sfx}@t.local`);
    const u2 = await mkUser(org, `s2-${sfx}`, 'member', 'Plain Name', `axb-${sfx}@t.local`);
    const u3 = await mkUser(org, `s3-${sfx}`, 'member', 'Back\\slash', `bs-${sfx}@t.local`);
    const ids = async (q: string) =>
      ((await api('GET', `/v1/admin/users?search=${encodeURIComponent(q)}`, adminA.token)).body.items as Array<{ id: string }>).map((i) => i.id);
    expect(await ids(`A_B-${sfx}`)).toEqual([u1.userId]); // '_' is not "any char": axb must not match
    expect(await ids('_')).toEqual([u1.userId]); // only the one containing a literal underscore (sub-based emails use '-')
    expect(await ids('%')).toEqual([u1.userId]); // '%' is not "match all"
    expect(await ids('100%')).toEqual([u1.userId]);
    expect(await ids('\\')).toEqual([u3.userId]);
    expect(await ids('plain name')).toEqual([u2.userId]);
    expect(await ids("'; DROP TABLE users;--")).toEqual([]);
    expect((await api('GET', `/v1/admin/users?search=${'x'.repeat(101)}`, adminA.token)).status).toBe(400);
  });

  it('escapeLike escapes backslash, percent and underscore', () => {
    expect(escapeLike('a%b_c\\d')).toBe('a\\%b\\_c\\\\d');
  });

  it('cursor round trip', () => {
    const c = encodeCursor('2026-01-01T00:00:00.123456Z', '00000000-0000-4000-8000-000000000000');
    expect(decodeCursor(c)).toEqual({ ts: '2026-01-01T00:00:00.123456Z', id: '00000000-0000-4000-8000-000000000000' });
  });
});

describe('users: create', () => {
  it('creates in the identity provider with the caller org and role, then in the database; password returned once', async () => {
    const out: string[] = [];
    const spies = [vi.spyOn(process.stdout, 'write'), vi.spyOn(process.stderr, 'write'), vi.spyOn(console, 'log'), vi.spyOn(console, 'error')];
    spies.forEach((s) => s.mockImplementation((...a: unknown[]) => (out.push(String(a[0])), true) as never));
    let r;
    try {
      r = await api('POST', '/v1/admin/users', adminA.token, { email: ` New.User-${sfx}@T.Local `, firstName: 'New', lastName: 'User', role: 'org_admin' });
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
    expect(r.status).toBe(201);
    const pw: string = r.body.temporaryPassword;
    expect(pw).toMatch(/^[\x21-\x7e]{20}$/);
    expect(r.body.user).toMatchObject({ email: `new.user-${sfx}@t.local`, displayName: 'New User', role: 'org_admin', department: null, disabled: false });
    const sent = idp.created.at(-1)!;
    expect(sent).toMatchObject({ orgSlug: slugs.a, role: 'org_admin', requireTotp: false, temporaryPassword: pw });
    const row = (await owner.query('SELECT external_sub, org_id FROM users WHERE id = $1', [r.body.user.id])).rows[0];
    expect(row.org_id).toBe(adminA.orgId);
    expect(row.external_sub).toMatch(/^[0-9a-f-]{36}$/);
    // no secret in logs, audit rows or any table
    expect(out.join('\n')).not.toContain(pw);
    const audit = await auditActions(adminA.orgId);
    expect(audit.some((a) => a.action === 'admin.user.create' && a.target.startsWith(r.body.user.id))).toBe(true);
    expect(JSON.stringify(audit)).not.toContain(pw);
    expect((await owner.query('SELECT 1 FROM users WHERE email = $1 OR display_name = $1 OR external_sub = $1', [pw])).rowCount).toBe(0);
    // the password is not retrievable later
    const list = await api('GET', `/v1/admin/users?search=${encodeURIComponent(`new.user-${sfx}`)}`, adminA.token);
    expect(JSON.stringify(list.body)).not.toContain(pw);
  });

  it('assigns a department of the own organization', async () => {
    const dep = (await api('POST', '/v1/admin/departments', adminA.token, { name: `Sales ${sfx}` })).body;
    const r = await api('POST', '/v1/admin/users', adminA.token, { email: `d1-${sfx}@t.local`, firstName: 'D', lastName: 'One', role: 'member', departmentId: dep.id });
    expect(r.status).toBe(201);
    expect(r.body.user.department).toEqual({ id: dep.id, name: `Sales ${sfx}` });
    expect(idp.created.at(-1)!.requireTotp).toBe(false); // member, no policy
  });

  it('applies requireTotp from the organization policy', async () => {
    await api('PUT', '/v1/admin/policies', adminA.token, { requirePasscode: false, waitingRoomDefault: true, maxParticipants: 300, requireTotp: true });
    const r = await api('POST', '/v1/admin/users', adminA.token, { email: `t1-${sfx}@t.local`, firstName: 'T', lastName: 'One', role: 'member' });
    expect(r.status).toBe(201);
    expect(idp.created.at(-1)).toMatchObject({ role: 'member', requireTotp: true });
    await api('PUT', '/v1/admin/policies', adminA.token, { requirePasscode: false, waitingRoomDefault: true, maxParticipants: 300, requireTotp: false });
  });

  it("refuses another organization's department (404) and creates nothing", async () => {
    const depB = (await api('POST', '/v1/admin/departments', adminB.token, { name: `Foreign ${sfx}` })).body;
    const before = idp.created.length;
    const r = await api('POST', '/v1/admin/users', adminA.token, { email: `f1-${sfx}@t.local`, firstName: 'F', lastName: 'One', role: 'member', departmentId: depB.id });
    expect(r.status).toBe(404);
    expect(idp.created.length).toBe(before);
    expect((await owner.query('SELECT 1 FROM users WHERE email = $1', [`f1-${sfx}@t.local`])).rowCount).toBe(0);
  });

  it.each([
    ['bad email', { email: 'not-an-email', firstName: 'A', lastName: 'B', role: 'member' }],
    ['unknown role', { email: 'a@t.local', firstName: 'A', lastName: 'B', role: 'superadmin' }],
    ['missing last name', { email: 'a@t.local', firstName: 'A', role: 'member' }],
    ['empty first name', { email: 'a@t.local', firstName: '  ', lastName: 'B', role: 'member' }],
    ['name too long', { email: 'a@t.local', firstName: 'A'.repeat(81), lastName: 'B', role: 'member' }],
    ['department not a uuid', { email: 'a@t.local', firstName: 'A', lastName: 'B', role: 'member', departmentId: 'x' }],
    ['extra field (mass assignment)', { email: 'a@t.local', firstName: 'A', lastName: 'B', role: 'member', disabled: true }],
    ['org smuggling', { email: 'a@t.local', firstName: 'A', lastName: 'B', role: 'member', orgSlug: slugs.b }],
  ])('validates input: %s -> 400 and nothing is created', async (_n, body) => {
    const before = idp.created.length;
    expect((await api('POST', '/v1/admin/users', adminA.token, body)).status).toBe(400);
    expect(idp.created.length).toBe(before);
  });

  it('maps a duplicate email from the identity provider to 409 and writes no row', async () => {
    idp.failCreate = new IdentityAdminError(409, 'a user with this email already exists');
    try {
      const r = await api('POST', '/v1/admin/users', adminA.token, { email: `dup-${sfx}@t.local`, firstName: 'D', lastName: 'Up', role: 'member' });
      expect(r.status).toBe(409);
    } finally {
      idp.failCreate = null;
    }
    expect((await owner.query('SELECT 1 FROM users WHERE email = $1', [`dup-${sfx}@t.local`])).rowCount).toBe(0);
  });

  it('answers 503 on user management when the identity provider admin access is not configured, other routes still work', async () => {
    const t = adminA.token;
    const post = await call(baseNoIdp, 'POST', '/v1/admin/users', t, { email: 'n@t.local', firstName: 'N', lastName: 'O', role: 'member' });
    expect(post.status).toBe(503);
    expect(post.body.message).toBe('identity provider admin access is not configured');
    const patch = await call(baseNoIdp, 'PATCH', `/v1/admin/users/${memberA.userId}`, t, { role: 'org_admin' });
    expect(patch.status).toBe(503);
    expect((await call(baseNoIdp, 'GET', '/v1/admin/users', t)).status).toBe(200);
    expect((await call(baseNoIdp, 'GET', '/v1/admin/departments', t)).status).toBe(200);
    expect((await call(baseNoIdp, 'GET', '/v1/admin/policies', t)).status).toBe(200);
    expect((await call(baseNoIdp, 'GET', '/v1/admin/overview', t)).status).toBe(200);
    // a department-only change needs no identity provider
    const dep = (await call(baseNoIdp, 'POST', '/v1/admin/departments', t, { name: `NoIdp ${sfx}` })).body;
    expect((await call(baseNoIdp, 'PATCH', `/v1/admin/users/${memberA.userId}`, t, { departmentId: dep.id })).status).toBe(200);
    expect((await call(baseNoIdp, 'PATCH', `/v1/admin/users/${memberA.userId}`, t, { departmentId: null })).status).toBe(200);
  });

  it('removes the identity provider user again when the database insert fails (consistency)', async () => {
    // Force a failure after the provider call: the same external id cannot be reused, so make the insert violate a constraint
    // by sending a display name longer than allowed through the service directly is not possible; use a unique clash instead.
    const svc = new AdminService(pool, {
      createUser: async () => ({ id: memberA.sub }), // clashes with UNIQUE (org_id, external_sub)
      updateUser: async () => true,
      deleteUser: async (sub: string) => void idp.deleted.push(`comp:${sub}`),
    });
    await expect(svc.createUser(adminA, { email: `cons-${sfx}@t.local`, firstName: 'C', lastName: 'O', role: 'member' })).rejects.toThrow();
    expect(idp.deleted).toContain(`comp:${memberA.sub}`);
  });
});

describe('users: update', () => {
  it('role and disabled are applied in the identity provider and in the database; audit rows are written', async () => {
    const u = await mkUser(slugs.a, `upd-${sfx}`, 'member', 'Upd');
    const r1 = await api('PATCH', `/v1/admin/users/${u.userId}`, adminA.token, { role: 'org_admin' });
    expect(r1.status).toBe(200);
    expect(r1.body.role).toBe('org_admin');
    expect(idp.updates.at(-1)).toEqual({ sub: u.sub, orgSlug: slugs.a, patch: { role: 'org_admin' } });
    const r2 = await api('PATCH', `/v1/admin/users/${u.userId}`, adminA.token, { disabled: true, role: 'member' });
    expect(r2.body).toMatchObject({ role: 'member', disabled: true });
    expect(idp.updates.at(-1)).toEqual({ sub: u.sub, orgSlug: slugs.a, patch: { role: 'member', enabled: false } });
    const actions = (await auditActions(adminA.orgId)).filter((a) => a.target.startsWith(u.userId));
    expect(actions.map((a) => a.action)).toEqual(['admin.user.update', 'admin.user.disable']);
  });

  it('a disabled user gets 403 on every authenticated route and can be re-enabled', async () => {
    const u = await mkUser(slugs.a, `dis-${sfx}`, 'member', 'Dis');
    expect((await api('GET', '/v1/meetings', u.token)).status).toBe(200);
    await api('PATCH', `/v1/admin/users/${u.userId}`, adminA.token, { disabled: true });
    const blocked = await api('GET', '/v1/meetings', u.token);
    expect(blocked.status).toBe(403);
    expect(blocked.body.message).toBe('account is disabled');
    // a token that claims org_admin does not bring a disabled user back
    const sneaky = Buffer.from(JSON.stringify({ sub: u.sub, email: u.email, name: u.name, orgSlug: slugs.a, role: 'org_admin' })).toString('base64url');
    expect((await api('GET', '/v1/admin/overview', sneaky)).status).toBe(403);
    expect((await owner.query('SELECT role FROM users WHERE id = $1', [u.userId])).rows[0].role).toBe('member'); // not overwritten
    await api('PATCH', `/v1/admin/users/${u.userId}`, adminA.token, { disabled: false });
    expect((await api('GET', '/v1/meetings', u.token)).status).toBe(200);
  });

  it('an admin cannot demote or disable themselves (400), but may re-assert their own role', async () => {
    const before = idp.updates.length;
    expect((await api('PATCH', `/v1/admin/users/${adminA.userId}`, adminA.token, { role: 'member' })).status).toBe(400);
    expect((await api('PATCH', `/v1/admin/users/${adminA.userId}`, adminA.token, { disabled: true })).status).toBe(400);
    expect(idp.updates.length).toBe(before);
    expect((await owner.query('SELECT role, disabled FROM users WHERE id = $1', [adminA.userId])).rows[0]).toEqual({ role: 'org_admin', disabled: false });
    expect((await api('PATCH', `/v1/admin/users/${adminA.userId}`, adminA.token, { role: 'org_admin' })).status).toBe(200);
  });

  it('the last organization admin cannot be demoted or disabled (409), even by an actor the guard let through', async () => {
    const admin = await mkUser(slugs.last, `lastadm-${sfx}`, 'org_admin');
    const other = await mkUser(slugs.last, `lastmem-${sfx}`, 'member');
    const svc = new AdminService(pool, new FakeIdp());
    const actor: AuthedUser = { ...other, role: 'org_admin' };
    await expect(svc.updateUser(actor, admin.userId, { role: 'member' })).rejects.toMatchObject({ status: 409 });
    await expect(svc.updateUser(actor, admin.userId, { disabled: true })).rejects.toMatchObject({ status: 409 });
    expect((await owner.query('SELECT role, disabled FROM users WHERE id = $1', [admin.userId])).rows[0]).toEqual({ role: 'org_admin', disabled: false });
    // with a second admin it is allowed
    const second = await mkUser(slugs.last, `lastadm2-${sfx}`, 'org_admin');
    await expect(svc.updateUser({ ...second }, admin.userId, { role: 'member' })).resolves.toMatchObject({ role: 'member' });
    await expect(svc.updateUser({ ...admin, role: 'org_admin' }, second.userId, { disabled: true })).rejects.toMatchObject({ status: 409 });
  });

  it("another organization's admin gets 404 and cannot modify foreign rows", async () => {
    const before = idp.updates.length;
    for (const body of [{ disabled: true }, { role: 'org_admin' }, { departmentId: null }]) {
      expect((await api('PATCH', `/v1/admin/users/${memberA.userId}`, adminB.token, body)).status).toBe(404);
    }
    expect(idp.updates.length).toBe(before);
    expect((await owner.query('SELECT role, disabled, department_id FROM users WHERE id = $1', [memberA.userId])).rows[0]).toEqual({
      role: 'member',
      disabled: false,
      department_id: null,
    });
  });

  it('assigning a foreign department is refused (404) and the database also forbids it', async () => {
    const depB = (await api('POST', '/v1/admin/departments', adminB.token, { name: `Only B ${sfx}` })).body;
    expect((await api('PATCH', `/v1/admin/users/${memberA.userId}`, adminA.token, { departmentId: depB.id })).status).toBe(404);
    // defence in depth: even a direct write that bypassed the service fails on the composite foreign key
    await expect(owner.query('UPDATE users SET department_id = $1 WHERE id = $2', [depB.id, memberA.userId])).rejects.toMatchObject({ code: '23503' });
  });

  it('assigns, changes and clears the department', async () => {
    const dep = (await api('POST', '/v1/admin/departments', adminA.token, { name: `Ops ${sfx}` })).body;
    const u = await mkUser(slugs.a, `dep-${sfx}`, 'member');
    const set = await api('PATCH', `/v1/admin/users/${u.userId}`, adminA.token, { departmentId: dep.id });
    expect(set.body.department).toEqual({ id: dep.id, name: `Ops ${sfx}` });
    const clr = await api('PATCH', `/v1/admin/users/${u.userId}`, adminA.token, { departmentId: null });
    expect(clr.body.department).toBeNull();
  });

  it.each([
    ['empty body', {}],
    ['unknown field', { email: 'x@y.z' }],
    ['bad role', { role: 'root' }],
    ['disabled as string', { disabled: 'yes' }],
    ['department not uuid', { departmentId: 'abc' }],
  ])('validates input: %s -> 400', async (_n, body) => {
    expect((await api('PATCH', `/v1/admin/users/${memberA.userId}`, adminA.token, body)).status).toBe(400);
  });

  it('a malformed id is 404, not 500', async () => {
    expect((await api('PATCH', '/v1/admin/users/not-a-uuid', adminA.token, { disabled: false })).status).toBe(404);
    expect((await api('PATCH', "/v1/admin/users/1'%20OR%20'1'='1", adminA.token, { disabled: false })).status).toBe(404);
  });
});

describe('departments', () => {
  it('creates, lists with user counts, renames, and deletes an empty department', async () => {
    const d = await api('POST', '/v1/admin/departments', adminA.token, { name: `  Finance ${sfx} ` });
    expect(d.status).toBe(201);
    expect(d.body).toEqual({ id: expect.any(String), name: `Finance ${sfx}`, userCount: 0 });
    const u = await mkUser(slugs.a, `fin-${sfx}`, 'member');
    await api('PATCH', `/v1/admin/users/${u.userId}`, adminA.token, { departmentId: d.body.id });
    const list = await api('GET', '/v1/admin/departments', adminA.token);
    expect(list.body.find((x: { id: string }) => x.id === d.body.id)).toEqual({ id: d.body.id, name: `Finance ${sfx}`, userCount: 1 });
    const ren = await api('PATCH', `/v1/admin/departments/${d.body.id}`, adminA.token, { name: `Treasury ${sfx}` });
    expect(ren.body).toEqual({ id: d.body.id, name: `Treasury ${sfx}`, userCount: 1 });
    // deleting a department that has users -> 409 and the assignment survives
    expect((await api('DELETE', `/v1/admin/departments/${d.body.id}`, adminA.token)).status).toBe(409);
    expect((await owner.query('SELECT department_id FROM users WHERE id = $1', [u.userId])).rows[0].department_id).toBe(d.body.id);
    await api('PATCH', `/v1/admin/users/${u.userId}`, adminA.token, { departmentId: null });
    const del = await api('DELETE', `/v1/admin/departments/${d.body.id}`, adminA.token);
    expect(del.status).toBe(200);
    expect((await api('DELETE', `/v1/admin/departments/${d.body.id}`, adminA.token)).status).toBe(404);
    const actions = (await auditActions(adminA.orgId)).map((a) => a.action);
    for (const a of ['admin.department.create', 'admin.department.update', 'admin.department.delete']) expect(actions).toContain(a);
  });

  it('names are unique per organization, case-insensitively, but not across organizations', async () => {
    const n = `Legal ${sfx}`;
    expect((await api('POST', '/v1/admin/departments', adminA.token, { name: n })).status).toBe(201);
    expect((await api('POST', '/v1/admin/departments', adminA.token, { name: n.toUpperCase() })).status).toBe(409);
    expect((await api('POST', '/v1/admin/departments', adminB.token, { name: n })).status).toBe(201);
    const other = (await api('POST', '/v1/admin/departments', adminA.token, { name: `Other ${sfx}` })).body;
    expect((await api('PATCH', `/v1/admin/departments/${other.id}`, adminA.token, { name: n })).status).toBe(409);
    expect((await api('PATCH', `/v1/admin/departments/${other.id}`, adminA.token, { name: `Other ${sfx}` })).status).toBe(200); // same name, same row
  });

  it.each([
    ['empty', { name: '' }],
    ['blank', { name: '   ' }],
    ['81 chars', { name: 'x'.repeat(81) }],
    ['missing', {}],
    ['not a string', { name: 5 }],
    ['extra field', { name: 'Ok', orgId: 'x' }],
  ])('validates the name: %s -> 400', async (_n, body) => {
    expect((await api('POST', '/v1/admin/departments', adminA.token, body)).status).toBe(400);
  });

  it('accepts 1 and 80 character names', async () => {
    expect((await api('POST', '/v1/admin/departments', adminA.token, { name: 'Z' })).status).toBe(201);
    expect((await api('POST', '/v1/admin/departments', adminA.token, { name: 'y'.repeat(80) })).status).toBe(201);
  });

  it("another organization's admin sees none of it and can neither rename nor delete (404)", async () => {
    const d = (await api('POST', '/v1/admin/departments', adminA.token, { name: `Private ${sfx}` })).body;
    const list = await api('GET', '/v1/admin/departments', adminB.token);
    expect(list.body.map((x: { id: string }) => x.id)).not.toContain(d.id);
    expect((await api('PATCH', `/v1/admin/departments/${d.id}`, adminB.token, { name: 'Hacked' })).status).toBe(404);
    expect((await api('DELETE', `/v1/admin/departments/${d.id}`, adminB.token)).status).toBe(404);
    expect((await owner.query('SELECT name FROM departments WHERE id = $1', [d.id])).rows[0].name).toBe(`Private ${sfx}`);
  });

  it('malformed ids are 404, not 500', async () => {
    expect((await api('PATCH', '/v1/admin/departments/xyz', adminA.token, { name: 'A' })).status).toBe(404);
    expect((await api('DELETE', '/v1/admin/departments/xyz', adminA.token)).status).toBe(404);
  });
});

describe('policies', () => {
  const valid = { requirePasscode: true, waitingRoomDefault: false, maxParticipants: 12, requireTotp: true };

  it('returns defaults, stores a full replacement, audits, and isolates organizations', async () => {
    const admin = await mkUser(slugs.pol, `poladm-${sfx}`, 'org_admin');
    const t = admin.token;
    const get0 = await api('GET', '/v1/admin/policies', t);
    expect(get0.body).toEqual({ requirePasscode: false, waitingRoomDefault: true, maxParticipants: 300, requireTotp: false, guestPolicy: 'off', defaultStyle: 'liquid-glass', defaultDensity: 'comfortable', allowedStyles: null });
    const put = await api('PUT', '/v1/admin/policies', t, valid);
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ ...valid, guestPolicy: 'off', defaultStyle: 'liquid-glass', defaultDensity: 'comfortable', allowedStyles: null }); // omitted guestPolicy is stored as the safe default
    expect((await api('GET', '/v1/admin/policies', t)).body).toEqual({ ...valid, guestPolicy: 'off', defaultStyle: 'liquid-glass', defaultDensity: 'comfortable', allowedStyles: null });
    expect((await api('GET', '/v1/admin/policies', adminB.token)).body.maxParticipants).toBe(300); // not org B's
    expect((await auditActions(admin.orgId)).map((a) => a.action)).toContain('admin.policy.update');
  });

  it.each([
    ['max 1', { ...valid, maxParticipants: 1 }],
    ['max 301', { ...valid, maxParticipants: 301 }],
    ['max fractional', { ...valid, maxParticipants: 10.5 }],
    ['max string', { ...valid, maxParticipants: '10' }],
    ['flag not boolean', { ...valid, requirePasscode: 'true' }],
    ['missing field', { requirePasscode: true, waitingRoomDefault: true, maxParticipants: 10 }],
    ['extra field', { ...valid, lockWaitingRoom: true }],
    ['unknown guest policy', { ...valid, guestPolicy: 'everyone' }],
    ['guest policy not a string', { ...valid, guestPolicy: true }],
  ])('rejects %s with 400 and stores nothing', async (_n, body) => {
    const before = (await api('GET', '/v1/admin/policies', adminB.token)).body;
    expect((await api('PUT', '/v1/admin/policies', adminB.token, body)).status).toBe(400);
    expect((await api('GET', '/v1/admin/policies', adminB.token)).body).toEqual(before);
  });

  it('stores each guest policy and an admin can lower it again', async () => {
    for (const g of ['open', 'waiting_room', 'off'] as const) {
      const r = await api('PUT', '/v1/admin/policies', adminB.token, { ...valid, guestPolicy: g });
      expect(r.status).toBe(200);
      expect((await api('GET', '/v1/admin/policies', adminB.token)).body.guestPolicy).toBe(g);
    }
    expect((await auditActions(adminB.orgId)).some((a) => a.action === 'admin.policy.update')).toBe(true);
    const row = await owner.query("SELECT target FROM audit_log WHERE org_id = $1 AND action = 'admin.policy.update' ORDER BY id DESC LIMIT 1", [adminB.orgId]);
    expect(row.rows[0].target).toContain('guestPolicy=off');
  });

  it('accepts the bounds 2 and 300', async () => {
    expect((await api('PUT', '/v1/admin/policies', adminB.token, { ...valid, maxParticipants: 2 })).status).toBe(200);
    expect((await api('PUT', '/v1/admin/policies', adminB.token, { ...valid, maxParticipants: 300 })).status).toBe(200);
    await api('PUT', '/v1/admin/policies', adminB.token, { requirePasscode: false, waitingRoomDefault: true, maxParticipants: 300, requireTotp: false });
  });

  it('the database itself refuses out-of-range values', async () => {
    await expect(owner.query('INSERT INTO org_policies (org_id, max_participants) VALUES ($1, 1)', [adminA.orgId])).rejects.toMatchObject({ code: '23514' });
  });
});

describe('policy enforcement in meetings', () => {
  const lk = new RoomServiceClient(cfg.LIVEKIT_API_URL, cfg.LIVEKIT_API_KEY, cfg.LIVEKIT_API_SECRET);
  const setPolicy = (a: Actor, p: object) => api('PUT', '/v1/admin/policies', a.token, p);
  const defaults = { requirePasscode: false, waitingRoomDefault: true, maxParticipants: 300, requireTotp: false };

  it('requirePasscode: a meeting without passcode is refused (400), with a passcode it is created', async () => {
    await setPolicy(adminB, { ...defaults, requirePasscode: true });
    try {
      const no = await api('POST', '/v1/meetings', adminB.token, { title: 'No pass' });
      expect(no.status).toBe(400);
      expect(no.body.message).toMatch(/passcode/);
      expect((await owner.query("SELECT 1 FROM meetings WHERE title = 'No pass' AND org_id = $1", [adminB.orgId])).rowCount).toBe(0);
      const ok = await api('POST', '/v1/meetings', adminB.token, { title: 'With pass', passcode: 'secret-123' });
      expect(ok.status).toBe(201);
      expect(ok.body.has_passcode).toBe(true);
      // another organization is not bound by this policy
      expect((await api('POST', '/v1/meetings', adminA.token, { title: 'A free' })).status).toBe(201);
    } finally {
      await setPolicy(adminB, defaults);
    }
    expect((await api('POST', '/v1/meetings', adminB.token, { title: 'No pass after reset' })).status).toBe(201);
  });

  it('waitingRoomDefault is used only when the client does not say; an explicit choice wins', async () => {
    await setPolicy(adminB, { ...defaults, waitingRoomDefault: false });
    try {
      expect((await api('POST', '/v1/meetings', adminB.token, { title: 'Default off' })).body.waiting_room).toBe(false);
      expect((await api('POST', '/v1/meetings', adminB.token, { title: 'Explicit on', waitingRoom: true })).body.waiting_room).toBe(true);
      expect((await api('POST', '/v1/meetings', adminA.token, { title: 'Other org' })).body.waiting_room).toBe(true);
    } finally {
      await setPolicy(adminB, defaults);
    }
    expect((await api('POST', '/v1/meetings', adminB.token, { title: 'Default on again' })).body.waiting_room).toBe(true);
  });

  it('maxParticipants becomes the LiveKit room limit (default stays 300)', async () => {
    await setPolicy(adminB, { ...defaults, maxParticipants: 7 });
    let id: string;
    try {
      const m = (await api('POST', '/v1/meetings', adminB.token, { title: 'Small', waitingRoom: false })).body;
      const j = await api('POST', `/v1/meetings/${m.code}/join`, memberB.token, {});
      expect(j.status).toBe(200);
      id = j.body.meetingId;
      const room = (await lk.listRooms([id]))[0]!;
      expect(room.maxParticipants).toBe(7);
      await lk.deleteRoom(id);
    } finally {
      await setPolicy(adminB, defaults);
    }
    const m2 = (await api('POST', '/v1/meetings', adminB.token, { title: 'Big', waitingRoom: false })).body;
    const j2 = await api('POST', `/v1/meetings/${m2.code}/join`, memberB.token, {});
    expect((await lk.listRooms([j2.body.meetingId]))[0]!.maxParticipants).toBe(300);
    await lk.deleteRoom(j2.body.meetingId);
  });
});

describe('seat limit', () => {
  it('refuses a NEW user beyond the limit at provisioning (SQL), keeps existing users, frees seats when users are disabled', async () => {
    const a1 = await mkUser(slugs.seat, `seat1-${sfx}`, 'org_admin');
    const m1 = await mkUser(slugs.seat, `seat2-${sfx}`, 'member');
    await owner.query('INSERT INTO org_licenses (org_id, seats_limit) VALUES ($1, 2)', [a1.orgId]);

    // a third, new user is refused with SQLSTATE 53400
    await expect(
      pool.query('SELECT * FROM provision_user($1,$2,$3,$4,$5,$6)', [slugs.seat, slugs.seat, `seat3-${sfx}`, 'x@t.local', 'x', 'member']),
    ).rejects.toMatchObject({ code: '53400' });
    expect((await owner.query('SELECT 1 FROM users WHERE org_id = $1', [a1.orgId])).rowCount).toBe(2);
    // existing users keep logging in
    const again = await pool.query('SELECT user_id, disabled FROM provision_user($1,$2,$3,$4,$5,$6)', [slugs.seat, slugs.seat, m1.sub, m1.email, 'm', 'member']);
    expect(again.rows[0]).toEqual({ user_id: m1.userId, disabled: false });

    // over HTTP the guard answers 403 for the new user
    const newcomer: Identity = { sub: `seat3-${sfx}`, email: 'x@t.local', name: 'x', orgSlug: slugs.seat, role: 'member' };
    const tok = Buffer.from(JSON.stringify(newcomer)).toString('base64url');
    const denied = await api('GET', '/v1/meetings', tok);
    expect(denied.status).toBe(403);
    expect(denied.body.message).toBe('seat limit reached');

    // admin-created users are refused as well (409) and nothing reaches the identity provider
    const before = idp.created.length;
    const viaAdmin = await api('POST', '/v1/admin/users', a1.token, { email: `seat4-${sfx}@t.local`, firstName: 'S', lastName: 'Four', role: 'member' });
    expect(viaAdmin.status).toBe(409);
    expect(idp.created.length).toBe(before);

    // overview reports the limit
    expect((await api('GET', '/v1/admin/overview', a1.token)).body).toMatchObject({ users: 2, seatsLimit: 2 });

    // disabling a user frees a seat; re-enabling when full is refused
    expect((await api('PATCH', `/v1/admin/users/${m1.userId}`, a1.token, { disabled: true })).status).toBe(200);
    expect((await api('GET', '/v1/meetings', tok)).status).toBe(200); // newcomer now fits
    expect((await api('PATCH', `/v1/admin/users/${m1.userId}`, a1.token, { disabled: false })).status).toBe(409);
    expect((await owner.query('SELECT disabled FROM users WHERE id = $1', [m1.userId])).rows[0].disabled).toBe(true);
  });

  it('the application role cannot change licences', async () => {
    await expect(pool.query('UPDATE org_licenses SET seats_limit = 9999')).rejects.toMatchObject({ code: '42501' });
    await expect(pool.query('INSERT INTO org_licenses (org_id, seats_limit) VALUES ($1, 5)', [adminA.orgId])).rejects.toMatchObject({ code: '42501' });
  });

  it('provision_user returns disabled and leaves a disabled user untouched', async () => {
    const u = await mkUser(slugs.a, `frozen-${sfx}`, 'member', 'Frozen');
    await owner.query('UPDATE users SET disabled = true WHERE id = $1', [u.userId]);
    const r = await pool.query('SELECT role, disabled FROM provision_user($1,$2,$3,$4,$5,$6)', [slugs.a, slugs.a, u.sub, 'changed@t.local', 'Changed', 'org_admin']);
    expect(r.rows[0]).toEqual({ role: 'member', disabled: true });
    expect((await owner.query('SELECT email, display_name FROM users WHERE id = $1', [u.userId])).rows[0]).toEqual({ email: u.email, display_name: 'Frozen' });
  });
});

describe('row-level security of the new tables', () => {
  it('departments, policies and licences are invisible across organizations, also with the raw application role', async () => {
    const dep = (await api('POST', '/v1/admin/departments', adminA.token, { name: `RLS ${sfx}` })).body;
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.current_org', $1, true)", [adminB.orgId]);
      expect((await c.query('SELECT 1 FROM departments WHERE id = $1', [dep.id])).rowCount).toBe(0);
      await expect(c.query('INSERT INTO departments (org_id, name) VALUES ($1, $2)', [adminA.orgId, 'forged'])).rejects.toMatchObject({ code: '42501' });
      await c.query('ROLLBACK');
      await c.query('BEGIN');
      await expect(c.query('SELECT 1 FROM departments')).resolves.toMatchObject({ rowCount: 0 }); // no tenant set: nothing
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  });

  it('a deleted department detaches its users (ON DELETE SET NULL) without touching org_id', async () => {
    const d = (await owner.query('INSERT INTO departments (org_id, name) VALUES ($1, $2) RETURNING id', [adminA.orgId, `Tmp ${sfx}`])).rows[0].id;
    const u = await mkUser(slugs.a, `det-${sfx}`, 'member');
    await owner.query('UPDATE users SET department_id = $1 WHERE id = $2', [d, u.userId]);
    await owner.query('DELETE FROM departments WHERE id = $1', [d]);
    expect((await owner.query('SELECT department_id, org_id FROM users WHERE id = $1', [u.userId])).rows[0]).toEqual({ department_id: null, org_id: adminA.orgId });
  });
});

describe('AdminError', () => {
  it('carries a status', () => {
    expect(new AdminError(409, 'x').status).toBe(409);
  });
});
