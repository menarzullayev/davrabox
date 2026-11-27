import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { loadConfig } from '../src/config.js';
import { IdentityAdminError, type BrokeredAccount, type OnboardingIdentity } from '../src/admin/identity-admin.js';
import { OnboardingError, OnboardingService } from '../src/onboarding/onboarding.service.js';
import { onboardingPatchSchema } from '../src/onboarding/onboarding.controller.js';
import { appUrlFor } from '../src/meetings/public-url.js';
import type { AuthedUser } from '../src/auth/auth.guard.js';

// Integration against the real database: the "Get started" checklist is derived from real rows, and the verification
// link goes through the identity provider (a fake here; the real Keycloak path is covered by onboarding.e2e.mjs).
const cfg = loadConfig();
const adminUrl = process.env.MIGRATE_DATABASE_URL;
if (!adminUrl) throw new Error('MIGRATE_DATABASE_URL is required for tests');
const pool = new Pool({ connectionString: cfg.DATABASE_URL, max: 4 });
const owner = new Pool({ connectionString: adminUrl, max: 2 });
const sfx = Math.random().toString(36).slice(2, 8);
const slugA = `ob-a-${sfx}`;
const slugB = `ob-b-${sfx}`;

class FakeIdp implements OnboardingIdentity {
  verified = new Set<string>();
  sent: Array<{ sub: string; redirect: string | null }> = [];
  fail: IdentityAdminError | null = null;
  async sendVerifyEmail(sub: string, redirect: string | null) {
    if (this.fail) throw this.fail;
    this.sent.push({ sub, redirect });
  }
  async emailVerified(sub: string) {
    return this.verified.has(sub);
  }
  async account(): Promise<BrokeredAccount | null> {
    return null;
  }
  async attachOrgAdmin() {}
  async detachOrg() {}
  async signInProviders() {
    return [] as Array<'google' | 'microsoft'>;
  }
  mail = true;
  async canSendEmail() {
    return this.mail;
  }
}
const idp = new FakeIdp();
const svc = new OnboardingService(pool, idp);

async function mkUser(slug: string, sub: string, role: 'org_admin' | 'member'): Promise<AuthedUser> {
  const r = await pool.query('SELECT org_id, user_id FROM provision_user($1,$2,$3,$4,$5,$6)', [slug, slug, sub, `${sub}@t.local`, sub, role]);
  return { sub, email: `${sub}@t.local`, name: sub, orgSlug: slug, role, orgId: r.rows[0].org_id, userId: r.rows[0].user_id };
}
const ids = (v: { steps: Array<{ id: string }> }) => v.steps.map((s) => s.id);
const done = (v: { steps: Array<{ id: string; done: boolean }> }, id: string) => v.steps.find((s) => s.id === id)?.done;

let admin: AuthedUser, other: AuthedUser;
beforeAll(async () => {
  admin = await mkUser(slugA, `oa-${sfx}`, 'org_admin');
  other = await mkUser(slugB, `ob-${sfx}`, 'org_admin');
});
afterAll(async () => {
  await owner.query('DELETE FROM organizations WHERE slug IN ($1,$2)', [slugA, slugB]);
  await pool.end();
  await owner.end();
});

describe('request shape', () => {
  it.each([[{ devicesTested: false }], [{ dismissed: 'yes' }], [{ emailVerified: true }], [{ devicesTested: true, x: 1 }], [[]], [null]])('refuses %j', (body) => {
    expect(onboardingPatchSchema.safeParse(body).success).toBe(false);
  });
  it('accepts the three client-side flags', () => {
    expect(onboardingPatchSchema.safeParse({ devicesTested: true, meetingJoined: true, dismissed: true }).success).toBe(true);
  });
});

describe('the checklist', () => {
  it('an administrator of a fresh organization sees five open steps in the agreed order', async () => {
    const v = await svc.get(admin);
    expect(ids(v)).toEqual(['devices', 'invite', 'meeting', 'guests', 'email']);
    expect(v.steps.every((s) => !s.done)).toBe(true);
    expect(v.dismissed).toBe(false);
    expect(v.canSendVerification).toBe(true);
  });

  it('a member sees only the steps that are theirs (no invite, no guest policy)', async () => {
    const m = await mkUser(slugA, `om-${sfx}`, 'member');
    expect(ids(await svc.get(m))).toEqual(['devices', 'meeting', 'email']);
  });

  it('"invite" ticks itself once somebody else is in the organization', async () => {
    // The member created in the previous test is that somebody.
    expect(done(await svc.get(admin), 'invite')).toBe(true);
    expect(done(await svc.get(other), 'invite')).toBe(false); // another organization is not affected
  });

  it('"first meeting" ticks itself for a hosted meeting, and for a call joined (reported by the app)', async () => {
    await owner.query(`INSERT INTO meetings (org_id, code, title, host_user_id) VALUES ($1, $2, 'First', $3)`, [admin.orgId, `9${Date.now()}`.slice(0, 12), admin.userId]);
    expect(done(await svc.get(admin), 'meeting')).toBe(true);
    expect(done(await svc.get(other), 'meeting')).toBe(false);
    expect(done(await svc.set(other, { meetingJoined: true }), 'meeting')).toBe(true);
  });

  it('"guest policy" ticks itself once the organization policy was saved', async () => {
    await owner.query(`INSERT INTO audit_log (org_id, actor_id, action, target) VALUES ($1, $2, 'admin.policy.update', 'guestPolicy=waiting_room')`, [admin.orgId, admin.userId]);
    expect(done(await svc.get(admin), 'guests')).toBe(true);
    expect(done(await svc.get(other), 'guests')).toBe(false);
  });

  it('"devices" is stored, and the first time is kept', async () => {
    await svc.set(admin, { devicesTested: true });
    const first = (await owner.query('SELECT devices_tested_at FROM user_onboarding WHERE user_id = $1', [admin.userId])).rows[0].devices_tested_at;
    await svc.set(admin, { devicesTested: true, dismissed: true });
    const r = (await owner.query('SELECT devices_tested_at, dismissed_at FROM user_onboarding WHERE user_id = $1', [admin.userId])).rows[0];
    expect(r.devices_tested_at.getTime()).toBe(first.getTime());
    expect(r.dismissed_at).not.toBeNull();
    const v = await svc.get(admin);
    expect(done(v, 'devices')).toBe(true);
    expect(v.dismissed).toBe(true);
  });

  it('"email" follows the token claim, else the provider (the click may be newer than the token)', async () => {
    expect(done(await svc.get({ ...other, emailVerified: true }), 'email')).toBe(true);
    expect(done(await svc.get(other), 'email')).toBe(false);
    idp.verified.add(other.sub);
    expect(done(await svc.get(other), 'email')).toBe(true);
    idp.verified.delete(other.sub);
  });

  it('a realm without a mail server: the card says the link cannot be sent', async () => {
    const noMail = new FakeIdp();
    noMail.mail = false;
    expect((await new OnboardingService(pool, noMail).get(other)).canSendVerification).toBe(false);
  });

  it('without an identity provider the card still works and says the link cannot be sent', async () => {
    const v = await new OnboardingService(pool, null).get(other);
    expect(v.canSendVerification).toBe(false);
    expect(done(v, 'email')).toBe(false);
  });

  it('row-level security: one organization never sees or writes another one\'s rows', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.current_org', $1, true)", [other.orgId]);
      expect((await c.query('SELECT count(*)::int AS n FROM user_onboarding WHERE user_id = $1', [admin.userId])).rows[0].n).toBe(0);
      await expect(c.query('INSERT INTO user_onboarding (user_id, org_id) VALUES ($1, $2)', [other.userId, admin.orgId])).rejects.toThrow();
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });
});

describe('the verification link', () => {
  it('is sent through the provider to the person\'s own account, with the landing page, and audited', async () => {
    idp.sent = [];
    await svc.sendVerification(other, 'https://davrabox.example.com/app');
    expect(idp.sent).toEqual([{ sub: other.sub, redirect: 'https://davrabox.example.com/app' }]);
    const n = (await owner.query(`SELECT count(*)::int AS n FROM audit_log WHERE org_id = $1 AND action = 'user.email.verify_sent'`, [other.orgId])).rows[0].n;
    expect(n).toBe(1);
  });

  it('is refused for an already verified address', async () => {
    await expect(svc.sendVerification({ ...other, emailVerified: true }, null)).rejects.toMatchObject({ status: 409, code: 'already_verified' });
  });

  it('a mail failure is a 503 the app can show, never a crash', async () => {
    idp.fail = new IdentityAdminError(503, 'smtp down');
    await expect(svc.sendVerification(other, null)).rejects.toBeInstanceOf(OnboardingError);
    await expect(svc.sendVerification(other, null)).rejects.toMatchObject({ status: 503, code: 'email_unavailable' });
    idp.fail = null;
  });

  it('without an identity provider it answers 503', async () => {
    await expect(new OnboardingService(pool, null).sendVerification(other, null)).rejects.toMatchObject({ status: 503 });
  });
});

describe('appUrlFor', () => {
  const allowed = ['https://davrabox.example.com', 'https://10.0.0.5:8443', 'http://plain.example.com', 'not a url'];
  it('lands on the application of the host the browser used', () => {
    expect(appUrlFor('DavraBox.Example.com', allowed)).toBe('https://davrabox.example.com/app');
    expect(appUrlFor('10.0.0.5:8443', allowed)).toBe('https://10.0.0.5:8443/app');
  });
  it.each([['evil.example.org'], ['plain.example.com'], [''], [undefined]])('ignores an unknown, forged or non-https host (%s)', (h) => {
    expect(appUrlFor(h as string | undefined, allowed)).toBeNull();
  });
});
