import type { Pool } from 'pg';
import type { OrgUserCleaner } from '../admin/identity-admin.js';
import { TRIAL_GRACE_DAYS } from './limits.js';

/** Advisory-lock key: only one API instance purges at a time (a second instance simply skips its turn). */
export const RETENTION_LOCK = 'davrabox.trial_retention';

/**
 * Deletes trial organizations TRIAL_GRACE_DAYS (30) after their trial ended. purge_expired_trials() writes a
 * platform-level record before each delete (the organization's own audit rows go with it) and keeps the one-trial-per-mailbox
 * record, so a purged trial cannot simply be restarted with the same mailbox. Runs hourly.
 */
export class TrialRetentionJob {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly pool: Pool,
    private readonly users: OrgUserCleaner | null = null,
  ) {}

  /** One pass; returns the slugs it purged ([] when another instance holds the lock or nothing is due). */
  async runOnce(batch = 50): Promise<string[]> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const lock = await c.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS ok', [RETENTION_LOCK]);
      if (!lock.rows[0]?.ok) {
        await c.query('ROLLBACK');
        return [];
      }
      const r = await c.query('SELECT org_slug FROM purge_expired_trials($1, $2)', [TRIAL_GRACE_DAYS, batch]);
      await c.query('COMMIT');
      const slugs = r.rows.map((x: { org_slug: string }) => x.org_slug);
      // Personal data must not outlive the trial. Best effort: the slug is retired, so a leftover user cannot get in anyway.
      for (const slug of slugs) await this.users?.deleteUsersByOrgSlug(slug).catch((e: unknown) => console.error('trial user cleanup failed for', slug, e instanceof Error ? e.message : 'error'));
      return slugs;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }

  start(intervalMs = 3_600_000, firstRunMs = 60_000): void {
    if (this.timer) return;
    const tick = () => {
      void this.runOnce().catch((e: unknown) => console.error('trial retention failed:', e instanceof Error ? e.message : 'error'));
    };
    const first = setTimeout(tick, firstRunMs);
    first.unref();
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
