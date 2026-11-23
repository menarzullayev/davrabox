import type { PoolClient } from 'pg';
import { z } from 'zod';

export interface OrgPolicies {
  requirePasscode: boolean;
  waitingRoomDefault: boolean;
  maxParticipants: number;
  requireTotp: boolean;
}

export const DEFAULT_POLICIES: OrgPolicies = {
  requirePasscode: false,
  waitingRoomDefault: true,
  maxParticipants: 300,
  requireTotp: false,
};

export const policiesSchema = z
  .object({
    requirePasscode: z.boolean(),
    waitingRoomDefault: z.boolean(),
    maxParticipants: z.number().int().min(2).max(300),
    requireTotp: z.boolean(),
  })
  .strict();

/** Reads the organization's policies inside a tenant transaction (RLS picks the org); defaults when never set. */
export async function loadPolicies(c: PoolClient): Promise<OrgPolicies> {
  const r = await c.query(
    'SELECT require_passcode, waiting_room_default, max_participants, require_totp FROM org_policies',
  );
  const row = r.rows[0] as
    | { require_passcode: boolean; waiting_room_default: boolean; max_participants: number; require_totp: boolean }
    | undefined;
  if (!row) return { ...DEFAULT_POLICIES };
  return {
    requirePasscode: row.require_passcode,
    waitingRoomDefault: row.waiting_room_default,
    maxParticipants: row.max_participants,
    requireTotp: row.require_totp,
  };
}
