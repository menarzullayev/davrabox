import type { Pool, PoolClient } from 'pg';
import type { AuthedUser } from '../auth/auth.guard.js';
import { FailureLimiter } from '../common/rate-limiter.js';
import { withTenant } from '../db/tenant.js';
import { UrlRejectedError } from '../ext-api/url-guard.js';
import { unwrapDataKeyWith, type KeyWrapper } from '../files/crypto.js';
import { encryptConfig, kekIdFor, KeyResolver, KeyUnavailableError, type OrgKms, type ResolverOptions, type VaultConfig } from './key-resolver.js';
import { isValidKeyName, isValidMount } from './vault-transit.js';
import { vetVaultAddress } from './vault-address.js';

export class ByokError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export interface KmsInput {
  addr: string;
  token: string;
  keyName: string;
  mount?: string;
  namespace?: string;
}

export interface KmsView {
  configured: boolean;
  provider?: 'vault-transit';
  addr?: string;
  keyName?: string;
  mount?: string;
  namespace?: string;
  kekId?: string;
  status?: string;
  checkedAt?: Date | null;
  createdAt?: Date;
  rotatedAt?: Date | null;
  /** How many stored objects are wrapped by the customer key. */
  wrapped?: { files: number; recordings: number };
}

export interface RewrapResult {
  processed: number;
  failed: number;
  /** Objects still not on the target key. */
  remaining: number;
  /** Pass as `after` to continue; null when every object has been looked at. */
  next: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR_RE = /^([fr]):([0-9a-f-]{36})$/i;
const MAX_REWRAP_BATCH = 500;

/**
 * Customer-held keys for an organization: configuration (org admins only), connection test, re-wrap and removal. Every
 * action, including every refusal, writes an audit row (kms.*). The Vault token is encrypted before it is stored and is
 * never returned, logged or put in an audit row.
 */
export class ByokService {
  private readonly keys?: KeyResolver;
  private readonly limiter = new FailureLimiter(20, 60_000);

  constructor(private readonly pool: Pool, private readonly master: Buffer | null, private readonly opts: ResolverOptions = {}) {
    if (master) this.keys = new KeyResolver(pool, master, opts);
  }

  get enabled(): boolean {
    return this.keys !== undefined;
  }

  private require(): { keys: KeyResolver; master: Buffer } {
    if (!this.keys || !this.master) throw new ByokError(503, 'customer-held keys are not configured on this server');
    return { keys: this.keys, master: this.master };
  }

  private async audit(user: AuthedUser, action: string, target: string): Promise<void> {
    await withTenant(this.pool, user.orgId, (c) => this.auditIn(c, user, action, target));
  }

  private auditIn(c: PoolClient, user: AuthedUser, action: string, target: string) {
    return c.query('INSERT INTO audit_log (org_id, actor_id, action, target) VALUES ($1, $2, $3, $4)', [user.orgId, user.userId, action, target]);
  }

  private async requireAdmin(user: AuthedUser, what: string): Promise<void> {
    if (user.role === 'org_admin') return;
    await this.audit(user, 'kms.denied', what);
    throw new ByokError(403, 'organization admin role required');
  }

  private async wrappedCounts(orgId: string): Promise<{ files: number; recordings: number }> {
    return withTenant(this.pool, orgId, async (c) => {
      const f = await c.query('SELECT count(*)::int AS n FROM meeting_files WHERE kek_id IS NOT NULL');
      const r = await c.query('SELECT count(*)::int AS n FROM recordings WHERE kek_id IS NOT NULL');
      return { files: f.rows[0].n as number, recordings: r.rows[0].n as number };
    });
  }

  // --- configuration ---------------------------------------------------------------------------------------------

  async get(user: AuthedUser): Promise<KmsView> {
    await this.requireAdmin(user, 'get');
    const { keys } = this.require();
    const kms = await this.loadOrFail(keys, user.orgId);
    if (!kms) return { configured: false };
    return {
      configured: true,
      provider: kms.provider,
      addr: kms.config.addr,
      keyName: kms.keyName,
      mount: kms.config.mount,
      namespace: kms.config.namespace,
      kekId: kms.kekId,
      status: kms.status,
      checkedAt: kms.checkedAt,
      createdAt: kms.createdAt,
      rotatedAt: kms.rotatedAt,
      wrapped: await this.wrappedCounts(user.orgId),
    };
  }

  private async loadOrFail(keys: KeyResolver, orgId: string): Promise<OrgKms | null> {
    try {
      return await keys.load(orgId);
    } catch (e) {
      if (e instanceof KeyUnavailableError) throw new ByokError(500, e.message);
      throw e;
    }
  }

  async put(user: AuthedUser, input: KmsInput): Promise<KmsView> {
    await this.requireAdmin(user, 'put');
    const { keys, master } = this.require();
    const mount = input.mount ?? 'transit';
    if (!isValidKeyName(input.keyName) || !isValidMount(mount) || !input.token || input.token.length > 4096) throw new ByokError(400, 'invalid key settings');
    if (this.limiter.isBlocked(user.orgId)) throw new ByokError(429, 'too many attempts, try again in a minute');
    this.limiter.recordFailure(user.orgId);

    let origin: string;
    try {
      const v = await vetVaultAddress(input.addr, this.opts.allowPrivate ?? false, this.opts.resolver);
      origin = v.origin;
    } catch (e) {
      if (!(e instanceof UrlRejectedError)) throw e;
      await this.audit(user, 'kms.configure.refused', `address:${e.code}`);
      throw new ByokError(400, `the Vault address was refused: ${e.message}`);
    }

    const cfg: VaultConfig = { addr: origin, token: input.token, mount, ...(input.namespace ? { namespace: input.namespace } : {}) };
    const provider = await keys.providerFor(cfg, input.keyName).catch(() => null);
    const health = provider ? await provider.health() : 'unreachable';
    if (health !== 'ok') {
      await this.audit(user, 'kms.configure.failed', `health:${health}`);
      throw new ByokError(422, health === 'denied' ? 'Vault refused the token or the key is missing: check the policy and the key name' : 'the Vault server could not be reached');
    }

    const kekId = kekIdFor(mount, input.keyName);
    const existing = await this.loadOrFail(keys, user.orgId);
    if (existing && existing.kekId !== kekId) {
      const n = await this.wrappedCounts(user.orgId);
      if (n.files + n.recordings > 0) {
        await this.audit(user, 'kms.configure.failed', 'objects_wrapped');
        throw new ByokError(409, 'objects are wrapped by the current key: move them to the platform key (re-wrap) before switching to another key');
      }
    }
    await withTenant(this.pool, user.orgId, async (c) => {
      await c.query(
        `INSERT INTO org_kms (org_id, provider, config_enc, key_name, kek_id, status, checked_at)
         VALUES ($1, 'vault-transit', $2, $3, $4, 'ok', now())
         ON CONFLICT (org_id) DO UPDATE SET provider = EXCLUDED.provider, config_enc = EXCLUDED.config_enc, key_name = EXCLUDED.key_name,
           kek_id = EXCLUDED.kek_id, status = 'ok', checked_at = now(), rotated_at = now()`,
        [user.orgId, encryptConfig(master, user.orgId, cfg), input.keyName, kekId],
      );
      await this.auditIn(c, user, existing ? 'kms.rotate' : 'kms.configure', `vault-transit:${kekId}`);
    });
    return this.get(user);
  }

  /** Runs a real wrap/unwrap round trip with the stored configuration and records the result. */
  async test(user: AuthedUser): Promise<{ status: 'ok' | 'denied' | 'unreachable' }> {
    await this.requireAdmin(user, 'test');
    const { keys } = this.require();
    if (this.limiter.isBlocked(user.orgId)) throw new ByokError(429, 'too many attempts, try again in a minute');
    this.limiter.recordFailure(user.orgId);
    const kms = await this.loadOrFail(keys, user.orgId);
    if (!kms) throw new ByokError(404, 'no customer key is configured');
    const provider = await keys.providerFor(kms.config, kms.keyName).catch(() => null);
    const status = provider ? await provider.health() : 'unreachable';
    await keys.noteStatus(user.orgId, status);
    await this.audit(user, 'kms.test', `${kms.kekId}:${status}`);
    return { status };
  }

  async remove(user: AuthedUser): Promise<{ removed: true }> {
    await this.requireAdmin(user, 'remove');
    const { keys } = this.require();
    const kms = await this.loadOrFail(keys, user.orgId);
    if (!kms) throw new ByokError(404, 'no customer key is configured');
    const n = await this.wrappedCounts(user.orgId);
    if (n.files + n.recordings > 0) {
      await this.audit(user, 'kms.remove.refused', `objects_wrapped:${n.files + n.recordings}`);
      throw new ByokError(409, 'objects are still wrapped by the customer key: re-wrap them to the platform key first, or they would become unreadable');
    }
    await withTenant(this.pool, user.orgId, async (c) => {
      await c.query('DELETE FROM org_kms WHERE org_id = $1', [user.orgId]);
      await this.auditIn(c, user, 'kms.remove', kms.kekId);
    });
    return { removed: true };
  }

  // --- re-wrap -----------------------------------------------------------------------------------------------------

  /**
   * Moves stored objects to another key by re-wrapping their data keys (the object bytes are untouched): to the customer
   * key (default) or back to the platform key. Resumable: each call handles at most `limit` objects in id order and
   * returns `next`; a repeated call with the same arguments continues, and objects already on the target are skipped.
   * If the key service refuses or is unreachable the call stops with 423/503; what was moved stays moved.
   */
  async rewrap(user: AuthedUser, input: { target?: 'customer' | 'platform'; limit?: number; after?: string }): Promise<RewrapResult> {
    await this.requireAdmin(user, 'rewrap');
    const { keys } = this.require();
    const target = input.target ?? 'customer';
    const limit = Math.min(Math.max(Math.trunc(input.limit ?? 100), 1), MAX_REWRAP_BATCH);
    if (input.after !== undefined && !CURSOR_RE.test(input.after)) throw new ByokError(400, 'invalid cursor');
    const kms = await this.loadOrFail(keys, user.orgId);
    if (target === 'customer' && !kms) {
      await this.audit(user, 'kms.rewrap.failed', 'no_customer_key');
      throw new ByokError(409, 'no customer key is configured');
    }
    const targetKek = target === 'customer' ? kms!.kekId : null;
    const dst = target === 'customer' ? await keys.wrapperForWrite(user.orgId).catch(() => null) : keys.platformKey();
    if (!dst) throw new ByokError(503, 'the customer key service could not be used');

    let processed = 0;
    let failed = 0;
    let budget = limit;
    let next: string | null = null;
    const srcCache = new Map<string | null, KeyWrapper>();
    const cur = input.after ? CURSOR_RE.exec(input.after)! : null;
    const phases: Array<'f' | 'r'> = cur && cur[1]!.toLowerCase() === 'r' ? ['r'] : ['f', 'r'];
    let after: string | null = cur ? cur[2]! : null;

    try {
      for (const phase of phases) {
        const table = phase === 'f' ? 'meeting_files' : 'recordings';
        const extra = phase === 'r' ? "AND status = 'ready' AND wrapped_key IS NOT NULL" : '';
        const rows = await withTenant(this.pool, user.orgId, async (c) =>
          (
            await c.query(
              `SELECT id, wrapped_key, kek_id FROM ${table} WHERE kek_id IS DISTINCT FROM $1::text ${extra} AND ($2::uuid IS NULL OR id > $2::uuid) ORDER BY id LIMIT $3`,
              [targetKek, after, budget],
            )
          ).rows as Array<{ id: string; wrapped_key: string; kek_id: string | null }>,
        );
        for (const row of rows) {
          if (!UUID_RE.test(row.id)) continue;
          try {
            let src = srcCache.get(row.kek_id);
            if (!src) {
              src = await keys.wrapperForRead(user.orgId, row.kek_id);
              srcCache.set(row.kek_id, src);
            }
            const dataKey = await unwrapDataKeyWith(src, row.id, row.wrapped_key);
            let rewrapped: string;
            try {
              rewrapped = (await dst.wrap(dataKey, Buffer.from(row.id, 'utf8'))).toString('base64');
            } finally {
              dataKey.fill(0);
            }
            // Only if the row still has the key we read: a concurrent change wins and is picked up by the next call.
            await withTenant(this.pool, user.orgId, (c) =>
              c.query(`UPDATE ${table} SET wrapped_key = $2, kek_id = $3 WHERE id = $1 AND wrapped_key = $4`, [row.id, rewrapped, targetKek, row.wrapped_key]),
            );
            processed++;
          } catch (e) {
            if (!(e instanceof KeyUnavailableError)) throw e;
            if (e.reason === 'denied' || e.reason === 'unreachable') throw e;
            failed++; // this object cannot be moved (unknown key id, damaged key): leave it and carry on
          }
          after = row.id;
          budget--;
        }
        if (budget <= 0) {
          next = `${phase}:${after}`;
          break;
        }
        after = null; // phase exhausted: the next table starts from its beginning
      }
    } catch (e) {
      if (e instanceof KeyUnavailableError) {
        await this.audit(user, 'kms.rewrap.failed', `${e.reason}:moved=${processed}`);
        throw new ByokError(e.status, e.message);
      }
      throw e;
    }

    const remaining = await withTenant(this.pool, user.orgId, async (c) => {
      const f = await c.query('SELECT count(*)::int AS n FROM meeting_files WHERE kek_id IS DISTINCT FROM $1::text', [targetKek]);
      const r = await c.query("SELECT count(*)::int AS n FROM recordings WHERE kek_id IS DISTINCT FROM $1::text AND status = 'ready' AND wrapped_key IS NOT NULL", [targetKek]);
      return (f.rows[0].n as number) + (r.rows[0].n as number);
    });
    await this.audit(user, 'kms.rewrap', `${target}:moved=${processed}:failed=${failed}:remaining=${remaining}`);
    return { processed, failed, remaining, next };
  }
}
