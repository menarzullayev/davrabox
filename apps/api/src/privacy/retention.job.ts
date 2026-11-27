import type { Pool } from 'pg';
import type { Config } from '../config.js';
import { withTenant } from '../db/tenant.js';
import type { ObjectEraser } from './ports.js';
import type { PrivacyService } from './privacy.service.js';

/** Advisory-lock key: only one API instance applies retention at a time (a second one skips its turn). */
export const PRIVACY_RETENTION_LOCK = 'davrabox.privacy_retention';

const DAY_MS = 86_400_000;
/** An erasure request younger than this is probably still being worked on by the caller; the job leaves it alone. */
const RESUME_AFTER_MS = 5 * 60_000;
const BATCH = 200;
const MAX_ROUNDS = 25;

export interface RetentionSettings {
  recordingsDays: number;
  filesDays: number;
  signupEventsDays: number;
  /** Age of ended-meeting metadata. There is no ended_at column: a meeting counts from the later of created_at and scheduled_at. */
  meetingsDays: number;
}

export function retentionSettings(cfg: Config): RetentionSettings {
  return {
    recordingsDays: cfg.RETENTION_RECORDINGS_DAYS,
    filesDays: cfg.RETENTION_FILES_DAYS,
    signupEventsDays: cfg.RETENTION_SIGNUP_EVENTS_DAYS,
    meetingsDays: cfg.RETENTION_MEETINGS_DAYS,
  };
}

export interface RetentionDeps {
  /** Null = no object storage: no file or recording row is dropped (the objects might still exist) and the pass reports failures. */
  objects: ObjectEraser | null;
  /** Finishes erasure requests nobody retried. */
  erasure?: PrivacyService | null;
  /** The clock; tests move it. */
  now?: () => number;
  /** Restricts the pass to these organizations (tests share a database with other suites). Production leaves it unset. */
  onlyOrgs?: string[];
}

export interface RetentionReport {
  skipped: boolean;
  files: number;
  recordings: number;
  meetings: number;
  signupEvents: number;
  erasuresResumed: number;
  failures: number;
}

/**
 * Applies the retention periods hourly: uploaded files, recordings, ended-meeting metadata and sign-up events. The audit log
 * is NOT touched (the application role cannot even delete from it). Every cutoff is computed from the job's clock and passed
 * as a parameter. Object first, row second: a row is deleted only after its object is gone, so a failed pass is simply retried.
 */
export class PrivacyRetentionJob {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly pool: Pool, private readonly deps: RetentionDeps, private readonly settings: RetentionSettings) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  async runOnce(): Promise<RetentionReport> {
    const rep: RetentionReport = { skipped: false, files: 0, recordings: 0, meetings: 0, signupEvents: 0, erasuresResumed: 0, failures: 0 };
    const lockClient = await this.pool.connect();
    let locked = false;
    try {
      const l = await lockClient.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok', [PRIVACY_RETENTION_LOCK]);
      locked = Boolean(l.rows[0]?.ok);
      if (!locked) return { ...rep, skipped: true };

      const t = this.now();
      const cut = (days: number) => new Date(t - days * DAY_MS).toISOString();
      const orgs = (await this.pool.query<{ org_id: string }>('SELECT org_id FROM privacy_list_orgs()')).rows.map((r) => r.org_id);
      for (const orgId of orgs) {
        if (this.deps.onlyOrgs && !this.deps.onlyOrgs.includes(orgId)) continue;
        try {
          await this.sweepOrg(orgId, cut(this.settings.filesDays), cut(this.settings.recordingsDays), cut(this.settings.meetingsDays), rep);
        } catch (e) {
          rep.failures++;
          console.error('privacy retention failed for one organization:', e instanceof Error ? e.message : 'error');
        }
      }
      try {
        const r = await this.pool.query<{ n: number }>('SELECT privacy_purge_signup_events($1::timestamptz) AS n', [cut(this.settings.signupEventsDays)]);
        rep.signupEvents = r.rows[0]?.n ?? 0;
      } catch (e) {
        rep.failures++;
        console.error('privacy retention failed for sign-up events:', e instanceof Error ? e.message : 'error');
      }
      await this.resumeErasures(t, rep);
      return rep;
    } finally {
      if (locked) await lockClient.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [PRIVACY_RETENTION_LOCK]).catch(() => undefined);
      lockClient.release();
    }
  }

  private async sweepOrg(orgId: string, filesCut: string, recsCut: string, meetingsCut: string, rep: RetentionReport): Promise<void> {
    let files = 0;
    let recordings = 0;
    let meetings = 0;

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const rows = (await withTenant(this.pool, orgId, (c) =>
        c.query<{ id: string; object_key: string }>('SELECT id, object_key FROM meeting_files WHERE created_at < $1::timestamptz ORDER BY created_at LIMIT $2', [filesCut, BATCH]),
      )).rows;
      if (!rows.length) break;
      const gone = await this.eraseObjects(rows, (r) => [this.deps.objects!.deleteFileObject(r.object_key)], rep);
      if (gone.length) await withTenant(this.pool, orgId, (c) => c.query('DELETE FROM meeting_files WHERE id = ANY($1::uuid[])', [gone]));
      files += gone.length;
      if (gone.length < rows.length) break; // something could not be deleted: do not spin on it, the next pass retries
    }

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const rows = (await withTenant(this.pool, orgId, (c) =>
        c.query<{ id: string; object_key: string; staging_key: string }>(
          `SELECT id, object_key, staging_key FROM recordings
            WHERE status IN ('ready', 'failed') AND coalesce(ended_at, started_at) < $1::timestamptz ORDER BY started_at LIMIT $2`,
          [recsCut, BATCH],
        ),
      )).rows;
      if (!rows.length) break;
      const gone = await this.eraseObjects(rows, (r) => [this.deps.objects!.deleteRecordingObject(r.object_key), this.deps.objects!.deleteRecordingObject(r.staging_key)], rep);
      if (gone.length) await withTenant(this.pool, orgId, (c) => c.query('DELETE FROM recordings WHERE id = ANY($1::uuid[])', [gone]));
      recordings += gone.length;
      if (gone.length < rows.length) break;
    }

    // Metadata of meetings that are over. Meetings that still hold a file or recording row stay: deleting them would cascade
    // to those rows and leave their objects behind.
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const n = await withTenant(this.pool, orgId, async (c) => {
        const r = await c.query(
          `DELETE FROM meetings WHERE id IN (
             SELECT m.id FROM meetings m
              WHERE greatest(m.created_at, coalesce(m.scheduled_at, m.created_at)) < $1::timestamptz
                AND m.personal_owner IS NULL
                AND NOT EXISTS (SELECT 1 FROM meeting_sessions s WHERE s.meeting_id = m.id AND coalesce(s.ended_at, now()) >= $1::timestamptz)
                AND NOT EXISTS (SELECT 1 FROM meeting_files f WHERE f.meeting_id = m.id)
                AND NOT EXISTS (SELECT 1 FROM recordings x WHERE x.meeting_id = m.id)
              ORDER BY m.created_at LIMIT $2)`,
          [meetingsCut, BATCH],
        );
        return r.rowCount ?? 0;
      });
      meetings += n;
      if (n < BATCH) break;
    }

    // "Where you're signed in": what was seen of a sign-in session is kept 90 days after it was last seen.
    await withTenant(this.pool, orgId, (c) => c.query("DELETE FROM user_session_devices WHERE last_seen < now() - interval '90 days'"));

    // Runs of meetings ("Recent activity") age out like the meetings themselves; personal rooms keep only recent runs.
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const n = await withTenant(this.pool, orgId, async (c) => {
        const r = await c.query(
          `DELETE FROM meeting_sessions WHERE id IN (SELECT id FROM meeting_sessions WHERE ended_at < $1::timestamptz ORDER BY ended_at LIMIT $2)`,
          [meetingsCut, BATCH],
        );
        return r.rowCount ?? 0;
      });
      if (n < BATCH) break;
    }

    rep.files += files;
    rep.recordings += recordings;
    rep.meetings += meetings;
    if (files + recordings + meetings > 0) {
      await withTenant(this.pool, orgId, (c) =>
        c.query('INSERT INTO audit_log (org_id, actor_id, action, target) VALUES ($1, NULL, $2, $3)', [orgId, 'retention.purge', `files=${files},recordings=${recordings},meetings=${meetings}`]),
      );
    }
  }

  /** Deletes the objects of each row; returns the ids whose objects are all gone. Failures are counted, never thrown. */
  private async eraseObjects<T extends { id: string }>(rows: T[], deletions: (r: T) => Array<Promise<void>>, rep: RetentionReport): Promise<string[]> {
    if (!this.deps.objects) {
      rep.failures += rows.length;
      return [];
    }
    const gone: string[] = [];
    for (const r of rows) {
      try {
        await Promise.all(deletions(r));
        gone.push(r.id);
      } catch {
        rep.failures++;
      }
    }
    return gone;
  }

  private async resumeErasures(t: number, rep: RetentionReport): Promise<void> {
    const svc = this.deps.erasure;
    if (!svc) return;
    const pending = (await this.pool.query<{ org_id: string; user_id: string }>('SELECT org_id, user_id FROM privacy_pending_erasures($1::timestamptz, 50)', [new Date(t - RESUME_AFTER_MS).toISOString()])).rows;
    for (const p of pending) {
      if (this.deps.onlyOrgs && !this.deps.onlyOrgs.includes(p.org_id)) continue;
      try {
        if (await svc.completeErasure(p.org_id, p.user_id)) rep.erasuresResumed++;
      } catch (e) {
        rep.failures++;
        console.error('could not finish a pending erasure:', e instanceof Error ? e.message : 'error');
      }
    }
  }

  start(intervalMs = 3_600_000, firstRunMs = 90_000): void {
    if (this.timer) return;
    const tick = () => {
      void this.runOnce().catch((e: unknown) => console.error('privacy retention failed:', e instanceof Error ? e.message : 'error'));
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
