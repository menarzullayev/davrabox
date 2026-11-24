import type { Pool, PoolClient } from 'pg';
import type { AuthedUser } from '../auth/auth.guard.js';
import type { RateLimiter } from '../rate-limit/limiter.js';
import { RateLimitService } from '../rate-limit/service.js';
import { IdentityAdminError } from '../admin/identity-admin.js';
import { withTenant } from '../db/tenant.js';
import type { CalendarRevoker, ObjectEraser, PrivacyIdentity } from './ports.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a tombstone holds. Constants: nothing in them derives from the person. */
export const ERASED_EMAIL = 'erased@erased.invalid';
export const ERASED_DISPLAY_NAME = 'Erased user';

/** Rows of the audit trail in an export (as actor). The export says when it was cut. */
export const EXPORT_AUDIT_CAP = 10_000;
const EXPORT_FORMAT = 'davrabox.personal-data-export.v1';

export class PrivacyError extends Error {
  constructor(public readonly status: number, message: string, public readonly headers: Record<string, string> = {}) {
    super(message);
  }
}

export interface PrivacyDeps {
  /** Null = identity provider admin access is not configured: erasure answers 503 (a half erasure would leave the account). */
  idp: PrivacyIdentity | null;
  /** Null = no object storage configured: erasure/retention refuse to drop rows whose objects might exist. */
  objects: ObjectEraser | null;
  calendar?: CalendarRevoker | null;
  now?: () => number;
  /** Shared limiter store (Redis-backed when configured); defaults to an in-process one. */
  rate?: RateLimitService;
  exportsPerHour?: number;
  erasuresPerHour?: number;
}

export interface Removed {
  files: number;
  recordings: number;
  calendarConnections: number;
  apiKeysRevoked: number;
  webhookEndpoints: number;
}

export interface ErasureResult {
  status: 'erased';
  userId: string;
  alreadyErased: boolean;
  removed: Removed;
}

interface TargetRow {
  id: string;
  email: string;
  role: 'org_admin' | 'member';
  disabled: boolean;
  external_sub: string;
  erasure_requested_at: Date | null;
  erased_at: Date | null;
}

const NO_REMOVED: Removed = { files: 0, recordings: 0, calendarConnections: 0, apiKeysRevoked: 0, webhookEndpoints: 0 };

function audit(c: PoolClient, orgId: string, actorId: string | null, action: string, target: string) {
  return c.query('INSERT INTO audit_log (org_id, actor_id, action, target) VALUES ($1, $2, $3, $4)', [orgId, actorId, action, target.slice(0, 500)]);
}

function mapIdp(e: unknown): unknown {
  if (e instanceof IdentityAdminError) return new PrivacyError(e.status, e.message);
  return e;
}

/**
 * Data-subject rights: export of a person's data and erasure by anonymisation.
 *
 * Erasure order is chosen so that every failure is retryable by the same call (and, for a request nobody retries, by the
 * hourly job): 1. the request is recorded (users.erasure_requested_at, audited once); 2. object storage and calendar grants,
 * the data that is easiest to leave behind; 3. the identity-provider account (after this the person cannot sign in); 4. one
 * transaction writes the tombstone and revokes keys. A failure in 2 or 3 leaves the account usable so the person can retry.
 * audit_log is never modified: the tombstone keeps the user id, so actor references stay valid and the hash chain keeps verifying.
 */
export class PrivacyService {
  private readonly exportLimiter: RateLimiter;
  private readonly eraseLimiter: RateLimiter;

  constructor(private readonly pool: Pool, private readonly deps: PrivacyDeps) {
    const rate = deps.rate ?? RateLimitService.memory({ now: deps.now });
    this.exportLimiter = rate.limiter({ name: 'privacy-export', max: deps.exportsPerHour ?? 5, windowMs: 3_600_000 });
    this.eraseLimiter = rate.limiter({ name: 'privacy-erase', max: deps.erasuresPerHour ?? 20, windowMs: 3_600_000 });
  }

  private authorize(actor: AuthedUser, targetId: string): void {
    if (!UUID_RE.test(targetId)) throw new PrivacyError(404, 'user not found');
    if (targetId !== actor.userId && actor.role !== 'org_admin') throw new PrivacyError(403, 'organization admin role required');
  }

  private async limit(l: RateLimiter, actor: AuthedUser, what: string): Promise<void> {
    const d = await l.hit(actor.userId);
    if (!d.allowed) throw new PrivacyError(429, `too many ${what} requests, try again later`, { 'Retry-After': String(d.retryAfterSec) });
  }

  // --- export ------------------------------------------------------------------------------------------------------

  /** The person's own data as one JSON document. Secrets (tokens, key hashes, wrapped keys, object keys) are never included. */
  async exportUser(actor: AuthedUser, targetId: string): Promise<Record<string, unknown>> {
    this.authorize(actor, targetId);
    await this.limit(this.exportLimiter, actor, 'export');
    const now = this.deps.now?.() ?? Date.now();
    return withTenant(this.pool, actor.orgId, async (c) => {
      const u = await c.query(
        `SELECT u.id, u.email, u.display_name, u.role, u.disabled, u.created_at, u.external_sub, u.erased_at, d.name AS department
           FROM users u LEFT JOIN departments d ON d.id = u.department_id WHERE u.id = $1`,
        [targetId],
      );
      const p = u.rows[0];
      if (!p) throw new PrivacyError(404, 'user not found'); // RLS hides other organizations
      if (p.erased_at) throw new PrivacyError(410, 'this account has been erased');
      const q = async (sql: string) => (await c.query(sql, [targetId])).rows;
      const hosted = await q(`SELECT code, title, scheduled_at, created_at, waiting_room, locked, e2ee FROM meetings WHERE host_user_id = $1 ORDER BY created_at`);
      const joined = await q(
        `SELECT m.code, m.title, a.first_at FROM meeting_access a JOIN meetings m ON m.id = a.meeting_id WHERE a.user_id = $1 ORDER BY a.first_at`,
      );
      const requests = await q(
        `SELECT m.code, j.status, j.created_at, j.decided_at FROM join_requests j JOIN meetings m ON m.id = j.meeting_id WHERE j.user_id = $1 ORDER BY j.created_at`,
      );
      const cohost = await q(`SELECT m.code, ch.created_at FROM meeting_cohosts ch JOIN meetings m ON m.id = ch.meeting_id WHERE ch.user_id = $1 ORDER BY ch.created_at`);
      const files = await q(
        `SELECT f.id, m.code AS meeting_code, f.name, f.size_bytes, f.sha256, f.created_at FROM meeting_files f JOIN meetings m ON m.id = f.meeting_id WHERE f.uploader_id = $1 ORDER BY f.created_at`,
      );
      const recordings = await q(
        `SELECT r.id, m.code AS meeting_code, r.status, r.started_at, r.ended_at, r.size_bytes FROM recordings r JOIN meetings m ON m.id = r.meeting_id WHERE r.started_by = $1 ORDER BY r.started_at`,
      );
      const calendar = await q(`SELECT provider, scope, created_at, updated_at FROM calendar_connections WHERE user_id = $1 ORDER BY provider`);
      const keys = await q(`SELECT name, prefix, scopes, created_at, last_used_at, revoked_at FROM api_keys WHERE created_by = $1 ORDER BY created_at`);
      const hooks = await q(`SELECT id, url, events, created_at FROM webhook_endpoints WHERE created_by = $1 ORDER BY created_at`);
      const trail = await c.query(
        `SELECT created_at, action, target FROM audit_log WHERE actor_id = $1 ORDER BY id LIMIT ${EXPORT_AUDIT_CAP + 1}`,
        [targetId],
      );
      await audit(c, actor.orgId, actor.userId, 'privacy.export', targetId);
      const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : d);
      return {
        format: EXPORT_FORMAT,
        exportedAt: new Date(now).toISOString(),
        scope: 'Data held about this person only. Other people are not included; secrets (tokens, key hashes, wrapped keys, storage keys) are never exported.',
        profile: {
          id: p.id,
          email: p.email,
          displayName: p.display_name,
          role: p.role,
          department: p.department,
          disabled: p.disabled,
          createdAt: iso(p.created_at),
          identityProviderSubject: p.external_sub,
        },
        meetingsHosted: hosted.map((m) => ({ code: m.code, title: m.title, scheduledAt: iso(m.scheduled_at), createdAt: iso(m.created_at), waitingRoom: m.waiting_room, locked: m.locked, e2ee: m.e2ee })),
        meetingsJoined: joined.map((m) => ({ code: m.code, title: m.title, firstJoinedAt: iso(m.first_at) })),
        joinRequests: requests.map((r) => ({ meetingCode: r.code, status: r.status, requestedAt: iso(r.created_at), decidedAt: iso(r.decided_at) })),
        coHostOf: cohost.map((r) => ({ meetingCode: r.code, since: iso(r.created_at) })),
        files: files.map((f) => ({ id: f.id, meetingCode: f.meeting_code, name: f.name, sizeBytes: Number(f.size_bytes), sha256: f.sha256, uploadedAt: iso(f.created_at) })),
        recordings: recordings.map((r) => ({ id: r.id, meetingCode: r.meeting_code, status: r.status, startedAt: iso(r.started_at), endedAt: iso(r.ended_at), sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes) })),
        calendarConnections: calendar.map((r) => ({ provider: r.provider, connected: true, scope: r.scope, connectedAt: iso(r.created_at), updatedAt: iso(r.updated_at) })),
        apiKeys: keys.map((k) => ({ name: k.name, prefix: k.prefix, scopes: k.scopes, createdAt: iso(k.created_at), lastUsedAt: iso(k.last_used_at), revokedAt: iso(k.revoked_at) })),
        // Only the host name of a webhook URL: the path of an endpoint often carries a secret token.
        webhookEndpoints: hooks.map((h) => ({ id: h.id, host: safeHost(h.url), events: h.events, createdAt: iso(h.created_at) })),
        auditAsActor: trail.rows.slice(0, EXPORT_AUDIT_CAP).map((a) => ({ at: iso(a.created_at), action: a.action, target: a.target })),
        auditAsActorTruncated: trail.rows.length > EXPORT_AUDIT_CAP,
      };
    });
  }

  // --- erasure -----------------------------------------------------------------------------------------------------

  /**
   * Erases (anonymises) one person. `confirm` must be the person's e-mail address: a typed confirmation is checked on the
   * server, so a stray click or a script that does not know the address cannot destroy an account. Idempotent.
   */
  async eraseUser(actor: AuthedUser, targetId: string, confirm: string): Promise<ErasureResult> {
    this.authorize(actor, targetId);
    await this.limit(this.eraseLimiter, actor, 'erasure');

    const target = await withTenant(this.pool, actor.orgId, async (c) => {
      const r = await c.query<TargetRow>(
        'SELECT id, email, role, disabled, external_sub, erasure_requested_at, erased_at FROM users WHERE id = $1 FOR UPDATE',
        [targetId],
      );
      const t = r.rows[0];
      if (!t) throw new PrivacyError(404, 'user not found'); // RLS hides other organizations
      if (t.erased_at) return t;
      if (!this.deps.idp) throw new PrivacyError(503, 'identity provider admin access is not configured');
      if (confirm.trim().toLowerCase() !== t.email.trim().toLowerCase()) {
        throw new PrivacyError(400, 'the confirmation does not match the e-mail address of the account');
      }
      const running = await c.query("SELECT 1 FROM recordings WHERE started_by = $1 AND status NOT IN ('ready', 'failed') LIMIT 1", [targetId]);
      if (running.rowCount) throw new PrivacyError(409, 'a recording started by this person is still running: stop it first');
      if (t.erasure_requested_at === null) {
        if (t.role === 'org_admin' && !t.disabled) {
          const others = await c.query(
            `SELECT id FROM users WHERE role = 'org_admin' AND NOT disabled AND erased_at IS NULL AND erasure_requested_at IS NULL AND id <> $1 FOR UPDATE`,
            [targetId],
          );
          if (!others.rowCount) {
            throw new PrivacyError(409, 'the last organization admin cannot be erased: make another member an admin first, or close the organization');
          }
        }
        await c.query('UPDATE users SET erasure_requested_at = now() WHERE id = $1', [targetId]);
        await audit(c, actor.orgId, actor.userId, 'privacy.erasure.requested', `${targetId}:${targetId === actor.userId ? 'self' : 'admin'}`);
      }
      return t;
    });

    if (target.erased_at) return { status: 'erased', userId: targetId, alreadyErased: true, removed: { ...NO_REMOVED } };
    const removed = await this.perform(actor.orgId, actor.orgSlug, target.id, target.external_sub, actor.userId);
    return { status: 'erased', userId: targetId, alreadyErased: false, removed };
  }

  /** Finishes a request that was recorded but not completed (called by the hourly job; no confirmation, it was given before). */
  async completeErasure(orgId: string, userId: string): Promise<boolean> {
    const info = await withTenant(this.pool, orgId, async (c) => {
      const r = await c.query<{ id: string; external_sub: string; erased_at: Date | null; erasure_requested_at: Date | null; slug: string }>(
        `SELECT u.id, u.external_sub, u.erased_at, u.erasure_requested_at, o.slug FROM users u JOIN organizations o ON o.id = u.org_id WHERE u.id = $1`,
        [userId],
      );
      return r.rows[0];
    });
    if (!info || info.erased_at || !info.erasure_requested_at) return false;
    if (!this.deps.idp) throw new PrivacyError(503, 'identity provider admin access is not configured');
    await this.perform(orgId, info.slug, info.id, info.external_sub, null);
    return true;
  }

  private async perform(orgId: string, orgSlug: string, userId: string, sub: string, actorId: string | null): Promise<Removed> {
    const idp = this.deps.idp!;
    const stored = await this.removeStored(orgId, userId);
    try {
      await this.deps.calendar?.revokeAll(orgId, userId);
    } catch {
      /* best effort: the stored grants are deleted below either way */
    }
    try {
      await idp.eraseUser(sub, orgSlug);
    } catch (e) {
      await withTenant(this.pool, orgId, (c) => audit(c, orgId, actorId, 'privacy.erasure.failed', `${userId}:identity_provider`)).catch(() => undefined);
      throw mapIdp(e);
    }
    return withTenant(this.pool, orgId, async (c) => {
      const keys = await c.query('UPDATE api_keys SET revoked_at = now() WHERE created_by = $1 AND revoked_at IS NULL', [userId]);
      const hooks = await c.query('DELETE FROM webhook_endpoints WHERE created_by = $1', [userId]);
      await c.query('DELETE FROM user_prefs WHERE user_id = $1', [userId]); // display choices go with the person
      const cal = await c.query('DELETE FROM calendar_connections WHERE user_id = $1', [userId]);
      await c.query('SELECT privacy_purge_user_oauth_states($1, $2)', [orgId, userId]);
      await c.query(
        `UPDATE users SET email = $2, display_name = $3, role = 'member', disabled = true, department_id = NULL, erased_at = now() WHERE id = $1`,
        [userId, ERASED_EMAIL, ERASED_DISPLAY_NAME],
      );
      const removed: Removed = {
        files: stored.files,
        recordings: stored.recordings,
        calendarConnections: cal.rowCount ?? 0,
        apiKeysRevoked: keys.rowCount ?? 0,
        webhookEndpoints: hooks.rowCount ?? 0,
      };
      await audit(
        c,
        orgId,
        actorId,
        'privacy.erasure.completed',
        `${userId}:files=${removed.files},recordings=${removed.recordings},calendar=${removed.calendarConnections},keys=${removed.apiKeysRevoked},webhooks=${removed.webhookEndpoints}`,
      );
      return removed;
    });
  }

  /** Objects first, rows after: a row is dropped only once its objects are gone, so a failure can always be retried. */
  private async removeStored(orgId: string, userId: string): Promise<{ files: number; recordings: number }> {
    const { files, recs } = await withTenant(this.pool, orgId, async (c) => ({
      files: (await c.query<{ id: string; object_key: string }>('SELECT id, object_key FROM meeting_files WHERE uploader_id = $1', [userId])).rows,
      recs: (await c.query<{ id: string; object_key: string; staging_key: string }>('SELECT id, object_key, staging_key FROM recordings WHERE started_by = $1', [userId])).rows,
    }));
    if ((files.length || recs.length) && !this.deps.objects) throw new PrivacyError(503, 'object storage is not configured');
    const objects = this.deps.objects;
    const goneFiles: string[] = [];
    const goneRecs: string[] = [];
    let failed = false;
    for (const f of files) {
      try {
        await objects!.deleteFileObject(f.object_key);
        goneFiles.push(f.id);
      } catch {
        failed = true;
      }
    }
    for (const r of recs) {
      try {
        await objects!.deleteRecordingObject(r.object_key);
        await objects!.deleteRecordingObject(r.staging_key); // the plaintext copy, if it is still there
        goneRecs.push(r.id);
      } catch {
        failed = true;
      }
    }
    await withTenant(this.pool, orgId, async (c) => {
      if (goneFiles.length) await c.query('DELETE FROM meeting_files WHERE id = ANY($1::uuid[])', [goneFiles]);
      if (goneRecs.length) await c.query('DELETE FROM recordings WHERE id = ANY($1::uuid[])', [goneRecs]);
    });
    if (failed) throw new PrivacyError(502, 'object storage could not delete every file, try again');
    return { files: goneFiles.length, recordings: goneRecs.length };
  }
}

function safeHost(url: unknown): string | null {
  try {
    return new URL(String(url)).hostname;
  } catch {
    return null;
  }
}
