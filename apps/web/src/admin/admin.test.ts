import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import { buildQuery, createAdminClient, errorDetail, filenameFromDisposition } from './client';
import {
  EMPTY_AUDIT_FORM,
  adminErrorKey,
  consumeReturnPath,
  createFlowReducer,
  fmt,
  formatTimestamp,
  localInputToIso,
  mergePage,
  parseMaxParticipants,
  rememberReturnPath,
  toAuditFilters,
  type CreateFlow,
} from './helpers';
import { decodeJwtPayload, isOrgAdmin } from './jwt';

function jwt(payload: unknown, raw = false): string {
  const b64 = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64('{"alg":"none"}')}.${raw ? b64(payload as string) : b64(JSON.stringify(payload))}.sig`;
}

describe('isOrgAdmin', () => {
  it('is true only with realm_access.roles containing org_admin', () => {
    expect(isOrgAdmin(jwt({ realm_access: { roles: ['member', 'org_admin'] } }))).toBe(true);
    expect(isOrgAdmin(jwt({ realm_access: { roles: ['member'] } }))).toBe(false);
  });
  it('is false for missing or malformed claims', () => {
    expect(isOrgAdmin(jwt({}))).toBe(false);
    expect(isOrgAdmin(jwt({ realm_access: null }))).toBe(false);
    expect(isOrgAdmin(jwt({ realm_access: { roles: 'org_admin' } }))).toBe(false);
    expect(isOrgAdmin(jwt({ realm_access: { roles: [{ x: 1 }] } }))).toBe(false);
    expect(isOrgAdmin(jwt({ roles: ['org_admin'] }))).toBe(false);
  });
  it('is false for malformed tokens', () => {
    for (const t of ['', 'abc', 'a.b', 'a.b.c.d', '..', 'a.!!!.c', jwt('not json', true), jwt('[1]', true), jwt('null', true)]) {
      expect(isOrgAdmin(t), t).toBe(false);
    }
    expect(isOrgAdmin(null)).toBe(false);
    expect(isOrgAdmin(undefined)).toBe(false);
  });
  it('decodes base64url payloads with non-ASCII text', () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ name: 'Ўзбек', realm_access: { roles: ['org_admin'] } }));
    const b64 = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(isOrgAdmin(`x.${b64}.y`)).toBe(true);
    expect(decodeJwtPayload(`x.${b64}.y`)?.['name']).toBe('Ўзбек');
  });
});

describe('buildQuery', () => {
  it('skips empty values and encodes the rest', () => {
    expect(buildQuery({})).toBe('');
    expect(buildQuery({ a: '', b: undefined, c: null })).toBe('');
    expect(buildQuery({ search: 'a b&c=d', limit: 25, cursor: 'x/y+z==' })).toBe('?search=a%20b%26c%3Dd&limit=25&cursor=x%2Fy%2Bz%3D%3D');
    expect(buildQuery({ limit: 0 })).toBe('?limit=0');
  });
});

function fakeFetch(responses: Array<{ status?: number; body?: unknown; text?: string; headers?: Record<string, string>; blob?: Blob }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let i = 0;
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = responses[Math.min(i++, responses.length - 1)]!;
    const status = r.status ?? 200;
    const text = r.text ?? (r.body === undefined ? '' : JSON.stringify(r.body));
    return new Response(r.blob ?? (status === 204 ? null : text), { status, headers: r.headers });
  });
  return { fn, calls };
}

describe('admin client', () => {
  const token = async () => 'tok';

  it('sends bearer token and JSON body, builds the users query with cursor', async () => {
    const f = fakeFetch([{ body: { items: [], next: 'n1' } }]);
    const c = createAdminClient(token, f.fn);
    const page = await c.listUsers({ search: ' ann ', limit: 20, cursor: 'c/1' });
    expect(page.next).toBe('n1');
    expect(f.calls[0]!.url).toBe('/api/v1/admin/users?search=ann&limit=20&cursor=c%2F1');
    expect((f.calls[0]!.init!.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(f.calls[0]!.init!.method).toBe('GET');
  });

  it('omits the cursor on the first page', async () => {
    const f = fakeFetch([{ body: { items: [], next: null } }]);
    await createAdminClient(token, f.fn).listUsers({ limit: 10, cursor: null });
    expect(f.calls[0]!.url).toBe('/api/v1/admin/users?limit=10');
  });

  it('POST create user and PATCH with encoded id', async () => {
    const f = fakeFetch([{ status: 201, body: { user: { id: 'u' }, temporaryPassword: 'pw' } }, { body: { id: 'a/b' } }]);
    const c = createAdminClient(token, f.fn);
    const r = await c.createUser({ email: 'a@b.c', firstName: 'A', lastName: 'B', role: 'member' });
    expect(r.temporaryPassword).toBe('pw');
    expect(JSON.parse(String(f.calls[0]!.init!.body))).toEqual({ email: 'a@b.c', firstName: 'A', lastName: 'B', role: 'member' });
    await c.updateUser('a/b', { departmentId: null, disabled: true });
    expect(f.calls[1]!.url).toBe('/api/v1/admin/users/a%2Fb');
    expect(f.calls[1]!.init!.method).toBe('PATCH');
    expect(JSON.parse(String(f.calls[1]!.init!.body))).toEqual({ departmentId: null, disabled: true });
  });

  it('handles an empty 204 DELETE response', async () => {
    const f = fakeFetch([{ status: 204 }]);
    await expect(createAdminClient(token, f.fn).deleteDepartment('d1')).resolves.toBeUndefined();
    expect(f.calls[0]!.init!.method).toBe('DELETE');
  });

  it.each([403, 404, 409, 429, 503])('maps HTTP %i to ApiError with the server message', async (status) => {
    const f = fakeFetch([{ status, body: { statusCode: status, message: 'department has users' } }]);
    const err = await createAdminClient(token, f.fn).overview().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(status);
    expect((err as ApiError).detail).toBe('department has users');
  });

  it('survives a non-JSON error body and array messages', async () => {
    const f = fakeFetch([{ status: 502, text: '<html>bad gateway</html>' }, { status: 400, body: { message: ['a', 'b'] } }]);
    const c = createAdminClient(token, f.fn);
    expect(((await c.overview().catch((e: unknown) => e)) as ApiError).detail).toBe('');
    expect(((await c.overview().catch((e: unknown) => e)) as ApiError).detail).toBe('a; b');
    expect(errorDetail(null)).toBe('');
    expect(errorDetail({ message: 5 })).toBe('');
  });

  it('exports through fetch with the bearer header and a blob', async () => {
    const f = fakeFetch([{ blob: new Blob(['a,b']), headers: { 'Content-Disposition': 'attachment; filename="audit-2026.csv"' } }]);
    const r = await createAdminClient(token, f.fn).exportAudit('csv', { from: '2026-01-01T00:00:00.000Z', action: ' user. ' });
    expect(f.calls[0]!.url).toBe('/api/v1/admin/audit/export?format=csv&from=2026-01-01T00%3A00%3A00.000Z&action=user.');
    expect((f.calls[0]!.init!.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(r.filename).toBe('audit-2026.csv');
    expect(await r.blob.text()).toBe('a,b');
  });

  it('falls back to a safe default file name per format', async () => {
    const f = fakeFetch([{ blob: new Blob(['x']) }]);
    expect((await createAdminClient(token, f.fn).exportAudit('json', {})).filename).toBe('audit.jsonl');
    expect(filenameFromDisposition('attachment; filename="../../etc/passwd"', 'x')).toBe('passwd');
    expect(filenameFromDisposition("attachment; filename*=UTF-8''a%20b.csv", 'x')).toBe('a b.csv');
    expect(filenameFromDisposition('attachment; filename=".."', 'x')).toBe('x');
    expect(filenameFromDisposition(null, 'x')).toBe('x');
  });

  it('builds audit list query with all filters', async () => {
    const f = fakeFetch([{ body: { items: [], next: null } }]);
    await createAdminClient(token, f.fn).listAudit({ from: 'F', to: 'T', action: 'user.', actor: 'a@b', target: 'x y', limit: 50, cursor: 'c' });
    expect(f.calls[0]!.url).toBe('/api/v1/admin/audit?from=F&to=T&action=user.&actor=a%40b&target=x%20y&limit=50&cursor=c');
  });

  it('rejects when signed out (token provider throws)', async () => {
    const f = fakeFetch([{ body: {} }]);
    await expect(createAdminClient(async () => { throw new Error('signed out'); }, f.fn).overview()).rejects.toThrow('signed out');
    expect(f.fn).not.toHaveBeenCalled();
  });
});

describe('adminErrorKey', () => {
  it('maps statuses', () => {
    expect(adminErrorKey(new ApiError(403))).toBe('admErrForbidden');
    expect(adminErrorKey(new ApiError(404))).toBe('errNotFound');
    expect(adminErrorKey(new ApiError(409))).toBe('admErrConflict');
    expect(adminErrorKey(new ApiError(409), { conflict: 'admErrDeptHasUsers' })).toBe('admErrDeptHasUsers');
    expect(adminErrorKey(new ApiError(429))).toBe('errTooMany');
    expect(adminErrorKey(new ApiError(503))).toBe('admErrUnavailable');
    expect(adminErrorKey(new ApiError(500))).toBe('errGeneric');
    expect(adminErrorKey(new TypeError('network'))).toBe('errGeneric');
  });
});

describe('temporary password lifecycle', () => {
  it('exists only while shown and is dropped on dismiss', () => {
    let s: CreateFlow = { phase: 'closed' };
    s = createFlowReducer(s, { type: 'open' });
    expect(s).toEqual({ phase: 'form' });
    s = createFlowReducer(s, { type: 'created', email: 'a@b.c', temporaryPassword: 'S3cret' });
    expect(s).toEqual({ phase: 'shown', email: 'a@b.c', temporaryPassword: 'S3cret' });
    s = createFlowReducer(s, { type: 'dismiss' });
    expect(s).toEqual({ phase: 'closed' });
    expect(JSON.stringify(s)).not.toContain('S3cret');
  });
  it('ignores a stray created event outside the form phase and drops the secret on reopen', () => {
    expect(createFlowReducer({ phase: 'closed' }, { type: 'created', email: 'x', temporaryPassword: 'p' })).toEqual({ phase: 'closed' });
    const shown: CreateFlow = { phase: 'shown', email: 'x', temporaryPassword: 'p' };
    expect(JSON.stringify(createFlowReducer(shown, { type: 'open' }))).not.toContain('"p"');
  });
});

describe('validation and filter helpers', () => {
  it('parseMaxParticipants accepts only whole numbers 2..300', () => {
    expect(parseMaxParticipants('2')).toBe(2);
    expect(parseMaxParticipants(' 300 ')).toBe(300);
    for (const bad of ['1', '301', '0', '', 'abc', '2.5', '-5', '1e2', '00000', '12345', '+7']) expect(parseMaxParticipants(bad), bad).toBeNull();
  });
  it('localInputToIso converts valid values only', () => {
    expect(localInputToIso('2026-03-04T10:15')).toBe(new Date('2026-03-04T10:15').toISOString());
    expect(localInputToIso('')).toBeUndefined();
    expect(localInputToIso('2026-13-45T99:99')).toBeUndefined();
    expect(localInputToIso('garbage')).toBeUndefined();
  });
  it('toAuditFilters trims, drops empties and rejects inverted ranges', () => {
    const ok = toAuditFilters({ ...EMPTY_AUDIT_FORM, from: '2026-03-04T10:00', to: '2026-03-05T10:00', action: ' user. ', actor: '  ' });
    expect(ok.error).toBeNull();
    expect(Object.keys(ok.filters).sort()).toEqual(['action', 'from', 'to']);
    expect(ok.filters.action).toBe('user.');
    expect(toAuditFilters({ ...EMPTY_AUDIT_FORM, from: '2026-03-06T10:00', to: '2026-03-05T10:00' }).error).toBe('admErrRange');
    expect(toAuditFilters(EMPTY_AUDIT_FORM)).toEqual({ filters: {}, error: null });
  });
  it('formatTimestamp localises and falls back to raw text', () => {
    expect(formatTimestamp('not a date', 'en')).toBe('not a date');
    expect(formatTimestamp('2026-03-04T10:15:00Z', 'en')).toMatch(/2026/);
    expect(formatTimestamp('2026-03-04T10:15:00Z', 'xx-invalid-locale-zzzzzzzzzz')).toMatch(/2026/);
  });
  it('fmt substitutes placeholders', () => {
    expect(fmt('Hi {name}, {n} left {x}', { name: 'A<b>', n: 3 })).toBe('Hi A<b>, 3 left {x}');
  });
});

describe('mergePage', () => {
  it('replaces on first page, appends and dedupes on load more', () => {
    const first = mergePage({ items: [], next: null }, { items: [{ id: '1' }, { id: '2' }], next: 'c' }, false);
    expect(first).toEqual({ items: [{ id: '1' }, { id: '2' }], next: 'c' });
    const more = mergePage(first, { items: [{ id: '2' }, { id: '3' }], next: null }, true);
    expect(more).toEqual({ items: [{ id: '1' }, { id: '2' }, { id: '3' }], next: null });
    expect(mergePage(more, { items: [{ id: '9' }], next: 'z' }, false).items).toEqual([{ id: '9' }]);
  });
});

describe('return path', () => {
  function store() {
    const m = new Map<string, string>();
    return { setItem: (k: string, v: string) => void m.set(k, v), getItem: (k: string) => m.get(k) ?? null, removeItem: (k: string) => void m.delete(k) };
  }
  it('remembers only /admin and clears after reading', () => {
    const s = store();
    rememberReturnPath('/', s);
    expect(consumeReturnPath(s)).toBeNull();
    rememberReturnPath('/admin/users', s);
    expect(consumeReturnPath(s)).toBe('/admin');
    expect(consumeReturnPath(s)).toBeNull();
  });
  it('never returns a foreign stored path', () => {
    const s = store();
    s.setItem('postLoginPath', 'https://evil.example/');
    expect(consumeReturnPath(s)).toBeNull();
  });
});
