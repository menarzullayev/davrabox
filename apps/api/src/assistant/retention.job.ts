import { Logger } from '@nestjs/common';
import type { Pool } from 'pg';

/** Advisory-lock key: one API instance purges at a time. */
export const ASSISTANT_RETENTION_LOCK = 'davrabox.assistant_retention';
const DAY_MS = 86_400_000;

/**
 * Deletes help-assistant conversations whose last message is older than the retention period (decision 5d: 30 days),
 * hourly. The cutoff comes from the job's clock so that tests can move it.
 */
export class AssistantRetentionJob {
  private timer: NodeJS.Timeout | null = null;
  private readonly log = new Logger('AssistantRetention');

  constructor(private readonly pool: Pool, private readonly days: number, private readonly now: () => number = Date.now) {}

  async runOnce(): Promise<{ skipped: boolean; deleted: number }> {
    const c = await this.pool.connect();
    try {
      const lock = await c.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok', [ASSISTANT_RETENTION_LOCK]);
      if (!lock.rows[0]?.ok) return { skipped: true, deleted: 0 };
      try {
        const cutoff = new Date(this.now() - this.days * DAY_MS);
        const r = await c.query<{ n: number }>('SELECT assistant_purge($1) AS n', [cutoff]);
        return { skipped: false, deleted: r.rows[0]?.n ?? 0 };
      } finally {
        await c.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [ASSISTANT_RETENTION_LOCK]);
      }
    } finally {
      c.release();
    }
  }

  start(intervalMs = 3_600_000): void {
    if (this.timer) return;
    const tick = () => {
      this.runOnce().then(
        (r) => {
          if (r.deleted) this.log.log(`deleted ${r.deleted} help-assistant conversation(s) past retention`);
        },
        (e: Error) => this.log.warn(`retention pass failed: ${e.message}`),
      );
    };
    setTimeout(tick, 30_000).unref();
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
