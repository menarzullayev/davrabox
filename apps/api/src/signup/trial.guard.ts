import type { Pool } from 'pg';
import { loadPolicies } from '../admin/policies.js';
import { withTenant } from '../db/tenant.js';
import { MeetingError } from '../meetings/meetings.service.js';

export interface TrialStatus {
  trial: boolean;
  expired: boolean;
  endsAt: string | null;
  maxParticipants: number | null;
  maxMinutes: number | null;
}

export interface EffectiveLimits {
  trial: boolean;
  maxParticipants: number;
  /** Meeting length limit in minutes; null = no limit (not a trial). */
  maxMinutes: number | null;
}

/**
 * Trial rules of an organization, read from org_licenses (trial_ends_at, max_participants, max_meeting_minutes).
 * An organization without trial fields (a paid or hand-made one) is never limited by anything in here.
 */
export class TrialLimits {
  constructor(private readonly pool: Pool) {}

  async status(orgId: string): Promise<TrialStatus> {
    const row = await withTenant(this.pool, orgId, async (c) => {
      const r = await c.query('SELECT trial_ends_at, max_participants, max_meeting_minutes FROM org_licenses');
      return r.rows[0] as { trial_ends_at: Date | null; max_participants: number | null; max_meeting_minutes: number | null } | undefined;
    });
    if (!row || !row.trial_ends_at) return { trial: false, expired: false, endsAt: null, maxParticipants: null, maxMinutes: null };
    return {
      trial: true,
      expired: row.trial_ends_at.getTime() <= Date.now(),
      endsAt: row.trial_ends_at.toISOString(),
      maxParticipants: row.max_participants,
      maxMinutes: row.max_meeting_minutes,
    };
  }

  /** Throws MeetingError(402, 'trial expired') once the trial of this organization is over. */
  async assertTrialActive(orgId: string): Promise<void> {
    if ((await this.status(orgId)).expired) throw new MeetingError(402, 'trial expired');
  }

  /** The participant cap is the lower of the organization policy and the trial cap; the time limit exists for trials only. */
  async effectiveLimits(orgId: string): Promise<EffectiveLimits> {
    const [policy, st] = await Promise.all([withTenant(this.pool, orgId, (c) => loadPolicies(c)), this.status(orgId)]);
    return {
      trial: st.trial,
      maxParticipants: st.trial && st.maxParticipants ? Math.min(policy.maxParticipants, st.maxParticipants) : policy.maxParticipants,
      maxMinutes: st.trial ? st.maxMinutes : null,
    };
  }
}
