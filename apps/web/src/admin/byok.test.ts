import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import { dictionaries } from '../i18n';
import { createAdminClient, type RewrapResult } from './client';
import { kmsErrorKey, kmsStatusKey, rewrapAll, validateKmsForm } from './byok-helpers';

function fakeFetch(responses: Array<{ status?: number; body?: unknown }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = responses.shift() ?? { status: 200, body: {} };
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  });
  return { fn, calls };
}

describe('encryption keys client', () => {
  it('uses the documented endpoints and sends the token only in the PUT body', async () => {
    const f = fakeFetch([{ body: { configured: false } }, { body: { configured: true } }, { body: { status: 'ok' } }, { body: { processed: 0, failed: 0, remaining: 0, next: null } }, { body: { removed: true } }]);
    const c = createAdminClient(async () => 'tok', f.fn);
    expect((await c.getKms()).configured).toBe(false);
    await c.putKms({ addr: 'https://v.example.com', token: 'hvs.secret', keyName: 'k', mount: 'transit' });
    await c.testKms();
    await c.rewrapKms({ target: 'customer', limit: 100, after: 'f:abc' });
    await c.removeKms();
    expect(f.calls.map((x) => `${x.init?.method ?? 'GET'} ${x.url}`)).toEqual([
      'GET /api/v1/admin/kms',
      'PUT /api/v1/admin/kms',
      'POST /api/v1/admin/kms/test',
      'POST /api/v1/admin/kms/rewrap',
      'DELETE /api/v1/admin/kms',
    ]);
    expect(String(f.calls[1]!.init?.body)).toContain('hvs.secret');
    for (const i of [0, 2, 3, 4]) expect(String(f.calls[i]!.init?.body ?? '')).not.toContain('hvs.secret');
    expect((f.calls[0]!.init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });
});

describe('validateKmsForm', () => {
  const ok = { addr: 'https://vault.example.com:8200', token: 'hvs.x', keyName: 'my-key_1', mount: 'transit', namespace: '' };
  it('accepts a normal form', () => expect(validateKmsForm(ok)).toBeNull());
  it.each([
    [{ addr: '' }, 'admEncNeedAddr'],
    [{ addr: 'vault.example.com' }, 'admEncNeedAddr'],
    [{ addr: 'ftp://vault.example.com' }, 'admEncNeedAddr'],
    [{ token: '' }, 'admEncNeedToken'],
    [{ keyName: '' }, 'admEncNeedKey'],
    [{ keyName: '../sys/seal' }, 'admEncNeedKey'],
    [{ keyName: 'a b' }, 'admEncNeedKey'],
    [{ keyName: 'x'.repeat(65) }, 'admEncNeedKey'],
    [{ mount: '/transit' }, 'admEncNeedMount'],
    [{ mount: 'a//b' }, 'admEncNeedMount'],
    [{ mount: '../x' }, 'admEncNeedMount'],
  ])('rejects %o', (patch, key) => expect(validateKmsForm({ ...ok, ...patch })).toBe(key));
});

describe('error and status keys exist in every language', () => {
  it('maps API failures to dedicated messages, never to server text', () => {
    expect(kmsErrorKey(new ApiError(400, 'internal 10.0.0.1'))).toBe('admEncErrAddr');
    expect(kmsErrorKey(new ApiError(422))).toBe('admEncErrUnusable');
    expect(kmsErrorKey(new ApiError(423))).toBe('admEncErrDenied');
    expect(kmsErrorKey(new ApiError(503, 'customer keys are not configured on this server'))).toBe('admEncErrNoKms');
    expect(kmsErrorKey(new ApiError(409), 'put')).toBe('admEncErrWrapped');
    expect(kmsErrorKey(new ApiError(409), 'remove')).toBe('admEncRemoveBlocked');
    expect(kmsErrorKey(new ApiError(404))).toBe('admEncErrNotConfigured');
    expect(kmsErrorKey(new Error('x'))).toBe('errGeneric');
    for (const s of ['ok', 'denied', 'unreachable', 'unknown']) expect(Object.keys(dictionaries.en)).toContain(kmsStatusKey(s));
  });
});

describe('rewrapAll', () => {
  const page = (r: Partial<RewrapResult>): RewrapResult => ({ processed: 0, failed: 0, remaining: 0, next: null, ...r });
  it('keeps calling with the cursor until the server says it is done and adds the totals up', async () => {
    const calls: Array<{ after?: string }> = [];
    const results = [page({ processed: 2, remaining: 3, next: 'f:1' }), page({ processed: 2, failed: 1, remaining: 1, next: 'f:2' }), page({ processed: 0, remaining: 1, next: null })];
    const progress: number[] = [];
    const total = await rewrapAll(async (b) => {
      calls.push({ after: b.after });
      return results.shift()!;
    }, 'customer', (n) => progress.push(n));
    expect(calls.map((c) => c.after)).toEqual([undefined, 'f:1', 'f:2']);
    expect(total).toEqual({ processed: 4, failed: 1, remaining: 1 });
    expect(progress).toEqual([2, 4, 4]);
  });
  it('stops on an error and surfaces it (what was moved stays moved)', async () => {
    const run = rewrapAll(async () => {
      throw new ApiError(423);
    }, 'customer', () => undefined);
    await expect(run).rejects.toBeInstanceOf(ApiError);
  });
  it('does not loop forever if the server repeats a cursor', async () => {
    let n = 0;
    const run = rewrapAll(async () => (n++, page({ processed: 1, remaining: 9, next: 'f:same' })), 'platform', () => undefined);
    await expect(run).rejects.toThrow(/cursor/);
    expect(n).toBeLessThan(5);
  });
});
