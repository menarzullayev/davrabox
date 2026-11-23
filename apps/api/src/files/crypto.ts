import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Envelope encryption for stored files: every file gets its own random AES-256 data key; the data key is wrapped
 * (AES-256-GCM) with the master key. Both layers use the file id as additional authenticated data, so a blob or a
 * wrapped key moved to another file fails authentication. In production the master key lives in Vault/HSM.
 */
const IV = 12;
const TAG = 16;

function gcmEncrypt(key: Buffer, plain: Buffer, aad: Buffer): Buffer {
  const iv = randomBytes(IV);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aad);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]);
}

function gcmDecrypt(key: Buffer, blob: Buffer, aad: Buffer): Buffer {
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
