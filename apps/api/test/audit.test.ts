import 'reflect-metadata';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Pool } from 'pg';
import { loadConfig } from '../src/config.js';
import { withTenant } from '../src/db/tenant.js';
import { AuthGuard, POOL, VERIFIER, type AuthedUser } from '../src/auth/auth.guard.js';
import type { Identity } from '../src/auth/jwt.js';
import { AUDIT, AuditAdminGuard, AuditController } from '../src/audit/audit.controller.js';
import { AuditError, AuditService, escapeLike } from '../src/audit/audit.service.js';
import { cefExt, cefHeader, cefLine, csvCell, csvLine, type AuditItem } from '../src/audit/format.js';
import { AuditForwarder, type ForwardEvent } from '../src/audit/forwarder.js';
import { signBody, verifySignature } from '../src/audit/signature.js';

const cfg = loadConfig();
const adminUrl = process.env.MIGRATE_DATABASE_URL;
if (!adminUrl) throw new Error('MIGRATE_DATABASE_URL is required for tests');
const pool = new Pool({ connectionString: cfg.DATABASE_URL, max: 12 });
const admin = new Pool({ connectionString: adminUrl, max: 3 });
const sfx = Math.random().toString(36).slice(2, 8);
const slugs: string[] = [];

async function mkUser(slug: string, sub: string, role: 'org_admin' | 'member'): Promise<AuthedUser> {
  if (!slugs.includes(slug)) slugs.push(slug);
  const email = `${sub}@t.local`;
  const r = await pool.query('SELECT org_id, user_id, role FROM provision_user($1,$2,$3,$4,$5,$6)', [slug, slug, sub, email, sub, role]);
  return { sub, email, name: sub, orgSlug: slug, role, orgId: r.rows[0].org_id, userId: r.rows[0].user_id };
}

function put(user: AuthedUser, action: string, target: string | null, actor: string | null = user.userId) {
  return withTenant(pool, user.orgId, (c) => c.query('INSERT INTO audit_log (org_id, actor_id, action, target) VALUES ($1,$2,$3,$4) RETURNING id', [user.orgId, actor, action, target]));
}

/** Minimal RFC 4180 parser for the tests. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else q = false;
      } else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

// ---------- HTTP harness: the real controller, guards and service with a stub token verifier ----------
const tokens = new Map<string, Identity>();
@Module({
  controllers: [AuditController],
  providers: [
    { provide: POOL, useValue: pool },
    { provide: VERIFIER, useValue: async (t: string) => { const i = tokens.get(t); if (!i) throw new Error('bad token'); return i; } },
    { provide: AUDIT, useFactory: () => new AuditService(pool, cfg.LIVEKIT_API_SECRET) },
    AuthGuard,
    AuditAdminGuard,
  ],
})
class TestModule {}

let app: INestApplication;
let base = '';
function api(path: string, who: Identity | null) {
  const token = who ? `${who.orgSlug}:${who.sub}` : null;
  if (who) tokens.set(token!, who);
  return fetch(base + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
}
const ident = (u: AuthedUser): Identity => ({ sub: u.sub, email: u.email, name: u.name, orgSlug: u.orgSlug, role: u.role });

const slugA = `au-a-${sfx}`;
const slugB = `au-b-${sfx}`;
let adminA: AuthedUser, memberA: AuthedUser, adminB: AuthedUser;
const aIds: string[] = []; // every audit row id of org A created by the seed, newest last

beforeAll(async () => {
  adminA = await mkUser(slugA, `adm-${sfx}`, 'org_admin');
  memberA = await mkUser(slugA, `mem-${sfx}`, 'member');
  adminB = await mkUser(slugB, `admb-${sfx}`, 'org_admin');
  app = await NestFactory.create(TestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${((app.getHttpServer() as Server).address() as AddressInfo).port}`;

  // Seed org A in several transactions so created_at differs between groups.
  const plan: Array<[string, string | null]> = [];
  for (let i = 0; i < 40; i++) plan.push([i % 2 ? 'meeting.create' : 'meeting.lock', `code${i}`]);
  for (let i = 0; i < 30; i++) plan.push(['file.upload', `code${i}:file${i}`]);
  plan.push(['weird_%name', 'x'], ['a.b', 'tgt-50%_done'], ['a.b', 'tgt-50xxdone'], ['a.b', null], ['literal*star', 'x']);
  for (let g = 0; g < plan.length; g += 25) {
    await withTenant(pool, adminA.orgId, async (c) => {
      for (const [action, target] of plan.slice(g, g + 25)) {
        const r = await c.query('INSERT INTO audit_log (org_id, actor_id, action, target) VALUES ($1,$2,$3,$4) RETURNING id', [adminA.orgId, g % 2 ? memberA.userId : adminA.userId, action, target]);
        aIds.push(r.rows[0].id);
      }
    });
    await new Promise((r) => setTimeout(r, 5));
  }
  await put(adminB, 'secret.b.action', 'B-ONLY-MARKER');
});
afterAll(async () => {
  await app.close();
  await admin.query('DELETE FROM organizations WHERE slug = ANY($1)', [slugs]);
  await pool.end();
  await admin.end();
});

describe('GET /v1/admin/audit', () => {
  it('paginates completely and strictly newest-first with no duplicates or gaps', async () => {
    const seen: Array<{ id: string; at: string }> = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await api(`/v1/admin/audit?limit=7${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, ident(adminA));
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const body = (await res.json()) as { items: Array<{ id: string; at: string; actorId: string | null; actorEmail: string | null; action: string; target: string | null }>; next: string | null };
      expect(body.items.length).toBeLessThanOrEqual(7);
      for (const it of body.items) {
        expect(Object.keys(it).sort()).toEqual(['action', 'actorEmail', 'actorId', 'at', 'id', 'target']);
        expect(typeof it.id).toBe('string');
        expect(Number.isNaN(Date.parse(it.at))).toBe(false);
      }
      seen.push(...body.items);
      cursor = body.next;
      pages++;
    } while (cursor && pages < 100);
    const expected = await admin.query("SELECT id::text FROM audit_log WHERE org_id = $1 ORDER BY created_at DESC, audit_log.id DESC", [adminA.orgId]);
    expect(seen.map((s) => s.id)).toEqual(expected.rows.map((r) => r.id));
    expect(new Set(seen.map((s) => s.id)).size).toBe(seen.length);
    for (let i = 1; i < seen.length; i++) expect(seen[i - 1]!.at >= seen[i]!.at).toBe(true);
    expect(seen.length).toBeGreaterThanOrEqual(aIds.length);
  });

  it('returns the actor email and defaults to 50 items', async () => {
    const body = (await (await api('/v1/admin/audit', ident(adminA))).json()) as { items: Array<{ actorEmail: string | null }>; next: string | null };
    expect(body.items).toHaveLength(50);
    expect(body.next).not.toBeNull();
    expect(body.items.some((i) => i.actorEmail === adminA.email)).toBe(true);
  });

  it.each(['0', '201', 'abc', '-1', '1.5', '', '99999'])('rejects limit=%s unless empty', async (l) => {
    const res = await api(`/v1/admin/audit?limit=${l}`, ident(adminA));
    expect(res.status).toBe(l === '' ? 200 : 400);
  });

  const items = async (qs: string) => {
    const out: AuditItem[] = [];
    let cursor: string | null = null;
    do {
      const res = await api(`/v1/admin/audit?limit=200&${qs}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, ident(adminA));
      expect(res.status).toBe(200);
      const b = (await res.json()) as { items: AuditItem[]; next: string | null };
      out.push(...b.items);
      cursor = b.next;
    } while (cursor);
    return out;
  };

  it('filters by exact action and by prefix with a trailing *', async () => {
    expect((await items('action=file.upload')).every((i) => i.action === 'file.upload')).toBe(true);
    expect((await items('action=file.upload')).length).toBe(30);
    const m = await items('action=meeting.*');
    expect(m).toHaveLength(40);
    expect(m.every((i) => i.action.startsWith('meeting.'))).toBe(true);
    expect(await items('action=meeting')).toHaveLength(0); // exact match only without *
  });

  it('treats LIKE wildcards literally in action, actor and target filters', async () => {
    expect(await items(`action=${encodeURIComponent('%*')}`)).toHaveLength(0);
    expect((await items(`action=${encodeURIComponent('weird_%*')}`)).map((i) => i.action)).toEqual(['weird_%name']);
    expect(await items(`action=${encodeURIComponent('weirdX%*')}`)).toHaveLength(0);
    expect((await items(`target=${encodeURIComponent('50%_done')}`)).map((i) => i.target)).toEqual(['tgt-50%_done']);
    expect(await items(`target=${encodeURIComponent('%')}`)).toHaveLength(1);
    expect((await items(`target=${encodeURIComponent('_')}`)).every((i) => (i.target ?? '').includes('_'))).toBe(true);
    expect(await items(`actor=${encodeURIComponent('%')}`)).toHaveLength(0);
  });

  it('rejects * anywhere but the end of action', async () => {
    expect((await api(`/v1/admin/audit?action=${encodeURIComponent('literal*star')}`, ident(adminA))).status).toBe(400);
    expect((await api(`/v1/admin/audit?action=${encodeURIComponent('*x')}`, ident(adminA))).status).toBe(400);
  });

  it('filters by actor email substring (case-insensitive) and by actor uuid', async () => {
    const byMail = await items(`actor=${encodeURIComponent(memberA.email.slice(1, 9).toUpperCase())}`);
    expect(byMail.length).toBeGreaterThan(0);
    expect(byMail.every((i) => i.actorEmail === memberA.email)).toBe(true);
    const byId = await items(`actor=${memberA.userId}`);
    expect(byId.map((i) => i.id).sort()).toEqual(byMail.map((i) => i.id).sort());
    expect((await items(`actor=${adminA.userId}`)).every((i) => i.actorId === adminA.userId)).toBe(true);
  });

  it('filters by target substring and by time range (inclusive) and validates timestamps', async () => {
    expect((await items('target=file1')).every((i) => (i.target ?? '').includes('file1'))).toBe(true);
    const all = await items('');
    const mid = all[Math.floor(all.length / 2)]!.at;
    const newer = await items(`from=${encodeURIComponent(mid)}`);
    const older = await items(`to=${encodeURIComponent(mid)}`);
    expect(newer.every((i) => i.at >= mid)).toBe(true);
    expect(older.every((i) => i.at <= mid)).toBe(true);
    expect(newer.length + older.length).toBeGreaterThanOrEqual(all.length); // the boundary instant is in both
    expect(await items('from=2999-01-01')).toHaveLength(0);
    for (const bad of ['from=yesterday', 'from=2026-02-31', 'to=2026-13-01T00:00:00Z', 'from=2026-11-23T10:00:00', 'from=2026-12-01&to=2026-01-01', 'from=1&from=2']) {
      expect((await api(`/v1/admin/audit?${bad}`, ident(adminA))).status, bad).toBe(400);
    }
  });

  it('rejects any tampered, foreign or malformed cursor with 400', async () => {
    const first = (await (await api('/v1/admin/audit?limit=5', ident(adminA))).json()) as { next: string };
    expect((await api(`/v1/admin/audit?limit=5&cursor=${encodeURIComponent(first.next)}`, ident(adminA))).status).toBe(200);
    const [b, m] = first.next.split('.') as [string, string];
    const flip = (s: string) => (s.startsWith('A') ? 'B' : 'A') + s.slice(1);
    const forged = Buffer.from(Buffer.from(b, 'base64url').toString().replace(/\|\d+$/, '|1')).toString('base64url');
    for (const c of [flip(b) + '.' + m, b + '.' + flip(m), forged + '.' + m, b, '.', 'x.y.z', 'a'.repeat(400), '%00']) {
      expect((await api(`/v1/admin/audit?cursor=${encodeURIComponent(c)}`, ident(adminA))).status, c.slice(0, 30)).toBe(400);
    }
    // a valid cursor of another organization does not work here either
    await put(adminB, 'b.x', null);
    await put(adminB, 'b.y', null);
    const other = (await (await api('/v1/admin/audit?limit=1', ident(adminB))).json()) as { next: string };
    expect(other.next).toBeTruthy();
    expect((await api(`/v1/admin/audit?cursor=${encodeURIComponent(other.next)}`, ident(adminA))).status).toBe(400);
  });

  it('is closed to members (403) and anonymous callers (401) on every route', async () => {
    for (const p of ['/v1/admin/audit', '/v1/admin/audit/export?format=csv', '/v1/admin/audit/verify']) {
      expect((await api(p, ident(memberA))).status, p).toBe(403);
      expect((await api(p, null)).status, p).toBe(401);
    }
  });

  it('isolates organizations: B sees none of A and cannot export it', async () => {
    const b = (await (await api('/v1/admin/audit?limit=200', ident(adminB))).json()) as { items: AuditItem[] };
    expect(b.items.length).toBeGreaterThan(0);
    expect(b.items.some((i) => aIds.includes(i.id))).toBe(false);
    expect(b.items.every((i) => i.actorEmail === null || i.actorEmail === adminB.email)).toBe(true);
    const exp = await (await api('/v1/admin/audit/export?format=json', ident(adminB))).text();
    expect(exp).toContain('B-ONLY-MARKER');
    expect(exp).not.toContain('file.upload');
    expect(exp).not.toContain(adminA.email);
    expect(aIds.some((id) => new RegExp(`"id":"${id}"`).test(exp))).toBe(false);
    const a = (await (await api(`/v1/admin/audit?limit=200&target=${encodeURIComponent('B-ONLY')}`, ident(adminA))).json()) as { items: unknown[] };
    expect(a.items).toHaveLength(0);
  });
});

describe('GET /v1/admin/audit/export', () => {
  it('streams a download with attachment, nosniff and no-store headers in all three formats', async () => {
    for (const [fmt, ct, ext] of [['csv', 'text/csv', 'csv'], ['json', 'application/x-ndjson', 'jsonl'], ['cef', 'text/plain', 'cef']] as const) {
      const res = await api(`/v1/admin/audit/export?format=${fmt}&action=meeting.*`, ident(adminA));
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain(ct);
      expect(res.headers.get('content-disposition')).toMatch(new RegExp(`^attachment; filename="audit-[0-9TZ]+\\.${ext}"$`));
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('cache-control')).toBe('no-store');
      const text = await res.text();
      if (fmt === 'csv') {
        const rows = parseCsv(text);
        expect(rows[0]).toEqual(['id', 'at', 'actor_id', 'actor_email', 'action', 'target']);
        expect(rows).toHaveLength(41);
        expect(text.endsWith('\r\n')).toBe(true);
      } else if (fmt === 'json') {
        const lines = text.trim().split('\n').map((l) => JSON.parse(l) as AuditItem);
        expect(lines).toHaveLength(40);
        expect(lines.every((l) => l.action.startsWith('meeting.'))).toBe(true);
      } else {
        const lines = text.trim().split('\n');
        expect(lines).toHaveLength(40);
        expect(lines.every((l) => l.startsWith('CEF:0|DavraBox|Platform|1.0|meeting.') && l.includes('|3|rt='))).toBe(true);
      }
    }
  });

  it('rejects an unknown format and bad filters', async () => {
    for (const q of ['format=xml', '', 'format=csv&from=nope', 'format=csv&action=a*b', 'format=csv&format=json']) {
      expect((await api(`/v1/admin/audit/export?${q}`, ident(adminA))).status, q).toBe(400);
    }
  });

  it('writes an audit.export row that records format and filters but no exported data', async () => {
    const before = await admin.query("SELECT count(*)::int AS n FROM audit_log WHERE org_id = $1 AND action = 'audit.export'", [adminA.orgId]);
    const res = await api('/v1/admin/audit/export?format=csv&action=file.*&from=2000-01-01', ident(adminA));
    await res.text();
    const rows = await admin.query("SELECT actor_id, target FROM audit_log WHERE org_id = $1 AND action = 'audit.export' ORDER BY id DESC", [adminA.orgId]);
    expect(rows.rows.length).toBe(before.rows[0].n + 1);
    expect(rows.rows[0].actor_id).toBe(adminA.userId);
    expect(rows.rows[0].target).toContain('format=csv');
    expect(rows.rows[0].target).toContain('action=file.*');
    expect(rows.rows[0].target).toContain('from=2000-01-01T00:00:00.000Z');
    expect(rows.rows[0].target).not.toContain('code1:file1');
  });

  it('exports exactly the same rows as pagination, across many chunks, without duplicates', async () => {
    const svc = new AuditService(pool, cfg.LIVEKIT_API_SECRET, { exportChunk: 3, exportsPerMinute: 100 });
    const out = await svc.export(adminA, 'json', {});
    let text = '';
    for await (const part of out.stream) text += part;
    const ids = text.trim().split('\n').map((l) => (JSON.parse(l) as AuditItem).id);
    const expected = await admin.query("SELECT id::text FROM audit_log WHERE org_id = $1 AND id <= $2 ORDER BY created_at DESC, audit_log.id DESC", [adminA.orgId, ids.reduce((m, x) => (BigInt(x) > BigInt(m) ? x : m), '0')]);
    expect(ids).toEqual(expected.rows.map((r) => r.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('refuses with 413 above the row cap, with a clear message, and allows it when filters narrow it', async () => {
    const svc = new AuditService(pool, cfg.LIVEKIT_API_SECRET, { exportCap: 5, exportsPerMinute: 100 });
    const err = (await svc.export(adminA, 'csv', {}).catch((e) => e)) as AuditError;
    expect(err).toBeInstanceOf(AuditError);
    expect(err.status).toBe(413);
    expect(err.message).toMatch(/5 rows.*narrow/);
    const before = await admin.query("SELECT count(*)::int AS n FROM audit_log WHERE org_id = $1 AND action = 'audit.export'", [adminA.orgId]);
    await svc.export(adminA, 'csv', {}).catch(() => undefined);
    const after = await admin.query("SELECT count(*)::int AS n FROM audit_log WHERE org_id = $1 AND action = 'audit.export'", [adminA.orgId]);
    expect(after.rows[0].n).toBe(before.rows[0].n); // a refused export is not recorded as an export
    const ok = await svc.export(adminA, 'csv', { action: 'literal*star'.replace('*', '') });
    expect(ok.contentType).toContain('csv');
  });

  it('limits exports per user (5 per minute by default) with 429 and Retry-After, per user not globally', async () => {
    const u = await mkUser(slugA, `rl-${sfx}`, 'org_admin');
    for (let i = 0; i < 5; i++) {
      const res = await api('/v1/admin/audit/export?format=json&action=nothing.here', ident(u));
      expect(res.status).toBe(200);
      await res.text();
    }
    const blocked = await api('/v1/admin/audit/export?format=json&action=nothing.here', ident(u));
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    const other = await api('/v1/admin/audit/export?format=json&action=nothing.here', ident(adminA));
    expect(other.status).toBe(200);
    await other.text();
  });

  it('rate limit window slides (injected clock)', async () => {
    let t = 1_000_000;
    const svc = new AuditService(pool, cfg.LIVEKIT_API_SECRET, { exportsPerMinute: 2, now: () => t });
    await svc.export(adminA, 'csv', { action: 'x.y' });
    await svc.export(adminA, 'csv', { action: 'x.y' });
    const e = (await svc.export(adminA, 'csv', { action: 'x.y' }).catch((x) => x)) as AuditError;
    expect(e.status).toBe(429);
    t += 61_000;
    await svc.export(adminA, 'csv', { action: 'x.y' });
  });

  it('is CSV and formula-injection safe end to end', async () => {
    const org = `au-csv-${sfx}`;
    const u = await mkUser(org, `csv-${sfx}`, 'org_admin');
    const nasty = ['=cmd|"/c calc"!A1', '+1+1', '-2+3', '@SUM(A1)', '\tTAB', '\rCR', 'a,b', 'q"uote', 'multi\nline', '  =lead-space', 'plain', "'already"];
    for (const t of nasty) await put(u, 'csv.test', t);
    const text = await (await api('/v1/admin/audit/export?format=csv&action=csv.test', ident(u))).text();
    const rows = parseCsv(text).slice(1);
    const targets = rows.map((r) => r[5]!).sort();
    const expected = nasty.map((t) => (/^[=+\-@\t\r]/.test(t) ? `'${t}` : t)).sort();
    expect(targets).toEqual(expected);
    for (const r of rows) expect(/^[=+\-@\t\r]/.test(r[5]!)).toBe(false);
  });
});

describe('format helpers', () => {
  it('csvCell neutralises formula starters, quotes specials, keeps normal text', () => {
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-1')).toBe("'-1");
    expect(csvCell('@a')).toBe("'@a");
    expect(csvCell('\tx')).toBe("'\tx");
    expect(csvCell('\rx')).toBe(`"'\rx"`);
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('l1\nl2')).toBe('"l1\nl2"');
    expect(csvCell('safe-text=ok')).toBe('safe-text=ok');
    expect(csvCell(null)).toBe('');
    expect(csvCell('')).toBe('');
  });
  it('csvLine ends with CRLF', () => {
    expect(csvLine({ id: '1', at: '2026-01-01T00:00:00.000000Z', actorId: null, actorEmail: null, action: 'a', target: null })).toBe('1,2026-01-01T00:00:00.000000Z,,,a,\r\n');
  });
  it('CEF escapes pipes and backslashes in the header and = backslash newlines in the extension', () => {
    expect(cefHeader('a|b\\c\nd')).toBe('a\\|b\\\\c d');
    expect(cefExt('k=v\\x\r\ny')).toBe('k\\=v\\\\x\\r\\ny');
    const line = cefLine({ id: '9', at: '2026-01-02T03:04:05.123456Z', actorId: 'u', actorEmail: 'e@x', action: 'x|y', target: 'a=b\nc|d' });
    expect(line).toBe(`CEF:0|DavraBox|Platform|1.0|x\\|y|x\\|y|3|rt=${Date.parse('2026-01-02T03:04:05.123Z')} externalId=9 suser=e@x msg=a\\=b\\nc|d\n`);
    expect(line.split('\n')).toHaveLength(2); // one physical line
  });
  it('escapeLike escapes %, _ and backslash', () => {
    expect(escapeLike('a%b_c\\d')).toBe('a\\%b\\_c\\\\d');
  });
});

describe('integrity: hash chain', () => {
  async function mkOrg(tag: string, n: number) {
    const u = await mkUser(`au-${tag}-${sfx}`, `${tag}-${sfx}`, 'org_admin');
    const ids: string[] = [];
    for (let i = 0; i < n; i++) ids.push((await put(u, 'chain.test', `t${i}`)).rows[0].id);
    return { u, ids };
  }
  const verifyOf = (u: AuthedUser) => new AuditService(pool, cfg.LIVEKIT_API_SECRET).verify(u);

  it('stays valid after 50 parallel inserts into one organization', async () => {
    const u = await mkUser(`au-par-${sfx}`, `par-${sfx}`, 'org_admin');
    await Promise.all(Array.from({ length: 50 }, (_, i) => put(u, 'par.test', `p${i}`)));
    expect(await verifyOf(u)).toEqual({ ok: true, checked: 50, firstBrokenId: null });
    const seqs = await admin.query('SELECT chain_seq::int AS s FROM audit_log WHERE org_id = $1 ORDER BY chain_seq', [u.orgId]);
    expect(seqs.rows.map((r) => r.s)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    const prev = await admin.query('SELECT count(*)::int AS n FROM audit_log a JOIN audit_log b ON b.org_id = a.org_id AND b.chain_seq = a.chain_seq + 1 WHERE a.org_id = $1 AND b.prev_hash = a.row_hash', [u.orgId]);
    expect(prev.rows[0].n).toBe(49);
    const via = (await (await api('/v1/admin/audit/verify', ident(u))).json()) as { ok: boolean; checked: number; firstBrokenId: string | null };
    expect(via).toEqual({ ok: true, checked: 50, firstBrokenId: null });
  });

  it('chains independently per organization and ignores client-supplied chain columns', async () => {
    const a = await mkOrg('c1', 3);
    const b = await mkOrg('c2', 2);
    await withTenant(pool, a.u.orgId, (c) => c.query("INSERT INTO audit_log (org_id, actor_id, action, chain_seq, prev_hash, row_hash, txid) VALUES ($1,$2,'forged',999,'\\x00','\\x01',1)", [a.u.orgId, a.u.userId]));
    expect(await verifyOf(a.u)).toEqual({ ok: true, checked: 4, firstBrokenId: null });
    expect(await verifyOf(b.u)).toEqual({ ok: true, checked: 2, firstBrokenId: null });
  });

  it('detects a modified row (content changed)', async () => {
    const { u, ids } = await mkOrg('t1', 6);
    await admin.query("UPDATE audit_log SET target = 'changed' WHERE id = $1", [ids[2]]);
    expect(await verifyOf(u)).toEqual({ ok: false, checked: 3, firstBrokenId: ids[2] });
    await admin.query("UPDATE audit_log SET target = 't2' WHERE id = $1", [ids[2]]);
    expect((await verifyOf(u)).ok).toBe(true);
  });

  it('detects a modified row whose own hash was recomputed (the next link breaks)', async () => {
    const { u, ids } = await mkOrg('t2', 6);
    await admin.query("UPDATE audit_log SET action = 'edited', row_hash = audit_row_hash(prev_hash, chain_seq, id, org_id, actor_id, 'edited', target, created_at) WHERE id = $1", [ids[1]]);
    expect(await verifyOf(u)).toEqual({ ok: false, checked: 3, firstBrokenId: ids[2] });
  });

  it('detects a deleted row in the middle and deletion of the newest rows', async () => {
    const m = await mkOrg('t3', 6);
    await admin.query('DELETE FROM audit_log WHERE id = $1', [m.ids[3]]);
    expect(await verifyOf(m.u)).toEqual({ ok: false, checked: 4, firstBrokenId: m.ids[4] });
    const t = await mkOrg('t4', 6);
    await admin.query('DELETE FROM audit_log WHERE id = ANY($1)', [t.ids.slice(-2)]);
    expect(await verifyOf(t.u)).toEqual({ ok: false, checked: 4, firstBrokenId: null });
    const e = await mkOrg('t5', 3);
    await admin.query('DELETE FROM audit_log WHERE org_id = $1', [e.u.orgId]);
    expect(await verifyOf(e.u)).toEqual({ ok: false, checked: 0, firstBrokenId: null });
  });

  it('detects a changed timestamp, actor, and a swapped prev_hash', async () => {
    for (const [tag, set] of [
      ['t6', "created_at = created_at + interval '1 second'"],
      ['t7', 'actor_id = NULL'],
      ['t8', "prev_hash = decode(repeat('ab', 32), 'hex')"],
    ] as const) {
      const { u, ids } = await mkOrg(tag, 4);
      await admin.query(`UPDATE audit_log SET ${set} WHERE id = $1`, [ids[1]]);
      expect(await verifyOf(u), tag).toEqual({ ok: false, checked: 2, firstBrokenId: ids[1] });
    }
  });

  it('keeps the app role append-only and without a path around row-level security', async () => {
    const u = await mkUser(`au-priv-${sfx}`, `priv-${sfx}`, 'org_admin');
    const r = await put(u, 'priv.test', null);
    const id = r.rows[0].id;
    await expect(withTenant(pool, u.orgId, (c) => c.query("UPDATE audit_log SET target = 'x' WHERE id = $1", [id]))).rejects.toThrow(/permission denied/);
    await expect(withTenant(pool, u.orgId, (c) => c.query('DELETE FROM audit_log WHERE id = $1', [id]))).rejects.toThrow(/permission denied/);
    await expect(pool.query('SELECT * FROM audit_forward_state')).rejects.toThrow(/permission denied/);
    await expect(pool.query('UPDATE audit_chain_head SET last_seq = 0')).rejects.toThrow(/permission denied/);
    expect((await pool.query('SELECT count(*)::int AS n FROM audit_log')).rows[0].n).toBe(0); // no tenant set: sees nothing
    const flags = await admin.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'davra_app'");
    expect(flags.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    // inside a tenant the cross-tenant function is the only way to see other organizations, and it is not a table read
    const viaFn = await pool.query('SELECT count(*)::int AS n FROM audit_forward_batch(0, 0, 1)');
    expect(viaFn.rows[0].n).toBeLessThanOrEqual(1);
  });
});

describe('signature helper', () => {
  const secret = 's3cret-s3cret-s3cret';
  it('verifies a correct signature and rejects every kind of wrong input', () => {
    const body = JSON.stringify({ events: [{ id: '1' }] });
    const sig = signBody(body, secret);
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifySignature(body, sig, secret)).toBe(true);
    expect(verifySignature(Buffer.from(body), sig, secret)).toBe(true);
    expect(verifySignature(body + ' ', sig, secret)).toBe(false);
    expect(verifySignature(body, sig, secret + 'x')).toBe(false);
    expect(verifySignature(body, undefined, secret)).toBe(false);
    expect(verifySignature(body, sig.toUpperCase(), secret)).toBe(false);
    expect(verifySignature(body, sig.slice(0, -2), secret)).toBe(false);
    expect(verifySignature(body, 'sha256=' + 'z'.repeat(64), secret)).toBe(false);
  });
});

describe('config for forwarding', () => {
  const base = { ...process.env };
  const tryLoad = (extra: Record<string, string | undefined>) => () => loadConfig({ ...base, AUDIT_WEBHOOK_URL: undefined, AUDIT_WEBHOOK_SECRET: undefined, ...extra });
  it('is off by default', () => {
    const c = tryLoad({})();
    expect(c.AUDIT_WEBHOOK_URL).toBeUndefined();
    expect(c.AUDIT_FORWARD_INTERVAL_MS).toBe(5000);
  });
  it('accepts https, and http only for localhost', () => {
    expect(tryLoad({ AUDIT_WEBHOOK_URL: 'https://siem.example.com/hook', AUDIT_WEBHOOK_SECRET: 'x'.repeat(20) })).not.toThrow();
    expect(tryLoad({ AUDIT_WEBHOOK_URL: 'http://127.0.0.1:9999/hook', AUDIT_WEBHOOK_SECRET: 'x'.repeat(20) })).not.toThrow();
    expect(tryLoad({ AUDIT_WEBHOOK_URL: 'http://localhost:9999/hook', AUDIT_WEBHOOK_SECRET: 'x'.repeat(20) })).not.toThrow();
    expect(tryLoad({ AUDIT_WEBHOOK_URL: 'http://siem.example.com/hook', AUDIT_WEBHOOK_SECRET: 'x'.repeat(20) })).toThrow(/AUDIT_WEBHOOK_URL/);
    expect(tryLoad({ AUDIT_WEBHOOK_URL: 'http://localhost.evil.com/hook', AUDIT_WEBHOOK_SECRET: 'x'.repeat(20) })).toThrow(/AUDIT_WEBHOOK_URL/);
    expect(tryLoad({ AUDIT_WEBHOOK_URL: 'ftp://x/y', AUDIT_WEBHOOK_SECRET: 'x'.repeat(20) })).toThrow();
  });
  it('requires a secret when a URL is set', () => {
    expect(tryLoad({ AUDIT_WEBHOOK_URL: 'https://siem.example.com/hook' })).toThrow(/AUDIT_WEBHOOK_SECRET/);
    expect(tryLoad({ AUDIT_WEBHOOK_URL: 'https://siem.example.com/hook', AUDIT_WEBHOOK_SECRET: 'short' })).toThrow(/AUDIT_WEBHOOK_SECRET/);
  });
});

describe('SIEM forwarding', () => {
  const secret = 'forward-secret-0123456789';
  interface Hit { body: string; headers: IncomingHttpHeaders; events: ForwardEvent[] }
  let srv: Server;
  let url = '';
  const hits: Hit[] = [];
  let failNext = 0;

  beforeAll(async () => {
    srv = createServer((req, res) => {
      const parts: Buffer[] = [];
      req.on('data', (d: Buffer) => parts.push(d));
      req.on('end', () => {
        const body = Buffer.concat(parts).toString('utf8');
        hits.push({ body, headers: req.headers, events: (JSON.parse(body) as { events: ForwardEvent[] }).events });
        if (failNext > 0) {
          failNext--;
          res.statusCode = 503;
        } else res.statusCode = 200;
        res.end('x');
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/hook`;
  });
  afterAll(() => new Promise<void>((r) => srv.close(() => r())));

  async function cursorToNow() {
    await admin.query(`UPDATE audit_forward_state SET (last_txid, last_id) = (SELECT coalesce((SELECT txid FROM audit_log ORDER BY txid DESC, id DESC LIMIT 1), 0), coalesce((SELECT id FROM audit_log ORDER BY txid DESC, id DESC LIMIT 1), 0))`);
  }
  const mine = (ids: Set<string>) => hits.flatMap((h) => h.events).filter((e) => ids.has(e.id));
  async function drain(f: AuditForwarder, want: Set<string>, times = 1, ms = 20_000) {
    const end = Date.now() + ms;
    for (;;) {
      const got = mine(want);
      const got1 = new Set(got.map((e) => e.id));
      if ([...want].every((id) => got.filter((e) => e.id === id).length >= times)) return;
      if (Date.now() > end) throw new Error(`timeout: delivered ${got1.size}/${want.size}`);
      try {
        await f.tick();
      } catch {
        /* retried by the loop of the test */
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  it('delivers new rows of all organizations, signed, with the right orgSlug and no cross-tenant mix-up', async () => {
    await cursorToNow();
    hits.length = 0;
    const idsA = new Set<string>();
    const idsB = new Set<string>();
    for (let i = 0; i < 4; i++) idsA.add((await put(adminA, 'fwd.a', `a${i}`)).rows[0].id);
    for (let i = 0; i < 3; i++) idsB.add((await put(adminB, 'fwd.b', `b${i}`)).rows[0].id);
    const f = new AuditForwarder(pool, { url, secret, batchSize: 3 });
    await drain(f, new Set([...idsA, ...idsB]));
    for (const h of hits) {
      expect(verifySignature(h.body, h.headers['x-davrabox-signature'] as string, secret)).toBe(true);
      expect(h.headers['x-davrabox-delivery']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(h.headers['content-type']).toBe('application/json');
      expect(h.events.length).toBeLessThanOrEqual(3);
    }
    expect(verifySignature(hits[0]!.body, hits[0]!.headers['x-davrabox-signature'] as string, 'wrong-secret-0123456789')).toBe(false);
    for (const e of mine(idsA)) {
      expect(e.orgSlug).toBe(slugA);
      expect(e.action).toBe('fwd.a');
      expect(e.actorEmail).toBe(adminA.email);
      expect(Object.keys(e).sort()).toEqual(['action', 'actorEmail', 'at', 'hash', 'id', 'orgSlug', 'target']);
    }
    for (const e of mine(idsB)) expect(e.orgSlug).toBe(slugB);
    expect(mine(idsA).some((e) => e.target?.startsWith('b'))).toBe(false);
    // hash equals the stored chain hash, so a receiver can anchor the chain externally
    const row = await admin.query("SELECT encode(row_hash,'hex') AS h FROM audit_log WHERE id = $1", [[...idsA][0]]);
    expect(mine(idsA).find((e) => e.id === [...idsA][0])!.hash).toBe(row.rows[0].h);
    // delivered in id order within an organization
    const aOrder = mine(idsA).map((e) => Number(e.id));
    expect(aOrder).toEqual([...aOrder].sort((x, y) => x - y));
  });

  it('retries after a failing endpoint without moving the cursor, then resumes after a restart without re-sending', async () => {
    await cursorToNow();
    hits.length = 0;
    const ids = new Set<string>();
    for (let i = 0; i < 5; i++) ids.add((await put(adminA, 'fwd.retry', `r${i}`)).rows[0].id);
    const f1 = new AuditForwarder(pool, { url, secret, batchSize: 500, log: () => undefined });
    const state = async () => (await admin.query('SELECT last_txid::text, last_id::text FROM audit_forward_state')).rows[0];
    const s0 = await state();
    failNext = 2;
    // keep trying until it ticks through; first two answers are HTTP 503
    await expect(f1.tick()).rejects.toThrow(/HTTP 503/);
    expect(f1.consecutiveFailures).toBe(1);
    expect(await state()).toEqual(s0); // not advanced
    await expect(f1.tick()).rejects.toThrow(/HTTP 503/);
    expect(f1.consecutiveFailures).toBe(2);
    await expect(f1.tick()).resolves.toBe(5);
    expect(f1.consecutiveFailures).toBe(0);
    // the retried batches carried the same events and the same delivery id
    const failed = hits.filter((h) => h.events.some((e) => ids.has(e.id)));
    expect(failed.length).toBeGreaterThanOrEqual(3);
    expect(new Set(failed.slice(0, 3).map((h) => h.headers['x-davrabox-delivery'])).size).toBe(1);
    expect(failed[0]!.body).toBe(failed[2]!.body);
    expect(await state()).not.toEqual(s0);
    // a fresh instance (restart) resumes after the stored cursor: nothing of ours is delivered again
    const delivered = hits.length;
    const f2 = new AuditForwarder(pool, { url, secret });
    for (let i = 0; i < 3; i++) await f2.tick();
    expect(hits.slice(delivered).flatMap((h) => h.events).filter((e) => ids.has(e.id))).toHaveLength(0);
    // and a new row after the restart is delivered exactly once
    const more = new Set([(await put(adminA, 'fwd.retry', 'later')).rows[0].id]);
    await drain(f2, more);
    expect(mine(more)).toHaveLength(1);
  });

  it('crash between delivery and cursor advance re-sends (at least once) and never skips', async () => {
    await cursorToNow();
    hits.length = 0;
    const ids = new Set<string>();
    for (let i = 0; i < 3; i++) ids.add((await put(adminA, 'fwd.crash', `c${i}`)).rows[0].id);
    // simulate a receiver that got the batch but the process died before saving the cursor
    const f1 = new AuditForwarder(pool, { url, secret, fetchImpl: (async (u: string, init: RequestInit) => { await fetch(u, init); throw new Error('process died'); }) as typeof fetch, log: () => undefined });
    await expect(f1.tick()).rejects.toThrow(/process died/);
    const f2 = new AuditForwarder(pool, { url, secret });
    await drain(f2, ids, 2);
    for (const id of ids) expect(mine(new Set([id])).length).toBe(2);
  });

  it('never loses a row that commits behind a later, already visible transaction', async () => {
    await cursorToNow();
    hits.length = 0;
    const slow = await pool.connect();
    const slowIds: string[] = [];
    try {
      await slow.query('BEGIN');
      await slow.query("SELECT set_config('app.current_org', $1, true)", [adminA.orgId]);
      slowIds.push((await slow.query("INSERT INTO audit_log (org_id, actor_id, action, target) VALUES ($1,$2,'fwd.slow','slow') RETURNING id", [adminA.orgId, adminA.userId])).rows[0].id);
      // a later transaction commits first and gets a HIGHER id; it must not overtake the open one
      const fast = (await put(adminB, 'fwd.fast', 'fast')).rows[0].id as string;
      expect(BigInt(fast)).toBeGreaterThan(BigInt(slowIds[0]!));
      const f = new AuditForwarder(pool, { url, secret });
      for (let i = 0; i < 3; i++) await f.tick();
      expect(mine(new Set([fast, slowIds[0]!]))).toHaveLength(0);
      await slow.query('COMMIT');
      await drain(f, new Set([fast, slowIds[0]!]));
      const order = mine(new Set([fast, slowIds[0]!])).map((e) => e.id);
      expect(order).toEqual([slowIds[0], fast]);
    } finally {
      await slow.query('ROLLBACK').catch(() => undefined);
      slow.release();
    }
  });

  it('backs off exponentially up to the cap and start() does not block or throw when the database is unreachable', async () => {
    expect(AuditForwarder.backoff(0, 5000, 300_000)).toBe(5000);
    expect(AuditForwarder.backoff(1, 5000, 300_000)).toBe(5000);
    expect(AuditForwarder.backoff(2, 5000, 300_000)).toBe(10_000);
    expect(AuditForwarder.backoff(4, 5000, 300_000)).toBe(40_000);
    expect(AuditForwarder.backoff(7, 5000, 300_000)).toBe(300_000);
    expect(AuditForwarder.backoff(500, 5000, 300_000)).toBe(300_000);
    const dead = new Pool({ connectionString: 'postgres://nobody:x@127.0.0.1:1/none', connectionTimeoutMillis: 300 });
    dead.on('error', () => undefined);
    const logs: string[] = [];
    const f = new AuditForwarder(dead, { url, secret, intervalMs: 100, log: (m) => logs.push(m) });
    const t0 = Date.now();
    f.start();
    expect(Date.now() - t0).toBeLessThan(50);
    await new Promise((r) => setTimeout(r, 900));
    f.stop();
    expect(f.consecutiveFailures).toBeGreaterThanOrEqual(1);
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs.join('\n')).not.toContain(secret);
    await dead.end().catch(() => undefined);
  });
});
