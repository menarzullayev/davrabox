export type KeyHealth = 'ok' | 'unreachable' | 'denied';

/**
 * A customer-held key-encryption key. The platform never sees the key itself: it sends a small data key to the
 * provider to be wrapped and sends the wrapped form back to unwrap it. `ctx` is authenticated additional data (the id
 * of the object the data key belongs to), so a wrapped key moved to another object does not unwrap.
 */
export interface KeyProvider {
  wrap(plain: Buffer, ctx: string): Promise<Buffer>;
  unwrap(wrapped: Buffer, ctx: string): Promise<Buffer>;
  health(): Promise<KeyHealth>;
}

/**
 *  - denied: the provider answered and refuses (revoked token, missing policy, key deleted or disabled);
 *  - unreachable: no usable answer (network, timeout, sealed or failing server);
 *  - invalid: the provider answered but the data does not verify (wrong context, damaged ciphertext).
 * The message never contains a token or a response body.
 */
export class KmsError extends Error {
  constructor(public readonly code: 'denied' | 'unreachable' | 'invalid', message: string) {
    super(message);
  }
}
