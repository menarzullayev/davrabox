import 'reflect-metadata';
import { createHash, randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Pool } from 'pg';
import { loadConfig } from '../src/config.js';
import { IdentityAdminError, type BrokeredAccount, type OnboardingIdentity } from '../src/admin/identity-admin.js';
import type { PendingIdentity } from '../src/auth/jwt.js';
import { createChallenge, type AltchaChallenge } from '../src/signup/altcha.js';
import { loadSignupSettings, TRIAL, type SignupSettings } from '../src/signup/limits.js';
import { OrgSetupController, PENDING_VERIFIER, SIGNUP, SignupController } from '../src/signup/signup.controller.js';
import { orgNameFor, SignupService, type NewOrgAdmin, type SignupIdentity } from '../src/signup/signup.service.js';

// Integration: POST /v1/public/{challenge,signup} over real HTTP (Nest app) against real Postgres. Only the identity
// provider is a fake here (it can be told to fail); the real Keycloak is exercised in signup-keycloak.test.ts.
const cfg = loadConfig();
const adminUrl = process.env.MIGRATE_DATABASE_URL;
if (!adminUrl) throw new Error('MIGRATE_DATABASE_URL is required for tests');
const pool = new Pool({ connectionString: cfg.DATABASE_URL, max: 6 });
const owner = new Pool({ connectionString: adminUrl, max: 2 });
const sfx = Math.random().toString(36).slice(2, 8);
const domain = `t${sfx}.example.org`;
const PASSWORD = 'correct-horse-battery';

class FakeIdp implements SignupIdentity, OnboardingIdentity {
  verifySent: Array<{ sub: string; redirect: string | null }> = [];
  accounts = new Map<string, BrokeredAccount>();
  attached: Array<{ sub: string; orgSlug: string }> = [];
  detached: Array<{ sub: string; orgSlug: string }> = [];
  attachFail: IdentityAdminError | null = null;
  async sendVerifyEmail(sub: string, redirect: string | null) {
    this.verifySent.push({ sub, redirect });
  }
  async emailVerified() {
    return false;
  }
  async account(sub: string) {
    return this.accounts.get(sub) ?? null;
  }
  async attachOrgAdmin(sub: string, orgSlug: string) {
    if (this.attachFail) throw this.attachFail;
    this.attached.push({ sub, orgSlug });
    const a = this.accounts.get(sub);
    if (a) a.orgSlug = orgSlug;
  }
  async detachOrg(sub: string, orgSlug: string) {
    this.detached.push({ sub, orgSlug });
  }
  providers: Array<'google' | 'microsoft'> = ['google'];
  providerCalls = 0;
  async signInProviders() {
    this.providerCalls += 1;
    return this.providers;
  }
  created: NewOrgAdmin[] = [];
  deletedSubs: string[] = [];
  deletedByEmail: Array<{ email: string; orgSlug: string }> = [];
  fail: IdentityAdminError | null = null;
  async createOrgAdmin(u: NewOrgAdmin) {
    if (this.fail) throw this.fail;
    this.created.push(u);
    return { id: crypto.randomUUID() };
  }
  async deleteUser(sub: string) {
    this.deletedSubs.push(sub);
  }
  async deleteOrgAdminByEmail(email: string, orgSlug: string) {
    this.deletedByEmail.push({ email, orgSlug });
  }
}
const idp = new FakeIdp();

const settings: SignupSettings = loadSignupSettings(
  { SIGNUP_IP_PER_HOUR: '1000', SIGNUP_DOMAIN_PER_HOUR: '1000', SIGNUP_DAILY_CAP: '100000', SIGNUP_ALTCHA_MAX_NUMBER: '3000', SIGNUP_CAPTCHA_SECRET: `unit-${sfx}`.padEnd(40, 'x') },
  cfg.LIVEKIT_API_SECRET,
);
const service = new SignupService(pool, settings, idp);

// Tokens of the organization set-up endpoint: "tok:<base64 JSON of the identity>" (the real verifier is tested in unit.test.ts).
const tokenFor = (who: PendingIdentity) => `tok:${Buffer.from(JSON.stringify(who)).toString('base64url')}`;
const fakeVerify = async (t: string): Promise<PendingIdentity> => {
  if (!t.startsWith('tok:')) throw new Error('bad token');
  return JSON.parse(Buffer.from(t.slice(4), 'base64url').toString()) as PendingIdentity;
};

@Module({
  controllers: [SignupController, OrgSetupController],
  providers: [
    { provide: SIGNUP, useValue: service },
    { provide: PENDING_VERIFIER, useValue: fakeVerify },
  ],
})
class TestModule {}

let app: INestApplication;
let base = '';
let n = 0;
const slugs = new Set<string>();

const solve = (ch: AltchaChallenge, tamper: Partial<Record<string, unknown>> = {}): string => {
  for (let i = 0; i <= ch.maxnumber; i++) {
    if (createHash('sha256').update(ch.salt + i).digest('hex') === ch.challenge) {
      return Buffer.from(JSON.stringify({ algorithm: ch.algorithm, challenge: ch.challenge, number: i, salt: ch.salt, signature: ch.signature, ...tamper })).toString('base64');
    }
  }
  throw new Error('unsolvable');
};
const freshIp = () => `10.${randomInt(1, 255)}.${randomInt(1, 255)}.${randomInt(1, 255)}`;
const getChallenge = async () =>
  (await (await fetch(`${base}/v1/public/challenge`, { method: 'POST', headers: { 'X-Forwarded-For': freshIp() } })).json()) as AltchaChallenge;

interface Over {
  orgName?: string;
  name?: string;
  email?: string;
  password?: string;
  altcha?: string;
  ip?: string;
  extra?: Record<string, unknown>;
}
async function signup(o: Over = {}) {
  n += 1;
  const altcha = o.altcha ?? solve(await getChallenge());
  const res = await fetch(`${base}/v1/public/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': o.ip ?? freshIp() },
    body: JSON.stringify({
      orgName: o.orgName ?? `Org ${sfx} ${n}`,
      name: o.name ?? 'Test Person',
      email: o.email ?? `u${n}@${domain}`,
      password: o.password ?? PASSWORD,
      altcha,
      ...o.extra,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (body.slug) slugs.add(body.slug);
  return { status: res.status, body, retryAfter: res.headers.get('retry-after') };
}

const count = async (sql: string, params: unknown[] = []) => Number((await owner.query(sql, params)).rows[0].c);
const refusals = async (reason: string) => count(`SELECT count(*) c FROM signup_events WHERE kind = 'refusal' AND reason = $1 AND email_domain = $2`, [reason, domain]);

beforeAll(async () => {
  app = await NestFactory.create(TestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
});
afterAll(async () => {
  await owner.query('DELETE FROM organizations WHERE slug = ANY($1)', [[...slugs]]);
  await owner.query('DELETE FROM signup_events WHERE email_domain = $1', [domain]);
  await app.close();
  await pool.end();
  await owner.end();
});

describe('POST /v1/public/challenge', () => {
  it('returns a signed proof-of-work challenge and no secret', async () => {
    const res = await fetch(`${base}/v1/public/challenge`, { method: 'POST' });
    expect(res.status).toBe(200);
    const ch = (await res.json()) as AltchaChallenge;
    expect(Object.keys(ch).sort()).toEqual(['algorithm', 'challenge', 'maxnumber', 'salt', 'signature']);
    expect(ch.algorithm).toBe('SHA-256');
    expect(ch.maxnumber).toBe(3000);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
  it('is rate limited per address', async () => {
    const ip = freshIp();
    let last = 200;
    for (let i = 0; i < 70; i++) {
      last = (await fetch(`${base}/v1/public/challenge`, { method: 'POST', headers: { 'X-Forwarded-For': ip } })).status;
      if (last === 429) break;
    }
    expect(last).toBe(429);
  });
});

describe('POST /v1/public/signup', () => {
  it('creates the organization, a 7-day trial licence, the admin user and an audit row', async () => {
    const email = `happy@${domain}`;
    const r = await signup({ email, orgName: `Happy ${sfx} Корп` });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ slug: expect.stringMatching(/^happy-/), signInUrl: '/app' });
    const slug = r.body.slug as string;

    const org = (await owner.query('SELECT id, name FROM organizations WHERE slug = $1', [slug])).rows[0];
    expect(org.name).toBe(`Happy ${sfx} Корп`);
    const lic = (await owner.query('SELECT trial_ends_at, max_participants, max_meeting_minutes, seats_limit FROM org_licenses WHERE org_id = $1', [org.id])).rows[0];
    expect(lic.max_participants).toBe(TRIAL.participants);
    expect(lic.max_meeting_minutes).toBe(TRIAL.minutes);
    expect(lic.seats_limit).toBe(TRIAL.participants);
    const days = (new Date(lic.trial_ends_at).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.99);
    expect(days).toBeLessThan(7.01);

    const user = (await owner.query('SELECT id, role, external_sub, email FROM users WHERE org_id = $1', [org.id])).rows;
    expect(user).toHaveLength(1);
    expect(user[0]).toMatchObject({ role: 'org_admin', email });
    expect(idp.created.at(-1)).toMatchObject({ email, orgSlug: slug, name: 'Test Person', password: PASSWORD });
    expect(user[0].external_sub).toMatch(/^[0-9a-f-]{36}$/);

    const audit = (await owner.query(`SELECT action, target, actor_id FROM audit_log WHERE org_id = $1`, [org.id])).rows;
    expect(audit).toEqual([{ action: 'signup.trial', target: slug, actor_id: user[0].id }]);
    expect(await count(`SELECT count(*) c FROM signup_events WHERE kind = 'success' AND org_slug = $1`, [slug])).toBe(1);
  });

  it('never stores the password or the plain mailbox in the sign-up tables', async () => {
    const email = `private@${domain}`;
    await signup({ email });
    const dump = JSON.stringify((await owner.query('SELECT * FROM trial_signups')).rows) + JSON.stringify((await owner.query('SELECT * FROM signup_events')).rows);
    expect(dump).not.toContain(PASSWORD);
    expect(dump).not.toContain('private@');
  });

  it('refuses a replayed solution with 400', async () => {
    const solution = solve(await getChallenge());
    const first = await signup({ altcha: solution });
    expect(first.status).toBe(201);
    const second = await signup({ altcha: solution });
    expect(second.status).toBe(400);
    expect(second.body.code).toBe('captcha_replayed');
    expect(await refusals('captcha_replayed')).toBe(1);
  });

  it('refuses an expired challenge with 400', async () => {
    const old = createChallenge(settings.captchaSecret, Date.now() - 6 * 60_000, settings.maxNumber);
    const r = await signup({ altcha: solve(old) });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('captcha_expired');
    expect(await refusals('captcha_expired')).toBe(1);
  });

  it('refuses a wrong signature, a foreign secret and a missing solution with 400', async () => {
    const ch = await getChallenge();
    const wrongSig = await signup({ altcha: solve(ch, { signature: 'f'.repeat(64) }) });
    expect(wrongSig.status).toBe(400);
    expect(wrongSig.body.code).toBe('captcha_invalid');
    const foreign = await signup({ altcha: solve(createChallenge('another-secret-another-secret-0123456789', Date.now(), 3000)) });
    expect(foreign.status).toBe(400);
    const none = await signup({ altcha: '' });
    expect(none.status).toBe(400);
    expect(await refusals('captcha_invalid')).toBe(2);
  });

  it('refuses a disposable mailbox with 422', async () => {
    const r = await signup({ email: `x${sfx}@mailinator.com` });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('disposable_email');
    expect(await owner.query(`SELECT 1 FROM signup_events WHERE kind = 'refusal' AND reason = 'disposable_email' AND email_domain = 'mailinator.com'`).then((x) => x.rowCount)).toBeGreaterThan(0);
    await owner.query(`DELETE FROM signup_events WHERE email_domain = 'mailinator.com'`);
  });

  it('the same mailbox in other spellings gets 409 and exactly one trial organization exists', async () => {
    const local = `jane${sfx}`;
    const dots = local.split('').join('.');
    const first = await signup({ email: `${local}@gmail.com` });
    expect(first.status).toBe(201);
    const variants = [`${dots}@gmail.com`, `${local.toUpperCase()}@GMAIL.COM`, `${local}+promo@googlemail.com`, `${dots}+x@gmail.com`];
    for (const email of variants) {
      const r = await signup({ email });
      expect(r.status, email).toBe(409);
      expect(r.body.code).toBe('email_taken');
    }
    const orgs = await count(`SELECT count(*) c FROM organizations o JOIN users u ON u.org_id = o.id WHERE u.email = $1`, [`${local}@gmail.com`]);
    expect(orgs).toBe(1);
    expect(await count(`SELECT count(*) c FROM signup_events WHERE kind = 'refusal' AND reason = 'email_taken' AND email_domain IN ('gmail.com', 'googlemail.com') AND at > now() - interval '5 minutes'`)).toBeGreaterThanOrEqual(variants.length);
    await owner.query(`DELETE FROM signup_events WHERE email_domain IN ('gmail.com', 'googlemail.com') AND at > now() - interval '5 minutes'`);
  });

  it('gives a numeric suffix to a taken slug and never overwrites the existing organization', async () => {
    const existing = `clash-${sfx}`;
    await pool.query('SELECT provision_user($1, $2, $3, $4, $5, $6)', [existing, 'Original Name', `sub-${sfx}`, `orig@${domain}`, 'Orig', 'org_admin']);
    slugs.add(existing);
    const a = await signup({ orgName: `Clash ${sfx}` });
    const b = await signup({ orgName: `Clash ${sfx}` });
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.slug).toBe(`${existing}-2`);
    expect(b.body.slug).toBe(`${existing}-3`);
    expect((await owner.query('SELECT name FROM organizations WHERE slug = $1', [existing])).rows[0].name).toBe('Original Name');
  });

  it('never creates a reserved slug', async () => {
    for (const name of ['admin', 'API', 'demo']) {
      const r = await signup({ orgName: name });
      expect(r.status).toBe(201);
      expect(['admin', 'api', 'demo', 'app', 'www', 'auth', 'status']).not.toContain(r.body.slug);
    }
    // The database refuses reserved words on its own, whatever the caller passes.
    const direct = await pool.query('SELECT slug FROM create_trial_org($1, $2, $3, $4, 7, 10, 30)', ['admin', 'Direct', `hash-${sfx}`, 'iphash']);
    slugs.add(direct.rows[0].slug);
    expect(direct.rows[0].slug).toBe('admin-2');
  });

  it('identity provider answers 409: nothing is left behind and the caller is told the mailbox exists', async () => {
    const before = await count('SELECT (SELECT count(*) FROM organizations) + (SELECT count(*) FROM org_licenses) + (SELECT count(*) FROM users) + (SELECT count(*) FROM trial_signups) c');
    idp.fail = new IdentityAdminError(409, 'a user with this email already exists');
    const r = await signup({ email: `kc409@${domain}`, orgName: `Kc409 ${sfx}` });
    idp.fail = null;
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('email_taken');
    const after = await count('SELECT (SELECT count(*) FROM organizations) + (SELECT count(*) FROM org_licenses) + (SELECT count(*) FROM users) + (SELECT count(*) FROM trial_signups) c');
    expect(after).toBe(before);
    expect(await count(`SELECT count(*) c FROM organizations WHERE slug LIKE $1`, [`kc409-${sfx}%`])).toBe(0);
    expect(idp.deletedByEmail).toHaveLength(0); // an existing user of the provider must never be deleted
    expect(await refusals('identity_email_taken')).toBe(1);
  });

  it('identity provider unreachable or timing out: nothing is left behind, 503 with Retry-After, mailbox usable afterwards', async () => {
    const email = `kc503@${domain}`;
    const before = await count('SELECT (SELECT count(*) FROM organizations) + (SELECT count(*) FROM org_licenses) + (SELECT count(*) FROM users) + (SELECT count(*) FROM trial_signups) c');
    idp.fail = new IdentityAdminError(502, 'identity provider is unreachable');
    const r = await signup({ email, orgName: `Kc503 ${sfx}` });
    idp.fail = null;
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('identity_unavailable');
    expect(Number(r.retryAfter)).toBeGreaterThan(0);
    const after = await count('SELECT (SELECT count(*) FROM organizations) + (SELECT count(*) FROM org_licenses) + (SELECT count(*) FROM users) + (SELECT count(*) FROM trial_signups) c');
    expect(after).toBe(before);
    expect(idp.deletedByEmail.at(-1)).toMatchObject({ email });
    expect(await refusals('identity_unavailable')).toBe(1);
    const retry = await signup({ email, orgName: `Kc503 ${sfx}` });
    expect(retry.status).toBe(201); // retryable: the failed attempt consumed nothing
  });

  it('identity provider rejects the data (password policy): 422, nothing left behind', async () => {
    const before = await count('SELECT (SELECT count(*) FROM organizations) + (SELECT count(*) FROM trial_signups) c');
    idp.fail = new IdentityAdminError(400, 'identity provider rejected the user data');
    const r = await signup({ email: `kc400@${domain}` });
    idp.fail = null;
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('identity_rejected');
    expect(await count('SELECT (SELECT count(*) FROM organizations) + (SELECT count(*) FROM trial_signups) c')).toBe(before);
  });

  it('answers 429 with Retry-After after too many sign-ups from one address', async () => {
    const saved = settings.ipPerHour;
    settings.ipPerHour = 2;
    try {
      const ip = freshIp();
      expect((await signup({ ip })).status).toBe(201);
      expect((await signup({ ip })).status).toBe(201);
      const third = await signup({ ip });
      expect(third.status).toBe(429);
      expect(third.body.code).toBe('rate_limited');
      expect(Number(third.retryAfter)).toBeGreaterThan(0);
      expect(Number(third.retryAfter)).toBeLessThanOrEqual(3600);
      expect(await signup({ ip: freshIp() }).then((x) => x.status)).toBe(201); // other addresses are not affected
    } finally {
      settings.ipPerHour = saved;
    }
    expect(await refusals('rate_limited')).toBeGreaterThanOrEqual(1);
  });

  it('answers 429 when one mailbox domain is used too often', async () => {
    const saved = settings.domainPerHour;
    const d = `lim${sfx}.example.net`;
    settings.domainPerHour = 2;
    try {
      expect((await signup({ email: `a@${d}` })).status).toBe(201);
      expect((await signup({ email: `b@${d}` })).status).toBe(201);
      const third = await signup({ email: `c@${d}` });
      expect(third.status).toBe(429);
      expect(third.body.code).toBe('rate_limited');
    } finally {
      settings.domainPerHour = saved;
      await owner.query('DELETE FROM signup_events WHERE email_domain = $1', [d]);
    }
  });

  it('answers 503 with a clear code when the global daily cap is reached', async () => {
    const used = await count(`SELECT count(*) c FROM trial_signups WHERE created_at > now() - interval '24 hours'`);
    const saved = settings.dailyCap;
    settings.dailyCap = used;
    try {
      const r = await signup();
      expect(r.status).toBe(503);
      expect(r.body.code).toBe('daily_cap');
      expect(Number(r.retryAfter)).toBeGreaterThan(0);
    } finally {
      settings.dailyCap = saved;
    }
    expect(await refusals('daily_cap')).toBe(1);
  });

  it('refuses a password shorter than 12 characters, one equal to the mailbox, and bad input, all with 400', async () => {
    expect((await signup({ password: 'short-pw-11' })).status).toBe(400);
    expect((await signup({ email: `same@${domain}`, password: `same@${domain}` })).status).toBe(400);
    expect((await signup({ email: 'not-an-email' })).status).toBe(400);
    expect((await signup({ orgName: 'x'.repeat(81) })).status).toBe(400);
    expect((await signup({ name: 'x'.repeat(200) })).status).toBe(400);
    expect((await signup({ extra: { admin: true } })).status).toBe(400); // unknown fields are rejected
    const res = await fetch(`${base}/v1/public/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"broken' });
    expect(res.status).toBe(400);
  });

  it('an empty organization name (decision 3: optional) names the organization after the person', async () => {
    const r = await signup({ orgName: '', name: `Dilnoza ${sfx}` });
    expect(r.status).toBe(201);
    const org = (await owner.query('SELECT name FROM organizations WHERE slug = $1', [r.body.slug])).rows[0];
    expect(org.name).toBe(`Dilnoza ${sfx}`);
    const r2 = await signup({ extra: { orgName: undefined }, name: `Akmal ${sfx}` });
    expect(r2.status).toBe(201);
  });

  it('orgNameFor: typed name wins, else the person, never shorter than two characters', () => {
    expect(orgNameFor('  Acme  ', 'Ali')).toBe('Acme');
    expect(orgNameFor('', 'Ali Valiyev')).toBe('Ali Valiyev');
    expect(orgNameFor(undefined, 'A')).toBe('A team');
    expect(orgNameFor('x', '')).toBe('DavraBox team');
  });

  it('sends the verification email right after the sign-up, landing on the host the visitor used (decision 2)', async () => {
    const port = new URL(base).port;
    settings.appOrigins = [`https://127.0.0.1:${port}`];
    idp.verifySent = [];
    const r = await signup({ email: `verify@${domain}` });
    expect(r.status).toBe(201);
    await new Promise((res) => setTimeout(res, 50)); // the send is not awaited by the sign-up (it never delays or fails it)
    const sub = (await owner.query('SELECT external_sub FROM users u JOIN organizations o ON o.id = u.org_id WHERE o.slug = $1', [r.body.slug])).rows[0].external_sub;
    expect(idp.verifySent).toEqual([{ sub, redirect: `https://127.0.0.1:${port}/app` }]);
    settings.appOrigins = [];
  });

  it('answers 503 when no identity provider is configured, without touching the database', async () => {
    const off = new SignupService(pool, settings, null);
    const before = await count('SELECT count(*) c FROM organizations');
    await expect(off.signup({ orgName: 'X Y', name: 'Z', email: `off@${domain}`, password: PASSWORD, altcha: 'x' }, '203.0.113.9')).rejects.toMatchObject({ status: 503, code: 'signup_unavailable' });
    expect(await count('SELECT count(*) c FROM organizations')).toBe(before);
  });

  it('error responses carry a stable code and no stack trace or internals', async () => {
    const r = await signup({ password: 'x' });
    expect(Object.keys(r.body).sort()).toEqual(['code', 'message', 'statusCode']);
    const text = JSON.stringify(r.body);
    expect(text).not.toMatch(/at .*\(.*:\d+:\d+\)|node_modules|postgres|select /i);
  });
});

describe('GET /v1/public/signin-options', () => {
  it('lists the configured providers, cached for a minute (the public page never hammers the identity provider)', async () => {
    const calls = idp.providerCalls;
    const a = await fetch(`${base}/v1/public/signin-options`);
    expect(a.status).toBe(200);
    expect(await a.json()).toEqual({ providers: ['google'] });
    await fetch(`${base}/v1/public/signin-options`);
    expect(idp.providerCalls - calls).toBeLessThanOrEqual(1);
  });
  it('no identity provider: no buttons', async () => {
    expect(await new SignupService(pool, settings, null).signInOptions()).toEqual({ providers: [] });
  });
});

describe('POST /v1/onboarding/organization (first sign-in through Google or Microsoft)', () => {
  const setup = async (who: PendingIdentity | null, body: unknown = {}, ip = freshIp()) => {
    const res = await fetch(`${base}/v1/onboarding/organization`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip, ...(who ? { Authorization: `Bearer ${tokenFor(who)}` } : {}) },
      body: JSON.stringify(body),
    });
    const b = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (b.slug) slugs.add(b.slug);
    return { status: res.status, body: b };
  };
  const person = (tag: string, providers = ['google']): PendingIdentity => {
    const sub = crypto.randomUUID();
    const email = `${tag}@${domain}`;
    idp.accounts.set(sub, { email, emailVerified: true, orgSlug: null, providers });
    return { sub, email, emailVerified: true, name: `Social ${tag}`, orgSlug: '' };
  };

  it('opens a trial organization with the person as administrator, attaches it in the provider, audits the provider', async () => {
    const who = person('social1');
    const r = await setup(who, { orgName: `Social ${sfx} Org` });
    expect(r.status).toBe(201);
    const slug = r.body.slug as string;
    expect(idp.attached.at(-1)).toEqual({ sub: who.sub, orgSlug: slug });
    const org = (await owner.query('SELECT id, name FROM organizations WHERE slug = $1', [slug])).rows[0];
    expect(org.name).toBe(`Social ${sfx} Org`);
    const users = (await owner.query('SELECT role, external_sub, email FROM users WHERE org_id = $1', [org.id])).rows;
    expect(users).toEqual([{ role: 'org_admin', external_sub: who.sub, email: who.email }]);
    const lic = (await owner.query('SELECT max_participants FROM org_licenses WHERE org_id = $1', [org.id])).rows[0];
    expect(lic.max_participants).toBe(TRIAL.participants);
    const audit = (await owner.query('SELECT action, target FROM audit_log WHERE org_id = $1', [org.id])).rows;
    expect(audit).toEqual([{ action: 'signup.trial', target: `${slug}:google` }]);
  });

  it('without a name the organization is named after the person', async () => {
    const who = person('social2', ['microsoft']);
    const r = await setup(who);
    expect(r.status).toBe(201);
    expect((await owner.query('SELECT name FROM organizations WHERE slug = $1', [r.body.slug])).rows[0].name).toBe('Social social2');
  });

  it('a second call (the account now has an organization) is refused with 409 and creates nothing', async () => {
    const who = person('social3');
    expect((await setup(who)).status).toBe(201);
    const before = await count('SELECT count(*) c FROM organizations');
    const again = await setup(who);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('already_member');
    expect(await count('SELECT count(*) c FROM organizations')).toBe(before);
  });

  it('a token that already carries an organization (an invited person) is refused with 409', async () => {
    const who = { ...person('social4'), orgSlug: 'demo' };
    expect((await setup(who)).body.code).toBe('already_member');
  });

  it('a password-only account (no linked provider) cannot use this path: 403', async () => {
    const who = person('social5', []);
    const r = await setup(who);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('not_external');
  });

  it('no token or a bad token: 401; bad input: 400', async () => {
    expect((await setup(null)).status).toBe(401);
    const res = await fetch(`${base}/v1/onboarding/organization`, { method: 'POST', headers: { Authorization: 'Bearer forged', 'Content-Type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
    expect((await setup(person('social6'), { orgName: 'x'.repeat(81) })).status).toBe(400);
    expect((await setup(person('social7'), { orgName: 'ok', admin: true })).status).toBe(400);
  });

  it('a disposable mailbox is refused like on the form', async () => {
    const sub = crypto.randomUUID();
    idp.accounts.set(sub, { email: 'x@mailinator.com', emailVerified: true, orgSlug: null, providers: ['google'] });
    const r = await setup({ sub, email: 'x@mailinator.com', emailVerified: true, name: 'X', orgSlug: '' });
    expect(r.status).toBe(422);
  });

  it('the provider fails while attaching: nothing is left in the database and the attribute is removed again', async () => {
    const who = person('social8');
    idp.attachFail = new IdentityAdminError(502, 'down');
    const before = await count('SELECT count(*) c FROM organizations');
    const r = await setup(who);
    idp.attachFail = null;
    expect(r.status).toBe(503);
    expect(await count('SELECT count(*) c FROM organizations')).toBe(before);
    expect(idp.detached.at(-1)?.sub).toBe(who.sub);
    expect((await setup(who)).status).toBe(201); // and the person can simply try again
  });

  it('the same mailbox cannot open a second trial through a provider (one trial per mailbox)', async () => {
    const email = `twice@${domain}`;
    expect((await signup({ email })).status).toBe(201);
    const sub = crypto.randomUUID();
    idp.accounts.set(sub, { email, emailVerified: true, orgSlug: null, providers: ['google'] });
    const r = await setup({ sub, email, emailVerified: true, name: 'Twice', orgSlug: '' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('email_taken');
  });
});
