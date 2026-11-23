import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RequestMethod } from '@nestjs/common';
// Nest's route metadata keys (constants PATH_METADATA / METHOD_METADATA are not exported with types)
const PATH_METADATA = 'path';
const METHOD_METADATA = 'method';
import { buildOpenApi } from '../src/ext-api/openapi.js';
import { call, extCfg, mkUser, newKey, owner, pool, sfx, slug, startApp, stopApp, TestModule, type Actor, type CallResult } from './ext-harness.js';

// D2: /v1/ext endpoints, idempotency, pagination, rate limit and the OpenAPI document.
const slugs = { a: slug('ea'), b: slug('eb'), page: slug('ep'), pol: slug('eo') };
let adminA: Actor, memberA: Actor, adminB: Actor;
const ext = (method: string, path: string, key: string | null, body?: unknown, headers: Record<string, string> = {}) => call(method, `/v1/ext${path}`, key, body, headers);
const title = (s: string) => `${s}-${sfx}-${Math.random().toString(36).slice(2, 7)}`;
let rw: string; // meetings:read + meetings:write + users:read, org A
let rwB: string;

beforeAll(async () => {
  await startApp();
  adminA = await mkUser(slugs.a, 'ea-admin', 'org_admin', 'Admin A');
  memberA = await mkUser(slugs.a, 'ea-member', 'member', 'Member A');
  adminB = await mkUser(slugs.b, 'eb-admin', 'org_admin', 'Admin B');
  rw = (await newKey(adminA, ['meetings:read', 'meetings:write', 'users:read'], 'rw')).secret;
  rwB = (await newKey(adminB, ['meetings:read', 'meetings:write', 'users:read'], 'rwB')).secret;
});
afterAll(stopApp);

describe('D2 external endpoints', () => {
  it('creates a meeting hosted by the key owner, reads it by id and by code, and lists it', async () => {
    const t = title('create');
    const r = await ext('POST', '/meetings', rw, { title: t, waitingRoom: false });
    expect(r.status, r.text).toBe(201);
    expect(r.body.code).toMatch(/^[0-9]{11}$/);
    expect(r.body).toMatchObject({ title: t, waitingRoom: false, locked: false, hasPasscode: false, hostUserId: adminA.userId });
    expect(r.text).not.toMatch(/passcode_hash|passcodeHash/);
    const byId = await ext('GET', `/meetings/${r.body.id}`, rw);
    expect(byId.status).toBe(200);
    expect(byId.body.id).toBe(r.body.id);
    expect((await ext('GET', `/meetings/${r.body.code}`, rw)).body.id).toBe(r.body.id);
    const list = await ext('GET', '/meetings?limit=100', rw);
    expect(list.body.items.some((m: { id: string }) => m.id === r.body.id)).toBe(true);
  });

  it('writes an audit row for the creation through a key', async () => {
    const r = await ext('POST', '/meetings', rw, { title: title('audit') });
    const a = await owner.query("SELECT action, target FROM audit_log WHERE org_id = $1 AND action = 'ext.meeting.create' AND target LIKE $2", [adminA.orgId, `${r.body.code}%`]);
    expect(a.rowCount).toBe(1);
  });

  it('a key of org A cannot read, list, delete or create into org B', async () => {
    const mb = await ext('POST', '/meetings', rwB, { title: title('b-only') });
    expect(mb.status).toBe(201);
    expect((await ext('GET', `/meetings/${mb.body.id}`, rw)).status).toBe(404);
    expect((await ext('GET', `/meetings/${mb.body.code}`, rw)).status).toBe(404);
    expect((await ext('DELETE', `/meetings/${mb.body.id}`, rw)).status).toBe(404);
    expect((await ext('GET', '/meetings?limit=100', rw)).body.items.some((m: { id: string }) => m.id === mb.body.id)).toBe(false);
    const row = await owner.query('SELECT org_id FROM meetings WHERE id = $1', [mb.body.id]);
    expect(row.rows[0].org_id).toBe(adminB.orgId);
    expect((await ext('GET', `/meetings/${mb.body.id}`, rwB)).status).toBe(200); // still there
  });

  it('enforces scopes per route', async () => {
    const ro = (await newKey(adminA, ['meetings:read'])).secret;
    const wo = (await newKey(adminA, ['meetings:write'])).secret;
    const uo = (await newKey(adminA, ['users:read'])).secret;
    expect((await ext('POST', '/meetings', ro, { title: 'x' })).status).toBe(403);
    expect((await ext('DELETE', `/meetings/${crypto.randomUUID()}`, ro)).status).toBe(403);
    expect((await ext('GET', '/meetings', wo)).status).toBe(403);
    expect((await ext('GET', '/users', wo)).status).toBe(403);
    expect((await ext('GET', '/meetings', uo)).status).toBe(403);
    expect((await ext('GET', '/users', uo)).status).toBe(200);
    expect((await ext('GET', '/meetings', null)).status).toBe(401);
  });

  it('rejects unknown fields and invalid values with 400', async () => {
    for (const body of [
      { title: 'x', hostUserId: crypto.randomUUID() },
      { title: 'x', orgId: crypto.randomUUID() },
      { title: '' },
      {},
      { title: 'x', passcode: '123' },
      { title: 'x', scheduledAt: 'tomorrow' },
      { title: 'x', waitingRoom: 'yes' },
      { title: 'x'.repeat(201) },
    ]) {
      expect((await ext('POST', '/meetings', rw, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await ext('GET', '/meetings?limit=0', rw)).status).toBe(400);
    expect((await ext('GET', '/meetings?limit=101', rw)).status).toBe(400);
    expect((await ext('GET', '/meetings?cursor=junk', rw)).status).toBe(400);
    expect((await ext('GET', '/meetings?foo=1', rw)).status).toBe(400);
    expect((await ext('GET', '/meetings/not-an-id', rw)).status).toBe(404);
  });

  it('an idempotent POST creates one meeting and replays the first response', async () => {
    const t = title('idem');
    const idem = { 'Idempotency-Key': `k-${sfx}-1` };
    const first = await ext('POST', '/meetings', rw, { title: t }, idem);
    const second = await ext('POST', '/meetings', rw, { title: t }, idem);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(first.headers.get('idempotent-replay')).toBeNull();
    expect(second.headers.get('idempotent-replay')).toBe('true');
    const n = await owner.query('SELECT count(*)::int AS n FROM meetings WHERE org_id = $1 AND title = $2', [adminA.orgId, t]);
    expect(n.rows[0].n).toBe(1);
  });

  it('the same Idempotency-Key with a different body is 422 and creates nothing', async () => {
    const idem = { 'Idempotency-Key': `k-${sfx}-2` };
    const t1 = title('idem-a');
    const t2 = title('idem-b');
    expect((await ext('POST', '/meetings', rw, { title: t1 }, idem)).status).toBe(201);
    expect((await ext('POST', '/meetings', rw, { title: t2 }, idem)).status).toBe(422);
    expect((await owner.query('SELECT 1 FROM meetings WHERE org_id = $1 AND title = $2', [adminA.orgId, t2])).rowCount).toBe(0);
  });

  it('concurrent duplicates with one key still create exactly one meeting', async () => {
    const t = title('race');
    const idem = { 'Idempotency-Key': `k-${sfx}-3` };
    const rs = await Promise.all(Array.from({ length: 6 }, () => ext('POST', '/meetings', rw, { title: t }, idem)));
    for (const r of rs) expect([201, 409], r.text).toContain(r.status); // 409 = the first request is still being processed: retry
    expect(rs.some((r) => r.status === 201)).toBe(true);
    const n = await owner.query('SELECT count(*)::int AS n FROM meetings WHERE org_id = $1 AND title = $2', [adminA.orgId, t]);
    expect(n.rows[0].n).toBe(1);
    const again = await ext('POST', '/meetings', rw, { title: t }, idem);
    expect(again.status).toBe(201);
    expect(again.headers.get('idempotent-replay')).toBe('true');
  });

  it('idempotency keys are per API key: another key with the same string creates its own meeting', async () => {
    const other = (await newKey(adminA, ['meetings:write'])).secret;
    const t = title('scoped-idem');
    const a = await ext('POST', '/meetings', rw, { title: t }, { 'Idempotency-Key': `k-${sfx}-4` });
    const b = await ext('POST', '/meetings', other, { title: t }, { 'Idempotency-Key': `k-${sfx}-4` });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.id).not.toBe(a.body.id);
  });

  it('rejects a malformed Idempotency-Key header', async () => {
    for (const k of ['x'.repeat(201), 'has space', 'tab\there']) {
      const r = await ext('POST', '/meetings', rw, { title: 'x' }, { 'Idempotency-Key': k });
      expect(r.status, k).toBe(400);
    }
  });

  it('a failed creation is not cached: the same key works once the body is acceptable', async () => {
    const admin = await mkUser(slugs.pol, 'eo-admin', 'org_admin');
    await owner.query('INSERT INTO org_policies (org_id, require_passcode) VALUES ($1, true) ON CONFLICT (org_id) DO UPDATE SET require_passcode = true', [admin.orgId]);
    const key = (await newKey(admin, ['meetings:write', 'meetings:read'])).secret;
    const idem = { 'Idempotency-Key': `k-${sfx}-5` };
    const t = title('policy');
    expect((await ext('POST', '/meetings', key, { title: t }, idem)).status).toBe(400); // the organization requires a passcode
    const ok = await ext('POST', '/meetings', key, { title: t, passcode: 'long-enough-pass' }, idem);
    expect(ok.status, ok.text).toBe(201);
    expect(ok.body.hasPasscode).toBe(true);
  });

  it('paginates with a stable cursor even when new meetings appear between pages', async () => {
    const admin = await mkUser(slugs.page, 'ep-admin', 'org_admin');
    const key = (await newKey(admin, ['meetings:write', 'meetings:read'])).secret;
    const made: string[] = [];
    for (let i = 0; i < 5; i++) made.push((await ext('POST', '/meetings', key, { title: `p${i}` })).body.id);
    const p1 = await ext('GET', '/meetings?limit=2', key);
    expect(p1.body.items).toHaveLength(2);
    expect(p1.body.next).toBeTruthy();
    const late = (await ext('POST', '/meetings', key, { title: 'late' })).body.id; // newest: must not shift page 2
    const p2 = await ext('GET', `/meetings?limit=2&cursor=${encodeURIComponent(p1.body.next)}`, key);
    const p3 = await ext('GET', `/meetings?limit=2&cursor=${encodeURIComponent(p2.body.next)}`, key);
    const seen = [...p1.body.items, ...p2.body.items, ...p3.body.items].map((m: { id: string }) => m.id);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual([...made].reverse()); // newest first, no duplicates, no gaps
    expect(seen).not.toContain(late);
    expect(p3.body.next).toBeNull();
    const fresh = await ext('GET', '/meetings?limit=1', key);
    expect(fresh.body.items[0].id).toBe(late);
  });

  it('deletes a meeting (204), 404 afterwards; refuses 409 when it has shared files', async () => {
    const m = await ext('POST', '/meetings', rw, { title: title('del') });
    expect((await ext('DELETE', `/meetings/${m.body.id}`, rw)).status).toBe(204);
    expect((await ext('GET', `/meetings/${m.body.id}`, rw)).status).toBe(404);
    expect((await ext('DELETE', `/meetings/${m.body.id}`, rw)).status).toBe(404);
    const f = await ext('POST', '/meetings', rw, { title: title('del-files') });
    await owner.query(
      `INSERT INTO meeting_files (org_id, meeting_id, uploader_id, name, size_bytes, mime, sha256, object_key, wrapped_key)
       VALUES ($1, $2, $3, 'a.txt', 1, 'text/plain', repeat('a', 64), 'k', 'w')`,
      [adminA.orgId, f.body.id, adminA.userId],
    );
    expect((await ext('DELETE', `/meetings/${f.body.id}`, rw)).status).toBe(409);
    expect((await ext('GET', `/meetings/${f.body.id}`, rw)).status).toBe(200);
    const a = await owner.query("SELECT 1 FROM audit_log WHERE org_id = $1 AND action = 'ext.meeting.delete' AND target LIKE $2", [adminA.orgId, `${m.body.code}%`]);
    expect(a.rowCount).toBe(1);
  });

  it('lists the users of the key organization only, paginated', async () => {
    const r = await ext('GET', '/users?limit=100', rw);
    expect(r.status).toBe(200);
    const emails = r.body.items.map((u: { email: string }) => u.email);
    expect(emails).toContain('ea-admin@t.local');
    expect(emails).toContain(memberA.email);
    expect(emails).not.toContain(adminB.email);
    expect(Object.keys(r.body.items[0]).sort()).toEqual(['createdAt', 'disabled', 'displayName', 'email', 'id', 'role']);
    const p1 = await ext('GET', '/users?limit=1', rw);
    expect(p1.body.items).toHaveLength(1);
    expect(p1.body.next).toBeTruthy();
    const p2 = await ext('GET', `/users?limit=1&cursor=${encodeURIComponent(p1.body.next)}`, rw);
    expect(p2.body.items[0].id).not.toBe(p1.body.items[0].id);
  });

  it('answers 429 with Retry-After when a key exceeds its per-minute limit (counted in the database)', async () => {
    const k = (await newKey(adminA, ['meetings:read'], 'limited')).secret;
    const fresh = (await newKey(adminA, ['meetings:read'], 'fresh')).secret;
    const prev = extCfg.EXT_API_RATE_PER_MINUTE;
    extCfg.EXT_API_RATE_PER_MINUTE = 4;
    try {
      let limited: CallResult | null = null;
      for (let i = 0; i < 9 && !limited; i++) {
        const r = await ext('GET', '/meetings?limit=1', k);
        if (r.status === 429) limited = r;
        else expect(r.status).toBe(200);
      }
      expect(limited, 'expected a 429 within 9 requests').not.toBeNull();
      const wait = Number(limited!.headers.get('retry-after'));
      expect(wait).toBeGreaterThanOrEqual(1);
      expect(wait).toBeLessThanOrEqual(60);
      expect((await ext('GET', '/meetings?limit=1', fresh)).status).toBe(200); // another key is unaffected
    } finally {
      extCfg.EXT_API_RATE_PER_MINUTE = prev;
    }
    const rows = await owner.query('SELECT sum(hits)::int AS n FROM ext_rate_limits WHERE key_id = (SELECT id FROM api_keys WHERE org_id = $1 AND name = $2)', [adminA.orgId, 'limited']);
    expect(rows.rows[0].n).toBeGreaterThanOrEqual(5);
  });

  it('ext_api_prune removes expired idempotency records and old rate windows', async () => {
    const k = await owner.query('SELECT id FROM api_keys WHERE org_id = $1 LIMIT 1', [adminA.orgId]);
    await owner.query("INSERT INTO ext_idempotency (key_id, idem_key, org_id, request_hash, response, created_at) VALUES ($1, 'old', $2, 'h', '{}', now() - interval '25 hours')", [k.rows[0].id, adminA.orgId]);
    await owner.query("INSERT INTO ext_rate_limits (key_id, window_start, org_id, hits) VALUES ($1, now() - interval '3 hours', $2, 1)", [k.rows[0].id, adminA.orgId]);
    await pool.query('SELECT ext_api_prune()');
    expect((await owner.query("SELECT 1 FROM ext_idempotency WHERE idem_key = 'old'")).rowCount).toBe(0);
    expect((await owner.query("SELECT 1 FROM ext_rate_limits WHERE window_start < now() - interval '2 hours'")).rowCount).toBe(0);
  });
});

describe('D2 OpenAPI document', () => {
  const norm = (p: string) => p.replace(/:([A-Za-z]+)/g, '{$1}');
  function realRoutes(): string[] {
    const out: string[] = [];
    const controllers: Array<new (...a: never[]) => unknown> = Reflect.getMetadata('controllers', TestModule);
    for (const ctl of controllers) {
      const prefix = Reflect.getMetadata(PATH_METADATA, ctl) as string;
      if (!prefix.startsWith('v1/ext/') && prefix !== 'v1/ext') continue;
      for (const name of Object.getOwnPropertyNames(ctl.prototype)) {
        const fn = (ctl.prototype as Record<string, unknown>)[name];
        if (typeof fn !== 'function' || name === 'constructor') continue;
        const method = Reflect.getMetadata(METHOD_METADATA, fn) as RequestMethod | undefined;
        if (method === undefined) continue;
        const sub = (Reflect.getMetadata(PATH_METADATA, fn) as string | undefined) ?? '';
        out.push(`${RequestMethod[method]!.toLowerCase()} ${norm('/' + [prefix, sub].filter((x) => x && x !== '/').join('/'))}`);
      }
    }
    return out.sort();
  }

  it('is served without authentication and lists every /v1/ext route and no other', async () => {
    const r = await call('GET', '/v1/ext/openapi.json', null);
    expect(r.status).toBe(200);
    expect(r.body.openapi).toMatch(/^3\.1/);
    const documented: string[] = [];
    for (const [path, ops] of Object.entries(r.body.paths as Record<string, Record<string, unknown>>)) {
      for (const m of Object.keys(ops)) documented.push(`${m} ${path}`);
    }
    expect(realRoutes().length).toBeGreaterThanOrEqual(6);
    expect(documented.sort()).toEqual(realRoutes());
    expect(documented.every((d) => d.split(' ')[1]!.startsWith('/v1/ext/'))).toBe(true);
    expect(documented.some((d) => d.includes('/v1/admin') || d.includes('webhook'))).toBe(false);
  });

  it('describes security, scopes, the strict request body and the idempotency header', async () => {
    const doc = (await call('GET', '/v1/ext/openapi.json', null)).body;
    expect(doc.components.securitySchemes.apiKey).toMatchObject({ type: 'http', scheme: 'bearer' });
    const post = doc.paths['/v1/ext/meetings'].post;
    expect(post['x-required-scope']).toBe('meetings:write');
    expect(post.security).toEqual([{ apiKey: [] }]);
    expect(post.requestBody.content['application/json'].schema.additionalProperties).toBe(false);
    expect(post.parameters.some((p: { name: string; in: string }) => p.name === 'Idempotency-Key' && p.in === 'header')).toBe(true);
    expect(Object.keys(post.responses)).toEqual(expect.arrayContaining(['201', '400', '401', '403', '422', '429']));
    expect(doc.paths['/v1/ext/openapi.json'].get.security).toEqual([]);
  });

  it('buildOpenApi is deterministic', () => {
    expect(JSON.stringify(buildOpenApi())).toBe(JSON.stringify(buildOpenApi()));
    expect(createHash('sha256').update(JSON.stringify(buildOpenApi())).digest('hex')).toMatch(/^[0-9a-f]{64}$/);
  });
});
