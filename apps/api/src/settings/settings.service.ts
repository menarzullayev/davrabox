import type { Pool, PoolClient } from 'pg';
import { loadPolicies } from '../admin/policies.js';
import type { AuthedUser } from '../auth/auth.guard.js';
import { withTenant } from '../db/tenant.js';
import { BY_KEY, PERSONAL, SETTINGS, effective, validValue, type Effective, type SettingDef, type SettingValue } from './catalog.js';

export class SettingsError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface SettingItem {
  key: string;
  group: SettingDef['group'];
  type: SettingDef['type'];
  options?: readonly string[];
  max?: number;
  min?: number;
  /** The value that applies to this person now. */
  value: SettingValue;
  /** The organization's value (default or locked), else the built-in default. */
  orgValue: SettingValue;
  locked: boolean;
}

export interface SettingsView {
  items: SettingItem[];
  /** Recording settings appear only while recording is on (decision 3). */
  recordingEnabled: boolean;
  /** Email notifications need the server's mail relay. */
  mailEnabled: boolean;
}

type OrgMap = Map<string, { value: SettingValue; locked: boolean }>;
const APPEARANCE = new Set(['style', 'theme', 'density']);

/**
 * Personal settings and organization defaults with locks (owner decisions 1-3). The existing organization policies keep
 * their meaning: "require a passcode" is a locked requirePasscode, the waiting-room default is the organization's default.
 */
export class SettingsService {
  constructor(
    private readonly pool: Pool,
    private readonly opts: { recordingEnabled: boolean; mailEnabled: boolean },
  ) {}

  async orgMap(c: PoolClient): Promise<OrgMap> {
    const map: OrgMap = new Map();
    const pol = await loadPolicies(c);
    map.set('waitingRoom', { value: pol.waitingRoomDefault, locked: false });
    if (pol.requirePasscode) map.set('requirePasscode', { value: true, locked: true });
    map.set('style', { value: pol.defaultStyle, locked: pol.allowedStyles?.length === 1 });
    map.set('density', { value: pol.defaultDensity, locked: false });
    const r = await c.query('SELECT key, value, locked FROM org_setting_defaults');
    for (const row of r.rows as Array<{ key: string; value: SettingValue; locked: boolean }>) {
      if (!BY_KEY.has(row.key)) continue;
      // The policy's passcode requirement cannot be weakened from here (it stays locked while the policy says so).
      if (row.key === 'requirePasscode' && pol.requirePasscode) continue;
      map.set(row.key, { value: row.value, locked: row.locked });
    }
    return map;
  }

  private async mine(c: PoolClient, userId: string): Promise<Map<string, SettingValue>> {
    const m = new Map<string, SettingValue>();
    const r = await c.query('SELECT key, value FROM user_settings WHERE user_id = $1', [userId]);
    for (const row of r.rows as Array<{ key: string; value: SettingValue }>) if (validValue(row.key, row.value) !== undefined) m.set(row.key, row.value);
    const p = await c.query('SELECT theme, style, density FROM user_prefs WHERE user_id = $1', [userId]);
    const pr = p.rows[0] as { theme: string | null; style: string | null; density: string | null } | undefined;
    if (pr?.theme) m.set('theme', pr.theme);
    if (pr?.style) m.set('style', pr.style);
    if (pr?.density) m.set('density', pr.density);
    return m;
  }

  /** The settings that apply to a person (in a tenant transaction). */
  async effectiveIn(c: PoolClient, userId: string): Promise<Effective> {
    return effective(await this.orgMap(c), await this.mine(c, userId));
  }

  async effectiveFor(orgId: string, userId: string): Promise<Effective> {
    return withTenant(this.pool, orgId, (c) => this.effectiveIn(c, userId));
  }

  /** Organization-only rules (join disclaimer, country list) of an organization. */
  async orgRules(orgId: string): Promise<{ joinDisclaimer: string; countryRule: string; countries: string[] }> {
    return withTenant(this.pool, orgId, async (c) => {
      const e = effective(await this.orgMap(c), new Map());
      return { joinDisclaimer: String(e['joinDisclaimer'] ?? ''), countryRule: String(e['countryRule'] ?? 'off'), countries: (e['countries'] as string[]) ?? [] };
    });
  }

  private visible(d: SettingDef): boolean {
    return !d.recording || this.opts.recordingEnabled;
  }

  async view(user: AuthedUser): Promise<SettingsView> {
    return withTenant(this.pool, user.orgId, async (c) => {
      const org = await this.orgMap(c);
      const eff = effective(org, await this.mine(c, user.userId));
      const items = SETTINGS.filter((d) => !d.orgOnly && this.visible(d)).map((d) => item(d, eff[d.key]!, org));
      return { items, recordingEnabled: this.opts.recordingEnabled, mailEnabled: this.opts.mailEnabled };
    });
  }

  /** The person's own values; a locked or organization-only setting is refused (403), a bad value too (400). */
  async setMine(user: AuthedUser, patch: Record<string, unknown>): Promise<SettingsView> {
    const entries = Object.entries(patch);
    if (!entries.length || entries.length > SETTINGS.length) throw new SettingsError(400, 'invalid_input', 'nothing to change');
    await withTenant(this.pool, user.orgId, async (c) => {
      const org = await this.orgMap(c);
      for (const [key, raw] of entries) {
        const d = BY_KEY.get(key);
        if (!d || d.orgOnly || !this.visible(d)) throw new SettingsError(400, 'unknown_setting', `unknown setting ${key}`);
        if (org.get(key)?.locked) throw new SettingsError(403, 'locked', `${key} is locked by your organization`);
        if (raw === null) {
          if (APPEARANCE.has(key)) await c.query(`UPDATE user_prefs SET ${key} = NULL, updated_at = now() WHERE user_id = $1`, [user.userId]);
          else await c.query('DELETE FROM user_settings WHERE user_id = $1 AND key = $2', [user.userId, key]);
          continue;
        }
        const v = validValue(key, raw);
        if (v === undefined) throw new SettingsError(400, 'invalid_value', `invalid value for ${key}`);
        if (APPEARANCE.has(key)) {
          // Appearance stays in user_prefs (the existing store all clients sync with); column names are from the fixed set.
          await c.query(`INSERT INTO user_prefs (user_id, org_id, ${key}) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO UPDATE SET ${key} = EXCLUDED.${key}, updated_at = now()`, [user.userId, user.orgId, v]);
        } else {
          await c.query(
            `INSERT INTO user_settings (user_id, org_id, key, value) VALUES ($1, $2, $3, $4::jsonb)
             ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
            [user.userId, user.orgId, key, JSON.stringify(v)],
          );
        }
      }
      await c.query('INSERT INTO audit_log (org_id, actor_id, action, target) VALUES ($1, $2, $3, $4)', [user.orgId, user.userId, 'settings.update', entries.map(([k]) => k).join(',')]);
    });
    return this.view(user);
  }

  /** The organization's defaults and locks, for the admin console (organization-only rules included). */
  async orgView(admin: AuthedUser): Promise<{ items: Array<SettingItem & { orgOnly: boolean; fromPolicy: boolean }>; recordingEnabled: boolean; mailEnabled: boolean }> {
    return withTenant(this.pool, admin.orgId, async (c) => {
      const org = await this.orgMap(c);
      const pol = await loadPolicies(c);
      const items = SETTINGS.filter((d) => this.visible(d)).map((d) => ({
        ...item(d, org.get(d.key)?.value ?? d.def, org),
        orgOnly: Boolean(d.orgOnly),
        // Governed by the Policies section (passcode requirement, allowed styles): shown, changed there.
        fromPolicy: (d.key === 'requirePasscode' && pol.requirePasscode) || d.key === 'style',
      }));
      return { items, recordingEnabled: this.opts.recordingEnabled, mailEnabled: this.opts.mailEnabled };
    });
  }

  async setOrg(admin: AuthedUser, patch: Record<string, unknown>): Promise<void> {
    const entries = Object.entries(patch);
    if (!entries.length || entries.length > SETTINGS.length) throw new SettingsError(400, 'invalid_input', 'nothing to change');
    await withTenant(this.pool, admin.orgId, async (c) => {
      for (const [key, raw] of entries) {
        const d = BY_KEY.get(key);
        if (!d || !this.visible(d) || key === 'style') throw new SettingsError(400, 'unknown_setting', `unknown setting ${key}`);
        if (raw === null) {
          await c.query('DELETE FROM org_setting_defaults WHERE key = $1', [key]);
          continue;
        }
        const r = raw as { value?: unknown; locked?: unknown };
        const v = validValue(key, r?.value);
        if (v === undefined || (r.locked !== undefined && typeof r.locked !== 'boolean')) throw new SettingsError(400, 'invalid_value', `invalid value for ${key}`);
        await c.query(
          `INSERT INTO org_setting_defaults (org_id, key, value, locked, updated_by) VALUES ($1, $2, $3::jsonb, $4, $5)
           ON CONFLICT (org_id, key) DO UPDATE SET value = EXCLUDED.value, locked = EXCLUDED.locked, updated_at = now(), updated_by = EXCLUDED.updated_by`,
          [admin.orgId, key, JSON.stringify(v), d.orgOnly ? true : r.locked === true, admin.userId],
        );
      }
      await c.query('INSERT INTO audit_log (org_id, actor_id, action, target) VALUES ($1, $2, $3, $4)', [
        admin.orgId,
        admin.userId,
        'admin.settings.update',
        entries.map(([k, v]) => `${k}${(v as { locked?: boolean } | null)?.locked ? ':locked' : ''}`).join(',').slice(0, 500),
      ]);
    });
  }

  /** Appearance locks for the prefs endpoint: which of theme/style/density are locked, and to what. */
  async appearanceLocks(c: PoolClient): Promise<Record<string, SettingValue>> {
    const org = await this.orgMap(c);
    const out: Record<string, SettingValue> = {};
    for (const k of APPEARANCE) if (org.get(k)?.locked) out[k] = org.get(k)!.value;
    return out;
  }
}

function item(d: SettingDef, value: SettingValue, org: OrgMap): SettingItem {
  const base: SettingItem = { key: d.key, group: d.group, type: d.type, value, orgValue: org.get(d.key)?.value ?? d.def, locked: Boolean(org.get(d.key)?.locked) };
  if (d.type === 'choice') base.options = d.options;
  if (d.type === 'text') base.max = d.max;
  if (d.type === 'int') Object.assign(base, { min: d.min, max: d.max });
  return base;
}

export { PERSONAL };
