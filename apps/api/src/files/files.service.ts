import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { CreateBucketCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { withTenant } from '../db/tenant.js';
import { s3ClientOptions } from '../common/timeouts.js';
import type { RateLimiter } from '../rate-limit/limiter.js';
import { RateLimitService } from '../rate-limit/service.js';
import type { Config } from '../config.js';
import type { AuthedUser } from '../auth/auth.guard.js';
import { MeetingError } from '../meetings/meetings.service.js';
import { scanBuffer } from './clamav.js';
import { gcmDecrypt, masterKeyFrom, sealWith, unwrapDataKeyWith } from './crypto.js';
import { KeyResolver, KeyUnavailableError } from '../byok/key-resolver.js';
import { MAX_FILE_BYTES, isBlockedName, sanitizeName } from './policy.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE_RE = /^[0-9]{11,12}$/;

export interface SharedFile {
  id: string;
  name: string;
  size: number;
}

/**
 * Files shared in a meeting chat. Upload path: authorize (the user must have really entered the meeting and not be
 * banned) -> size/name policy -> ClamAV scan (fail closed) -> envelope encryption -> object storage. Download streams
 * through the API so authorization is checked on every request, and is always an attachment.
 */
export class FilesService {
  private readonly s3?: S3Client;
  private readonly master?: Buffer;
  private readonly keys?: KeyResolver;
  private bucketReady = false;
  /** Set by the application module: the host's "file sending" setting for this person in this meeting. */
  fileSendingAllowed: ((user: AuthedUser, meetingId: string) => Promise<boolean>) | null = null;
  private readonly limiter: RateLimiter; // 20 uploads per minute per user

  constructor(private readonly pool: Pool, private readonly cfg: Config, rate: RateLimitService = RateLimitService.memory()) {
    this.limiter = rate.limiter({ name: 'upload', max: 20, windowMs: 60_000 });
    if (cfg.S3_ENDPOINT && cfg.S3_ACCESS_KEY && cfg.S3_SECRET_KEY && cfg.CLAMAV_HOST && cfg.FILE_MASTER_KEY) {
      this.master = masterKeyFrom(cfg.FILE_MASTER_KEY);
      this.keys = new KeyResolver(pool, this.master, { allowPrivate: cfg.BYOK_ALLOW_PRIVATE_VAULT });
      const { S3_ACCESS_KEY: accessKeyId, S3_SECRET_KEY: secretAccessKey } = cfg;
      this.s3 = new S3Client({ endpoint: cfg.S3_ENDPOINT, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId, secretAccessKey }, ...s3ClientOptions() });
    }
  }

  get enabled(): boolean {
    return Boolean(this.s3 && this.master);
  }

  private require(): { s3: S3Client; keys: KeyResolver } {
    if (!this.s3 || !this.keys) throw new MeetingError(503, 'file sharing is not configured');
    return { s3: this.s3, keys: this.keys };
  }

  /** The customer key could not be used: audit it (own transaction, it must survive the refusal) and refuse. Never a fallback. */
  private async keyRefused(user: AuthedUser, action: string, code: string, e: KeyUnavailableError): Promise<never> {
    await withTenant(this.pool, user.orgId, (c) =>
      c.query('INSERT INTO audit_log (org_id, actor_id, action, target) VALUES ($1, $2, $3, $4)', [user.orgId, user.userId, action, `${code}:kms_${e.reason}`]),
    );
    throw new MeetingError(e.status, e.status === 500 ? 'stored file failed its integrity check' : e.message);
  }

  private async ensureBucket(s3: S3Client): Promise<void> {
    if (this.bucketReady) return;
    try {
      await s3.send(new HeadBucketCommand({ Bucket: this.cfg.S3_BUCKET }));
    } catch {
      await s3.send(new CreateBucketCommand({ Bucket: this.cfg.S3_BUCKET }));
    }
    this.bucketReady = true;
  }

  /** The meeting row if the caller may use its files, otherwise throws. */
  private async authorize(user: AuthedUser, code: string): Promise<{ id: string; e2ee: boolean }> {
    if (!CODE_RE.test(code)) throw new MeetingError(404, 'meeting not found');
    return withTenant(this.pool, user.orgId, async (c) => {
      const r = await c.query(
        `SELECT m.id, m.e2ee,
                (m.host_user_id = $2 OR EXISTS (SELECT 1 FROM meeting_cohosts ch WHERE ch.meeting_id = m.id AND ch.user_id = $2)) AS manages,
                EXISTS (SELECT 1 FROM meeting_bans b WHERE b.meeting_id = m.id AND b.user_id = $2) AS banned,
                EXISTS (SELECT 1 FROM meeting_access a WHERE a.meeting_id = m.id AND a.user_id = $2) AS entered
         FROM meetings m WHERE m.code = $1`,
        [code, user.userId],
      );
      const row = r.rows[0] as { id: string; e2ee: boolean; manages: boolean; banned: boolean; entered: boolean } | undefined;
      if (!row) throw new MeetingError(404, 'meeting not found');
      const manages = row.manages || user.role === 'org_admin';
      if (row.banned && !manages) throw new MeetingError(403, 'removed from this meeting');
      if (!manages && !row.entered) throw new MeetingError(403, 'join the meeting first');
      return { id: row.id, e2ee: row.e2ee };
    });
  }

  async upload(user: AuthedUser, code: string, rawName: string, data: Buffer): Promise<SharedFile> {
    const { s3, keys } = this.require();
    const meeting = await this.authorize(user, code);
    // Files are stored by the server (envelope-encrypted with a server key), which contradicts the promise of an E2EE meeting.
    if (meeting.e2ee) throw new MeetingError(409, 'file sharing is turned off in end-to-end encrypted meetings');
    // "File sending" off in the host's settings: only the host side may share files.
    if (this.fileSendingAllowed && !(await this.fileSendingAllowed(user, meeting.id))) throw new MeetingError(403, 'file sending is turned off in this meeting', { code: 'files_off' });
    if (!(await this.limiter.hit(user.userId)).allowed) throw new MeetingError(429, 'too many uploads, try again in a minute'); // counts every attempt
    const name = sanitizeName(rawName);
    if (!name) throw new MeetingError(400, 'invalid file name');
    if (data.length === 0) throw new MeetingError(400, 'empty file');
    if (data.length > MAX_FILE_BYTES) throw new MeetingError(413, 'file too large');
    if (isBlockedName(name)) throw new MeetingError(415, 'this file type is not allowed');

    let scan;
    try {
      scan = await scanBuffer(data, this.cfg.CLAMAV_HOST!, this.cfg.CLAMAV_PORT);
    } catch {
      throw new MeetingError(503, 'antivirus is unavailable, the file was not stored');
    }
    if (!scan.clean) throw new MeetingError(422, 'the file was rejected by the antivirus');

    const id = randomUUID();
    let sealed;
    let kekId: string | null;
    try {
      const wrapper = await keys.wrapperForWrite(user.orgId);
      kekId = wrapper.kekId;
      sealed = await sealWith(wrapper, id, data);
    } catch (e) {
      if (e instanceof KeyUnavailableError) return this.keyRefused(user, 'file.upload.denied', code, e);
      throw e;
    }
    const { blob, wrappedKey } = sealed;
    const key = `${user.orgId}/${meeting.id}/${id}`;
    await this.ensureBucket(s3);
    await s3.send(new PutObjectCommand({ Bucket: this.cfg.S3_BUCKET, Key: key, Body: blob, ContentType: 'application/octet-stream' }));
    const sha = createHash('sha256').update(data).digest('hex');
    await withTenant(this.pool, user.orgId, async (c) => {
      await c.query(
        `INSERT INTO meeting_files (id, org_id, meeting_id, uploader_id, name, size_bytes, mime, sha256, object_key, wrapped_key, kek_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'application/octet-stream', $7, $8, $9, $10)`,
        [id, user.orgId, meeting.id, user.userId, name, data.length, sha, key, wrappedKey, kekId],
      );
      await c.query('INSERT INTO audit_log (org_id, actor_id, action, target) VALUES ($1, $2, $3, $4)', [user.orgId, user.userId, 'file.upload', `${code}:${id}`]);
    });
    return { id, name, size: data.length };
  }

  async download(user: AuthedUser, code: string, fileId: string): Promise<{ name: string; data: Buffer }> {
    const { s3, keys } = this.require();
    if (!UUID_RE.test(fileId)) throw new MeetingError(404, 'file not found');
    const meeting = await this.authorize(user, code);
    const row = await withTenant(this.pool, user.orgId, async (c) => {
      const r = await c.query('SELECT name, object_key, wrapped_key, kek_id FROM meeting_files WHERE id = $1 AND meeting_id = $2', [fileId, meeting.id]);
      return r.rows[0] as { name: string; object_key: string; wrapped_key: string; kek_id: string | null } | undefined;
    });
    if (!row) throw new MeetingError(404, 'file not found');
    // The data key is unwrapped first: with the customer key revoked nothing is fetched, and nothing falls back.
    let dataKey: Buffer;
    try {
      dataKey = await unwrapDataKeyWith(await keys.wrapperForRead(user.orgId, row.kek_id), fileId, row.wrapped_key);
    } catch (e) {
      if (e instanceof KeyUnavailableError) return this.keyRefused(user, 'file.download.denied', code, e);
      throw new MeetingError(500, 'stored file failed its integrity check');
    }
    const obj = await s3.send(new GetObjectCommand({ Bucket: this.cfg.S3_BUCKET, Key: row.object_key }));
    const blob = Buffer.from(await obj.Body!.transformToByteArray());
    let data: Buffer;
    try {
      data = gcmDecrypt(dataKey, blob, Buffer.from(fileId, 'utf8'));
    } catch {
      throw new MeetingError(500, 'stored file failed its integrity check');
    } finally {
      dataKey.fill(0);
    }
    await withTenant(this.pool, user.orgId, (c) =>
      c.query('INSERT INTO audit_log (org_id, actor_id, action, target) VALUES ($1, $2, $3, $4)', [user.orgId, user.userId, 'file.download', `${code}:${fileId}`]),
    );
    return { name: row.name, data };
  }
}
