import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { loadConfig } from '../src/config.js';
import type { SelfServiceIdentity } from '../src/admin/identity-admin.js';
import type { AuthedUser } from '../src/auth/auth.guard.js';
import { identityFromClaims } from '../src/auth/jwt.js';
import { avatarProblem, inspectImage } from '../src/profile/image.js';
import { ProfileError, ProfileService, isTimeZone } from '../src/profile/profile.service.js';
import { SecurityService, describeAgent, ipPrefix } from '../src/profile/security.service.js';
import { profilePatchSchema } from '../src/profile/profile.controller.js';

// Integration against the real database (RLS) for the profile package (owner decisions 2, 3 and 5 of 2026-11-27). The
// identity provider is a fake here; the real Keycloak flows are covered by profile.e2e.mjs.
const cfg = loadConfig();
const adminUrl = process.env.MIGRATE_DATABASE_URL;
if (!adminUrl) throw new Error('MIGRATE_DATABASE_URL is required for tests');
const pool = new Pool({ connectionString: cfg.DATABASE_URL, max: 4 });
const owner = new Pool({ connectionString: adminUrl, max: 2 });
const profile = new ProfileService(pool, cfg);
const sfx = Math.random().toString(36).slice(2, 8);
const slugA = `pf-a-${sfx}`;
const slugB = `pf-b-${sfx}`;

async function mkUser(slug: string, sub: string, role: 'org_admin' | 'member', sid?: string): Promise<AuthedUser> {
  const r = await pool.query('SELECT org_id, user_id FROM provision_user($1,$2,$3,$4,$5,$6)', [slug, slug, sub, `${sub}@t.local`, sub, role]);
  return { sub, email: `${sub}@t.local`, name: sub, orgSlug: slug, role, orgId: r.rows[0].org_id, userId: r.rows[0].user_id, ...(sid ? { sid } : {}) };
}
async function status(p: Promise<unknown>): Promise<number> {
  try {
    await p;
    return 200;
  } catch (e) {
    if (e instanceof ProfileError) return e.status;
    throw e;
  }
}

// --- tiny valid images (headers only matter to the checks) ---
function png(w: number, h: number): Buffer {
  const b = Buffer.alloc(40);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}
function jpeg(w: number, h: number): Buffer {
  // SOI, APP0 (len 16), SOF0 (len 17) with height/width
  const app0 = Buffer.concat([Buffer.from([0xff, 0xe0, 0x00, 0x10]), Buffer.alloc(14)]);
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(h, 5);
  sof.writeUInt16BE(w, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}

let admin: AuthedUser, member: AuthedUser, outsider: AuthedUser;
beforeAll(async () => {
  admin = await mkUser(slugA, `pa-${sfx}`, 'org_admin', 'sid-admin-1');
  member = await mkUser(slugA, `pm-${sfx}`, 'member', 'sid-member-1');
  outsider = await mkUser(slugB, `po-${sfx}`, 'org_admin');
});
afterAll(async () => {
  await owner.query('DELETE FROM organizations WHERE slug IN ($1,$2)', [slugA, slugB]);
  await pool.end();
  await owner.end();
});

describe('token session id', () => {
  it('keeps a well-formed sid and drops anything else', () => {
    const base = { sub: 's', email: 'a@b.c', org_slug: 'acme', realm_access: { roles: ['member'] } };
    expect(identityFromClaims({ ...base, sid: 'abc-123_x.y' }).sid).toBe('abc-123_x.y');
    expect(identityFromClaims({ ...base, sid: 'a b/c' }).sid).toBeUndefined();
    expect(identityFromClaims(base).sid).toBeUndefined();
  });
});

describe('request shape', () => {
  it.each([[{ jobTitle: 'x'.repeat(101) }], [{ phone: 'call me' }], [{ timeZone: '../etc' }], [{ dateFormat: 'yyyy' }], [{ timeFormat: '25h' }], [{ name: 'x' }], [{ departmentId: 'nope' }]])('refuses %j', (b) => {
    expect(profilePatchSchema.safeParse(b).success).toBe(false);
  });
  it('accepts the real fields and clearing them', () => {
    expect(profilePatchSchema.safeParse({ jobTitle: 'Engineer', phone: '+998 90 123-45-67', timeZone: 'Asia/Tashkent', dateFormat: 'dmy', timeFormat: '24h', departmentId: null }).success).toBe(true);
    expect(profilePatchSchema.safeParse({ jobTitle: null, phone: null }).success).toBe(true);
  });
  it('knows real time zones', () => {
    expect(isTimeZone('Asia/Tashkent')).toBe(true);
    expect(isTimeZone('UTC')).toBe(true);
    expect(isTimeZone('Mars/Olympus')).toBe(false);
  });
});

describe('avatar checks (bytes decide, not the client)', () => {
  it('reads PNG and JPEG sizes from their headers', () => {
    expect(inspectImage(png(256, 256))).toEqual({ mime: 'image/png', width: 256, height: 256 });
    expect(inspectImage(jpeg(512, 512))).toEqual({ mime: 'image/jpeg', width: 512, height: 512 });
  });
  it('refuses non-images, non-square, tiny, huge and over-2-MB uploads', () => {
    expect(avatarProblem(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe('not_an_image');
    expect(avatarProblem(Buffer.from('GIF89a......'))).toBe('not_an_image');
    expect(avatarProblem(png(300, 200))).toBe('not_square');
    expect(avatarProblem(png(32, 32))).toBe('bad_size');
    expect(avatarProblem(png(4096, 4096))).toBe('bad_size');
    expect(avatarProblem(Buffer.concat([png(256, 256), Buffer.alloc(2 * 1024 * 1024)]))).toBe('too_large');
    expect(avatarProblem(png(256, 256))).toBeNull();
  });
});

describe('profile fields', () => {
  it('a fresh profile is empty; name and email come from the account', async () => {
    const v = await profile.get(member);
    expect(v).toMatchObject({ name: member.name, email: member.email, jobTitle: null, phone: null, timeZone: null, avatarUrl: null });
  });

  it('saves title, phone, time zone and formats; empty text clears', async () => {
    const v = await profile.update(member, { jobTitle: 'Analyst', phone: '+998 90 123-45-67', timeZone: 'Asia/Tashkent', dateFormat: 'dmy', timeFormat: '24h' });
    expect(v).toMatchObject({ jobTitle: 'Analyst', phone: '+998 90 123-45-67', timeZone: 'Asia/Tashkent', dateFormat: 'dmy', timeFormat: '24h' });
    expect((await profile.update(member, { jobTitle: '' })).jobTitle).toBeNull();
    await profile.update(member, { jobTitle: 'Analyst' });
    expect(await status(profile.update(member, { timeZone: 'Mars/Olympus' }))).toBe(400);
  });

  it('a department of the own organization only', async () => {
    const d = await owner.query('INSERT INTO departments (org_id, name) VALUES ($1, $2) RETURNING id', [admin.orgId, `Sales ${sfx}`]);
    const foreign = await owner.query('INSERT INTO departments (org_id, name) VALUES ($1, $2) RETURNING id', [outsider.orgId, `Ops ${sfx}`]);
    expect(await status(profile.update(member, { departmentId: foreign.rows[0].id }))).toBe(400);
    const v = await profile.update(member, { departmentId: d.rows[0].id });
    expect(v.department).toBe(`Sales ${sfx}`);
    expect(v.departments.map((x) => x.name)).toEqual([`Sales ${sfx}`]);
  });

  it('visibility: members see title and department, only admins also email and phone, other organizations nothing', async () => {
    const byMember = await profile.card(member, admin.userId);
    expect(byMember).not.toHaveProperty('email');
    expect(byMember).not.toHaveProperty('phone');
    const byAdmin = await profile.card(admin, member.userId);
    expect(byAdmin).toMatchObject({ jobTitle: 'Analyst', department: `Sales ${sfx}`, email: member.email, phone: '+998 90 123-45-67' });
    const peer = await profile.card({ ...member }, member.userId);
    expect(peer.jobTitle).toBe('Analyst');
    expect(await status(profile.card(outsider, member.userId))).toBe(404);
  });

  it('pictures are refused while storage is not configured (no silent success)', async () => {
    const off = new ProfileService(pool, { ...cfg, S3_ENDPOINT: undefined } as typeof cfg);
    expect(await status(off.setAvatar(member, png(256, 256)))).toBe(503);
    expect(await off.avatar('0'.repeat(32))).toBeNull();
  });
});

class FakeIdp implements SelfServiceIdentity {
  creds: Array<{ id: string; type: string; label: string | null; createdAt: string | null }> = [
    { id: 'c1', type: 'password', label: null, createdAt: '2026-11-01T00:00:00.000Z' },
    { id: 'c2', type: 'otp', label: 'Phone', createdAt: '2026-11-02T00:00:00.000Z' },
    { id: 'c3', type: 'webauthn-passwordless', label: 'Laptop', createdAt: '2026-11-03T00:00:00.000Z' },
  ];
  sess = [
    { id: 'sid-member-1', ip: '10.0.0.1', start: '2026-11-27T08:00:00.000Z', lastAccess: '2026-11-27T09:00:00.000Z' },
    { id: 'sid-member-2', ip: '10.0.0.2', start: '2026-11-26T08:00:00.000Z', lastAccess: '2026-11-26T09:00:00.000Z' },
  ];
  linked = [{ provider: 'google', userName: 'p@gmail.test' }];
  ended: string[] = [];
  all = 0;
  removed: string[] = [];
  async credentials() {
    return this.creds;
  }
  async sessions() {
    return this.sess;
  }
  async endSession(_sub: string, sid: string) {
    if (!this.sess.some((s) => s.id === sid)) return false;
    this.ended.push(sid);
    return true;
  }
  async endAllSessions() {
    this.all++;
  }
  async links() {
    return this.linked;
  }
  async unlink(_sub: string, p: string) {
    this.removed.push(p);
  }
  async signInProviders() {
    return ['google', 'microsoft'] as Array<'google' | 'microsoft'>;
  }
}

describe('self-service security', () => {
  it('describes devices and keeps only a network prefix', () => {
    expect(describeAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0 Safari/537.36')).toEqual({ device: 'Windows', browser: 'Chrome' });
    expect(describeAgent('Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/150 Mobile Safari/537.36 Edg/150')).toEqual({ device: 'Android', browser: 'Edge' });
    expect(ipPrefix('203.0.113.77')).toBe('203.0.113.0/24');
    expect(ipPrefix('::ffff:198.51.100.9')).toBe('198.51.100.0/24');
    expect(ipPrefix('2001:db8:abcd:12::1')).toBe('2001:db8:abcd::/48');
    expect(ipPrefix('not-an-ip')).toBeNull();
  });

  it('lists methods, sessions with the device seen, the current one first, and links', async () => {
    const idp = new FakeIdp();
    const sec = new SecurityService(pool, idp);
    await sec.record(member, { userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/150 Safari/537', ip: '203.0.113.77', country: 'UZ', city: 'Tashkent' });
    const v = await sec.view(member);
    expect(v.password).toBe(true);
    expect(v.totp).toHaveLength(1);
    expect(v.passkeys.map((p) => p.label)).toEqual(['Laptop']);
    expect(v.sessions[0]).toMatchObject({ id: 'sid-member-1', current: true, device: 'Windows', browser: 'Chrome', city: 'Tashkent', country: 'UZ', ip: '203.0.113.0/24' });
    expect(v.sessions[1]).toMatchObject({ id: 'sid-member-2', current: false, device: null });
    expect(v.links).toEqual([{ provider: 'google', userName: 'p@gmail.test' }]);
    const raw = await owner.query('SELECT ip_prefix FROM user_session_devices WHERE user_id = $1', [member.userId]);
    expect(raw.rows[0].ip_prefix).toBe('203.0.113.0/24'); // the full address is never stored
  });

  it('ends one own session, refuses a foreign one, ends all; every action is audited', async () => {
    const idp = new FakeIdp();
    const sec = new SecurityService(pool, idp);
    await sec.endSession(member, 'sid-member-2');
    expect(idp.ended).toEqual(['sid-member-2']);
    expect(await status(sec.endSession(member, 'sid-of-someone-else'))).toBe(404);
    await sec.endAll(member);
    expect(idp.all).toBe(1);
    const a = await owner.query("SELECT action FROM audit_log WHERE actor_id = $1 AND action LIKE 'security.%' ORDER BY id", [member.userId]);
    expect(a.rows.map((r) => r.action)).toEqual(['security.session.end', 'security.session.end_all']);
  });

  it('never removes the last way to sign in', async () => {
    const idp = new FakeIdp();
    idp.creds = [];
    const sec = new SecurityService(pool, idp);
    expect(await status(sec.unlink(member, 'google'))).toBe(409);
    idp.creds = [{ id: 'c1', type: 'password', label: null, createdAt: null }];
    await sec.unlink(member, 'google');
    expect(idp.removed).toEqual(['google']);
    expect(await status(sec.unlink(member, 'microsoft'))).toBe(404);
  });

  it('answers 503 without the identity provider admin client', async () => {
    expect(await status(new SecurityService(pool, null).view(member))).toBe(503);
  });
});
