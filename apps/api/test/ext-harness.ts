import 'reflect-metadata';
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
import { MeetingsService } from '../src/meetings/meetings.service.js';
import { ExtMeetingsService } from '../src/ext-api/ext-meetings.service.js';
import { ExtUsersService } from '../src/ext-api/ext-users.service.js';
import { MeetingsExtController } from '../src/ext-api/meetings.ext.controller.js';
import { UsersExtController } from '../src/ext-api/users.ext.controller.js';
import { OpenApiController } from '../src/ext-api/openapi.js';
import { EXT_CONFIG, EXT_KEYS, EXT_MEETINGS, EXT_USERS } from '../src/ext-api/tokens.js';

// Shared harness for the external API tests: a Nest app over real HTTP with the real guards, real Postgres (row-level
// security, database davra_wsd or whatever DATABASE_URL points at) and a fake identity provider token.
export const cfg = loadConfig();
export const extCfg = { ...loadExtConfig({}), EXT_API_RATE_PER_MINUTE: 1000, WEBHOOK_DELIVERY_INTERVAL_MS: 0 };
const adminUrl = process.env.MIGRATE_DATABASE_URL;
if (!adminUrl) throw new Error('MIGRATE_DATABASE_URL is required for tests');
export const pool = new Pool({ connectionString: cfg.DATABASE_URL, max: 8 });
export const owner = new Pool({ connectionString: adminUrl, max: 2 });
export const sfx = Math.random().toString(36).slice(2, 8);

const usedSlugs = new Set<string>();
export function slug(name: string): string {
  const s = `ext-${name}-${sfx}`;
  usedSlugs.add(s);
  return s;
}

const fakeVerifier = async (token: string): Promise<Identity> => {
  try {
    return JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as Identity;
  } catch {
    throw new Error('bad token');
  }
};

/** A tiny scoped endpoint to exercise ApiKeyGuard on its own. */
@Controller('v1/ext-probe')
@UseGuards(ApiKeyGuard)
export class ProbeController {
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
  controllers: [KeysController, ProbeController, MeetingsExtController, UsersExtController, OpenApiController],
  providers: [
    { provide: POOL, useValue: pool },
    { provide: VERIFIER, useValue: fakeVerifier },
    { provide: EXT_CONFIG, useValue: extCfg },
    { provide: EXT_KEYS, useFactory: () => new ApiKeysService(pool, extCfg) },
    { provide: EXT_MEETINGS, useFactory: () => new ExtMeetingsService(pool, new MeetingsService(pool, cfg), cfg) },
    { provide: EXT_USERS, useFactory: () => new ExtUsersService(pool) },
    AuthGuard,
    AdminGuard,
    ApiKeyGuard,
  ],
})
export class TestModule {}

export interface Actor extends AuthedUser {
  token: string;
}

export async function mkUser(orgSlug: string, sub: string, role: 'org_admin' | 'member', name = sub): Promise<Actor> {
  const email = `${sub}@t.local`;
  const r = await pool.query('SELECT org_id, user_id FROM provision_user($1,$2,$3,$4,$5,$6)', [orgSlug, orgSlug, sub, email, name, role]);
  const identity: Identity = { sub, email, name, orgSlug, role };
  return { ...identity, orgId: r.rows[0].org_id, userId: r.rows[0].user_id, token: Buffer.from(JSON.stringify(identity)).toString('base64url') };
}

let app: INestApplication;
let base = '';

export async function startApp(module: new () => unknown = TestModule): Promise<void> {
  app = await NestFactory.create(module, { logger: false });
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
}

export async function stopApp(): Promise<void> {
  await app.close();
  await owner.query('DELETE FROM organizations WHERE slug = ANY($1)', [[...usedSlugs]]);
  await owner.end();
  await pool.end();
}

export interface CallResult {
  status: number;
  body: any;
  text: string;
  headers: Headers;
}

export async function call(method: string, path: string, token: string | null, body?: unknown, headers: Record<string, string> = {}): Promise<CallResult> {
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

export async function newKey(admin: Actor, scopes: string[], name = 'k') {
  const r = await call('POST', '/v1/admin/api-keys', admin.token, { name, scopes });
  if (r.status !== 201) throw new Error(`could not create a key: ${r.status} ${r.text}`);
  return r.body as { id: string; prefix: string; secret: string; scopes: string[] };
}
