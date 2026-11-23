import { randomUUID } from 'node:crypto';

// Bounded character class, no nested quantifiers: safe on hostile input.
const ID_RE = /^[A-Za-z0-9._-]{8,64}$/;

/** Accepts a caller-supplied correlation id only when it is short and made of safe characters; otherwise generates one. */
export function acceptRequestId(header: string | string[] | undefined): string {
  return typeof header === 'string' && ID_RE.test(header) ? header : randomUUID();
}
