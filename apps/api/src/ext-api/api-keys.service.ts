import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { withTenant } from '../db/tenant.js';
import type { AuthedUser } from '../auth/auth.guard.js';
import { ExtError, type ExtConfig } from './ext-config.js';

export const API_KEY_SCOPES = ['meetings:read', 'meetings:write', 'users:read'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];
export const MAX_ACTIVE_KEYS_PER_ORG = 20;

const KEY_RE = /^dbx_([0-9a-f]{8})_([A-Za-z0-9_-]{43})$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// API key secrets are 256-bit random values, not user passwords: a fast keyed hash is the right tool (a slow password hash
// would only add latency to every request). The fixed key is a domain-separation label, not a secret.
const KEY_HASH_LABEL = 'davrabox.ext-api.key.v1';

export function hashSecret(secret: string): Buffer {
  return createHmac('sha256', KEY_HASH_LABEL).update(secret, 'utf8').digest();
}

/** Compared against when the prefix is unknown, so a lookup miss costs the same as a wrong secret. */
export const DUMMY_HASH = randomBytes(32); // random per process: nothing can ever hash to it

/** Constant-time comparison of a presented secret with a stored SHA-256 hash. */
export function secretMatches(secret: string, storedHash: Buffer): boolean {
  const presented = hashSecret(secret);
  const stored = storedHash.length === presented.length ? storedHash : DUMMY_HASH; // timingSafeEqual needs equal lengths
  return timingSafeEqual(presented, stored) && stored === storedHash;
}

export interface GeneratedKey {
  prefix: string;
  secret: string; // the 43-character secret part
  hash: Buffer;
  token: string; // dbx_<prefix>_<secret>: the only form a client ever sees, once
}

export function generateApiKey(): GeneratedKey {
  const prefix = randomBytes(4).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  return { prefix, secret, hash: hashSecret(secret), token: `dbx_${prefix}_${secret}` };
}

export function parseApiKey(token: string): { prefix: string; secret: string } | null {
  const m = KEY_RE.exec(token);
  return m ? { prefix: m[1]!, secret: m[2]! } : null;
}

export interface ApiPrincipal {
  keyId: string;
  orgId: string;
  prefix: string;
  scopes: ApiKeyScope[];
  createdBy: string;
}

export interface ApiKeyItem {
  id: string;
  name: string;
  prefix: string;
  scopes: ApiKeyScope[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

interface KeyRow {
  id: string;
  name: string;
  prefix: string;
  scopes: ApiKeyScope[];
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

function toItem(r: KeyRow): ApiKeyItem {
  return {
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    scopes: r.scopes,
    createdAt: r.created_at.toISOString(),
    lastUsedAt: r.last_used_at ? r.last_used_at.toISOString() : null,
    revokedAt: r.revoked_at ? r.revoked_at.toISOString() : null,
  };
}

function audit(c: PoolClient, user: AuthedUser, action: string, target: string) {
  return c.query('INSERT INTO audit_log (org_id, actor_id, action, target) VALUES ($1, $2, $3, $4)', [user.orgId, user.userId, action, target]);
}

export class ApiKeysService {
  constructor(private readonly pool: Pool, private readonly cfg: Pick<ExtConfig, 'EXT_API_RATE_PER_MINUTE'>) {}

  /** Creates a key. The full token is in the result and nowhere else: only its hash and prefix are stored. */
  async create(user: AuthedUser, input: { name: string; scopes: ApiKeyScope[] }): Promise<ApiKeyItem & { secret: string }> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const key = generateApiKey();
      try {
        return await withTenant(this.pool, user.orgId, async (c) => {
          await c.query("SELECT pg_advisory_xact_lock(hashtextextended('davrabox.api_keys:' || $1::text, 0))", [user.orgId]);
          const n = await c.query('SELECT count(*)::int AS n FROM api_keys WHERE revoked_at IS NULL');
          if ((n.rows[0].n as number) >= MAX_ACTIVE_KEYS_PER_ORG) throw new ExtError(409, `at most ${MAX_ACTIVE_KEYS_PER_ORG} active API keys per organization`);
          const r = await c.query(
            `INSERT INTO api_keys (org_id, name, prefix, secret_hash, scopes, created_by)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id, name, prefix, scopes, created_at, last_used_at, revoked_at`,
            [user.orgId, input.name, key.prefix, key.hash, input.scopes, user.userId],
          );
          await audit(c, user, 'api_key.create', key.prefix);
          return { ...toItem(r.rows[0] as KeyRow), secret: key.token };
        });
      } catch (e) {
        if ((e as { code?: string }).code === '23505') continue; // prefix collision (1 in 4 billion): draw again
        throw e;
      }
    }
    throw new ExtError(503, 'could not allocate an API key');
  }

  list(user: AuthedUser): Promise<ApiKeyItem[]> {
    return withTenant(this.pool, user.orgId, async (c) => {
      const r = await c.query('SELECT id, name, prefix, scopes, created_at, last_used_at, revoked_at FROM api_keys ORDER BY created_at DESC, id DESC');
      return (r.rows as KeyRow[]).map(toItem);
    });
  }

  async revoke(user: AuthedUser, id: string): Promise<void> {
    if (!UUID_RE.test(id)) throw new ExtError(404, 'API key not found');
    await withTenant(this.pool, user.orgId, async (c) => {
      const r = await c.query('UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING prefix', [id]); // RLS: own organization only
      if (!r.rowCount) throw new ExtError(404, 'API key not found');
      await audit(c, user, 'api_key.revoke', r.rows[0].prefix as string);
    });
  }

  /** Resolves a presented key to its organization, or null. Revoked, unknown and wrong keys are indistinguishable. */
  async authenticate(token: string): Promise<ApiPrincipal | null> {
    const parsed = parseApiKey(token);
    if (!parsed) return null;
    const r = await this.pool.query('SELECT key_id, org_id, secret_hash, scopes, revoked, created_by FROM api_key_lookup($1)', [parsed.prefix]);
    const row = r.rows[0] as { key_id: string; org_id: string; secret_hash: Buffer; scopes: ApiKeyScope[]; revoked: boolean; created_by: string } | undefined;
    const ok = secretMatches(parsed.secret, row ? row.secret_hash : DUMMY_HASH);
    if (!row || !ok || row.revoked) return null;
    await this.pool.query('SELECT api_key_touch($1)', [row.key_id]).catch(() => undefined); // bookkeeping must never fail a request
    return { keyId: row.key_id, orgId: row.org_id, prefix: parsed.prefix, scopes: row.scopes, createdBy: row.created_by };
  }

  /**
   * Counts one request for this key in the current one-minute window (database clock, shared by every API instance).
   * Returns the seconds to wait when the key is over its limit, otherwise null.
   */
  async hit(p: ApiPrincipal): Promise<number | null> {
    return withTenant(this.pool, p.orgId, async (c) => {
      const r = await c.query(
        `INSERT INTO ext_rate_limits (key_id, window_start, org_id, hits)
         VALUES ($1, date_trunc('minute', now()), $2, 1)
         ON CONFLICT (key_id, window_start) DO UPDATE SET hits = ext_rate_limits.hits + 1
         RETURNING hits, ceil(extract(epoch FROM (window_start + interval '1 minute' - now())))::int AS retry`,
        [p.keyId, p.orgId],
      );
      const { hits, retry } = r.rows[0] as { hits: number; retry: number };
      return hits > this.cfg.EXT_API_RATE_PER_MINUTE ? Math.max(1, retry) : null;
    });
  }
}
