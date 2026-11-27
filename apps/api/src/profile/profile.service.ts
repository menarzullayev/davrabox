import { randomBytes } from 'node:crypto';
import { CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Pool, PoolClient } from 'pg';
import type { AuthedUser } from '../auth/auth.guard.js';
import type { Config } from '../config.js';
import { withTenant } from '../db/tenant.js';
import { scanBuffer } from '../files/clamav.js';
import { masterKeyFrom, openWith, platformWrapper, sealWith, type KeyWrapper } from '../files/crypto.js';
import { s3ClientOptions } from '../common/timeouts.js';
import type { RateLimiter } from '../rate-limit/limiter.js';
import { RateLimitService } from '../rate-limit/service.js';
import { avatarProblem, inspectImage } from './image.js';

export class ProfileError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ProfileView {
  name: string;
  email: string;
  jobTitle: string | null;
  departmentId: string | null;
  department: string | null;
  phone: string | null;
  timeZone: string | null;
  dateFormat: 'dmy' | 'mdy' | 'ymd' | null;
  timeFormat: '24h' | '12h' | null;
  avatarUrl: string | null;
  /** The organization's departments to choose from. */
  departments: Array<{ id: string; name: string }>;
}

export interface ProfilePatch {
  jobTitle?: string | null;
  departmentId?: string | null;
  phone?: string | null;
  timeZone?: string | null;
  dateFormat?: 'dmy' | 'mdy' | 'ymd' | null;
  timeFormat?: '24h' | '12h' | null;
}

/** What one person may see about another (owner decision 5). */
export interface PersonCard {
  id: string;
  name: string;
  avatarUrl: string | null;
  jobTitle?: string | null;
  department?: string | null;
  email?: string;
  phone?: string | null;
}

export const avatarUrl = (id: string | null): string | null => (id ? `/api/v1/avatars/${id}` : null);

let zones: Set<string> | null = null;
/** IANA time zones the runtime knows (plus UTC). */
export function isTimeZone(tz: string): boolean {
  if (!zones) {
    const list = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
    zones = new Set([...list, 'UTC']);
  }
  return zones.has(tz);
}

/**
 * The person's own profile (owner decision 2): job title, department, phone (never shown to other participants), time zone
 * and formats, and the picture. Name and email stay in the identity provider. Pictures are checked (type and size from
 * the bytes, square, at most 2 MB), scanned by ClamAV (fail closed), envelope-encrypted and stored under a random id.
 */
export class ProfileService {
  private readonly s3?: S3Client;
  private readonly wrapper?: KeyWrapper;
  private bucketReady = false;
  private readonly limiter: RateLimiter;

  constructor(
    private readonly pool: Pool,
    private readonly cfg: Config,
    rate: RateLimitService = RateLimitService.memory(),
  ) {
    this.limiter = rate.limiter({ name: 'avatar', max: 10, windowMs: 60 * 60_000 });
    if (cfg.S3_ENDPOINT && cfg.S3_ACCESS_KEY && cfg.S3_SECRET_KEY && cfg.CLAMAV_HOST && cfg.FILE_MASTER_KEY) {
      this.wrapper = platformWrapper(masterKeyFrom(cfg.FILE_MASTER_KEY));
      const { S3_ACCESS_KEY: accessKeyId, S3_SECRET_KEY: secretAccessKey } = cfg;
      this.s3 = new S3Client({ endpoint: cfg.S3_ENDPOINT, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId, secretAccessKey }, ...s3ClientOptions() });
    }
  }

  get avatarsEnabled(): boolean {
    return Boolean(this.s3 && this.wrapper);
  }

  async get(user: AuthedUser): Promise<ProfileView> {
    return withTenant(this.pool, user.orgId, async (c) => {
      const r = await c.query(
        `SELECT u.display_name, u.email, u.department_id, d.name AS department, p.job_title, p.phone, p.time_zone, p.date_format, p.time_format, p.avatar_id
           FROM users u LEFT JOIN departments d ON d.id = u.department_id LEFT JOIN user_profiles p ON p.user_id = u.id
          WHERE u.id = $1`,
        [user.userId],
      );
      const x = r.rows[0] as Record<string, string | null>;
      const deps = await c.query('SELECT id, name FROM departments ORDER BY lower(name)');
      return {
        name: x['display_name'] || user.name,
        email: x['email'] ?? user.email,
        jobTitle: x['job_title'] ?? null,
        departmentId: x['department_id'] ?? null,
        department: x['department'] ?? null,
        phone: x['phone'] ?? null,
        timeZone: x['time_zone'] ?? null,
        dateFormat: (x['date_format'] as ProfileView['dateFormat']) ?? null,
        timeFormat: (x['time_format'] as ProfileView['timeFormat']) ?? null,
        avatarUrl: avatarUrl(x['avatar_id'] ?? null),
        departments: deps.rows as Array<{ id: string; name: string }>,
      };
    });
  }

  async update(user: AuthedUser, patch: ProfilePatch): Promise<ProfileView> {
    if (patch.timeZone && !isTimeZone(patch.timeZone)) throw new ProfileError(400, 'invalid_time_zone', 'unknown time zone');
    await withTenant(this.pool, user.orgId, async (c) => {
      if (patch.departmentId !== undefined) {
        if (patch.departmentId !== null) {
          const d = await c.query('SELECT 1 FROM departments WHERE id = $1', [patch.departmentId]); // RLS: own organization only
          if (!d.rowCount) throw new ProfileError(400, 'invalid_department', 'unknown department');
        }
        await c.query('UPDATE users SET department_id = $2 WHERE id = $1', [user.userId, patch.departmentId]);
      }
      const cols: Array<[keyof ProfilePatch, string]> = [
        ['jobTitle', 'job_title'],
        ['phone', 'phone'],
        ['timeZone', 'time_zone'],
        ['dateFormat', 'date_format'],
        ['timeFormat', 'time_format'],
      ];
      const set = cols.filter(([k]) => patch[k] !== undefined);
      await this.ensureRow(c, user);
      if (set.length) {
        await c.query(
          `UPDATE user_profiles SET ${set.map(([, col], i) => `${col} = $${i + 2}`).join(', ')}, updated_at = now() WHERE user_id = $1`,
          [user.userId, ...set.map(([k]) => (typeof patch[k] === 'string' && (patch[k] as string).trim() === '' ? null : patch[k]))],
        );
      }
      const changed = [...set.map(([k]) => k), ...(patch.departmentId !== undefined ? ['departmentId'] : [])];
      if (changed.length) await this.audit(c, user, 'profile.update', changed.join(','));
    });
    return this.get(user);
  }

  async setAvatar(user: AuthedUser, data: Buffer): Promise<{ avatarUrl: string }> {
    if (!this.s3 || !this.wrapper) throw new ProfileError(503, 'avatars_off', 'pictures are not configured on this server');
    if (!(await this.limiter.hit(user.userId)).allowed) throw new ProfileError(429, 'rate_limited', 'too many pictures, try again later');
    const problem = avatarProblem(data);
    if (problem) throw new ProfileError(problem === 'too_large' ? 413 : 400, problem, 'the picture was not accepted');
    const scan = await scanBuffer(data, this.cfg.CLAMAV_HOST!, this.cfg.CLAMAV_PORT).catch(() => null);
    if (!scan) throw new ProfileError(503, 'scanner_unavailable', 'the virus scanner is not reachable');
    if (!scan.clean) throw new ProfileError(422, 'rejected', 'the picture was rejected by the antivirus');
    const mime = inspectImage(data)!.mime;
    const id = randomBytes(16).toString('hex');
    const key = `avatars/${user.orgId}/${user.userId}/${id}`;
    const { blob, wrappedKey } = await sealWith(this.wrapper, id, data);
    await this.ensureBucket();
    await this.s3.send(new PutObjectCommand({ Bucket: this.cfg.S3_BUCKET, Key: key, Body: blob, ContentType: 'application/octet-stream' }));
    const old = await withTenant(this.pool, user.orgId, async (c) => {
      await this.ensureRow(c, user);
      const prev = await c.query('SELECT avatar_object FROM user_profiles WHERE user_id = $1', [user.userId]);
      await c.query(
        'UPDATE user_profiles SET avatar_id = $2, avatar_object = $3, avatar_wrapped_key = $4, avatar_mime = $5, avatar_updated_at = now(), updated_at = now() WHERE user_id = $1',
        [user.userId, id, key, wrappedKey, mime],
      );
      await this.audit(c, user, 'profile.avatar.set', id);
      return (prev.rows[0] as { avatar_object: string | null } | undefined)?.avatar_object ?? null;
    });
    if (old) await this.s3.send(new DeleteObjectCommand({ Bucket: this.cfg.S3_BUCKET, Key: old })).catch(() => undefined);
    return { avatarUrl: avatarUrl(id)! };
  }

  async deleteAvatar(user: AuthedUser): Promise<void> {
    const old = await withTenant(this.pool, user.orgId, async (c) => {
      const prev = await c.query('SELECT avatar_object FROM user_profiles WHERE user_id = $1', [user.userId]);
      await c.query('UPDATE user_profiles SET avatar_id = NULL, avatar_object = NULL, avatar_wrapped_key = NULL, avatar_mime = NULL, avatar_updated_at = now() WHERE user_id = $1', [user.userId]);
      await this.audit(c, user, 'profile.avatar.delete', '');
      return (prev.rows[0] as { avatar_object: string | null } | undefined)?.avatar_object ?? null;
    });
    if (old && this.s3) await this.s3.send(new DeleteObjectCommand({ Bucket: this.cfg.S3_BUCKET, Key: old })).catch(() => undefined);
  }

  /** The picture behind a random id (public: the id itself is the capability). Null when there is none. */
  async avatar(id: string): Promise<{ mime: string; data: Buffer } | null> {
    if (!/^[0-9a-f]{32}$/.test(id) || !this.s3 || !this.wrapper) return null;
    const r = await this.pool.query('SELECT avatar_object, avatar_wrapped_key, avatar_mime FROM avatar_lookup($1)', [id]);
    const row = r.rows[0] as { avatar_object: string; avatar_wrapped_key: string; avatar_mime: string } | undefined;
    if (!row) return null;
    const obj = await this.s3.send(new GetObjectCommand({ Bucket: this.cfg.S3_BUCKET, Key: row.avatar_object }));
    const blob = Buffer.from(await obj.Body!.transformToByteArray());
    try {
      return { mime: row.avatar_mime, data: await openWith(this.wrapper, id, blob, row.avatar_wrapped_key) };
    } catch {
      return null; // integrity failure: show nothing rather than damaged bytes
    }
  }

  /** The current avatar id of a member (for the join token), or null. */
  async avatarIdOf(orgId: string, userId: string): Promise<string | null> {
    return withTenant(this.pool, orgId, async (c) => {
      const r = await c.query('SELECT avatar_id FROM user_profiles WHERE user_id = $1', [userId]);
      return (r.rows[0] as { avatar_id: string | null } | undefined)?.avatar_id ?? null;
    });
  }

  /**
   * Another person as the viewer may see them (owner decision 5): name and picture for everyone in the organization; job
   * title and department for members; email and phone only for organization admins. Other organizations get 404 (RLS).
   */
  async card(viewer: AuthedUser, userId: string): Promise<PersonCard> {
    if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new ProfileError(404, 'not_found', 'not found');
    return withTenant(this.pool, viewer.orgId, async (c) => {
      const r = await c.query(
        `SELECT u.id, u.display_name, u.email, u.erased_at, d.name AS department, p.job_title, p.phone, p.avatar_id
           FROM users u LEFT JOIN departments d ON d.id = u.department_id LEFT JOIN user_profiles p ON p.user_id = u.id
          WHERE u.id = $1`,
        [userId],
      );
      const x = r.rows[0] as Record<string, string | null> | undefined;
      if (!x || x['erased_at']) throw new ProfileError(404, 'not_found', 'not found');
      const card: PersonCard = { id: x['id']!, name: x['display_name'] ?? '', avatarUrl: avatarUrl(x['avatar_id'] ?? null), jobTitle: x['job_title'] ?? null, department: x['department'] ?? null };
      if (viewer.role === 'org_admin') {
        card.email = x['email'] ?? '';
        card.phone = x['phone'] ?? null;
      }
      return card;
    });
  }

  private async ensureRow(c: PoolClient, user: AuthedUser): Promise<void> {
    await c.query('INSERT INTO user_profiles (user_id, org_id) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING', [user.userId, user.orgId]);
  }

  private async ensureBucket(): Promise<void> {
    if (this.bucketReady || !this.s3) return;
    try {
      await this.s3.send(new HeadBucketCommand({ Bucket: this.cfg.S3_BUCKET }));
    } catch {
      await this.s3.send(new CreateBucketCommand({ Bucket: this.cfg.S3_BUCKET }));
    }
    this.bucketReady = true;
  }

  private audit(c: PoolClient, user: AuthedUser, action: string, target: string) {
    return c.query('INSERT INTO audit_log (org_id, actor_id, action, target) VALUES ($1, $2, $3, $4)', [user.orgId, user.userId, action, target]);
  }
}
