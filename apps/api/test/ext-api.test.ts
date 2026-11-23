import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Controller, Get, Module, Req, UseGuards, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Pool } from 'pg';
import { loadConfig } from '../src/config.js';
import { AuthGuard, POOL, VERIFIER, type AuthedUser } from '../src/auth/auth.guard.js';
import type { Identity } from '../src/auth/jwt.js';
import { AdminGuard } from '../src/admin/admin.controller.js';
import { ApiKeyGuard, Scope, type ApiPrincipal } from '../src/ext-api/api-key.guard.js';
import { ApiKeysService } from '../src/ext-api/api-keys.service.js';
import { KeysController } from '../src/ext-api/keys.controller.js';
import { loadExtConfig } from '../src/ext-api/ext-config.js';
import { EXT_CONFIG, EXT_KEYS } from '../src/ext-api/tokens.js';

// Integration over real HTTP (Nest app, real guards) against real Postgres with row-level security.
const cfg = loadConfig();
const extCfg = { ...loadExtConfig({}), EXT_API_RATE_PER_MINUTE: 1000 };
const adminUrl = process.env.MIGRATE_DATABASE_URL;
if (!adminUrl) throw new Error('MIGRATE_DATABASE_URL is required for tests');
const pool = new Pool({ connectionString: cfg.DATABASE_URL, max: 8 });
const owner = new Pool({ connectionString: adminUrl, max: 2 });
const sfx = Math.random().toString(36).slice(2, 8);
const slugs = { a: `ext-a-${sfx}`, b: `ext-b-${sfx}`, many: `ext-m-${sfx}` };

const fakeVerifier = async (token: string): Promise<Identity> => {
  try {
    return JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as Identity;
  } catch {
    throw new Error('bad token');
  }
};

@Controller('v1/ext-probe')
@UseGuards(ApiKeyGuard)
class ProbeController {
  @Get('read')
  @Scope('meetings:read')
  read(@Req() req: { apiOrg: ApiPrincipal }) {
    return { orgId: req.apiOrg.orgId, keyId: req.apiOrg.keyId };
  }
  @Get('write')
  @Scope('meetings:write')
  write(@Req() req: { apiOrg: ApiPrincipal }) {
    return { orgId: req.apiOrg.orgId };
  }
  @Get('unscoped')
  unscoped() {
    return { reached: true };
  }
}

@Module({
  controllers: [KeysController, ProbeController],
  providers: [
    { provide: POOL, useValue: pool },
    { provide: VERIFIER, useValue: fakeVerifier },
    { provide: EXT_CONFIG, useValue: extCfg },
    { provide: EXT_KEYS, useFactory: () => new ApiKeysService(pool, extCfg) },
    AuthGuard,
    AdminGuard,
    ApiKeyGuard,
  ],
})
class TestModule {}

let app: INestApplication;
let base = '';

interface Actor extends AuthedUser {
  token: string;
}
async function mkUser(slug: string, sub: string, role: 'org_admin' | 'member', name = sub): Promise<Actor> {
  const email = `${sub}@t.local`;
  const r = await pool.query('SELECT org_id, user_id FROM provision_user($1,$2,$3,$4,$5,$6)', [slug, slug, sub, email, name, role]);
  const identity: Identity = { sub, email, name, orgSlug: slug, role };
  return { ...identity, orgId: r.rows[0].org_id, userId: r.rows[0].user_id, token: Buffer.from(JSON.stringify(identity)).toString('base64url') };
}

async function call(method: string, path: string, token: string | null, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* empty or non-JSON body */
  }
  return { status: res.status, body: json, text, headers: res.headers };
}

let adminA: Actor, memberA: Actor, adminB: Actor;
async function newKey(admin: Actor, scopes: string[], name = 'k') {
  const r = await call('POST', '/v1/admin/api-keys', admin.token, { name, scopes });
  expect(r.status, r.text).toBe(201);
  return r.body as { id: string; prefix: string; secret: string; scopes: string[] };
}

beforeAll(async () => {
  app = await NestFactory.create(TestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
  adminA = await mkUser(slugs.a, `exta-${sfx}`, 'org_admin', 'Admin A');
  memberA = await mkUser(slugs.a, `extm-${sfx}`, 'member', 'Member A');
  adminB = await mkUser(slugs.b, `extb-${sfx}`, 'org_admin', 'Admin B');
});
afterAll(async () => {
  await app.close();
  await owner.query('DELETE FROM organizations WHERE slug = ANY($1)', [Object.values(slugs)]);
  await owner.end();
  await pool.end();
});

describe('D1 api keys: management', () => {
  it('only an org admin can manage keys (member 403, anonymous 401)', async () => {
    expect((await call('POST', '/v1/admin/api-keys', memberA.token, { name: 'x', scopes: ['meetings:read'] })).status).toBe(403);
    expect((await call('GET', '/v1/admin/api-keys', memberA.token)).status).toBe(403);
    expect((await call('DELETE', `/v1/admin/api-keys/${crypto.randomUUID()}`, memberA.token)).status).toBe(403);
    expect((await call('GET', '/v1/admin/api-keys', null)).status).toBe(401);
  });

  it('returns the secret once, in the documented format', async () => {
    const r = await call('POST', '/v1/admin/api-keys', adminA.token, { name: 'ci', scopes: ['meetings:read', 'users:read'] });
    expect(r.status).toBe(201);
    expect(r.body.secret).toMatch(/^dbx_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/);
    expect(r.body.secret.startsWith(`dbx_${r.body.prefix}_`)).toBe(true);
    expect(r.body.scopes).toEqual(['meetings:read', 'users:read']);
    expect(r.body.name).toBe('ci');
  });

  it('never returns the secret again and stores only hash and prefix', async () => {
    const k = await newKey(adminA, ['meetings:read'], 'once');
    const list = await call('GET', '/v1/admin/api-keys', adminA.token);
    expect(list.status).toBe(200);
    expect(list.text).not.toContain(k.secret);
    expect(list.text).not.toContain(k.secret.slice(13));
    const row = list.body.find((x: { id: string }) => x.id === k.id);
    expect(row).toBeTruthy();
    expect(Object.keys(row).sort()).toEqual(['createdAt', 'id', 'lastUsedAt', 'name', 'prefix', 'revokedAt', 'scopes']);
    const db = await owner.query('SELECT prefix, encode(secret_hash, $2) AS h, row_to_json(api_keys)::text AS raw FROM api_keys WHERE id = $1', [k.id, 'hex']);
    expect(db.rows[0].prefix).toBe(k.prefix);
    expect(db.rows[0].raw).not.toContain(k.secret.slice(13));
    expect(db.rows[0].h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('validates input: unknown scope, empty scopes, extra fields, bad name -> 400', async () => {
    for (const body of [
      { name: 'x', scopes: ['admin:all'] },
      { name: 'x', scopes: [] },
      { name: 'x' },
      { name: '', scopes: ['meetings:read'] },
      { name: 'x'.repeat(81), scopes: ['meetings:read'] },
      { name: 'x', scopes: ['meetings:read'], orgId: crypto.randomUUID() },
      { name: 'x', scopes: ['meetings:read', 'meetings:read'] },
    ]) {
      expect((await call('POST', '/v1/admin/api-keys', adminA.token, body)).status, JSON.stringify(body)).toBe(400);
    }
  });

  it('a key of org A is invisible to org B and cannot be revoked by it', async () => {
    const k = await newKey(adminA, ['meetings:read'], 'a-only');
    const listB = await call('GET', '/v1/admin/api-keys', adminB.token);
    expect(listB.body.some((x: { id: string }) => x.id === k.id)).toBe(false);
    expect((await call('DELETE', `/v1/admin/api-keys/${k.id}`, adminB.token)).status).toBe(404);
    expect((await call('DELETE', '/v1/admin/api-keys/not-a-uuid', adminA.token)).status).toBe(404);
    expect((await call('GET', '/v1/ext-probe/read', k.secret)).status).toBe(200); // still alive
  });

  it('refuses more than 20 active keys per organization (revoked ones do not count)', async () => {
    const admin = await mkUser(slugs.many, `extmany-${sfx}`, 'org_admin');
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) ids.push((await newKey(admin, ['users:read'], `k${i}`)).id);
    const over = await call('POST', '/v1/admin/api-keys', admin.token, { name: 'over', scopes: ['users:read'] });
    expect(over.status).toBe(409);
    expect((await call('DELETE', `/v1/admin/api-keys/${ids[0]}`, admin.token)).status).toBe(204);
    expect((await call('POST', '/v1/admin/api-keys', admin.token, { name: 'again', scopes: ['users:read'] })).status).toBe(201);
  });

  it('writes audit rows for create and revoke (without the secret)', async () => {
    const k = await newKey(adminA, ['meetings:read'], 'audited');
    expect((await call('DELETE', `/v1/admin/api-keys/${k.id}`, adminA.token)).status).toBe(204);
    const r = await owner.query("SELECT action, target FROM audit_log WHERE org_id = $1 AND target LIKE $2 ORDER BY id", [adminA.orgId, `%${k.prefix}%`]);
    expect(r.rows.map((x) => x.action)).toEqual(['api_key.create', 'api_key.revoke']);
    expect(JSON.stringify(r.rows)).not.toContain(k.secret.slice(13));
  });
});

describe('D1 api keys: authentication and scopes', () => {
  it('a valid key reaches the handler as its own organization', async () => {
    const k = await newKey(adminA, ['meetings:read']);
    const r = await call('GET', '/v1/ext-probe/read', k.secret);
    expect(r.status).toBe(200);
    expect(r.body.orgId).toBe(adminA.orgId);
    const kb = await newKey(adminB, ['meetings:read']);
    expect((await call('GET', '/v1/ext-probe/read', kb.secret)).body.orgId).toBe(adminB.orgId);
  });

  it('a revoked key is 401 and stays 401', async () => {
    const k = await newKey(adminA, ['meetings:read']);
    expect((await call('GET', '/v1/ext-probe/read', k.secret)).status).toBe(200);
    expect((await call('DELETE', `/v1/admin/api-keys/${k.id}`, adminA.token)).status).toBe(204);
    expect((await call('GET', '/v1/ext-probe/read', k.secret)).status).toBe(401);
    expect((await call('DELETE', `/v1/admin/api-keys/${k.id}`, adminA.token)).status).toBe(404); // already revoked
  });

  it('a missing scope is 403; an unscoped handler is denied by default', async () => {
    const k = await newKey(adminA, ['meetings:read']);
    expect((await call('GET', '/v1/ext-probe/write', k.secret)).status).toBe(403);
    expect((await call('GET', '/v1/ext-probe/read', k.secret)).status).toBe(200);
    expect((await call('GET', '/v1/ext-probe/unscoped', k.secret)).status).toBe(403);
    const w = await newKey(adminA, ['meetings:write']);
    expect((await call('GET', '/v1/ext-probe/write', w.secret)).status).toBe(200);
    expect((await call('GET', '/v1/ext-probe/read', w.secret)).status).toBe(403);
  });

  it('every malformed or wrong credential gets the same 401 and the body never echoes the key', async () => {
    const k = await newKey(adminA, ['meetings:read']);
    const prefix = k.secret.slice(4, 12);
    const secret = k.secret.slice(13);
    const wrongSecret = `dbx_${prefix}_${secret.slice(0, 42)}${secret.endsWith('A') ? 'B' : 'A'}`;
    const unknownPrefix = `dbx_${prefix === 'ffffffff' ? '00000000' : 'ffffffff'}_${secret}`;
    const bodies = new Set<string>();
    for (const token of [wrongSecret, unknownPrefix, 'dbx_garbage', 'nonsense', adminA.token]) {
      const r = await call('GET', '/v1/ext-probe/read', token);
      expect(r.status, token.slice(0, 20)).toBe(401);
      expect(r.text).not.toContain(token);
      bodies.add(r.text);
    }
    expect(bodies.size).toBe(1);
    expect((await call('GET', '/v1/ext-probe/read', null)).status).toBe(401);
    // the key is accepted in the Authorization header only, never in the URL
    expect((await call('GET', `/v1/ext-probe/read?api_key=${k.secret}`, null)).status).toBe(401);
    // and the console login token does not work as an API key on the external surface
    expect((await call('GET', '/v1/ext-probe/read', adminA.token)).status).toBe(401);
  });

  it('last_used_at is empty before the first use and set after it', async () => {
    const k = await newKey(adminA, ['meetings:read']);
    const before = await call('GET', '/v1/admin/api-keys', adminA.token);
    expect(before.body.find((x: { id: string }) => x.id === k.id).lastUsedAt).toBeNull();
    expect((await call('GET', '/v1/ext-probe/read', k.secret)).status).toBe(200);
    const after = await call('GET', '/v1/admin/api-keys', adminA.token);
    expect(new Date(after.body.find((x: { id: string }) => x.id === k.id).lastUsedAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('never writes the secret to stdout, stderr or the console', async () => {
    const chunks: string[] = [];
    const spies = [
      vi.spyOn(process.stdout, 'write').mockImplementation(((c: unknown) => (chunks.push(String(c)), true)) as never),
      vi.spyOn(process.stderr, 'write').mockImplementation(((c: unknown) => (chunks.push(String(c)), true)) as never),
    ];
    let secret = '';
    try {
      const k = await newKey(adminA, ['meetings:read']);
      secret = k.secret;
      await call('GET', '/v1/ext-probe/read', k.secret);
      await call('GET', '/v1/ext-probe/read', `${k.secret}x`);
      await call('GET', '/v1/ext-probe/write', k.secret);
      await call('DELETE', `/v1/admin/api-keys/${k.id}`, adminA.token);
      await call('GET', '/v1/ext-probe/read', k.secret);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
    expect(secret).not.toBe('');
    expect(chunks.join('')).not.toContain(secret.slice(13));
  });
});
