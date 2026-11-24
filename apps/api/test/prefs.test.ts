import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { loadConfig } from '../src/config.js';
import { PrefsError, PrefsService } from '../src/prefs/prefs.service.js';
import { patchSchema } from '../src/prefs/prefs.controller.js';
import { DENSITY_IDS, STYLE_IDS } from '../src/prefs/ids.js';
import { policiesSchema } from '../src/admin/policies.js';
import { readFileSync } from 'node:fs';
import type { AuthedUser } from '../src/auth/auth.guard.js';

// The design tokens own the lists; read them from the source text so this test does not need the package at compile time.
const tokensSrc = readFileSync(new URL('../../../packages/design-tokens/src/tokens.ts', import.meta.url), 'utf8');
const tokenList = (name: string): string[] => {
  const start = tokensSrc.indexOf(`${name} = [`);
  const m = start < 0 ? null : /\[([^\]]*)\]/.exec(tokensSrc.slice(start));
  if (!m) throw new Error('list not found in tokens.ts: ' + name);
  return [...m[1]!.matchAll(/'([a-z]+)'/g)].map((x) => x[1]!);
};
const TOKEN_STYLES = tokenList('STYLE_IDS');
const TOKEN_DENSITIES = tokenList('DENSITY_IDS');

const cfg = loadConfig();
const adminUrl = process.env.MIGRATE_DATABASE_URL;
if (!adminUrl) throw new Error('MIGRATE_DATABASE_URL is required for tests');
const pool = new Pool({ connectionString: cfg.DATABASE_URL, max: 4 });
const admin = new Pool({ connectionString: adminUrl, max: 2 });
const svc = new PrefsService(pool);
const sfx = Math.random().toString(36).slice(2, 8);
const slugA = `pf-a-${sfx}`;
const slugB = `pf-b-${sfx}`;

async function mkUser(slug: string, sub: string): Promise<AuthedUser> {
  const r = await pool.query('SELECT org_id, user_id FROM provision_user($1,$2,$3,$4,$5,$6)', [slug, slug, sub, `${sub}@t.local`, sub, 'member']);
  return { sub, email: `${sub}@t.local`, name: sub, orgSlug: slug, role: 'member', orgId: r.rows[0].org_id, userId: r.rows[0].user_id };
}
const setPolicy = (u: AuthedUser, allowed: string[] | null, def = 'dashboard') =>
  admin.query(
    `INSERT INTO org_policies (org_id, default_style, allowed_styles) VALUES ($1, $2, $3)
     ON CONFLICT (org_id) DO UPDATE SET default_style = EXCLUDED.default_style, allowed_styles = EXCLUDED.allowed_styles`,
    [u.orgId, def, allowed],
  );

let a1: AuthedUser, a2: AuthedUser, b1: AuthedUser;
beforeAll(async () => {
  a1 = await mkUser(slugA, `a1-${sfx}`);
  a2 = await mkUser(slugA, `a2-${sfx}`);
  b1 = await mkUser(slugB, `b1-${sfx}`);
});
afterAll(async () => {
  await admin.query('DELETE FROM organizations WHERE slug IN ($1,$2)', [slugA, slugB]);
  await pool.end();
  await admin.end();
});

describe('the id lists are the design tokens lists', () => {
  it('styles and densities match packages/design-tokens', () => {
    expect([...STYLE_IDS]).toEqual([...TOKEN_STYLES]);
    expect([...DENSITY_IDS]).toEqual([...TOKEN_DENSITIES]);
  });
});

describe('request shape', () => {
  it.each([[{ style: 'rainbow' }], [{ theme: 'sepia' }], [{ lang: 'de' }], [{ density: 'tiny' }], [{ style: 5 }], [{ role: 'org_admin' }], [{ style: 'swiss', extra: 1 }], [[]], ['x'], [null]])(
    'refuses %j',
    (body) => {
      expect(patchSchema.safeParse(body).success).toBe(false);
    },
  );
  it('accepts a partial update and an explicit null (clear)', () => {
    expect(patchSchema.safeParse({ style: 'swiss' }).success).toBe(true);
    expect(patchSchema.safeParse({ style: null, density: 'compact' }).success).toBe(true);
    expect(patchSchema.safeParse({}).success).toBe(true);
  });
});

describe('policy shape', () => {
  const base = { requirePasscode: false, waitingRoomDefault: true, maxParticipants: 10, requireTotp: false, guestPolicy: 'off' };
  it('the default style must be among the allowed styles, and unknown styles are refused', () => {
    expect(policiesSchema.safeParse({ ...base, defaultStyle: 'swiss', allowedStyles: ['flat'] }).success).toBe(false);
    expect(policiesSchema.safeParse({ ...base, defaultStyle: 'flat', allowedStyles: ['flat', 'swiss'] }).success).toBe(true);
    expect(policiesSchema.safeParse({ ...base, allowedStyles: ['nope'] }).success).toBe(false);
    expect(policiesSchema.safeParse({ ...base, allowedStyles: [] }).success).toBe(false);
    expect(policiesSchema.safeParse({ ...base, defaultStyle: 'dashboard', allowedStyles: null }).success).toBe(true);
  });
});

describe('stored preferences', () => {
  it('start empty with the organization defaults, then keep what the person chose, per person', async () => {
    await setPolicy(a1, null);
    const empty = await svc.get(a1);
    expect(empty.prefs).toEqual({ lang: null, theme: null, style: null, density: null });
    expect(empty.org).toEqual({ defaultStyle: 'dashboard', defaultDensity: 'comfortable', allowedStyles: null });
    const set = await svc.set(a1, { lang: 'ru', theme: 'light', style: 'terminal', density: 'compact' });
    expect(set.prefs).toEqual({ lang: 'ru', theme: 'light', style: 'terminal', density: 'compact' });
    expect((await svc.get(a2)).prefs.style).toBeNull(); // another person of the same organization
    expect((await svc.get(b1)).prefs.style).toBeNull(); // another organization
  });

  it('a partial update keeps the other fields, null clears one', async () => {
    await setPolicy(a1, null);
    await svc.set(a1, { style: 'swiss' });
    expect((await svc.get(a1)).prefs).toMatchObject({ lang: 'ru', style: 'swiss' });
    await svc.set(a1, { style: null });
    expect((await svc.get(a1)).prefs.style).toBeNull();
    expect((await svc.get(a1)).prefs.lang).toBe('ru');
  });

  it('an empty update changes nothing', async () => {
    const before = await svc.get(a1);
    expect(await svc.set(a1, {})).toEqual(before);
  });

  it('a style outside the allowed list is refused (403) and nothing is stored', async () => {
    await setPolicy(a2, ['flat', 'swiss'], 'flat');
    await svc.set(a2, { style: 'flat' });
    await expect(svc.set(a2, { style: 'neobrutalism' })).rejects.toBeInstanceOf(PrefsError);
    await expect(svc.set(a2, { style: 'neobrutalism' })).rejects.toMatchObject({ status: 403 });
    expect((await svc.get(a2)).prefs.style).toBe('flat');
    expect((await svc.set(a2, { style: 'swiss', density: 'spacious' })).prefs).toMatchObject({ style: 'swiss', density: 'spacious' });
  });

  it('lowering the allowed list hides a stored style that is no longer allowed', async () => {
    await setPolicy(a2, null);
    await svc.set(a2, { style: 'aurora' });
    expect((await svc.get(a2)).prefs.style).toBe('aurora');
    await setPolicy(a2, ['flat'], 'flat');
    const v = await svc.get(a2);
    expect(v.prefs.style).toBeNull();
    expect(v.org.allowedStyles).toEqual(['flat']);
    expect(v.org.defaultStyle).toBe('flat');
  });

  it('rows are invisible to another organization and the database refuses bad values', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.current_org', $1, true)", [b1.orgId]);
      expect((await c.query('SELECT 1 FROM user_prefs')).rowCount).toBe(0);
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
    await expect(admin.query("INSERT INTO user_prefs (user_id, org_id, style) VALUES ($1, $2, 'Bad Style!')", [b1.userId, b1.orgId])).rejects.toThrow();
    await expect(admin.query("INSERT INTO user_prefs (user_id, org_id, theme) VALUES ($1, $2, 'sepia')", [b1.userId, b1.orgId])).rejects.toThrow();
  });
});
