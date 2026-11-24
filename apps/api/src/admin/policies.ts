import type { PoolClient } from 'pg';
import { z } from 'zod';
import { DENSITY_IDS, STYLE_IDS } from '../prefs/ids.js';

export interface OrgPolicies {
  requirePasscode: boolean;
  waitingRoomDefault: boolean;
  maxParticipants: number;
  requireTotp: boolean;
  /** The most an organization lets hosts do about guests (people without an account): off < waiting_room < open. */
  guestPolicy: 'off' | 'waiting_room' | 'open';
  /** What a person who never chose a look gets, and the only looks people may pick (null = all of them). */
  defaultStyle: string;
  defaultDensity: string;
  allowedStyles: string[] | null;
}

export const DEFAULT_POLICIES: OrgPolicies = {
  requirePasscode: false,
  waitingRoomDefault: true,
  maxParticipants: 300,
  requireTotp: false,
  guestPolicy: 'off',
  defaultStyle: 'dashboard',
  defaultDensity: 'comfortable',
  allowedStyles: null,
};

export const policiesSchema = z
  .object({
    requirePasscode: z.boolean(),
    waitingRoomDefault: z.boolean(),
    maxParticipants: z.number().int().min(2).max(300),
    requireTotp: z.boolean(),
    guestPolicy: z.enum(['off', 'waiting_room', 'open']).default('off'),
    defaultStyle: z.enum(STYLE_IDS).default('dashboard'),
    defaultDensity: z.enum(DENSITY_IDS).default('comfortable'),
    allowedStyles: z.array(z.enum(STYLE_IDS)).min(1).max(STYLE_IDS.length).nullable().default(null),
  })
  .strict()
  .refine((p) => p.allowedStyles === null || p.allowedStyles.includes(p.defaultStyle), { message: 'the default style must be among the allowed styles' });

/** Reads the organization's policies inside a tenant transaction (RLS picks the org); defaults when never set. */
export async function loadPolicies(c: PoolClient): Promise<OrgPolicies> {
  const r = await c.query(
    'SELECT require_passcode, waiting_room_default, max_participants, require_totp, guest_policy, default_style, default_density, allowed_styles FROM org_policies',
  );
  const row = r.rows[0] as
    | { require_passcode: boolean; waiting_room_default: boolean; max_participants: number; require_totp: boolean; guest_policy: 'off' | 'waiting_room' | 'open'; default_style: string; default_density: string; allowed_styles: string[] | null }
    | undefined;
  if (!row) return { ...DEFAULT_POLICIES };
  return {
    requirePasscode: row.require_passcode,
    waitingRoomDefault: row.waiting_room_default,
    maxParticipants: row.max_participants,
    requireTotp: row.require_totp,
    guestPolicy: row.guest_policy,
    defaultStyle: row.default_style,
    defaultDensity: row.default_density,
    allowedStyles: row.allowed_styles,
  };
}
