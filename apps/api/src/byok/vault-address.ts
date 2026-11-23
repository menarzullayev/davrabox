import { isIP } from 'node:net';
import { resolvePublicHttpsUrl, UrlRejectedError, type Resolver } from '../ext-api/url-guard.js';

export interface VettedVault {
  /** scheme://host[:port], nothing else: the origin is all a Vault address may be. */
  origin: string;
  /** Addresses the host resolved to (all public) when the guard is on; empty when private addresses are allowed. */
  addresses: string[];
}

/**
 * A customer-supplied Vault address is called by our servers, so it is held to the webhook rules (ext-api/url-guard.ts):
 * https only, no credentials, every resolved address public. Self-hosted installations whose Vault lives on a private
 * network set BYOK_ALLOW_PRIVATE_VAULT=1 (default off): then http and private addresses are accepted, credentials, paths
 * and queries still are not.
 */
export async function vetVaultAddress(raw: string, allowPrivate: boolean, resolver?: Resolver): Promise<VettedVault> {
  if (!allowPrivate) {
    const v = await resolvePublicHttpsUrl(raw, resolver);
    if ((v.url.pathname !== '/' && v.url.pathname !== '') || v.url.search || v.url.hash) throw new UrlRejectedError('form', 'the Vault address must be a bare origin, without a path or query');
    return { origin: v.url.origin, addresses: v.addresses };
  }
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) throw new UrlRejectedError('form', 'the Vault address is empty or too long');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UrlRejectedError('form', 'the Vault address is not a valid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new UrlRejectedError('scheme', 'the Vault address must use http or https');
  if (url.username || url.password) throw new UrlRejectedError('credentials', 'the Vault address must not contain credentials');
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) throw new UrlRejectedError('form', 'the Vault address must be a bare origin, without a path or query');
  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  if (!host || (!isIP(host) && host.length > 253)) throw new UrlRejectedError('host', 'the Vault address has no usable host');
  return { origin: url.origin, addresses: [] };
}

export { UrlRejectedError };
