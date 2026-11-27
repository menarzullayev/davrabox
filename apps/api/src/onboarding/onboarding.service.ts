import type { Pool } from 'pg';
import { IdentityAdminError, type OnboardingIdentity } from '../admin/identity-admin.js';
import type { AuthedUser } from '../auth/auth.guard.js';
import { withTenant } from '../db/tenant.js';

/** The "Get started" steps (owner decision 5). invite and guests apply to administrators only. */
export const STEP_IDS = ['devices', 'invite', 'meeting', 'guests', 'email'] as const;
export type StepId = (typeof STEP_IDS)[number];

export interface OnboardingView {
  /** The steps that apply to this person, in display order, with their state. */
  steps: Array<{ id: StepId; done: boolean }>;
  dismissed: boolean;
  /** The provider's current answer; false when it cannot be asked. */
  emailVerified: boolean;
  /** Whether "send the verification link" can work here (the provider can send mail on our behalf). */
  canSendVerification: boolean;
}

export interface OnboardingPatch {
  devicesTested?: true;
  meetingJoined?: true;
  dismissed?: true;
}

export class OnboardingError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Derives the checklist from what really happened: another person in the organization (invite), a meeting the person hosted
 * or a call they were in (meeting), a saved organization policy (guests), the provider's email flag (email), and the device
 * check the person finished. Nothing here blocks anything: the card is optional and can be closed.
 */
export class OnboardingService {
  private mailCache: { at: number; value: boolean } | null = null;

  constructor(
    private readonly pool: Pool,
    private readonly identity: OnboardingIdentity | null,
  ) {}

  async get(user: AuthedUser): Promise<OnboardingView> {
    const row = await withTenant(this.pool, user.orgId, async (c) => {
      const r = await c.query(
        `SELECT
           (SELECT devices_tested_at IS NOT NULL FROM user_onboarding WHERE user_id = $1) AS devices,
           (SELECT meeting_joined_at IS NOT NULL FROM user_onboarding WHERE user_id = $1) AS joined,
           (SELECT dismissed_at IS NOT NULL FROM user_onboarding WHERE user_id = $1) AS dismissed,
           EXISTS (SELECT 1 FROM meetings WHERE host_user_id = $1) AS hosted,
           (SELECT count(*) FROM users) > 1 AS invited,
           EXISTS (SELECT 1 FROM audit_log WHERE action = 'admin.policy.update') AS guests`,
        [user.userId],
      );
      return r.rows[0] as { devices: boolean | null; joined: boolean | null; dismissed: boolean | null; hosted: boolean; invited: boolean; guests: boolean };
    });
    const emailVerified = await this.emailVerified(user);
    const admin = user.role === 'org_admin';
    const all: Array<{ id: StepId; done: boolean; admin: boolean }> = [
      { id: 'devices', done: row.devices === true, admin: false },
      { id: 'invite', done: row.invited, admin: true },
      { id: 'meeting', done: row.hosted || row.joined === true, admin: false },
      { id: 'guests', done: row.guests, admin: true },
      { id: 'email', done: emailVerified, admin: false },
    ];
    return {
      steps: all.filter((s) => admin || !s.admin).map(({ id, done }) => ({ id, done })),
      dismissed: row.dismissed === true,
      emailVerified,
      canSendVerification: await this.canSend(),
    };
  }

  async set(user: AuthedUser, patch: OnboardingPatch): Promise<OnboardingView> {
    if (patch.devicesTested || patch.meetingJoined || patch.dismissed) {
      await withTenant(this.pool, user.orgId, (c) =>
        // COALESCE keeps the first time a step was done; the flags only ever go from "not yet" to "done".
        c.query(
          `INSERT INTO user_onboarding (user_id, org_id, devices_tested_at, meeting_joined_at, dismissed_at)
           VALUES ($1, $2, CASE WHEN $3 THEN now() END, CASE WHEN $4 THEN now() END, CASE WHEN $5 THEN now() END)
           ON CONFLICT (user_id) DO UPDATE SET
             devices_tested_at = COALESCE(user_onboarding.devices_tested_at, EXCLUDED.devices_tested_at),
             meeting_joined_at = COALESCE(user_onboarding.meeting_joined_at, EXCLUDED.meeting_joined_at),
             dismissed_at      = COALESCE(user_onboarding.dismissed_at, EXCLUDED.dismissed_at),
             updated_at        = now()`,
          [user.userId, user.orgId, patch.devicesTested === true, patch.meetingJoined === true, patch.dismissed === true],
        ),
      );
    }
    return this.get(user);
  }

  /** Sends (again) the verification link to the person's own address. */
  async sendVerification(user: AuthedUser, redirectUri: string | null): Promise<void> {
    if (!this.identity) throw new OnboardingError(503, 'email_unavailable', 'email is not available on this server');
    if (await this.emailVerified(user)) throw new OnboardingError(409, 'already_verified', 'the email is already verified');
    try {
      await this.identity.sendVerifyEmail(user.sub, redirectUri);
    } catch (e) {
      if (e instanceof IdentityAdminError && e.status === 400) throw new OnboardingError(400, 'no_account', 'this account cannot receive a verification email');
      throw new OnboardingError(503, 'email_unavailable', 'the email could not be sent, please try again later');
    }
    await withTenant(this.pool, user.orgId, (c) =>
      c.query('INSERT INTO audit_log (org_id, actor_id, action, target) VALUES ($1, $2, $3, $4)', [user.orgId, user.userId, 'user.email.verify_sent', user.userId]),
    );
  }

  /** The realm's mail server, asked at most once a minute; unknown = assume it works (the send itself reports a failure). */
  private async canSend(): Promise<boolean> {
    if (!this.identity) return false;
    const now = Date.now();
    if (this.mailCache && now - this.mailCache.at < 60_000) return this.mailCache.value;
    let value = true;
    try {
      value = await this.identity.canSendEmail();
    } catch {
      value = true;
    }
    this.mailCache = { at: now, value };
    return value;
  }

  private async emailVerified(user: AuthedUser): Promise<boolean> {
    if (user.emailVerified) return true;
    if (!this.identity) return false;
    try {
      return await this.identity.emailVerified(user.sub);
    } catch {
      return false; // the provider is unreachable: show the step as not done rather than failing the whole card
    }
  }
}
