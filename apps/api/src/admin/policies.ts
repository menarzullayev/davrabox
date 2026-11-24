import type { PoolClient } from 'pg';
import { z } from 'zod';

export interface OrgPolicies {
  requirePasscode: boolean;
  waitingRoomDefault: boolean;
  maxParticipants: number;
  requireTotp: boolean;
  /** The most an organization lets hosts do about guests (people without an account): off < waiting_room < open. */
  guestPolicy: 'off' | 'waiting_room' | 'open';
}

export const DEFAULT_POLICIES: OrgPolicies = {
  requirePasscode: false,
  waitingRoomDefault: true,
  maxParticipants: 300,
  requireTotp: false,
  guestPolicy: 'off',
};

export const policiesSchema = z
  .object({
    requirePasscode: z.boolean(),
    waitingRoomDefault: z.boolean(),
    maxParticipants: z.number().int().min(2).max(300),
    requireTotp: z.boolean(),
    guestPolicy: z.enum(['off', 'waiting_room', 'open']).default('off'),
  })
  .strict();

/** Reads the organization's policies inside a tenant transaction (RLS picks the org); defaults when never set. */
export async function loadPolicies(c: PoolClient): Promise<OrgPolicies> {
  const r = await c.query(
    'SELECT require_passcode, waiting_room_default, max_participants, require_totp, guest_policy FROM org_policies',
  );
  const row = r.rows[0] as
    | { require_passcode: boolean; waiting_room_default: boolean; max_participants: number; require_totp: boolean; guest_policy: 'off' | 'waiting_room' | 'open' }
    | undefined;
  if (!row) return { ...DEFAULT_POLICIES };
  return {
    requirePasscode: row.require_passcode,
    waitingRoomDefault: row.waiting_room_default,
    maxParticipants: row.max_participants,
    requireTotp: row.require_totp,
    guestPolicy: row.guest_policy,
  };
}
