import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PROD_SETTINGS, ProdRealmError, auditProdRealm, toProdRealm } from './prod-realm.mjs';

const dev = JSON.parse(readFileSync(new URL('../../deploy/keycloak/davrabox-realm.json', import.meta.url), 'utf8'));

describe('toProdRealm', () => {
  const prod = toProdRealm(dev);

  it('requires TLS, rotates refresh tokens and records events', () => {
    for (const [k, v] of Object.entries(PROD_SETTINGS)) expect(prod[k]).toEqual(v);
    expect(auditProdRealm(prod)).toEqual([]);
  });

  it('drops every demo user but keeps the API service account', () => {
    expect(prod.users.map((u) => u.username)).toEqual(['service-account-davrabox-admin-api']);
    expect(JSON.stringify(prod)).not.toMatch(/DEMO_USER_PASSWORD/);
  });

  it('keeps only the production host as redirect URI and web origin', () => {
    const web = prod.clients.find((c) => c.clientId === 'davrabox-web');
    expect(web.redirectUris).toEqual(['https://${PUBLIC_HOST}/*']);
    expect(web.webOrigins).toEqual(['https://${PUBLIC_HOST}']);
    expect(JSON.stringify(prod)).not.toMatch(/localhost|bugvector/);
  });

  it('does not modify the development realm', () => {
    expect(dev.sslRequired).toBe('none');
    expect(dev.users.length).toBeGreaterThan(1);
  });
});

describe('negative cases', () => {
  it('rejects a realm that is not the davrabox one', () => {
    expect(() => toProdRealm({ realm: 'other' })).toThrow(ProdRealmError);
    expect(() => toProdRealm(null)).toThrow(ProdRealmError);
  });
  it('refuses to produce a realm without the service account', () => {
    const d = structuredClone(dev);
    d.users = d.users.filter((u) => u.username !== 'service-account-davrabox-admin-api');
    expect(() => toProdRealm(d)).toThrow(/service account/);
  });
  it('audit flags the development realm and each weakened setting', () => {
    expect(auditProdRealm(dev).length).toBeGreaterThan(3);
    const p = toProdRealm(dev);
    expect(auditProdRealm({ ...p, sslRequired: 'none' })).toContain('sslRequired is none');
    expect(auditProdRealm({ ...p, revokeRefreshToken: false })).toContain('refresh token rotation with reuse detection is off');
    expect(auditProdRealm({ ...p, accessTokenLifespan: 86400 })).toContain('access token lifespan must be 1..900 s');
    const withUser = { ...p, users: [...p.users, { username: 'admin.demo' }] };
    expect(auditProdRealm(withUser)).toContain('user admin.demo must not exist in production');
    const wide = structuredClone(p);
    wide.clients[0].redirectUris.push('https://localhost:8443/*');
    expect(auditProdRealm(wide).join(' ')).toMatch(/localhost/);
  });
});
