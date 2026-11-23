import { randomBytes } from 'node:crypto';
import { KmsError, type KeyHealth, type KeyProvider } from './key-provider.js';

export interface VaultTransitOptions {
  /** Origin of the Vault server, e.g. https://vault.example.com:8200 (vetted by vault-address.ts before it gets here). */
  addr: string;
  token: string;
  keyName: string;
  /** Mount path of the transit engine (default "transit"). */
  mount?: string;
  /** Enterprise namespace, sent as X-Vault-Namespace. */
  namespace?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_REPLY = 64 * 1024;

export function isValidKeyName(s: string): boolean {
  return NAME_RE.test(s);
}

/** Mount paths are a few segments of the same safe alphabet joined by single slashes (checked per segment: linear). */
export function isValidMount(s: string): boolean {
  const parts = s.split('/');
  return parts.length >= 1 && parts.length <= 4 && parts.every((p) => NAME_RE.test(p));
}

/**
 * HashiCorp Vault Transit (https://developer.hashicorp.com/vault/api-docs/secret/transit):
 *   POST /v1/<mount>/encrypt/<key>  { plaintext, associated_data }  ->  { data: { ciphertext: "vault:v1:..." } }
 *   POST /v1/<mount>/decrypt/<key>  { ciphertext, associated_data }  ->  { data: { plaintext } }
 * Plaintext and associated data travel base64 encoded. The wrapped form we keep is the ciphertext string itself, which
 * also records the key version, so Vault's own key rotation keeps working for old objects.
 * The token is sent only in the X-Vault-Token header; redirects are refused so it cannot be handed to another host.
 */
export class VaultTransitProvider implements KeyProvider {
  private readonly base: string;
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly opts: VaultTransitOptions) {
    const mount = opts.mount ?? 'transit';
    if (!isValidKeyName(opts.keyName)) throw new Error('invalid Vault key name');
    if (!isValidMount(mount)) throw new Error('invalid Vault transit mount');
    this.base = `${opts.addr.replace(/\/+$/, '')}/v1/${mount}`;
    this.doFetch = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 8000;
  }

  private async call(op: 'encrypt' | 'decrypt', body: Record<string, string>): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { 'X-Vault-Token': this.opts.token, 'Content-Type': 'application/json' };
    if (this.opts.namespace) headers['X-Vault-Namespace'] = this.opts.namespace;
    let res: Response;
    let text: string;
    try {
      res = await this.doFetch(`${this.base}/${op}/${this.opts.keyName}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      text = (await res.text()).slice(0, MAX_REPLY);
    } catch {
      throw new KmsError('unreachable', 'the key service could not be reached');
    }
    if (res.status === 200) {
      try {
        const data = (JSON.parse(text) as { data?: unknown }).data;
        if (data && typeof data === 'object') return data as Record<string, unknown>;
      } catch {
        /* fall through */
      }
      throw new KmsError('invalid', 'the key service sent an unexpected reply');
    }
    if (res.status === 403 || res.status === 404) throw new KmsError('denied', 'the key service refused the request');
    if (res.status === 400) {
      // Vault answers 400 both for a key that is gone or disabled and for a ciphertext that does not verify.
      if (/key not found|min_decryption_version|disabled|not supported/i.test(text)) throw new KmsError('denied', 'the customer key is not available');
      throw new KmsError('invalid', 'the key service rejected the data');
    }
    throw new KmsError('unreachable', 'the key service is unavailable');
  }

  async wrap(plain: Buffer, ctx: string): Promise<Buffer> {
    const d = await this.call('encrypt', { plaintext: plain.toString('base64'), associated_data: Buffer.from(ctx, 'utf8').toString('base64') });
    if (typeof d.ciphertext !== 'string' || !d.ciphertext.startsWith('vault:v')) throw new KmsError('invalid', 'the key service sent an unexpected reply');
    return Buffer.from(d.ciphertext, 'utf8');
  }

  async unwrap(wrapped: Buffer, ctx: string): Promise<Buffer> {
    const d = await this.call('decrypt', { ciphertext: wrapped.toString('utf8'), associated_data: Buffer.from(ctx, 'utf8').toString('base64') });
    if (typeof d.plaintext !== 'string') throw new KmsError('invalid', 'the key service sent an unexpected reply');
    return Buffer.from(d.plaintext, 'base64');
  }

  /** A real round trip with a random probe: proves the address, the token, the policy and the key at once. */
  async health(): Promise<KeyHealth> {
    try {
      const probe = randomBytes(16);
      const w = await this.wrap(probe, 'health-check');
      const back = await this.unwrap(w, 'health-check');
      return back.equals(probe) ? 'ok' : 'denied';
    } catch (e) {
      if (e instanceof KmsError) return e.code === 'unreachable' ? 'unreachable' : 'denied';
      return 'unreachable';
    }
  }
}
