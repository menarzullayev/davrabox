import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Pool, PoolClient } from 'pg';
import { withTenant } from '../db/tenant.js';
import type { AuthedUser } from '../auth/auth.guard.js';
import { MeetingError } from '../meetings/meetings.service.js';
import { decryptStream, encryptStream } from './recording-crypto.js';
import { newDataKeyWith, unwrapDataKeyWith } from '../files/crypto.js';
import { KeyResolver, KeyUnavailableError } from '../byok/key-resolver.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE_RE = /^[0-9]{11,12}$/;

export type EgressState = 'active' | 'complete' | 'failed';

/** The media server side: LiveKit room metadata and Egress. Faked in tests; LiveKitMedia in production. */
export interface MediaPort {
  /** Sets or clears the `recording` flag in the room metadata that every participant (also late joiners) can read. */
  setRecordingFlag(room: string, on: boolean): Promise<void>;
  /** Starts a room composite recording written as MP4 to `key` in the recordings bucket. */
  startRoomComposite(room: string, key: string): Promise<{ egressId: string }>;
  stop(egressId: string): Promise<void>;
  status(egressId: string): Promise<{ state: EgressState }>;
}

export interface ObjectStore {
  ensure(): Promise<void>;
  get(key: string): Promise<Readable>;
  put(key: string, body: Readable, length: number): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface RecordingDeps {
  media: MediaPort;
  store: ObjectStore;
  master: Buffer;
  /** Finds the key that wraps each recording's data key: the organization's own key (BYOK) or the master key. Defaults to a resolver on `master`. */
  keys?: KeyResolver;
  /** Pause between polls of a stopped recording (default 3 s). */
  settleDelayMs?: number;
  /** After this long a recording whose file never arrives is marked failed (default 15 min). */
  settleMaxMs?: number;
}

export interface RecordingSummary {
  id: string;
  status: string;
  startedAt: Date;
  endedAt: Date | null;
  sizeBytes: number | null;
  startedBy: string;
}

interface MeetingInfo {
  id: string;
  title: string;
  e2ee: boolean;
  host_user_id: string;
  manages: boolean;
  entered: boolean;
}

interface RecRow {
  id: string;
  org_id: string;
  meeting_id: string;
  egress_id: string | null;
  status: string;
  staging_key: string;
  object_key: string;
  wrapped_key: string | null;
  updated_at: Date;
}

const IN_FLIGHT = ['starting', 'active', 'stopping'];
const STALE_STARTING_SQL = "interval '2 minutes'";
const STALE_PROCESSING_SQL = "interval '10 minutes'";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function safeFileName(title: string, at: Date): string {
  const base = title.replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^[._]+|[._]+$/g, '').slice(0, 60) || 'recording';
  return `${base}-${at.toISOString().slice(0, 10)}.mp4`;
}

/**
 * Meeting recording. Only the host, a co-host or an organization admin may start, stop, list or download; E2EE meetings
 * refuse recording. The consent flag in the room metadata is set BEFORE Egress starts and a recording never runs without it.
 * Egress writes a plaintext MP4 to a staging key; once it is complete the file is envelope-encrypted (recording-crypto.ts)
 * into its final key and the plaintext is deleted. Only the encrypted object can be downloaded, streamed and decrypted on
 * the fly, so authorization is checked on every request. Every action, including each refusal, is audited.
 */
export class RecordingService {
  private readonly settleDelay: number;
  private readonly settleMax: number;
  private readonly watchers = new Set<string>();
  private readonly keys: KeyResolver | null;

  constructor(private readonly pool: Pool, private readonly deps: RecordingDeps | null) {
    this.keys = deps ? (deps.keys ?? new KeyResolver(pool, deps.master)) : null;
    this.settleDelay = deps?.settleDelayMs ?? 3000;
    this.settleMax = deps?.settleMaxMs ?? 15 * 60_000;
  }

  /** Set by the application module: the host's "My settings" (recording group). */
  hostSettings: ((orgId: string, hostUserId: string) => Promise<Record<string, unknown>>) | null = null;

  get enabled(): boolean {
    return this.deps !== null;
  }

  private require(): RecordingDeps {
    if (!this.deps) throw new MeetingError(503, 'recording is not configured');
    return this.deps;
  }

  // --- API ------------------------------------------------------------------------------------------------------

  /** What the call screen needs: whether recording is available and whether one is running. Participants only. */
  async status(user: AuthedUser, code: string): Promise<{ enabled: boolean; e2ee: boolean; active: boolean; canRecord: boolean }> {
    const m = await this.meeting(user, code);
    if (!m.manages && !m.entered) throw new MeetingError(403, 'join the meeting first');
    const active = await withTenant(this.pool, user.orgId, async (c) => {
      const r = await c.query("SELECT 1 FROM recordings WHERE meeting_id = $1 AND status = 'active'", [m.id]);
      return (r.rowCount ?? 0) > 0;
    });
    return { enabled: this.enabled, e2ee: m.e2ee, active, canRecord: this.enabled && m.manages && !m.e2ee };
  }

  async start(user: AuthedUser, code: string, opts: { confirmed?: boolean } = {}): Promise<{ id: string; status: string }> {
    const { media, store } = this.require();
    const m = await this.meeting(user, code);
    if (!m.manages) await this.refuse(user, 'recording.start.denied', code, 'forbidden', 403, 'only the host can do this');
    // Host settings (recording group): who may record, and an explicit confirmation before recording starts.
    const hs = this.hostSettings ? await this.hostSettings(user.orgId, m.host_user_id) : null;
    if (hs?.['whoMayRecord'] === 'host' && m.host_user_id !== user.userId && user.role !== 'org_admin') await this.refuse(user, 'recording.start.denied', code, 'host_only', 403, 'only the host may record this meeting');
    if (hs?.['confirmRecording'] === true && !opts.confirmed) throw new MeetingError(428, 'confirm that the meeting will be recorded', { code: 'confirm_recording' });
    if (m.e2ee) await this.refuse(user, 'recording.start.denied', code, 'e2ee', 409, 'end-to-end encrypted meetings cannot be recorded');

    // Never record into a customer key that cannot wrap the result: refuse before anything starts.
    try {
      await this.keys!.assertUsable(user.orgId);
    } catch (e) {
      if (e instanceof KeyUnavailableError) await this.refuse(user, 'recording.start.denied', code, `kms_${e.reason}`, e.status, e.message);
      throw e;
    }

    // A recording whose Egress ended by itself must not block the next one.
    for (const old of await this.inFlight(user.orgId, m.id)) await this.settle(user.orgId, old);

    const id = randomUUID();
    const staging = `staging/${user.orgId}/${m.id}/${id}.mp4`;
    const finalKey = `${user.orgId}/${m.id}/${id}.enc`;
    try {
      await withTenant(this.pool, user.orgId, (c) =>
        c.query(
          `INSERT INTO recordings (id, org_id, meeting_id, status, staging_key, object_key, started_by) VALUES ($1, $2, $3, 'starting', $4, $5, $6)`,
          [id, user.orgId, m.id, staging, finalKey, user.userId],
        ),
      );
    } catch (e) {
      if ((e as { code?: string }).code === '23505') await this.refuse(user, 'recording.start.denied', code, 'already_recording', 409, 'this meeting is already being recorded');
      throw e;
    }

    try {
      await store.ensure();
      await media.setRecordingFlag(m.id, true); // consent flag first: nobody is ever recorded without the badge
    } catch {
      await this.fail(user.orgId, id, null);
      throw new MeetingError(502, 'the recording service is unavailable');
    }
    let egressId: string;
    try {
      ({ egressId } = await media.startRoomComposite(m.id, staging));
    } catch (e) {
      await this.fail(user.orgId, id, m.id);
      if (/not found|does not exist/i.test((e as Error).message)) throw new MeetingError(409, 'the meeting is not live yet');
      throw new MeetingError(502, 'the recording service is unavailable');
    }
    await withTenant(this.pool, user.orgId, async (c) => {
      await c.query("UPDATE recordings SET status = 'active', egress_id = $2, updated_at = now() WHERE id = $1", [id, egressId]);
      await this.audit(c, user, 'recording.start', `${code}:${id}`);
    });
    return { id, status: 'active' };
  }

  async stop(user: AuthedUser, code: string): Promise<{ id: string; status: string }> {
    const { media } = this.require();
    const m = await this.meeting(user, code);
    if (!m.manages) await this.refuse(user, 'recording.stop.denied', code, 'forbidden', 403, 'only the host can do this');
    const rec = await withTenant(this.pool, user.orgId, async (c) => {
      const r = await c.query("SELECT id, egress_id FROM recordings WHERE meeting_id = $1 AND status = 'active'", [m.id]);
      return r.rows[0] as { id: string; egress_id: string } | undefined;
    });
    if (!rec) throw new MeetingError(404, 'no recording is running');
    try {
      await media.stop(rec.egress_id);
    } catch {
      // Already ended on its own: settle() below picks the file up either way.
    }
    await withTenant(this.pool, user.orgId, async (c) => {
      await c.query("UPDATE recordings SET status = 'stopping', updated_at = now() WHERE id = $1 AND status = 'active'", [rec.id]);
      await this.audit(c, user, 'recording.stop', `${code}:${rec.id}`);
    });
    await this.clearFlag(m.id);
    this.watch(user.orgId, rec.id);
    return { id: rec.id, status: 'stopping' };
  }

  /**
   * The "Recordings" section of the app: finished recordings of the meetings this person manages (host or co-host; an
   * organization admin sees the organization's). Works while recording is switched off too (enabled=false), so the page
   * can say so instead of showing an empty list that looks broken. Downloads go through download(), which checks again.
   */
  async mine(user: AuthedUser): Promise<{ enabled: boolean; items: Array<{ id: string; meetingCode: string; title: string; startedAt: Date; endedAt: Date | null; sizeBytes: number | null }> }> {
    const items = await withTenant(this.pool, user.orgId, async (c) => {
      const r = await c.query(
        `SELECT r.id, m.code, m.title, r.started_at, r.ended_at, r.size_bytes::float8 AS size_bytes
           FROM recordings r JOIN meetings m ON m.id = r.meeting_id
          WHERE r.status = 'ready'
            AND ($2 OR m.host_user_id = $1 OR EXISTS (SELECT 1 FROM meeting_cohosts ch WHERE ch.meeting_id = m.id AND ch.user_id = $1))
          ORDER BY r.started_at DESC LIMIT 100`,
        [user.userId, user.role === 'org_admin'],
      );
      return r.rows.map((x) => ({ id: x.id as string, meetingCode: x.code as string, title: x.title as string, startedAt: x.started_at as Date, endedAt: x.ended_at as Date | null, sizeBytes: x.size_bytes as number | null }));
    });
    return { enabled: this.enabled, items };
  }

  async list(user: AuthedUser, code: string): Promise<RecordingSummary[]> {
    this.require();
    const m = await this.meeting(user, code);
    if (!m.manages) await this.refuse(user, 'recording.list.denied', code, 'forbidden', 403, 'only the host can do this');
    for (const id of await this.inFlight(user.orgId, m.id)) await this.settle(user.orgId, id);
    return withTenant(this.pool, user.orgId, async (c) => {
      const r = await c.query(
        `SELECT id, status, started_at, ended_at, size_bytes::float8 AS size_bytes, started_by FROM recordings
         WHERE meeting_id = $1 ORDER BY started_at DESC LIMIT 100`,
        [m.id],
      );
      await this.audit(c, user, 'recording.list', code);
      return r.rows.map((x) => ({ id: x.id, status: x.status, startedAt: x.started_at, endedAt: x.ended_at, sizeBytes: x.size_bytes, startedBy: x.started_by }));
    });
  }

  async download(user: AuthedUser, id: string): Promise<{ name: string; stream: Readable }> {
    const { store } = this.require();
    if (!UUID_RE.test(id)) throw new MeetingError(404, 'recording not found');
    const row = await withTenant(this.pool, user.orgId, async (c) => {
      const r = await c.query(
        `SELECT r.id, r.status, r.object_key, r.wrapped_key, r.started_at, m.id AS meeting_id, m.code, m.title,
                (m.host_user_id = $2 OR EXISTS (SELECT 1 FROM meeting_cohosts ch WHERE ch.meeting_id = m.id AND ch.user_id = $2)) AS manages
         FROM recordings r JOIN meetings m ON m.id = r.meeting_id WHERE r.id = $1`,
        [id, user.userId],
      );
      return r.rows[0] as { id: string; status: string; object_key: string; wrapped_key: string | null; started_at: Date; meeting_id: string; code: string; title: string; manages: boolean } | undefined;
    });
    if (!row) throw new MeetingError(404, 'recording not found'); // also another organization's recording (RLS)
    if (!(row.manages || user.role === 'org_admin')) await this.refuse(user, 'recording.download.denied', row.code, id, 403, 'only the host can do this');
    if (row.status === 'stopping' || row.status === 'active' || row.status === 'processing') await this.settle(user.orgId, id).catch(() => undefined);
    const fresh = await withTenant(this.pool, user.orgId, async (c) => (await c.query('SELECT status, wrapped_key, kek_id FROM recordings WHERE id = $1', [id])).rows[0] as { status: string; wrapped_key: string | null; kek_id: string | null });
    if (fresh.status !== 'ready' || !fresh.wrapped_key) throw new MeetingError(409, fresh.status === 'failed' ? 'the recording failed' : 'the recording is not ready yet');
    let dataKey: Buffer;
    try {
      dataKey = await unwrapDataKeyWith(await this.keys!.wrapperForRead(user.orgId, fresh.kek_id), id, fresh.wrapped_key);
    } catch (e) {
      // The customer key is disabled, revoked, unreachable or not the one this recording was written with: stop, never fall back.
      if (e instanceof KeyUnavailableError) await this.refuse(user, 'recording.download.denied', row.code, `kms_${e.reason}`, e.status, e.status === 500 ? 'the recording failed its integrity check' : e.message);
      throw new MeetingError(500, 'the recording failed its integrity check');
    }
    let src: Readable;
    try {
      src = await store.get(row.object_key);
    } catch {
      throw new MeetingError(404, 'recording not found');
    }
    await withTenant(this.pool, user.orgId, (c) => this.audit(c, user, 'recording.download', `${row.code}:${id}`));
    const out = decryptStream(dataKey, id);
    src.on('error', (e) => out.destroy(e));
    out.on('close', () => src.destroy());
    src.pipe(out);
    return { name: safeFileName(row.title, row.started_at), stream: out };
  }

  // --- finishing a recording -------------------------------------------------------------------------------------

  /** Drives one recording until it is ready or failed (waiting while Egress finishes or another caller processes it). */
  async settleNow(orgId: string, id: string, timeoutMs = 60_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const s = await this.settle(orgId, id);
      if (s === 'ready' || s === 'failed') return s;
      if (Date.now() > deadline) throw new Error(`recording is still ${s}`);
      await sleep(50);
    }
  }

  /** Polls a stopped recording in the background until it is ready, failed or too old. */
  private watch(orgId: string, id: string): void {
    if (this.watchers.has(id)) return;
    this.watchers.add(id);
    const deadline = Date.now() + this.settleMax;
    const tick = async () => {
      let done = false;
      try {
        const s = await this.settle(orgId, id);
        done = s === 'ready' || s === 'failed';
        if (!done && Date.now() > deadline) {
          await this.fail(orgId, id, null);
          done = true;
        }
      } catch {
        done = Date.now() > deadline;
      }
      if (done) this.watchers.delete(id);
      else setTimeout(() => void tick(), this.settleDelay).unref();
    };
    setTimeout(() => void tick(), this.settleDelay).unref();
  }

  private async inFlight(orgId: string, meetingId: string): Promise<string[]> {
    return withTenant(this.pool, orgId, async (c) => {
      const r = await c.query('SELECT id FROM recordings WHERE meeting_id = $1 AND status = ANY($2)', [meetingId, IN_FLIGHT]);
      return r.rows.map((x: { id: string }) => x.id);
    });
  }

  /** Moves one recording forward if Egress has finished. Returns the status afterwards. */
  private async settle(orgId: string, id: string): Promise<string> {
    const { media } = this.require();
    const row = await withTenant(this.pool, orgId, async (c) => {
      // Rows abandoned by a crash: a start that never finished, an encryption that never completed.
      await c.query(`UPDATE recordings SET status = 'failed', updated_at = now() WHERE id = $1 AND status = 'starting' AND updated_at < now() - ${STALE_STARTING_SQL}`, [id]);
      await c.query(`UPDATE recordings SET status = 'stopping', updated_at = now() WHERE id = $1 AND status = 'processing' AND updated_at < now() - ${STALE_PROCESSING_SQL}`, [id]);
      return (await c.query('SELECT * FROM recordings WHERE id = $1', [id])).rows[0] as RecRow | undefined;
    });
    if (!row) throw new MeetingError(404, 'recording not found');
    if (row.status !== 'active' && row.status !== 'stopping') return row.status;
    if (!row.egress_id) {
      await this.fail(orgId, id, row.meeting_id);
      return 'failed';
    }
    let state: EgressState;
    try {
      state = (await media.status(row.egress_id)).state;
    } catch {
      return row.status; // media server unreachable: try again later
    }
    if (state === 'active') return row.status;
    if (state === 'failed') {
      await this.fail(orgId, id, row.meeting_id);
      return 'failed';
    }
    if (row.status === 'active') await this.clearFlag(row.meeting_id); // Egress ended on its own: the badge must go too
    return this.finalize(orgId, row);
  }

  private async finalize(orgId: string, row: RecRow): Promise<string> {
    const { store } = this.require();
    const claimed = await withTenant(this.pool, orgId, async (c) => {
      const r = await c.query("UPDATE recordings SET status = 'processing', updated_at = now() WHERE id = $1 AND status IN ('active', 'stopping') RETURNING id", [row.id]);
      return (r.rowCount ?? 0) > 0;
    });
    if (!claimed) return 'processing';
    const tmp = join(tmpdir(), `davra-rec-${row.id}.enc`);
    try {
      const wrapper = await this.keys!.wrapperForWrite(orgId);
      const { dataKey, wrappedKey } = await newDataKeyWith(wrapper, row.id);
      let plainBytes = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _e, cb) {
          plainBytes += chunk.length;
          cb(null, chunk);
        },
      });
      await pipeline(await store.get(row.staging_key), counter, encryptStream(dataKey, row.id), createWriteStream(tmp));
      const size = (await stat(tmp)).size;
      await store.put(row.object_key, createReadStream(tmp), size);
      await store.delete(row.staging_key); // from here on only ciphertext exists
      await withTenant(this.pool, orgId, (c) =>
        c.query("UPDATE recordings SET status = 'ready', wrapped_key = $2, kek_id = $4, size_bytes = $3, ended_at = now(), updated_at = now() WHERE id = $1", [row.id, wrappedKey, plainBytes, wrapper.kekId]),
      );
      return 'ready';
    } catch (e) {
      if (e instanceof KeyUnavailableError) {
        await this.auditSystem(orgId, e.status === 503 ? 'recording.encrypt.unavailable' : 'recording.encrypt.denied', `${row.id}:kms_${e.reason}`, e.status === 503);
        if (e.status !== 503) {
          // The customer key is gone: the recording cannot be protected the way the organization chose, so it is dropped
          // (with its plaintext staging file) rather than stored under the platform key.
          await this.fail(orgId, row.id, row.meeting_id);
          return 'failed';
        }
      }
      // Retryable: back to 'stopping' (the staging file is kept); watch() gives up and marks it failed after settleMaxMs.
      await withTenant(this.pool, orgId, (c) => c.query("UPDATE recordings SET status = 'stopping', updated_at = now() WHERE id = $1 AND status = 'processing'", [row.id]));
      return 'stopping';
    } finally {
      await unlink(tmp).catch(() => undefined);
    }
  }

  /** Marks a recording failed, removes any plaintext it left behind and, when given a meeting, clears the consent flag. */
  private async fail(orgId: string, id: string, clearFlagFor: string | null): Promise<void> {
    const row = await withTenant(this.pool, orgId, async (c) => {
      const r = await c.query("UPDATE recordings SET status = 'failed', ended_at = now(), updated_at = now() WHERE id = $1 AND status <> 'ready' RETURNING staging_key, object_key, meeting_id", [id]);
      return r.rows[0] as { staging_key: string; object_key: string; meeting_id: string } | undefined;
    });
    if (!row) return;
    if (this.deps) {
      await this.deps.store.delete(row.staging_key).catch(() => undefined);
      await this.deps.store.delete(row.object_key).catch(() => undefined);
    }
    if (clearFlagFor) await this.clearFlag(clearFlagFor);
  }

  private async clearFlag(meetingId: string): Promise<void> {
    if (!this.deps) return;
    for (let i = 0; i < 3; i++) {
      try {
        await this.deps.media.setRecordingFlag(meetingId, false);
        return;
      } catch {
        await sleep(200);
      }
    }
  }

  // --- helpers ---------------------------------------------------------------------------------------------------

  private async meeting(user: AuthedUser, code: string): Promise<MeetingInfo> {
    if (!CODE_RE.test(code)) throw new MeetingError(404, 'meeting not found');
    return withTenant(this.pool, user.orgId, async (c) => {
      const r = await c.query(
        `SELECT m.id, m.title, m.e2ee, m.host_user_id,
                (m.host_user_id = $2 OR EXISTS (SELECT 1 FROM meeting_cohosts ch WHERE ch.meeting_id = m.id AND ch.user_id = $2)) AS manages,
                EXISTS (SELECT 1 FROM meeting_access a WHERE a.meeting_id = m.id AND a.user_id = $2) AS entered
         FROM meetings m WHERE m.code = $1`,
        [code, user.userId],
      );
      const row = r.rows[0] as MeetingInfo | undefined;
      if (!row) throw new MeetingError(404, 'meeting not found');
      return { ...row, manages: row.manages || user.role === 'org_admin' };
    });
  }

  /** Writes the audit row in its own transaction (so it survives the refusal) and throws the refusal. */
  private async refuse(user: AuthedUser, action: string, code: string, reason: string, status: number, message: string): Promise<never> {
    await withTenant(this.pool, user.orgId, (c) => this.audit(c, user, action, `${code}:${reason}`));
    throw new MeetingError(status, message);
  }

  /** An audit row with no acting user (background work). `once` skips it when the same row already exists. */
  private async auditSystem(orgId: string, action: string, target: string, once: boolean): Promise<void> {
    await withTenant(this.pool, orgId, (c) =>
      c.query(
        `INSERT INTO audit_log (org_id, actor_id, action, target) SELECT $1, NULL, $2, $3 WHERE NOT ($4 AND EXISTS (SELECT 1 FROM audit_log WHERE org_id = $1 AND action = $2 AND target = $3))`,
        [orgId, action, target, once],
      ),
    ).catch(() => undefined);
  }

  private audit(c: PoolClient, user: AuthedUser, action: string, target: string) {
    return c.query('INSERT INTO audit_log (org_id, actor_id, action, target) VALUES ($1, $2, $3, $4)', [user.orgId, user.userId, action, target]);
  }
}
