import { afterEach, describe, expect, it, vi } from 'vitest';
import { IdentityAdminError, KeycloakAdmin } from '../src/admin/identity-admin.js';

// Unit: the identity-provider side of an erasure against a scripted Keycloak (global fetch is replaced).
const SUB = '3f2a9d52-1c1e-4b7e-9d0c-0a6a6b1d2e33';
const kc = () => new KeycloakAdmin({ baseUrl: 'http://kc.test/auth', realm: 'r', clientId: 'c', clientSecret: 'not-a-real-secret' });

interface Call {
  method: string;
  path: string;
}
function script(user: { status: number; body?: unknown }, over: Partial<Record<string, number>> = {}) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string }) => {
      const u = new URL(url);
      const method = init?.method ?? 'GET';
      if (u.pathname.endsWith('/protocol/openid-connect/token')) return new Response(JSON.stringify({ access_token: 't', expires_in: 60 }), { status: 200 });
      const path = u.pathname.replace('/auth/admin/realms/r', '');
      calls.push({ method, path });
      if (method === 'GET') return new Response(JSON.stringify(user.body ?? {}), { status: user.status });
      if (path.endsWith('/logout')) return new Response(null, { status: over['logout'] ?? 204 });
      if (method === 'DELETE') return new Response(null, { status: over['delete'] ?? 204 });
      return new Response(null, { status: 500 });
    }),
  );
  return calls;
}
afterEach(() => vi.unstubAllGlobals());

describe('KeycloakAdmin.eraseUser', () => {
  it('ends the sessions, then deletes the account', async () => {
    const calls = script({ status: 200, body: { id: SUB, attributes: { org_slug: ['acme'] } } });
    await kc().eraseUser(SUB, 'acme');
    expect(calls).toEqual([
      { method: 'GET', path: `/users/${SUB}` },
      { method: 'POST', path: `/users/${SUB}/logout` },
      { method: 'DELETE', path: `/users/${SUB}` },
    ]);
  });

  it('is repeatable: a user that is already gone is success', async () => {
    const calls = script({ status: 404 });
    await expect(kc().eraseUser(SUB, 'acme')).resolves.toBeUndefined();
    expect(calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('refuses an account of another organization and deletes nothing', async () => {
    const calls = script({ status: 200, body: { id: SUB, attributes: { org_slug: ['other'] } } });
    await expect(kc().eraseUser(SUB, 'acme')).rejects.toBeInstanceOf(IdentityAdminError);
    expect(calls.some((c) => c.method === 'DELETE' || c.path.endsWith('/logout'))).toBe(false);
  });

  it('does not touch the provider for a subject that is not a provider id', async () => {
    const calls = script({ status: 200 });
    await expect(kc().eraseUser('placeholder-sub', 'acme')).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('a provider failure while deleting is reported (so the erasure stays retryable)', async () => {
    script({ status: 200, body: { id: SUB, attributes: { org_slug: ['acme'] } } }, { delete: 500 });
    await expect(kc().eraseUser(SUB, 'acme')).rejects.toMatchObject({ status: 502 });
  });
});
