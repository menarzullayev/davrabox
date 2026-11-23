import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import { createAdminClient } from './client';
import { API_KEY_SCOPES, WEBHOOK_EVENTS, deliveryStatusKey, eventLabelKey, integrationErrorKey, scopeLabelKey, toggleOrdered, validateHookForm, validateKeyForm } from './integrations-helpers';

function fakeFetch(responses: Array<{ status?: number; body?: unknown }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = responses.shift() ?? { status: 200, body: {} };
    const text = r.body === undefined ? '' : JSON.stringify(r.body);
    return new Response(r.status === 204 ? null : text, { status: r.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  });
  return { fn, calls };
}
const client = (f: ReturnType<typeof fakeFetch>) => createAdminClient(async () => 'tok', f.fn);

describe('integrations client', () => {
  it('lists, creates and revokes API keys with the bearer token', async () => {
    const f = fakeFetch([
      { body: [{ id: 'k1', name: 'ci', prefix: 'abcd1234', scopes: ['meetings:read'], createdAt: 't', lastUsedAt: null, revokedAt: null }] },
      { status: 201, body: { id: 'k2', name: 'n', prefix: 'p', scopes: ['users:read'], createdAt: 't', lastUsedAt: null, revokedAt: null, secret: 'dbx_p_x' } },
      { status: 204 },
    ]);
    const c = client(f);
    expect((await c.listApiKeys())[0]!.prefix).toBe('abcd1234');
    const created = await c.createApiKey({ name: 'n', scopes: ['users:read'] });
    expect(created.secret).toBe('dbx_p_x');
    await c.revokeApiKey('k 2/x');
    expect(f.calls.map((x) => `${x.init?.method ?? 'GET'} ${x.url}`)).toEqual(['GET /api/v1/admin/api-keys', 'POST /api/v1/admin/api-keys', 'DELETE /api/v1/admin/api-keys/k%202%2Fx']);
    expect(f.calls[1]!.init?.body).toBe(JSON.stringify({ name: 'n', scopes: ['users:read'] }));
    expect((f.calls[0]!.init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('lists, creates and deletes webhooks and pages through deliveries with filters', async () => {
    const f = fakeFetch([
      { body: [] },
      { status: 201, body: { id: 'w1', url: 'https://x.example/h', events: ['meeting.created'], createdAt: 't', secret: 'whsec_abc' } },
      { status: 204 },
      { body: { items: [], next: null } },
    ]);
    const c = client(f);
    await c.listWebhooks();
    expect((await c.createWebhook({ url: 'https://x.example/h', events: ['meeting.created'] })).secret).toBe('whsec_abc');
    await c.deleteWebhook('w1');
    await c.listDeliveries('w1', { status: 'dead', limit: 10, cursor: 'c u' });
    expect(f.calls.map((x) => `${x.init?.method ?? 'GET'} ${x.url}`)).toEqual([
      'GET /api/v1/admin/webhooks',
      'POST /api/v1/admin/webhooks',
      'DELETE /api/v1/admin/webhooks/w1',
      'GET /api/v1/admin/webhooks/w1/deliveries?status=dead&limit=10&cursor=c%20u',
    ]);
  });

  it('surfaces API failures as ApiError', async () => {
    const f = fakeFetch([{ status: 409, body: { statusCode: 409, message: 'at most 20 active API keys per organization' } }]);
    await expect(client(f).createApiKey({ name: 'x', scopes: ['users:read'] })).rejects.toBeInstanceOf(ApiError);
  });
});

describe('integration forms', () => {
  it('a key needs a name and at least one known scope', () => {
    expect(validateKeyForm({ name: 'ci', scopes: ['meetings:read'] })).toBeNull();
    expect(validateKeyForm({ name: '   ', scopes: ['meetings:read'] })).toBe('admErrBadRequest');
    expect(validateKeyForm({ name: 'ci', scopes: [] })).toBe('admIntNeedScope');
  });

  it('a webhook needs an https URL and at least one event', () => {
    expect(validateHookForm({ url: 'https://hooks.example.com/in', events: ['meeting.created'] })).toBeNull();
    expect(validateHookForm({ url: '  https://hooks.example.com/in ', events: ['meeting.ended'] })).toBeNull();
    for (const url of ['http://hooks.example.com/in', 'ftp://x', 'hooks.example.com', '', 'javascript:alert(1)', 'HTTP://x.example']) {
      expect(validateHookForm({ url, events: ['meeting.created'] }), url).toBe('admIntUrlHttps');
    }
    expect(validateHookForm({ url: 'https://hooks.example.com/in', events: [] })).toBe('admIntNeedEvent');
  });

  it('toggleOrdered adds and removes while keeping the canonical order', () => {
    expect(toggleOrdered([], 'meetings:write', API_KEY_SCOPES)).toEqual(['meetings:write']);
    expect(toggleOrdered(['users:read'], 'meetings:read', API_KEY_SCOPES)).toEqual(['meetings:read', 'users:read']);
    expect(toggleOrdered(['meetings:read', 'users:read'], 'meetings:read', API_KEY_SCOPES)).toEqual(['users:read']);
  });

  it('every scope, event and delivery status has a label key (no raw strings in the UI)', () => {
    for (const s of API_KEY_SCOPES) expect(scopeLabelKey(s)).toMatch(/^admInt/);
    for (const e of WEBHOOK_EVENTS) expect(eventLabelKey(e)).toMatch(/^admInt/);
    for (const s of ['pending', 'delivered', 'dead'] as const) expect(deliveryStatusKey(s)).toMatch(/^admInt/);
  });

  it('maps API failures to specific messages without exposing server text', () => {
    const e = (status: number) => new ApiError(status, 'internal detail 10.0.0.5');
    expect(integrationErrorKey(e(409), 'key')).toBe('admIntKeyTooMany');
    expect(integrationErrorKey(e(409), 'hook')).toBe('admIntHookTooMany');
    expect(integrationErrorKey(e(400), 'hook')).toBe('admIntUrlRejected');
    expect(integrationErrorKey(e(503), 'hook')).toBe('admIntHookNotConfigured');
    expect(integrationErrorKey(e(403), 'key')).toBe('admErrForbidden');
    expect(integrationErrorKey(e(500), 'hook')).toBe('errGeneric');
    expect(integrationErrorKey(new Error('boom'), 'key')).toBe('errGeneric');
  });
});
