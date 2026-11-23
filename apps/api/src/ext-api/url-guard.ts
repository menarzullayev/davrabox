import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Webhook URL safety (SSRF). A customer-supplied URL is fetched by our servers, so it must lead to a public host only.
 *  - https only, no credentials in the URL, bounded length;
 *  - the host is resolved and EVERY address must be public (IPv4 and IPv6, IPv4-mapped / compatible / NAT64 forms
 *    included, 6to4 and Teredo refused outright); one private answer refuses the URL;
 *  - the check is repeated at delivery time (DNS may change), and the delivery connects to the vetted address, so a
 *    second lookup cannot rebind the name to an internal host;
 *  - redirects are never followed (see http-poster.ts).
 */
export class UrlRejectedError extends Error {
  constructor(public readonly code: 'form' | 'scheme' | 'credentials' | 'host' | 'address' | 'resolve', message: string) {
    super(message);
  }
}

export type Resolver = (hostname: string) => Promise<string[]>;

export const defaultResolver: Resolver = async (hostname) => {
  const r = await lookup(hostname, { all: true, verbatim: true });
  return r.map((a) => a.address);
};

const MAX_URL_LENGTH = 2048;
const RESERVED_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.home.arpa', '.lan', '.intranet', '.corp', '.private', '.invalid', '.test'];

// ---------------------------------------------------------------------------------------------------------------------
function parseIPv4(s: string): number[] | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(p)) return null; // no leading zeros: "010" is ambiguous (octal in some parsers)
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

const V4_BLOCKS: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT (includes 100.100.100.200, a cloud metadata address)
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, includes 169.254.169.254 (cloud metadata)
  ['172.16.0.0', 12],
  ['192.0.0.0', 24], // IETF protocol assignments (includes 192.0.0.192)
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved and broadcast
  ['168.63.129.16', 32], // Azure wire server: a public address that is a metadata endpoint
];

function toInt(o: number[]): number {
  return ((o[0]! << 24) | (o[1]! << 16) | (o[2]! << 8) | o[3]!) >>> 0;
}

function isPublicV4Octets(o: number[]): boolean {
  const n = toInt(o);
  for (const [base, bits] of V4_BLOCKS) {
    const b = toInt(parseIPv4(base)!);
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((n & mask) >>> 0 === (b & mask) >>> 0) return false;
  }
  return true;
}

function parseIPv6(input: string): number[] | null {
  let s = input;
  if (!/^[0-9a-fA-F:.]+$/.test(s)) return null; // rejects zone ids (%eth0), brackets and other junk
  if (s.includes('.')) {
    const cut = s.lastIndexOf(':');
    const v4 = parseIPv4(s.slice(cut + 1));
    if (cut < 0 || !v4) return null;
    s = `${s.slice(0, cut + 1)}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 ? left.length !== 8 : left.length + right.length > 7) return null;
  const groups = [...left, ...(halves.length === 2 ? Array(8 - left.length - right.length).fill('0') : []), ...right];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

function v4From(hi: number, lo: number): number[] {
  return [hi >> 8, hi & 255, lo >> 8, lo & 255];
}

function isPublicV6(g: number[]): boolean {
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (zero(0, 5) && g[5] === 0xffff) return isPublicV4Octets(v4From(g[6]!, g[7]!)); // IPv4-mapped ::ffff:a.b.c.d
  if (zero(0, 6)) return false; // :: ::1 and IPv4-compatible ::a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b) return zero(2, 6) ? isPublicV4Octets(v4From(g[6]!, g[7]!)) : false; // NAT64: judge the embedded IPv4
  if ((g[0]! & 0xe000) !== 0x2000) return false; // only global unicast 2000::/3; drops fc00::/7, fe80::/10, ff00::/8, ::/8 and the rest
  if (g[0] === 0x2002) return false; // 6to4 embeds an arbitrary IPv4
  if (g[0] === 0x2001 && g[1]! < 0x200) return false; // 2001::/23: Teredo and other protocol assignments
  if (g[0] === 0x2001 && g[1] === 0xdb8) return false; // documentation
  if (g[0] === 0x3fff && (g[1]! & 0xf000) === 0) return false; // documentation 3fff::/20
  return true;
}

/** True only for a plain textual IPv4/IPv6 address that is globally routable. Anything else, including odd spellings, is false. */
export function isPublicIp(addr: string): boolean {
  const kind = isIP(addr);
  if (kind === 4) {
    const o = parseIPv4(addr);
    return !!o && isPublicV4Octets(o);
  }
  if (kind === 6) {
    const g = parseIPv6(addr);
    return !!g && isPublicV6(g);
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------------------------
export interface VettedUrl {
  url: URL;
  /** Every address the host resolved to; all of them are public. The delivery connects to one of these. */
  addresses: string[];
}

export async function resolvePublicHttpsUrl(raw: string, resolver: Resolver = defaultResolver): Promise<VettedUrl> {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL_LENGTH) throw new UrlRejectedError('form', 'webhook URL is empty or too long');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UrlRejectedError('form', 'webhook URL is not a valid URL');
  }
  if (url.protocol !== 'https:') throw new UrlRejectedError('scheme', 'webhook URL must use https');
  if (url.username || url.password) throw new UrlRejectedError('credentials', 'webhook URL must not contain credentials');

  let host = url.hostname.toLowerCase(); // the URL parser has already normalized decimal, hex and octal IPv4 spellings
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (!host) throw new UrlRejectedError('host', 'webhook URL has no host');

  if (isIP(host)) {
    if (!isPublicIp(host)) throw new UrlRejectedError('address', 'webhook URL points to a private, loopback, link-local or reserved address');
    return { url, addresses: [host] };
  }
  if (!host.includes('.') || host === 'localhost' || RESERVED_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new UrlRejectedError('host', 'webhook URL host is a reserved or local name');
  }
  let addresses: string[];
  try {
    addresses = await resolver(host);
  } catch {
    throw new UrlRejectedError('resolve', 'webhook URL host could not be resolved');
  }
  if (!addresses.length) throw new UrlRejectedError('resolve', 'webhook URL host has no address');
  if (!addresses.every(isPublicIp)) throw new UrlRejectedError('address', 'webhook URL host resolves to a private, loopback, link-local or reserved address');
  return { url, addresses };
}

export async function assertPublicHttpsUrl(raw: string, resolver: Resolver = defaultResolver): Promise<void> {
  await resolvePublicHttpsUrl(raw, resolver);
}
