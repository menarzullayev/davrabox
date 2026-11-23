import https from 'node:https';
import { isIP } from 'node:net';
import type { Pool } from 'pg';
import { withTenant } from '../db/tenant.js';
import { gcmDecrypt, gcmEncrypt, platformWrapper, type KeyWrapper } from '../files/crypto.js';
import type { Resolver } from '../ext-api/url-guard.js';
import { KmsError, type KeyProvider } from './key-provider.js';
import { VaultTransitProvider } from './vault-transit.js';
import { vetVaultAddress } from './vault-address.js';

export interface VaultConfig {
  addr: string;
  token: string;
  mount: string;
  namespace?: string;
}

export interface OrgKms {
  orgId: string;
  provider: 'vault-transit';
  keyName: string;
  kekId: string;
  status: string;
  checkedAt: Date | null;
  createdAt: Date;
  rotatedAt: Date | null;
  config: VaultConfig;
}

export interface ResolverOptions {
  /** BYOK_ALLOW_PRIVATE_VAULT: accept http and private addresses (self-hosted customers). Default off. */
  allowPrivate?: boolean;
  /** Replaces the network entirely (tests). */
  fetch?: typeof fetch;
  resolver?: Resolver;
}

/**
 * The customer key could not be used. 423 = the customer key refuses or is gone (revoked, disabled, wrong key for this
 * object); 503 = the customer's key service cannot be reached; 500 = the stored data does not verify. In every case the
 * caller stops: there is no fallback to the platform key.
 */
export class KeyUnavailableError extends Error {
  constructor(public readonly status: 423 | 503 | 500, public readonly reason: 'denied' | 'unreachable' | 'invalid' | 'mismatch' | 'not_configured' | 'config', message: string) {
    super(message);
  }
}

export const kekIdFor = (mount: string, keyName: string): string => `vault-transit:${mount}/${keyName}`;

const cfgAad = (orgId: string): Buffer => Buffer.from(`kms:${orgId}`, 'utf8');

/** The address, token and mount are encrypted with the same envelope helper that protects stored files (AES-256-GCM). */
export function encryptConfig(master: Buffer, orgId: string, cfg: VaultConfig): Buffer {
  return gcmEncrypt(master, Buffer.from(JSON.stringify(cfg), 'utf8'), cfgAad(orgId));
}

export function decryptConfig(master: Buffer, orgId: string, blob: Buffer): VaultConfig {
  const c = JSON.parse(gcmDecrypt(master, blob, cfgAad(orgId)).toString('utf8')) as VaultConfig;
  if (typeof c.addr !== 'string' || typeof c.token !== 'string' || typeof c.mount !== 'string') throw new Error('malformed key configuration');
  return c;
}

/**
 * A fetch that connects to one vetted IP address while keeping the host name for TLS and the Host header, so the name
 * cannot be re-pointed at an internal address between the check and the request (DNS rebinding). Redirects are not
 * followed (a 3xx comes back as a status), the reply is capped.
 */
export function pinnedFetch(address: string): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const family = isIP(address) || 4;
    return new Promise<Response>((resolve, reject) => {
      const req = https.request(
        {
          hostname: url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname,
          port: url.port ? Number(url.port) : 443,
          path: `${url.pathname}${url.search}`,
          method: init?.method ?? 'GET',
          headers: init?.headers as Record<string, string>,
          agent: false,
          signal: init?.signal ?? undefined,
          lookup: ((_h: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) => (opts?.all ? cb(null, [{ address, family }]) : cb(null, address, family))) as never,
        },
        (res) => {
          const parts: Buffer[] = [];
          let size = 0;
          res.on('data', (c: Buffer) => {
            size += c.length;
            if (size > 256 * 1024) return res.destroy(new Error('reply too large'));
            parts.push(c);
          });
          res.on('error', reject);
          res.on('end', () => resolve(new Response(res.statusCode === 204 || res.statusCode === 304 ? null : Buffer.concat(parts), { status: res.statusCode ?? 502 })));
        },
      );
      req.on('error', reject);
      req.end(typeof init?.body === 'string' ? init.body : undefined);
    });
  }) as typeof fetch;
}

/** Finds the key that must wrap or unwrap an organization's data keys. Stateless: it reads org_kms on every call. */
export class KeyResolver {
  private readonly platform: KeyWrapper;

  constructor(private readonly pool: Pool, private readonly master: Buffer, private readonly opts: ResolverOptions = {}) {
    this.platform = platformWrapper(master);
  }

  /** The organization's customer-key configuration, or null when it uses the platform key. */
  async load(orgId: string): Promise<OrgKms | null> {
    const r = await withTenant(this.pool, orgId, (c) =>
      c.query('SELECT provider, key_name, kek_id, status, checked_at, created_at, rotated_at, config_enc FROM org_kms WHERE org_id = $1', [orgId]),
    );
    const row = r.rows[0];
    if (!row) return null;
    let config: VaultConfig;
    try {
      config = decryptConfig(this.master, orgId, row.config_enc as Buffer);
    } catch {
      throw new KeyUnavailableError(500, 'config', 'the stored key configuration cannot be read');
    }
    return { orgId, provider: row.provider, keyName: row.key_name, kekId: row.kek_id, status: row.status, checkedAt: row.checked_at, createdAt: row.created_at, rotatedAt: row.rotated_at, config };
  }

  /** Builds the provider for a configuration. The address is vetted again here, at the moment of use. */
  async providerFor(cfg: VaultConfig, keyName: string): Promise<KeyProvider> {
    const allow = this.opts.allowPrivate ?? false;
    let fetchImpl = this.opts.fetch;
    let addr = cfg.addr;
    try {
      const v = await vetVaultAddress(cfg.addr, allow, this.opts.resolver);
      addr = v.origin;
      if (!fetchImpl && !allow && v.addresses[0]) fetchImpl = pinnedFetch(v.addresses[0]);
    } catch {
      throw new KeyUnavailableError(503, 'unreachable', 'the customer key service address is not allowed');
    }
    return new VaultTransitProvider({ addr, token: cfg.token, keyName, mount: cfg.mount, namespace: cfg.namespace, fetch: fetchImpl });
  }

  /** Records what the last use of the key showed, so the admin console can warn. Best effort, never throws. */
  async noteStatus(orgId: string, status: 'ok' | 'denied' | 'unreachable'): Promise<void> {
    try {
      await withTenant(this.pool, orgId, (c) => c.query('UPDATE org_kms SET status = $2, checked_at = now() WHERE org_id = $1', [orgId, status]));
    } catch {
      /* the failure that matters is the one being reported */
    }
  }

  private wrapperFor(kms: OrgKms, provider: KeyProvider): KeyWrapper {
    const guard = async <T>(op: () => Promise<T>): Promise<T> => {
      try {
        return await op();
      } catch (e) {
        if (!(e instanceof KmsError)) throw e;
        if (e.code === 'denied') {
          await this.noteStatus(kms.orgId, 'denied');
          throw new KeyUnavailableError(423, 'denied', 'the customer key is disabled or access to it was revoked');
        }
        if (e.code === 'unreachable') {
          await this.noteStatus(kms.orgId, 'unreachable');
          throw new KeyUnavailableError(503, 'unreachable', 'the customer key service is unreachable');
        }
        throw new KeyUnavailableError(500, 'invalid', 'the stored key failed its integrity check');
      }
    };
    return {
      kekId: kms.kekId,
      wrap: (dataKey, aad) => guard(() => provider.wrap(dataKey, aad.toString('utf8'))),
      unwrap: (wrapped, aad) => guard(() => provider.unwrap(wrapped, aad.toString('utf8'))),
    };
  }

  /** For new objects: the customer key when the organization has one, otherwise the platform key. */
  async wrapperForWrite(orgId: string): Promise<KeyWrapper> {
    const kms = await this.load(orgId);
    if (!kms) return this.platform;
    return this.wrapperFor(kms, await this.providerFor(kms.config, kms.keyName));
  }

  /**
   * For an existing object, by the kek_id it was written with. null = the platform key (everything written before BYOK
   * was switched on). A customer key id must be the organization's current key: anything else is refused, never
   * answered with the platform key.
   */
  async wrapperForRead(orgId: string, kekId: string | null): Promise<KeyWrapper> {
    if (kekId === null) return this.platform;
    const kms = await this.load(orgId);
    if (!kms) throw new KeyUnavailableError(423, 'not_configured', 'the customer key for this object is no longer configured');
    if (kms.kekId !== kekId) throw new KeyUnavailableError(423, 'mismatch', 'this object is wrapped by a customer key that is not the configured one');
    return this.wrapperFor(kms, await this.providerFor(kms.config, kms.keyName));
  }

  /** The platform wrapper, for moving objects back to the platform key. */
  platformKey(): KeyWrapper {
    return this.platform;
  }

  /** A cheap pre-flight for starting a recording: refuse early rather than record into a key that cannot wrap it. */
  async assertUsable(orgId: string): Promise<void> {
    const kms = await this.load(orgId);
    if (!kms) return;
    const h = await (await this.providerFor(kms.config, kms.keyName)).health();
    await this.noteStatus(orgId, h);
    if (h === 'denied') throw new KeyUnavailableError(423, 'denied', 'the customer key is disabled or access to it was revoked');
    if (h === 'unreachable') throw new KeyUnavailableError(503, 'unreachable', 'the customer key service is unreachable');
  }
}
