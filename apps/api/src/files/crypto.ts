import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Envelope encryption for stored files: every file gets its own random AES-256 data key; the data key is wrapped
 * (AES-256-GCM) with the master key. Both layers use the file id as additional authenticated data, so a blob or a
 * wrapped key moved to another file fails authentication. In production the master key lives in Vault/HSM.
 */
const IV = 12;
const TAG = 16;

export function gcmEncrypt(key: Buffer, plain: Buffer, aad: Buffer): Buffer {
  const iv = randomBytes(IV);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aad);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]);
}

export function gcmDecrypt(key: Buffer, blob: Buffer, aad: Buffer): Buffer {
  if (blob.length < IV + TAG) throw new Error('ciphertext too short');
  const d = createDecipheriv('aes-256-gcm', key, blob.subarray(0, IV));
  d.setAAD(aad);
  d.setAuthTag(blob.subarray(blob.length - TAG));
  return Buffer.concat([d.update(blob.subarray(IV, blob.length - TAG)), d.final()]);
}

export function masterKeyFrom(b64: string): Buffer {
  const k = Buffer.from(b64, 'base64');
  if (k.length !== 32) throw new Error('FILE_MASTER_KEY must be 32 bytes, base64 encoded');
  return k;
}

export function seal(master: Buffer, fileId: string, plain: Buffer): { blob: Buffer; wrappedKey: string } {
  const aad = Buffer.from(fileId, 'utf8');
  const dataKey = randomBytes(32);
  const blob = gcmEncrypt(dataKey, plain, aad);
  const wrappedKey = gcmEncrypt(master, dataKey, aad).toString('base64');
  dataKey.fill(0);
  return { blob, wrappedKey };
}

export function open(master: Buffer, fileId: string, blob: Buffer, wrappedKey: string): Buffer {
  const aad = Buffer.from(fileId, 'utf8');
  const dataKey = gcmDecrypt(master, Buffer.from(wrappedKey, 'base64'), aad);
  try {
    return gcmDecrypt(dataKey, blob, aad);
  } finally {
    dataKey.fill(0);
  }
}

/** Generates a data key for a stream-encrypted object and wraps it with the master key (same wrapping as seal()). */
export function newDataKey(master: Buffer, id: string): { dataKey: Buffer; wrappedKey: string } {
  const dataKey = randomBytes(32);
  return { dataKey, wrappedKey: gcmEncrypt(master, dataKey, Buffer.from(id, 'utf8')).toString('base64') };
}

export function unwrapDataKey(master: Buffer, id: string, wrappedKey: string): Buffer {
  return gcmDecrypt(master, Buffer.from(wrappedKey, 'base64'), Buffer.from(id, 'utf8'));
}

// ---------------------------------------------------------------------------------------------------------------------
// Key-wrapping hook (BYOK). The functions above wrap the per-object data key with the platform master key and stay
// byte for byte as they were. A KeyWrapper is the same operation behind an interface, so an organization's own key
// (a KMS reached over the network, hence async) can wrap the data keys instead. The object bytes are always encrypted
// locally with the data key; only the small wrapped key goes to the KMS.

export interface KeyWrapper {
  /** Names the key-encryption key stored beside every wrapped data key; null means the platform master key. */
  readonly kekId: string | null;
  wrap(dataKey: Buffer, aad: Buffer): Promise<Buffer>;
  unwrap(wrapped: Buffer, aad: Buffer): Promise<Buffer>;
}

/** The default wrapper: AES-256-GCM under the master key, exactly what seal() and newDataKey() do. */
export function platformWrapper(master: Buffer): KeyWrapper {
  return {
    kekId: null,
    wrap: async (dataKey, aad) => gcmEncrypt(master, dataKey, aad),
    unwrap: async (wrapped, aad) => gcmDecrypt(master, wrapped, aad),
  };
}

export async function newDataKeyWith(w: KeyWrapper, id: string): Promise<{ dataKey: Buffer; wrappedKey: string }> {
  const dataKey = randomBytes(32);
  try {
    return { dataKey, wrappedKey: (await w.wrap(dataKey, Buffer.from(id, 'utf8'))).toString('base64') };
  } catch (e) {
    dataKey.fill(0);
    throw e;
  }
}

export async function unwrapDataKeyWith(w: KeyWrapper, id: string, wrappedKey: string): Promise<Buffer> {
  return w.unwrap(Buffer.from(wrappedKey, 'base64'), Buffer.from(id, 'utf8'));
}

export async function sealWith(w: KeyWrapper, fileId: string, plain: Buffer): Promise<{ blob: Buffer; wrappedKey: string }> {
  const { dataKey, wrappedKey } = await newDataKeyWith(w, fileId);
  try {
    return { blob: gcmEncrypt(dataKey, plain, Buffer.from(fileId, 'utf8')), wrappedKey };
  } finally {
    dataKey.fill(0);
  }
}

export async function openWith(w: KeyWrapper, fileId: string, blob: Buffer, wrappedKey: string): Promise<Buffer> {
  const dataKey = await unwrapDataKeyWith(w, fileId, wrappedKey);
  try {
    return gcmDecrypt(dataKey, blob, Buffer.from(fileId, 'utf8'));
  } finally {
    dataKey.fill(0);
  }
}
