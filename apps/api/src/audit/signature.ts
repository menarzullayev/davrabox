import { createHmac, timingSafeEqual } from 'node:crypto';

/** Value of the X-DavraBox-Signature header for a raw request body. */
export function signBody(body: string | Buffer, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

/**
 * Receiver-side check of X-DavraBox-Signature. Pass the RAW body bytes exactly as received (not re-serialised JSON).
 * Comparison is constant-time; any malformed header returns false.
 */
export function verifySignature(body: string | Buffer, header: string | undefined, secret: string): boolean {
  if (typeof header !== 'string' || !/^sha256=[0-9a-f]{64}$/.test(header)) return false;
  const expected = Buffer.from(signBody(body, secret));
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
