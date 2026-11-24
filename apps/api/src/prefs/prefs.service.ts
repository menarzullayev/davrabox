import type { Pool } from 'pg';
import { withTenant } from '../db/tenant.js';
import { loadPolicies } from '../admin/policies.js';
import type { AuthedUser } from '../auth/auth.guard.js';

export interface StoredPrefs {
  lang: string | null;
  theme: string | null;
  style: string | null;
  density: string | null;
}
export interface PrefsView {
  prefs: StoredPrefs;
  org: { defaultStyle: string; defaultDensity: string; allowedStyles: string[] | null };
}
export type PrefsPatch = Partial<StoredPrefs>;

export class PrefsError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

const COLUMNS = ['lang', 'theme', 'style', 'density'] as const;

export class PrefsService {
  constructor(private readonly pool: Pool) {}

  async get(user: AuthedUser): Promise<PrefsView> {
    return withTenant(this.pool, user.orgId, async (c) => {
      const r = await c.query('SELECT lang, theme, style, density FROM user_prefs WHERE user_id = $1', [user.userId]);
      const pol = await loadPolicies(c);
      const row = (r.rows[0] ?? { lang: null, theme: null, style: null, density: null }) as StoredPrefs;
      // A style the organization no longer allows is never handed out: the person gets the organization's default instead.
      const style = row.style && (pol.allowedStyles === null || pol.allowedStyles.includes(row.style)) ? row.style : null;
      return { prefs: { ...row, style }, org: { defaultStyle: pol.defaultStyle, defaultDensity: pol.defaultDensity, allowedStyles: pol.allowedStyles } };
    });
  }

  /** Stores the given fields (null clears one). A style outside the organization's allowed list is refused. */
  async set(user: AuthedUser, patch: PrefsPatch): Promise<PrefsView> {
    const cols = COLUMNS.filter((k) => k in patch);
    if (cols.length) {
      await withTenant(this.pool, user.orgId, async (c) => {
        if (patch.style) {
          const pol = await loadPolicies(c);
          if (pol.allowedStyles !== null && !pol.allowedStyles.includes(patch.style)) throw new PrefsError(403, 'this style is not allowed by your organization');
        }
        // Column names come from the fixed COLUMNS list above, never from the request.
        const names = cols.join(', ');
        const params = cols.map((_, i) => `$${i + 3}`).join(', ');
        const updates = cols.map((k) => `${k} = EXCLUDED.${k}`).join(', ');
        await c.query(
          `INSERT INTO user_prefs (user_id, org_id, ${names}) VALUES ($1, $2, ${params})
           ON CONFLICT (user_id) DO UPDATE SET ${updates}, updated_at = now()`,
          [user.userId, user.orgId, ...cols.map((k) => patch[k] ?? null)],
        );
      });
    }
    return this.get(user);
  }
}
