import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { withTenant } from '../src/db/tenant.js';

// Integration tests against the real dev Postgres. They connect as the unprivileged application role.
const appUrl = process.env.DATABASE_URL;
const adminUrl = process.env.MIGRATE_DATABASE_URL;
if (!appUrl || !adminUrl) throw new Error('DATABASE_URL and MIGRATE_DATABASE_URL are required for tests');

const app = new Pool({ connectionString: appUrl, max: 4 });
const admin = new Pool({ connectionString: adminUrl, max: 2 });
const suffix = Math.random().toString(36).slice(2, 8);
let orgA = '', orgB = '', userA = '', userB = '';

async function provision(slug: string, sub: string) {
  const r = await app.query('SELECT org_id, user_id FROM provision_user($1,$2,$3,$4,$5,$6)', [
    slug, slug, sub, `${sub}@test.local`, sub, 'member',
  ]);
  return r.rows[0] as { org_id: string; user_id: string };
}

beforeAll(async () => {
  const a = await provision(`rls-a-${suffix}`, `sub-a-${suffix}`);
  const b = await provision(`rls-b-${suffix}`, `sub-b-${suffix}`);
  orgA = a.org_id; userA = a.user_id; orgB = b.org_id; userB = b.user_id;
  const mk = (org: string, user: string, code: string) =>
    withTenant(app, org, (c) =>
      c.query('INSERT INTO meetings (org_id, code, title, host_user_id) VALUES ($1,$2,$3,$4)', [org, code, 't', user]),
    );
  const digits = () => '9' + String(Math.floor(Math.random() * 1e10)).padStart(10, '0');
  await mk(orgA, userA, digits());
  await mk(orgB, userB, digits());
});

afterAll(async () => {
  await admin.query('DELETE FROM organizations WHERE slug IN ($1,$2)', [`rls-a-${suffix}`, `rls-b-${suffix}`]);
  await app.end();
  await admin.end();
});

describe('row-level security', () => {
  it('application role is neither superuser nor BYPASSRLS', async () => {
    const r = await app.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user");
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('a tenant sees only its own meetings', async () => {
    const rows = await withTenant(app, orgA, async (c) => (await c.query('SELECT org_id FROM meetings')).rows);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.org_id === orgA)).toBe(true);
  });

  it('the other tenant is isolated the same way', async () => {
    const rows = await withTenant(app, orgB, async (c) => (await c.query('SELECT org_id FROM meetings')).rows);
    expect(rows.every((r) => r.org_id === orgB)).toBe(true);
  });

  it('without a tenant context nothing is visible', async () => {
    for (const t of ['meetings', 'users', 'organizations', 'audit_log']) {
      const r = await app.query(`SELECT count(*)::int AS n FROM ${t}`);
      expect(r.rows[0].n, t).toBe(0);
    }
  });

  it('cannot read another tenant by guessing its id in a WHERE clause', async () => {
    const rows = await withTenant(app, orgA, async (c) => (await c.query('SELECT id FROM meetings WHERE org_id = $1', [orgB])).rows);
    expect(rows).toHaveLength(0);
  });

  it('cannot insert a row into another tenant (WITH CHECK)', async () => {
    await expect(
      withTenant(app, orgA, (c) =>
        c.query('INSERT INTO meetings (org_id, code, title, host_user_id) VALUES ($1,$2,$3,$4)', [orgB, '70000000001', 'x', userB]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('cannot move a row to another tenant by UPDATE', async () => {
    await expect(
      withTenant(app, orgA, (c) => c.query('UPDATE meetings SET org_id = $1', [orgB])),
    ).rejects.toThrow(/row-level security/);
  });

  it('audit log is append-only for the application role', async () => {
    await withTenant(app, orgA, (c) =>
      c.query('INSERT INTO audit_log (org_id, actor_id, action) VALUES ($1,$2,$3)', [orgA, userA, 'test']),
    );
    await expect(withTenant(app, orgA, (c) => c.query("UPDATE audit_log SET action = 'x'"))).rejects.toThrow(/permission denied/);
    await expect(withTenant(app, orgA, (c) => c.query('DELETE FROM audit_log'))).rejects.toThrow(/permission denied/);
  });

  it('tenant setting does not leak between pooled connections', async () => {
    await withTenant(app, orgA, async () => undefined);
    const r = await app.query('SELECT count(*)::int AS n FROM meetings');
    expect(r.rows[0].n).toBe(0);
  });

  it('rejects a malformed or hostile tenant id before touching the database', async () => {
    await expect(withTenant(app, "x'; DROP TABLE meetings;--", async () => 1)).rejects.toThrow('invalid org id');
    await expect(withTenant(app, '', async () => 1)).rejects.toThrow('invalid org id');
  });

  it('provision_user rejects an unknown role', async () => {
    await expect(app.query('SELECT * FROM provision_user($1,$2,$3,$4,$5,$6)', ['x-org', 'x', 's', 'e@x', 'n', 'superadmin'])).rejects.toThrow(/invalid role/);
  });
});
