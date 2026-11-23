import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { IdentityAdminError, KeycloakAdmin } from '../src/admin/identity-admin.js';

// Integration against the REAL running Keycloak (dev realm): the sign-up's identity calls. Needs KEYCLOAK_ADMIN_URL and
// KEYCLOAK_ADMIN_CLIENT_SECRET (scripts/devenv.sh); otherwise the suite is reported as skipped. Every user it creates
// carries a throw-away organization slug and is deleted at the end.
const cfg = loadConfig();
const enabled = Boolean(cfg.KEYCLOAK_ADMIN_URL && cfg.KEYCLOAK_ADMIN_CLIENT_SECRET);

describe.skipIf(!enabled)('sign-up identity calls (real Keycloak)', () => {
  const kc = new KeycloakAdmin({
    baseUrl: cfg.KEYCLOAK_ADMIN_URL ?? '',
    realm: cfg.KEYCLOAK_ADMIN_REALM,
    clientId: cfg.KEYCLOAK_ADMIN_REALM_CLIENT_ID,
    clientSecret: cfg.KEYCLOAK_ADMIN_CLIENT_SECRET!,
  });
  const sfx = Math.random().toString(36).slice(2, 8);
  const created: string[] = [];
  const base = `${cfg.KEYCLOAK_ADMIN_URL}/admin/realms/${cfg.KEYCLOAK_ADMIN_REALM}`;

  async function get(path: string): Promise<{ status: number; body: any }> {
    const t = await fetch(`${cfg.KEYCLOAK_ADMIN_URL}/realms/${cfg.KEYCLOAK_ADMIN_REALM}/protocol/openid-connect/token`, {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: cfg.KEYCLOAK_ADMIN_REALM_CLIENT_ID, client_secret: cfg.KEYCLOAK_ADMIN_CLIENT_SECRET! }),
    });
    const token = ((await t.json()) as { access_token: string }).access_token;
    const r = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    return { status: r.status, body: await r.json().catch(() => null) };
  }

  afterAll(async () => {
    for (const id of created) await kc.deleteUser(id).catch(() => undefined);
  });

  it('creates an org admin with the org attribute, a permanent password, no required actions and both realm roles', async () => {
    const email = `su-${sfx}@signup-test.example.org`;
    const { id } = await kc.createOrgAdmin({ email, name: 'Aziza Karimova', orgSlug: `su-${sfx}`, password: `Pw-${sfx}-correct-horse` });
    created.push(id);
    const u = (await get(`/users/${id}`)).body;
    expect(u).toMatchObject({ email, firstName: 'Aziza', lastName: 'Karimova', enabled: true });
    expect(u.attributes.org_slug).toEqual([`su-${sfx}`]);
    expect(u.requiredActions).toEqual([]);
    const roles = ((await get(`/users/${id}/role-mappings/realm`)).body as Array<{ name: string }>).map((r) => r.name);
    expect(roles).toEqual(expect.arrayContaining(['member', 'org_admin']));
    const creds = (await get(`/users/${id}/credentials`)).body as Array<{ type: string }>;
    expect(creds.map((c) => c.type)).toEqual(['password']);
  });

  it('answers 409 for an existing email and does not touch that user', async () => {
    const email = `su2-${sfx}@signup-test.example.org`;
    const { id } = await kc.createOrgAdmin({ email, name: 'First User', orgSlug: `su2-${sfx}`, password: `Pw-${sfx}-correct-horse` });
    created.push(id);
    await expect(kc.createOrgAdmin({ email, name: 'Second User', orgSlug: `su2b-${sfx}`, password: `Pw-${sfx}-correct-horse` })).rejects.toMatchObject({ status: 409 });
    expect((await get(`/users/${id}`)).body.attributes.org_slug).toEqual([`su2-${sfx}`]);
  });

  it('answers 400 when the realm password policy refuses the password', async () => {
    const err = await kc.createOrgAdmin({ email: `su3-${sfx}@signup-test.example.org`, name: 'Weak', orgSlug: `su3-${sfx}`, password: 'short' }).catch((e) => e);
    expect(err).toBeInstanceOf(IdentityAdminError);
    expect((err as IdentityAdminError).status).toBe(400);
  });

  it('deleteUsersByOrgSlug removes every user of that organization and nobody else', async () => {
    const slug = `su5-${sfx}`;
    const a = await kc.createOrgAdmin({ email: `su5a-${sfx}@signup-test.example.org`, name: 'A', orgSlug: slug, password: `Pw-${sfx}-correct-horse` });
    const b = await kc.createOrgAdmin({ email: `su5b-${sfx}@signup-test.example.org`, name: 'B', orgSlug: slug, password: `Pw-${sfx}-correct-horse` });
    const other = await kc.createOrgAdmin({ email: `su5c-${sfx}@signup-test.example.org`, name: 'C', orgSlug: `su5x-${sfx}`, password: `Pw-${sfx}-correct-horse` });
    created.push(a.id, b.id, other.id);
    await kc.deleteUsersByOrgSlug(slug);
    expect((await get(`/users/${a.id}`)).status).toBe(404);
    expect((await get(`/users/${b.id}`)).status).toBe(404);
    expect((await get(`/users/${other.id}`)).status).toBe(200);
  });

  it('deleteOrgAdminByEmail removes only a user that carries the given org slug', async () => {
    const email = `su4-${sfx}@signup-test.example.org`;
    const { id } = await kc.createOrgAdmin({ email, name: 'Cleanup Me', orgSlug: `su4-${sfx}`, password: `Pw-${sfx}-correct-horse` });
    created.push(id);
    await kc.deleteOrgAdminByEmail(email, `someone-else-${sfx}`);
    expect((await get(`/users/${id}`)).status).toBe(200); // different slug: untouched
    await kc.deleteOrgAdminByEmail(email, `su4-${sfx}`);
    expect((await get(`/users/${id}`)).status).toBe(404);
  });
});
