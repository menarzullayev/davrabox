import 'reflect-metadata';
import http from 'node:http';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { exportJWK, generateKeyPair, SignJWT, type JWK, type KeyLike } from 'jose';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Manual attack suite against the REAL application module: real guards, real JWT verification (a local JWKS stands in
// for Keycloak), real Postgres with row-level security, real file/recording/BYOK/webhook code. Every case is something an
// attacker could try; the assertion is what must happen. Run: pnpm --filter @davrabox/api test security-attacks

const ISS = 'https://attack.test/auth/realms/davrabox';
const AZP = 'davrabox-web';
const adminUrl = process.env.MIGRATE_DATABASE_URL;
if (!adminUrl) throw new Error('MIGRATE_DATABASE_URL is required for tests');
const owner = new Pool({ connectionString: adminUrl, max: 2 });
const sfx = Math.random().toString(36).slice(2, 8);
const slugA = `atk-a-${sfx}`;
const slugB = `atk-b-${sfx}`;

let signKey: KeyLike;
let jwks: http.Server;
let app: INestApplication;
let base = '';

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

interface Claims {
  sub?: string;
  org?: string | null;
  role?: string | null;
  email?: string;
  azp?: string;
  iss?: string;
  exp?: number | string;
  nbf?: number;
  extra?: Record<string, unknown>;
}

async function mint(c: Claims, key: KeyLike = signKey, kid = 'k1'): Promise<string> {
  const payload: Record<string, unknown> = { email: c.email ?? `${c.sub}@t.local`, name: c.sub, azp: c.azp ?? AZP, ...(c.extra ?? {}) };
  if (c.org !== null) payload['org_slug'] = c.org;
  if (c.role !== null) payload['realm_access'] = { roles: [c.role ?? 'member'] };
  let jwt = new SignJWT(payload).setProtectedHeader({ alg: 'RS256', kid }).setSubject(c.sub ?? 'nobody').setIssuer(c.iss ?? ISS).setIssuedAt();
  if (c.nbf !== undefined) jwt = jwt.setNotBefore(c.nbf);
  jwt = jwt.setExpirationTime(c.exp ?? '5m');
  return jwt.sign(key);
}

const users = {} as Record<'aAdmin' | 'aMember' | 'bAdmin' | 'bMember', string>;
const ids = {} as Record<string, string>;

interface Res {
  status: number;
  body: any;
  text: string;
  headers: Headers;
}
async function call(method: string, path: string, token: string | null, body?: unknown, headers: Record<string, string> = {}, raw?: BodyInit): Promise<Res> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, body: json, text, headers: res.headers };
}

async function boot(env: Record<string, string>): Promise<INestApplication> {
  // The attack suite must never create users in a real identity provider: without the admin client those endpoints answer 503
  // after validation. Recording is switched on so its endpoints are exercised (nothing is recorded: no media server involved).
  delete process.env['KEYCLOAK_ADMIN_URL'];
  delete process.env['KEYCLOAK_ADMIN_CLIENT_SECRET'];
  process.env['RECORDING_ENABLED'] = '1';
  process.env['RECORDING_S3_ENDPOINT'] = process.env['S3_ENDPOINT'] ?? '';
  Object.assign(process.env, env);
  const { AppModule } = await import('../src/app.module.js'); // after the environment is set
  const a = await NestFactory.create(AppModule, { logger: ['error'], abortOnError: false });
  await a.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(a.getHttpServer().address() as net.AddressInfo).port}`;
  return a;
}

beforeAll(async () => {
  const kp = await generateKeyPair('RS256', { extractable: true });
  signKey = kp.privateKey;
  const jwk: JWK = { ...(await exportJWK(kp.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  jwks = http.createServer((_q, r) => {
    r.setHeader('content-type', 'application/json');
    r.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((r) => jwks.listen(0, '127.0.0.1', r));
  const jwksPort = (jwks.address() as net.AddressInfo).port;

  app = await boot({
    KEYCLOAK_ISSUER: ISS,
    KEYCLOAK_JWKS_URL: `http://127.0.0.1:${jwksPort}/jwks`,
    KEYCLOAK_AUDIENCE: AZP,
    SIGNUP_BACKGROUND_JOBS: '0',
    RATE_LIMIT_IP_PER_MINUTE: '1000000',
    RATE_LIMIT_USER_PER_MINUTE: '1000000',
    RATE_LIMIT_AUTH_FAIL_MAX: '100000',
    SIGNUP_TRUSTED_PROXY_HOPS: '1',
    SIGNUP_IP_PER_HOUR: '10000',
  });

  users.aAdmin = await mint({ sub: `aadmin-${sfx}`, org: slugA, role: 'org_admin' });
  users.aMember = await mint({ sub: `amember-${sfx}`, org: slugA, role: 'member' });
  users.bAdmin = await mint({ sub: `badmin-${sfx}`, org: slugB, role: 'org_admin' });
  users.bMember = await mint({ sub: `bmember-${sfx}`, org: slugB, role: 'member' });
  for (const t of Object.values(users)) expect((await call('GET', '/v1/meetings', t)).status).toBe(200); // provisions the user and the organization
});

afterAll(async () => {
  await app.close();
  await owner.query('DELETE FROM organizations WHERE slug = ANY($1)', [[slugA, slugB]]);
  await owner.end();
  jwks.close();
});

// ---------------------------------------------------------------------------------------------------------------------
describe('JWT attacks', () => {
  const probe = (token: string | null) => call('GET', '/v1/meetings', token);

  it('baseline: a correctly signed token is accepted', async () => {
    expect((await probe(users.aMember)).status).toBe(200);
  });

  it('alg:none (unsigned token) is refused', async () => {
    const t = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ iss: ISS, sub: 'x', azp: AZP, org_slug: slugA, email: 'x@t.local', realm_access: { roles: ['org_admin'] }, exp: Math.floor(Date.now() / 1000) + 300 })}.`;
    expect((await probe(t)).status).toBe(401);
    expect((await probe(t.slice(0, -1))).status).toBe(401); // without the trailing dot
  });

  it('algorithm confusion: HS256 "signed" with the public key as the secret is refused', async () => {
    const jwksPort = (jwks.address() as net.AddressInfo).port;
    const pub = (await (await fetch(`http://127.0.0.1:${jwksPort}/jwks`)).json()) as { keys: JWK[] };
    const secret = new TextEncoder().encode(JSON.stringify(pub.keys[0]));
    const t = await new SignJWT({ azp: AZP, org_slug: slugA, email: 'x@t.local', realm_access: { roles: ['org_admin'] } }).setProtectedHeader({ alg: 'HS256', kid: 'k1' }).setIssuer(ISS).setSubject('x').setExpirationTime('5m').sign(secret);
    expect((await probe(t)).status).toBe(401);
  });

  it('a token signed by another key (even with the right kid) is refused', async () => {
    const other = await generateKeyPair('RS256');
    expect((await probe(await mint({ sub: 'evil', org: slugA, role: 'org_admin' }, other.privateKey))).status).toBe(401);
  });

  it('unknown kid is refused', async () => {
    expect((await probe(await mint({ sub: 'evil', org: slugA, role: 'org_admin' }, signKey, 'nope'))).status).toBe(401);
  });

  it.each([
    ['wrong issuer', { iss: 'https://evil.example/auth/realms/davrabox' }],
    ['issuer with a trailing slash', { iss: `${ISS}/` }],
    ['another client (azp)', { azp: 'some-other-client' }],
    ['expired', { exp: Math.floor(Date.now() / 1000) - 3600 }],
    ['not valid yet (nbf in the future)', { nbf: Math.floor(Date.now() / 1000) + 3600 }],
  ])('%s is refused', async (_n, over) => {
    expect((await probe(await mint({ sub: 'x', org: slugA, role: 'org_admin', ...over }))).status).toBe(401);
  });

  it.each([
    ['no organization claim', { org: null }],
    ['no role', { role: null }],
    ['an unknown role', { role: 'superuser' }],
    ['a path-traversal organization slug', { org: '../../etc' }],
    ['an upper-case organization slug', { org: 'ACME' }],
    ['an SQL-looking organization slug', { org: "a'; DROP TABLE meetings;--" }],
    ['an empty organization slug', { org: '' }],
  ])('%s is refused', async (_n, over) => {
    expect((await probe(await mint({ sub: 'x', ...over }))).status).toBe(401);
  });

  it('garbage, truncated and empty tokens are refused; a token in the query string is ignored', async () => {
    for (const t of ['', 'abc', 'a.b.c', `${users.aMember}x`, users.aMember.split('.').slice(0, 2).join('.'), 'Bearer']) expect((await probe(t || null)).status).toBe(401);
    expect((await call('GET', `/v1/meetings?access_token=${users.aMember}`, null)).status).toBe(401);
    expect((await call('GET', '/v1/meetings', null, undefined, { Authorization: `Basic ${users.aMember}` })).status).toBe(401);
  });

  it('a member token with extra self-granted claims does not become an admin', async () => {
    const t = await mint({ sub: `amember-${sfx}`, org: slugA, role: 'member', extra: { role: 'org_admin', org_id: ids['orgB'], roles: ['org_admin'], resource_access: { x: { roles: ['org_admin'] } } } });
    expect((await call('GET', '/v1/admin/users', t)).status).toBe(403);
  });

  it('every protected route answers 401 without a token', async () => {
    const code = '12345678901';
    const routes: Array<[string, string]> = [
      ['GET', '/v1/meetings'], ['POST', '/v1/meetings'], ['PATCH', `/v1/meetings/${code}`], ['POST', `/v1/meetings/${code}/join`],
      ['GET', `/v1/meetings/${code}/requests`], ['POST', `/v1/meetings/${code}/lock`], ['GET', `/v1/meetings/${code}/cohosts`],
      ['PUT', `/v1/meetings/${code}/files?name=a.txt`], ['GET', `/v1/meetings/${code}/files/${randomUUID()}`],
      ['GET', `/v1/meetings/${code}/recording`], ['POST', `/v1/meetings/${code}/recording/start`], ['GET', `/v1/recordings/${randomUUID()}/download`],
      ['GET', '/v1/admin/overview'], ['GET', '/v1/admin/users'], ['POST', '/v1/admin/users'], ['GET', '/v1/admin/departments'], ['PUT', '/v1/admin/policies'],
      ['GET', '/v1/admin/audit'], ['GET', '/v1/admin/audit/export?format=csv'], ['GET', '/v1/admin/api-keys'], ['GET', '/v1/admin/webhooks'], ['GET', '/v1/admin/kms'],
      ['GET', '/v1/calendar'], ['GET', '/v1/trial'],
    ];
    for (const [m, p] of routes) expect((await call(m, p, null, m === 'GET' ? undefined : {})).status, `${m} ${p}`).toBe(401);
  });

  it('the external API refuses session tokens and unknown or malformed keys with the same 401', async () => {
    for (const t of [users.aAdmin, 'dbx_00000000_' + 'a'.repeat(43), 'dbx_', 'dbx_zz', 'x'.repeat(5000)]) {
      const r = await call('GET', '/v1/ext/meetings', t);
      expect(r.status, t.slice(0, 20)).toBe(401);
    }
    const noKeyInUrl = await call('GET', '/v1/ext/meetings?api_key=dbx_00000000_' + 'a'.repeat(43), null);
    expect(noKeyInUrl.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('cross-tenant access (IDOR)', () => {
  let codeA = '';
  let meetingA = '';
  let fileA = '';
  let recordingA = '';
  let keyA = '';
  let keyAId = '';
  let keyB = '';
  let webhookA = '';
  let deptA = '';
  let userAId = '';

  beforeAll(async () => {
    const m = await call('POST', '/v1/meetings', users.aAdmin, { title: 'A secret board meeting', passcode: 'passcode-A-1' });
    expect(m.status).toBe(201);
    codeA = m.body.code;
    meetingA = m.body.id;
    const f = await call('PUT', `/v1/meetings/${codeA}/files?name=${encodeURIComponent('secret.txt')}`, users.aAdmin, undefined, { 'Content-Type': 'application/octet-stream' }, Buffer.from('top secret of org A'));
    expect(f.status, f.text).toBe(200);
    fileA = f.body.id;
    const orgA = (await owner.query('SELECT id FROM organizations WHERE slug = $1', [slugA])).rows[0].id as string;
    ids['orgA'] = orgA;
    ids['orgB'] = (await owner.query('SELECT id FROM organizations WHERE slug = $1', [slugB])).rows[0].id as string;
    const hostRow = (await owner.query('SELECT id FROM users WHERE org_id = $1 ORDER BY created_at LIMIT 1', [orgA])).rows[0].id as string;
    userAId = hostRow;
    recordingA = randomUUID();
    await owner.query(
      "INSERT INTO recordings (id, org_id, meeting_id, status, staging_key, object_key, started_by) VALUES ($1, $2, $3, 'ready', 'stg', 'obj', $4)",
      [recordingA, orgA, meetingA, hostRow],
    );
    const k = await call('POST', '/v1/admin/api-keys', users.aAdmin, { name: 'a', scopes: ['meetings:read', 'meetings:write', 'users:read'] });
    expect(k.status).toBe(201);
    keyA = k.body.secret;
    keyAId = k.body.id;
    const kb = await call('POST', '/v1/admin/api-keys', users.bAdmin, { name: 'b', scopes: ['meetings:read', 'meetings:write', 'users:read'] });
    keyB = kb.body.secret;
    const dep = await call('POST', '/v1/admin/departments', users.aAdmin, { name: 'Dept A' });
    deptA = dep.body.id;
    const wh = await call('POST', '/v1/admin/webhooks', users.aAdmin, { url: 'https://example.com/hook-a', events: ['meeting.created'] });
    webhookA = wh.body?.id;
  });

  const sameAsUnknown = async (method: string, path: (code: string) => string, token: string, body?: unknown) => {
    const real = await call(method, path(codeA), token, body);
    const unknown = await call(method, path('99999999999'), token, body);
    return { real, unknown };
  };

  it('B cannot see A in meeting lists, and gets the SAME answer for A\'s code as for a code that does not exist (no oracle)', async () => {
    const list = await call('GET', '/v1/meetings', users.bAdmin);
    expect(list.text).not.toContain(codeA);
    const rows: Array<[string, (c: string) => string, unknown?]> = [
      ['POST', (c) => `/v1/meetings/${c}/join`, { passcode: 'passcode-A-1' }],
      ['PATCH', (c) => `/v1/meetings/${c}`, { title: 'hijack' }],
      ['GET', (c) => `/v1/meetings/${c}/requests`],
      ['POST', (c) => `/v1/meetings/${c}/lock`, { locked: true }],
      ['GET', (c) => `/v1/meetings/${c}/cohosts`],
      ['GET', (c) => `/v1/meetings/${c}/me`],
      ['GET', (c) => `/v1/meetings/${c}/recording`],
      ['GET', (c) => `/v1/meetings/${c}/recordings`],
      ['POST', (c) => `/v1/meetings/${c}/recording/start`],
      ['GET', (c) => `/v1/meetings/${c}/files/${fileA}`],
    ];
    for (const [m, p, b] of rows) {
      for (const who of [users.bAdmin, users.bMember]) {
        const { real, unknown } = await sameAsUnknown(m, p, who, b);
        expect([m, p('<code>'), real.status, real.text]).toEqual([m, p('<code>'), unknown.status, unknown.text]);
        expect(real.status, `${m} ${p('<code>')}`).toBe(404);
      }
    }
  });

  it('B cannot upload into A\'s meeting or download A\'s file (also not through its own meeting\'s code)', async () => {
    const up = await call('PUT', `/v1/meetings/${codeA}/files?name=x.txt`, users.bAdmin, undefined, { 'Content-Type': 'application/octet-stream' }, Buffer.from('x'));
    expect(up.status).toBe(404);
    const mB = await call('POST', '/v1/meetings', users.bAdmin, { title: 'B meeting' });
    const dl = await call('GET', `/v1/meetings/${mB.body.code}/files/${fileA}`, users.bAdmin);
    expect(dl.status).toBe(404);
    expect(dl.text).not.toContain('top secret');
  });

  it('B cannot download or list A\'s recording; a random id and A\'s id look the same', async () => {
    const real = await call('GET', `/v1/recordings/${recordingA}/download`, users.bAdmin);
    const fake = await call('GET', `/v1/recordings/${randomUUID()}/download`, users.bAdmin);
    expect([real.status, real.text]).toEqual([fake.status, fake.text]);
    expect(real.status).toBe(404);
  });

  it('a plain member of A is refused A\'s recording download and recording start (host, co-host or admin only)', async () => {
    expect([403, 404]).toContain((await call('GET', `/v1/recordings/${recordingA}/download`, users.aMember)).status);
    expect([403, 404]).toContain((await call('POST', `/v1/meetings/${codeA}/recording/start`, users.aMember)).status);
  });

  it('admin console: B\'s admin cannot read or change A\'s users, departments or settings', async () => {
    const ul = await call('GET', '/v1/admin/users?limit=100', users.bAdmin);
    expect(ul.status).toBe(200);
    expect(ul.text).not.toContain(`aadmin-${sfx}`);
    // 404, or 503 when the identity provider's admin client is not configured (it is checked first); either way nothing changes
    expect([404, 503]).toContain((await call('PATCH', `/v1/admin/users/${userAId}`, users.bAdmin, { role: 'member', disabled: true })).status);
    const stillAdmin = (await owner.query('SELECT role, disabled FROM users WHERE id = $1', [userAId])).rows[0];
    expect(stillAdmin).toEqual({ role: 'org_admin', disabled: false });
    expect((await call('PATCH', `/v1/admin/departments/${deptA}`, users.bAdmin, { name: 'pwned' })).status).toBe(404);
    expect((await call('DELETE', `/v1/admin/departments/${deptA}`, users.bAdmin)).status).toBe(404);
    const stillThere = await call('GET', '/v1/admin/departments', users.aAdmin);
    expect(stillThere.text).toContain('Dept A');
    const dl = await call('GET', '/v1/admin/departments', users.bAdmin);
    expect(dl.text).not.toContain('Dept A');
  });

  it('a plain member is refused every admin endpoint', async () => {
    for (const [m, p, b] of [
      ['GET', '/v1/admin/overview'], ['GET', '/v1/admin/users'], ['POST', '/v1/admin/users', { email: 'a@b.co', firstName: 'A', lastName: 'B', role: 'member' }],
      ['PATCH', `/v1/admin/users/${userAId}`, { role: 'org_admin' }], ['GET', '/v1/admin/departments'], ['POST', '/v1/admin/departments', { name: 'x' }],
      ['GET', '/v1/admin/policies'], ['PUT', '/v1/admin/policies', { requirePasscode: false, waitingRoomDefault: false, maxParticipants: 300, requireTotp: false }],
      ['GET', '/v1/admin/audit'], ['GET', '/v1/admin/audit/verify'], ['GET', '/v1/admin/audit/export?format=csv'],
      ['GET', '/v1/admin/api-keys'], ['POST', '/v1/admin/api-keys', { name: 'k', scopes: ['meetings:read'] }], ['GET', '/v1/admin/webhooks'], ['GET', '/v1/admin/kms'],
    ] as Array<[string, string, unknown?]>) {
      expect((await call(m, p, users.aMember, b)).status, `${m} ${p}`).toBe(403);
    }
  });

  it('audit log: B\'s admin sees, verifies and exports only B\'s rows', async () => {
    const mine = await call('GET', '/v1/admin/audit?limit=100', users.bAdmin);
    expect(mine.status).toBe(200);
    expect(mine.text).not.toContain(`aadmin-${sfx}`);
    expect(mine.text).not.toContain(slugA);
    const exp = await call('GET', '/v1/admin/audit/export?format=json', users.bAdmin);
    expect(exp.status).toBe(200);
    expect(exp.text).not.toContain(`aadmin-${sfx}`);
  });

  it('API keys: B cannot list or revoke A\'s keys', async () => {
    const list = await call('GET', '/v1/admin/api-keys', users.bAdmin);
    expect(list.text).not.toContain(keyAId);
    expect((await call('DELETE', `/v1/admin/api-keys/${keyAId}`, users.bAdmin)).status).toBe(404);
    expect((await call('GET', '/v1/ext/meetings', keyA)).status).toBe(200); // A's key still works
  });

  it('webhooks: B cannot read deliveries of or delete A\'s endpoint', async () => {
    expect(webhookA).toBeTruthy();
    expect((await call('GET', `/v1/admin/webhooks/${webhookA}/deliveries`, users.bAdmin)).status).toBe(404);
    expect((await call('DELETE', `/v1/admin/webhooks/${webhookA}`, users.bAdmin)).status).toBe(404);
    expect((await call('GET', '/v1/admin/webhooks', users.bAdmin)).text).not.toContain(webhookA);
  });

  it('external API: a key sees and changes only its own organization', async () => {
    const bList = await call('GET', '/v1/ext/meetings', keyB);
    expect(bList.status).toBe(200);
    expect(bList.text).not.toContain(codeA);
    const users1 = await call('GET', '/v1/ext/users', keyB);
    expect(users1.text).not.toContain(`aadmin-${sfx}`);
    for (const id of [meetingA, codeA]) {
      expect((await call('GET', `/v1/ext/meetings/${id}`, keyB)).status).toBe(404);
      expect((await call('DELETE', `/v1/ext/meetings/${id}`, keyB)).status).toBe(404);
    }
    expect((await call('GET', `/v1/ext/meetings/${codeA}`, keyA)).status).toBe(200); // A still owns it
  });

  it('a key without the scope is refused (default deny), and cannot be used on the session API', async () => {
    const ro = await call('POST', '/v1/admin/api-keys', users.aAdmin, { name: 'ro', scopes: ['meetings:read'] });
    expect((await call('POST', '/v1/ext/meetings', ro.body.secret, { title: 'x' })).status).toBe(403);
    expect((await call('GET', '/v1/ext/users', ro.body.secret)).status).toBe(403);
    expect((await call('GET', '/v1/admin/users', ro.body.secret)).status).toBe(401);
    expect((await call('GET', '/v1/meetings', ro.body.secret)).status).toBe(401);
  });

  it('row-level security holds under the application role even for a forged WHERE: org id in the path is not a thing, and the DB refuses a cross-org insert', async () => {
    const app = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    const c = await app.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.current_org', $1, true)", [ids['orgB']]);
      const seen = await c.query('SELECT count(*)::int AS n FROM meetings WHERE id = $1', [meetingA]);
      expect(seen.rows[0].n).toBe(0);
      await expect(c.query("INSERT INTO departments (org_id, name) VALUES ($1, 'x')", [ids['orgA']])).rejects.toThrow(/row-level security/);
      await c.query('ROLLBACK');
    } finally {
      c.release();
      await app.end();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('mass assignment', () => {
  const evil = { org_id: randomUUID(), orgId: randomUUID(), org_slug: 'someone-else', role: 'org_admin', host_user_id: randomUUID(), hostUserId: randomUUID(), is_admin: true, disabled: false, id: randomUUID(), created_at: '2000-01-01T00:00:00Z' };

  it.each(Object.keys(evil))('POST /v1/meetings with an extra "%s" is refused (strict schema)', async (k) => {
    const r = await call('POST', '/v1/meetings', users.aMember, { title: 'x', [k]: (evil as Record<string, unknown>)[k] });
    expect(r.status).toBe(400);
  });

  it.each(Object.keys(evil))('POST /v1/ext/meetings with an extra "%s" is refused', async (k) => {
    const key = (await call('POST', '/v1/admin/api-keys', users.aAdmin, { name: `m-${k}`, scopes: ['meetings:write'] })).body.secret;
    expect((await call('POST', '/v1/ext/meetings', key, { title: 'x', [k]: (evil as Record<string, unknown>)[k] })).status).toBe(400);
  });

  it('admin create/update user, department, policies, api key, webhook and KMS reject unknown fields', async () => {
    const t = users.aAdmin;
    expect((await call('POST', '/v1/admin/users', t, { email: 'new@t.local', firstName: 'N', lastName: 'U', role: 'member', org_id: ids['orgB'] })).status).toBe(400);
    expect((await call('POST', '/v1/admin/users', t, { email: 'new@t.local', firstName: 'N', lastName: 'U', role: 'super_admin' })).status).toBe(400);
    expect((await call('PATCH', `/v1/admin/users/${randomUUID()}`, t, { org_id: ids['orgB'] })).status).toBe(400);
    expect((await call('PUT', '/v1/admin/policies', t, { requirePasscode: false, waitingRoomDefault: false, maxParticipants: 10, requireTotp: false, org_id: ids['orgB'] })).status).toBe(400);
    expect((await call('POST', '/v1/admin/api-keys', t, { name: 'k', scopes: ['meetings:read'], org_id: ids['orgB'] })).status).toBe(400);
    expect((await call('POST', '/v1/admin/api-keys', t, { name: 'k', scopes: ['admin:everything'] })).status).toBe(400);
    expect((await call('POST', '/v1/admin/webhooks', t, { url: 'https://example.com/h', events: ['meeting.created'], org_id: ids['orgB'] })).status).toBe(400);
    expect((await call('PUT', '/v1/admin/kms', t, { addr: 'https://vault.example.com', token: 'x', keyName: 'k', org_id: ids['orgB'] })).status).toBe(400);
  });

  it('a member cannot raise their own role through any user endpoint', async () => {
    const me = (await owner.query('SELECT id FROM users WHERE email = $1', [`amember-${sfx}@t.local`])).rows[0].id as string;
    expect((await call('PATCH', `/v1/admin/users/${me}`, users.aMember, { role: 'org_admin' })).status).toBe(403);
    const row = (await owner.query('SELECT role FROM users WHERE id = $1', [me])).rows[0];
    expect(row.role).toBe('member');
  });

  it('a JSON __proto__ / constructor payload does not pollute anything and is refused', async () => {
    const raw = '{"title":"x","__proto__":{"role":"org_admin","isAdmin":true},"constructor":{"prototype":{"role":"org_admin"}}}';
    const r = await call('POST', '/v1/meetings', users.aMember, undefined, { 'Content-Type': 'application/json' }, raw);
    expect(r.status).toBe(400);
    expect(({} as Record<string, unknown>)['role']).toBeUndefined();
    expect((await call('GET', '/v1/admin/users', users.aMember)).status).toBe(403);
  });

  it('a meeting is created in the caller\'s organization and hosted by the caller, whatever the body says', async () => {
    const r = await call('POST', '/v1/meetings', users.aMember, { title: 'mine' });
    expect(r.status).toBe(201);
    const row = (await owner.query('SELECT m.org_id, u.email FROM meetings m JOIN users u ON u.id = m.host_user_id WHERE m.id = $1', [r.body.id])).rows[0];
    expect(row.org_id).toBe(ids['orgA']);
    expect(row.email).toBe(`amember-${sfx}@t.local`);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('oversized and malformed input', () => {
  it('a 2 MB JSON body is refused with 413, not processed', async () => {
    const r = await call('POST', '/v1/meetings', users.aMember, { title: 'x'.repeat(2 * 1024 * 1024) });
    expect(r.status).toBe(413);
  });

  it('malformed JSON, wrong content type, empty and non-object bodies answer 4xx (never 5xx)', async () => {
    const t = users.aMember;
    expect((await call('POST', '/v1/meetings', t, undefined, { 'Content-Type': 'application/json' }, '{"title": ')).status).toBe(400);
    expect((await call('POST', '/v1/meetings', t, undefined, { 'Content-Type': 'text/plain' }, '{"title":"x"}')).status).toBe(400);
    expect((await call('POST', '/v1/meetings', t, undefined, { 'Content-Type': 'application/json' }, '')).status).toBe(400);
    expect((await call('POST', '/v1/meetings', t, undefined, { 'Content-Type': 'application/json' }, '[]')).status).toBe(400);
    expect((await call('POST', '/v1/meetings', t, undefined, { 'Content-Type': 'application/json' }, 'null')).status).toBe(400);
    expect((await call('POST', '/v1/meetings', t, undefined, { 'Content-Type': 'application/json' }, '"a string"')).status).toBe(400);
    expect((await call('POST', '/v1/meetings', t, { title: 12345 })).status).toBe(400);
    expect((await call('POST', '/v1/meetings', t, { title: '' })).status).toBe(400);
    expect((await call('POST', '/v1/meetings', t, { title: 'x', scheduledAt: 'tomorrow' })).status).toBe(400);
    expect((await call('PATCH', `/v1/meetings/12345678901`, t, [] as unknown as object)).status).toBe(400);
  });

  it('deeply nested JSON is refused without crashing the server', async () => {
    const deep = '['.repeat(20000) + ']'.repeat(20000);
    const r = await call('POST', '/v1/meetings', users.aMember, undefined, { 'Content-Type': 'application/json' }, `{"title":"x","a":${deep}}`);
    expect([400, 413]).toContain(r.status);
    expect((await call('GET', '/v1/meetings', users.aMember)).status).toBe(200); // still alive
  });

  it('hostile titles are stored as plain data (no 5xx) and control characters do not break the list', async () => {
    for (const title of ['<script>alert(1)</script>', "'; DROP TABLE meetings;--", '\u0000nul', 'x'.repeat(200), '‮RTL', '{{7*7}}${7*7}']) {
      const r = await call('POST', '/v1/meetings', users.aMember, { title });
      expect([201, 400], title).toContain(r.status);
    }
    expect((await call('GET', '/v1/meetings', users.aMember)).status).toBe(200);
    const tables = await owner.query("SELECT to_regclass('public.meetings') AS t");
    expect(tables.rows[0].t).toBe('meetings');
  });

  it('a NUL or control character in any free-text field is a 4xx, never a 500 (Postgres rejects NUL in text)', async () => {
    const nul = 'a\u0000b';
    const key = (await call('POST', '/v1/admin/api-keys', users.aAdmin, { name: 'nulsweep', scopes: ['meetings:write', 'meetings:read'] })).body.secret;
    const dept = await call('POST', '/v1/admin/departments', users.aAdmin, { name: `nul-sweep-${sfx}` });
    const m = await call('POST', '/v1/meetings', users.aAdmin, { title: 'nul sweep' });
    const cases: Array<[string, string, string | null, unknown, Record<string, string>?]> = [
      ['POST', '/v1/meetings', users.aMember, { title: nul }],
      ['POST', '/v1/meetings', users.aMember, { title: 'ok', passcode: `${nul}xxxxxx` }],
      ['POST', '/v1/ext/meetings', key, { title: nul }],
      ['POST', '/v1/ext/meetings', key, { title: 'ok', passcode: `${nul}xxxxxx` }],
      ['POST', '/v1/admin/departments', users.aAdmin, { name: nul }],
      ['PATCH', `/v1/admin/departments/${dept.body.id}`, users.aAdmin, { name: nul }],
      ['POST', '/v1/admin/users', users.aAdmin, { email: `a${nul}@t.local`, firstName: 'A', lastName: 'B', role: 'member' }],
      ['POST', '/v1/admin/users', users.aAdmin, { email: 'a@t.local', firstName: nul, lastName: 'B', role: 'member' }],
      ['POST', '/v1/admin/api-keys', users.aAdmin, { name: nul, scopes: ['meetings:read'] }],
      ['POST', '/v1/admin/webhooks', users.aAdmin, { url: `https://example.com/${nul}`, events: ['meeting.created'] }],
      ['PUT', '/v1/admin/kms', users.aAdmin, { addr: `https://vault.example.com/${nul}`, token: 'x', keyName: 'k' }],
      ['PUT', '/v1/admin/kms', users.aAdmin, { addr: 'https://vault.example.com', token: nul, keyName: 'k' }],
      ['POST', `/v1/meetings/${m.body.code}/join`, users.aMember, { passcode: nul }],
      ['PUT', `/v1/meetings/${m.body.code}/files?name=${encodeURIComponent(nul)}`, users.aAdmin, undefined, { 'Content-Type': 'application/octet-stream' }],
      ['GET', `/v1/admin/users?search=${encodeURIComponent(nul)}`, users.aAdmin, undefined],
      ['GET', `/v1/admin/users?cursor=${encodeURIComponent(nul)}`, users.aAdmin, undefined],
      ['GET', `/v1/admin/audit?action=${encodeURIComponent(nul)}&cursor=${encodeURIComponent(nul)}`, users.aAdmin, undefined],
      ['GET', `/v1/ext/meetings?cursor=${encodeURIComponent(nul)}`, key, undefined],
      ['GET', `/v1/ext/meetings/${encodeURIComponent(nul)}`, key, undefined],
    ];
    for (const [method, path, token, body, headers] of cases) {
      const r = await call(method, path, token, body, headers ?? {}, method === 'PUT' && path.includes('/files') ? Buffer.from('x') : undefined);
      expect(r.status, `${method} ${path.split('?')[0]} ${JSON.stringify(body)} -> ${r.status} ${r.text.slice(0, 100)}`).toBeLessThan(500);
    }
  });

  it('absurd codes and ids in the path answer 404/400, never 500', async () => {
    for (const code of ['0', 'abc', '1'.repeat(11) + 'x', '9'.repeat(5000), '%00', '..%2f..%2fetc%2fpasswd', '%E0%A4%A', encodeURIComponent("1' OR '1'='1")]) {
      const r = await call('POST', `/v1/meetings/${code}/join`, users.aMember, {});
      expect([400, 404], `${code.slice(0, 30)} -> ${r.status}`).toContain(r.status);
    }
  });

  it('file upload: more than the cap is refused with 413 and nothing is stored', async () => {
    const m = await call('POST', '/v1/meetings', users.aAdmin, { title: 'upload cap' });
    const before = Number((await owner.query('SELECT count(*) AS n FROM meeting_files')).rows[0].n);
    const r = await call('PUT', `/v1/meetings/${m.body.code}/files?name=big.bin`, users.aAdmin, undefined, { 'Content-Type': 'application/octet-stream' }, new Uint8Array(25 * 1024 * 1024 + 1));
    expect(r.status).toBe(413);
    expect(Number((await owner.query('SELECT count(*) AS n FROM meeting_files')).rows[0].n)).toBe(before);
  }, 60_000);

  it('file upload: hostile file names are sanitised or refused, never used as a path', async () => {
    const m = await call('POST', '/v1/meetings', users.aAdmin, { title: 'names' });
    for (const name of ['../../etc/passwd', '..\\..\\windows\\win.ini', 'a\u0000.txt', 'con.txt', 'x.exe', 'x.html.exe', '%2e%2e%2fa', 'a'.repeat(300) + '.txt']) {
      const r = await call('PUT', `/v1/meetings/${m.body.code}/files?name=${encodeURIComponent(name)}`, users.aAdmin, undefined, { 'Content-Type': 'application/octet-stream' }, Buffer.from('data'));
      expect([200, 400, 415, 422], `${name.slice(0, 30)} -> ${r.status} ${r.text.slice(0, 80)}`).toContain(r.status);
      if (r.status === 200) {
        expect(r.body.name).not.toMatch(/[\\/]/); // a flat name: no path separators (a literal ".." inside the name is harmless)
        const key = (await owner.query('SELECT object_key FROM meeting_files WHERE id = $1', [r.body.id])).rows[0].object_key as string;
        expect(key).not.toMatch(/\.\./);
      }
    }
  });

  it('path traversal in file and recording ids is refused before it reaches storage', async () => {
    const m = await call('POST', '/v1/meetings', users.aAdmin, { title: 'traversal' });
    for (const id of ['..%2f..%2f..%2fetc%2fpasswd', '..', '%2e%2e', 'not-a-uuid', `${randomUUID()}%00`, '0'.repeat(5000), encodeURIComponent('../../x')]) {
      const f = await call('GET', `/v1/meetings/${m.body.code}/files/${id}`, users.aAdmin);
      expect([400, 404], `file ${id.slice(0, 30)} -> ${f.status}`).toContain(f.status);
      const r = await call('GET', `/v1/recordings/${id}/download`, users.aAdmin);
      expect([400, 404], `rec ${id.slice(0, 30)} -> ${r.status}`).toContain(r.status);
    }
  });

  it('a forged Host / X-Forwarded-Host never steers the client to another media server URL', async () => {
    const m = await call('POST', '/v1/meetings', users.aAdmin, { title: 'hosts' });
    const r = await call('POST', `/v1/meetings/${m.body.code}/join`, users.aAdmin, {}, { 'X-Forwarded-Host': 'evil.example' });
    expect(r.status).toBe(200);
    expect(r.text).not.toContain('evil.example');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('SSRF', () => {
  const hostile = [
    'http://169.254.169.254/latest/meta-data/', 'https://169.254.169.254/', 'https://127.0.0.1/hook', 'https://127.0.0.1:9100/metrics', 'https://localhost/hook',
    'https://[::1]/hook', 'https://[::ffff:127.0.0.1]/hook', 'https://[fd00::1]/hook', 'https://10.0.0.5/hook', 'https://192.168.1.1/hook', 'https://172.16.0.9/hook',
    'https://0.0.0.0/hook', 'https://0x7f000001/hook', 'https://2130706433/hook', 'https://017700000001/hook', 'https://127.1/hook',
    'https://user:pass@example.com/hook', 'http://example.com/hook', 'ftp://example.com/hook', 'file:///etc/passwd', 'gopher://example.com/', 'javascript:alert(1)',
    'https://metadata.google.internal/', 'https://kubernetes.default.svc/', 'https://postgres:5432/', 'https://redis:6379/', 'https://keycloak:8080/auth/admin/',
    'https://example.com@127.0.0.1/hook', 'https://127.0.0.1#@example.com/hook',
  ];

  it.each(hostile)('webhook URL %s is refused', async (url) => {
    const r = await call('POST', '/v1/admin/webhooks', users.aAdmin, { url, events: ['meeting.created'] });
    expect(r.status, `${url} -> ${r.status} ${r.text}`).toBe(400);
  });

  const vault = [
    'http://169.254.169.254', 'https://169.254.169.254', 'https://127.0.0.1:8200', 'https://localhost:8200', 'https://[::1]:8200', 'https://10.1.2.3:8200', 'https://192.168.0.10:8200',
    'http://vault.example.com', 'https://0x7f000001', 'https://2130706433', 'file:///etc/passwd', 'https://user:pw@vault.example.com', 'https://metadata.google.internal',
  ];
  it.each(vault)('BYOK Vault address %s is refused (no private or plain-http Vault by default)', async (addr) => {
    const r = await call('PUT', '/v1/admin/kms', users.aAdmin, { addr, token: 'hvs.test-token-not-real', keyName: 'k1' });
    expect([400, 422], `${addr} -> ${r.status} ${r.text}`).toContain(r.status);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('brute force and limiter bypass', () => {
  it('parallel passcode guessing cannot beat the attempt limit (check-then-record race)', async () => {
    const m = await call('POST', '/v1/meetings', users.aAdmin, { title: 'passcode race', passcode: 'the-right-passcode-1' });
    const guesses = Array.from({ length: 40 }, (_, i) => call('POST', `/v1/meetings/${m.body.code}/join`, users.aMember, { passcode: `wrong-guess-${i}-x` }));
    const results = await Promise.all(guesses);
    const reachedVerification = results.filter((r) => r.status === 403).length; // 403 = a guess was actually checked against the hash
    const refused = results.filter((r) => r.status === 429).length;
    expect(reachedVerification).toBeLessThanOrEqual(5); // the limit is 5 failures in 15 minutes
    expect(refused).toBeGreaterThanOrEqual(35);
    // and the right passcode is refused while blocked
    const right = await call('POST', `/v1/meetings/${m.body.code}/join`, users.aMember, { passcode: 'the-right-passcode-1' });
    expect(right.status).toBe(429);
  }, 60_000);

  it('the passcode limit follows the user and meeting, not the claimed address: spoofed X-Forwarded-For changes nothing', async () => {
    const m = await call('POST', '/v1/meetings', users.aAdmin, { title: 'passcode xff', passcode: 'the-right-passcode-2' });
    const codes: number[] = [];
    for (let i = 0; i < 9; i++) codes.push((await call('POST', `/v1/meetings/${m.body.code}/join`, users.aMember, { passcode: `bad-${i}-xxxxx` }, { 'X-Forwarded-For': `203.0.113.${i}, 198.51.100.${i}` })).status);
    expect(codes.slice(0, 5).every((c) => c === 403)).toBe(true);
    expect(codes.slice(5).every((c) => c === 429)).toBe(true);
  });

  it('public sign-up challenge issuance is limited per real address and stays limited under spoofing', async () => {
    let limited = 0;
    for (let i = 0; i < 75; i++) {
      const r = await call('POST', '/v1/public/challenge', null, {}, { 'X-Forwarded-For': `${i}.9.9.9, 192.0.2.200` });
      if (r.status === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
  });
});

describe('rate limits against header spoofing (second app instance with low limits)', () => {
  let app2: INestApplication;
  let base1 = '';
  beforeAll(async () => {
    base1 = base;
    app2 = await boot({ RATE_LIMIT_AUTH_FAIL_MAX: '5', RATE_LIMIT_IP_PER_MINUTE: '40', SIGNUP_TRUSTED_PROXY_HOPS: '1', SIGNUP_ENABLED: 'true' });
  });
  afterAll(async () => {
    await app2.close();
    base = base1;
  });

  it('bad tokens are throttled per real address: rotating a forged left-hand X-Forwarded-For entry does not reset the count', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 9; i++) codes.push((await call('GET', '/v1/meetings', 'not-a-token', undefined, { 'X-Forwarded-For': `10.${i}.${i}.${i}, 192.0.2.77` })).status);
    expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(codes.slice(5).every((c) => c === 429)).toBe(true);
    const good = await call('GET', '/v1/meetings', users.aMember, undefined, { 'X-Forwarded-For': '1.1.1.1, 192.0.2.77' });
    expect(good.status).toBe(429); // the address (as the proxy saw it) is blocked even for a good token
    expect(Number(good.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect((await call('GET', '/v1/meetings', users.aMember, undefined, { 'X-Forwarded-For': '1.1.1.1, 192.0.2.78' })).status).toBe(200); // another real address is fine
  });

  it('the global per-IP ceiling cannot be dodged with forged X-Forwarded-For entries, and answers with Retry-After', async () => {
    const codes: number[] = [];
    let retry: string | null = null;
    for (let i = 0; i < 60; i++) {
      const r = await call('GET', '/v1/ext/openapi.json', null, undefined, { 'X-Forwarded-For': `${i}.${i}.${i}.${i}, 192.0.2.99` });
      codes.push(r.status);
      if (r.status === 429) retry = r.headers.get('retry-after');
    }
    expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(15);
    expect(Number(retry)).toBeGreaterThanOrEqual(1);
  });

});
