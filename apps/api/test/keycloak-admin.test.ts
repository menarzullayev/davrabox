import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { loadConfig } from '../src/config.js';
import type { AuthedUser } from '../src/auth/auth.guard.js';
import { AdminService } from '../src/admin/admin.service.js';
import { generateTemporaryPassword, IdentityAdminError, KeycloakAdmin } from '../src/admin/identity-admin.js';

// Integration against the REAL running Keycloak (dev realm). Needs KEYCLOAK_ADMIN_URL and KEYCLOAK_ADMIN_CLIENT_SECRET
// (scripts/devenv.sh exports them when ADMIN_API_CLIENT_SECRET is in dev.env); otherwise the suite is reported as skipped.
const cfg = loadConfig();
const enabled = Boolean(cfg.KEYCLOAK_ADMIN_URL && cfg.KEYCLOAK_ADMIN_CLIENT_SECRET);
const adminUrl = process.env.MIGRATE_DATABASE_URL;
if (!adminUrl) throw new Error('MIGRATE_DATABASE_URL is required for tests');

describe.skipIf(!enabled)('Keycloak admin (real identity provider)', () => {
  const pool = new Pool({ connectionString: cfg.DATABASE_URL, max: 4 });
  const owner = new Pool({ connectionString: adminUrl, max: 2 });
  const sfx = Math.random().toString(36).slice(2, 8);
  const slug = `kc-int-${sfx}`;
  const kc = new KeycloakAdmin({
    baseUrl: cfg.KEYCLOAK_ADMIN_URL!,
    realm: cfg.KEYCLOAK_ADMIN_REALM,
    clientId: cfg.KEYCLOAK_ADMIN_REALM_CLIENT_ID,
    clientSecret: cfg.KEYCLOAK_ADMIN_CLIENT_SECRET!,
  });
  const svc = new AdminService(pool, kc);
  const createdSubs: string[] = [];
  let actor: AuthedUser;

  // Independent read access to Keycloak (same service account) to verify what the code did.
  async function kcGet(path: string): Promise<any> {
    const t = await fetch(`${cfg.KEYCLOAK_ADMIN_URL}/realms/${cfg.KEYCLOAK_ADMIN_REALM}/protocol/openid-connect/token`, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: cfg.KEYCLOAK_ADMIN_REALM_CLIENT_ID,
        client_secret: cfg.KEYCLOAK_ADMIN_CLIENT_SECRET!,
      }),
    });
    const token = ((await t.json()) as { access_token: string }).access_token;
    const r = await fetch(`${cfg.KEYCLOAK_ADMIN_URL}/admin/realms/${cfg.KEYCLOAK_ADMIN_REALM}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) };
  }
  const roleNames = async (id: string) => ((await kcGet(`/users/${id}/role-mappings/realm`)).body as Array<{ name: string }>).map((r) => r.name).sort();

  beforeAll(async () => {
    const r = await pool.query('SELECT org_id, user_id FROM provision_user($1,$2,$3,$4,$5,$6)', [slug, slug, `kc-admin-${sfx}`, `kcadm-${sfx}@t.local`, 'Kc Admin', 'org_admin']);
    actor = { sub: `kc-admin-${sfx}`, email: `kcadm-${sfx}@t.local`, name: 'Kc Admin', orgSlug: slug, role: 'org_admin', orgId: r.rows[0].org_id, userId: r.rows[0].user_id };
  });
  afterAll(async () => {
    for (const sub of createdSubs) await kc.deleteUser(sub).catch(() => undefined);
    await owner.query('DELETE FROM organizations WHERE slug = $1', [slug]);
    await pool.end();
    await owner.end();
  });

  it('creates an admin user with org attribute, both realm roles, UPDATE_PASSWORD + CONFIGURE_TOTP and a temporary password', async () => {
    const email = `kc-a-${sfx}@t.local`;
    const out = await svc.createUser(actor, { email, firstName: 'Kc', lastName: 'Admin', role: 'org_admin' });
    const row = (await owner.query('SELECT external_sub, org_id, role FROM users WHERE id = $1', [out.user.id])).rows[0];
    createdSubs.push(row.external_sub);
    expect(row).toMatchObject({ org_id: actor.orgId, role: 'org_admin' });

    const u = (await kcGet(`/users/${row.external_sub}`)).body;
    expect(u).toMatchObject({ email, firstName: 'Kc', lastName: 'Admin', enabled: true });
    expect(u.attributes.org_slug).toEqual([slug]);
    expect([...u.requiredActions].sort()).toEqual(['CONFIGURE_TOTP', 'UPDATE_PASSWORD']);
    expect(await roleNames(row.external_sub)).toEqual(expect.arrayContaining(['member', 'org_admin']));
    const creds = (await kcGet(`/users/${row.external_sub}/credentials`)).body as Array<{ type: string }>;
    expect(creds.map((c) => c.type)).toEqual(['password']);
    expect(out.temporaryPassword).toHaveLength(20);
  });

  it('a plain member gets only UPDATE_PASSWORD and only the member role; the org policy adds CONFIGURE_TOTP', async () => {
    const out = await svc.createUser(actor, { email: `kc-m-${sfx}@t.local`, firstName: 'Kc', lastName: 'Member', role: 'member' });
    const sub = (await owner.query('SELECT external_sub FROM users WHERE id = $1', [out.user.id])).rows[0].external_sub as string;
    createdSubs.push(sub);
    expect((await kcGet(`/users/${sub}`)).body.requiredActions).toEqual(['UPDATE_PASSWORD']);
    expect(await roleNames(sub)).toEqual(expect.arrayContaining(['member']));
    expect(await roleNames(sub)).not.toContain('org_admin');

    await owner.query('INSERT INTO org_policies (org_id, require_totp) VALUES ($1, true)', [actor.orgId]);
    const out2 = await svc.createUser(actor, { email: `kc-t-${sfx}@t.local`, firstName: 'Kc', lastName: 'Totp', role: 'member' });
    const sub2 = (await owner.query('SELECT external_sub FROM users WHERE id = $1', [out2.user.id])).rows[0].external_sub as string;
    createdSubs.push(sub2);
    expect([...(await kcGet(`/users/${sub2}`)).body.requiredActions].sort()).toEqual(['CONFIGURE_TOTP', 'UPDATE_PASSWORD']);
  });

  it('a duplicate email is a 409 and leaves no database row', async () => {
    const email = `kc-m-${sfx}@t.local`;
    await expect(svc.createUser(actor, { email, firstName: 'Dup', lastName: 'Licate', role: 'member' })).rejects.toMatchObject({ status: 409 });
    expect((await owner.query('SELECT count(*)::int AS n FROM users WHERE org_id = $1 AND email = $2', [actor.orgId, email])).rows[0].n).toBe(1);
  });

  it('role and disabled changes reach Keycloak (roles swapped, account disabled) and the database', async () => {
    const email = `kc-m-${sfx}@t.local`;
    const id = (await owner.query('SELECT id, external_sub FROM users WHERE email = $1 AND org_id = $2', [email, actor.orgId])).rows[0] as { id: string; external_sub: string };

    const promoted = await svc.updateUser(actor, id.id, { role: 'org_admin' });
    expect(promoted.role).toBe('org_admin');
    expect(await roleNames(id.external_sub)).toEqual(expect.arrayContaining(['member', 'org_admin']));

    const demoted = await svc.updateUser(actor, id.id, { role: 'member', disabled: true });
    expect(demoted).toMatchObject({ role: 'member', disabled: true });
    expect(await roleNames(id.external_sub)).not.toContain('org_admin');
    const u = (await kcGet(`/users/${id.external_sub}`)).body;
    expect(u.enabled).toBe(false);
    expect(u.attributes.org_slug).toEqual([slug]); // full-representation PUT kept the attribute
    expect(u.email).toBe(email);

    await svc.updateUser(actor, id.id, { disabled: false });
    expect((await kcGet(`/users/${id.external_sub}`)).body.enabled).toBe(true);
  });

  it('never touches a Keycloak user that belongs to another organization', async () => {
    const sub = createdSubs[0]!;
    expect(await kc.updateUser(sub, 'some-other-org', { enabled: false, role: 'member' })).toBe(false);
    const u = (await kcGet(`/users/${sub}`)).body;
    expect(u.enabled).toBe(true);
    expect(await roleNames(sub)).toContain('org_admin');
  });

  it('treats an unknown or non-Keycloak subject as nothing to sync', async () => {
    expect(await kc.updateUser('00000000-0000-4000-8000-000000000000', slug, { enabled: false })).toBe(false);
    expect(await kc.updateUser('placeholder-subject', slug, { enabled: false })).toBe(false);
  });

  it('wrong credentials surface as a 502 error without leaking the secret', async () => {
    const bad = new KeycloakAdmin({ baseUrl: cfg.KEYCLOAK_ADMIN_URL!, realm: cfg.KEYCLOAK_ADMIN_REALM, clientId: cfg.KEYCLOAK_ADMIN_REALM_CLIENT_ID, clientSecret: 'definitely-wrong-secret' });
    const err = await bad.deleteUser('00000000-0000-4000-8000-000000000000').catch((e) => e);
    expect(err).toBeInstanceOf(IdentityAdminError);
    expect(err.status).toBe(502);
    expect(String(err.message)).not.toContain('definitely-wrong-secret');
  });

  it('the service account is least-privilege: it cannot manage clients or realm settings', async () => {
    const t = await fetch(`${cfg.KEYCLOAK_ADMIN_URL}/realms/${cfg.KEYCLOAK_ADMIN_REALM}/protocol/openid-connect/token`, {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: cfg.KEYCLOAK_ADMIN_REALM_CLIENT_ID, client_secret: cfg.KEYCLOAK_ADMIN_CLIENT_SECRET! }),
    });
    const token = ((await t.json()) as { access_token: string }).access_token;
    const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const base = `${cfg.KEYCLOAK_ADMIN_URL}/admin/realms/${cfg.KEYCLOAK_ADMIN_REALM}`;
    // Keycloak answers a client listing without view-clients with an empty list (200) instead of 403.
    const clients = await fetch(`${base}/clients`, { headers: h });
    expect(clients.status === 403 || ((await clients.json()) as unknown[]).length === 0).toBe(true);
    expect((await fetch(`${base}/clients`, { method: 'POST', headers: h, body: JSON.stringify({ clientId: `evil-${sfx}` }) })).status).toBe(403);
    expect((await fetch(`${base}`, { method: 'PUT', headers: h, body: JSON.stringify({ realm: cfg.KEYCLOAK_ADMIN_REALM, enabled: false }) })).status).toBe(403);
    expect((await fetch(`${base}/roles`, { method: 'POST', headers: h, body: JSON.stringify({ name: `evil-${sfx}` }) })).status).toBe(403);
  });
});

describe('temporary password generator', () => {
  it('is 20 chars, covers every class and does not repeat', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const p = generateTemporaryPassword();
      expect(p).toHaveLength(20);
      expect(p).toMatch(/[A-Z]/);
      expect(p).toMatch(/[a-z]/);
      expect(p).toMatch(/[0-9]/);
      expect(p).toMatch(/[-_.!#%]/);
      seen.add(p);
    }
    expect(seen.size).toBe(200);
  });
});
