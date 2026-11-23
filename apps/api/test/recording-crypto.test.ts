import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { describe, expect, it } from 'vitest';
import { decryptStream, encryptStream, newRecordingKey, unwrapRecordingKey } from '../src/recording/recording-crypto.js';

const master = randomBytes(32);

async function collect(r: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const p of r) parts.push(p);
  return Buffer.concat(parts);
}

async function enc(plain: Buffer, id = 'rec-1', chunk = 64): Promise<{ blob: Buffer; wrappedKey: string }> {
  const { dataKey, wrappedKey } = newRecordingKey(master, id);
  const out = encryptStream(dataKey, id, chunk);
  await pipeline(Readable.from([plain]), out);
  return { blob: await collect(out), wrappedKey };
}

async function dec(blob: Buffer, wrappedKey: string, id = 'rec-1'): Promise<Buffer> {
  const out = decryptStream(unwrapRecordingKey(master, id, wrappedKey), id);
  Readable.from([blob]).pipe(out);
  return collect(out);
}

describe('recording stream encryption', () => {
  it('round-trips data spanning many chunks and hides the plaintext', async () => {
    const plain = Buffer.concat([Buffer.from('MEETING-VIDEO-MARKER'), randomBytes(1000)]);
    const { blob, wrappedKey } = await enc(plain);
    expect(blob.includes(Buffer.from('MEETING-VIDEO-MARKER'))).toBe(false);
    expect((await dec(blob, wrappedKey)).equals(plain)).toBe(true);
  });

  it('round-trips an empty input and an exact multiple of the chunk size', async () => {
    for (const n of [0, 1, 64, 128, 129]) {
      const plain = randomBytes(n);
      const { blob, wrappedKey } = await enc(plain);
      expect((await dec(blob, wrappedKey)).equals(plain)).toBe(true);
    }
  });

  it('each recording gets its own data key', () => {
    const a = newRecordingKey(master, 'rec-1');
    const b = newRecordingKey(master, 'rec-1');
    expect(a.dataKey.equals(b.dataKey)).toBe(false);
    expect(a.wrappedKey).not.toBe(b.wrappedKey);
  });

  it('refuses a flipped byte', async () => {
    const { blob, wrappedKey } = await enc(randomBytes(300));
    const bad = Buffer.from(blob);
    bad.writeUInt8(bad.readUInt8(40) ^ 0xff, 40);
    await expect(dec(bad, wrappedKey)).rejects.toThrow();
  });

  it('refuses a truncated stream (cut at a chunk boundary or inside a frame)', async () => {
    const { blob, wrappedKey } = await enc(randomBytes(300));
    const firstFrame = 5 + blob.readUInt32BE(0);
    await expect(dec(blob.subarray(0, firstFrame), wrappedKey)).rejects.toThrow(/truncated/);
    await expect(dec(blob.subarray(0, blob.length - 3), wrappedKey)).rejects.toThrow();
    await expect(dec(Buffer.alloc(0), wrappedKey)).rejects.toThrow();
  });

  it('refuses reordered chunks and trailing data after the final chunk', async () => {
    const { blob, wrappedKey } = await enc(randomBytes(300));
    const frames: Buffer[] = [];
    for (let o = 0; o < blob.length; ) {
      const n = 5 + blob.readUInt32BE(o);
      frames.push(blob.subarray(o, o + n));
      o += n;
    }
    expect(frames.length).toBeGreaterThan(2);
    const swapped = Buffer.concat([frames[1]!, frames[0]!, ...frames.slice(2)]);
    await expect(dec(swapped, wrappedKey)).rejects.toThrow();
    await expect(dec(Buffer.concat([blob, frames[0]!]), wrappedKey)).rejects.toThrow();
  });

  it('refuses another recording id, another master key and an oversized frame header', async () => {
    const { blob, wrappedKey } = await enc(randomBytes(100), 'rec-1');
    await expect(dec(blob, wrappedKey, 'rec-2')).rejects.toThrow();
    expect(() => unwrapRecordingKey(randomBytes(32), 'rec-1', wrappedKey)).toThrow();
    const huge = Buffer.from(blob);
    huge.writeUInt32BE(0x7fffffff, 0);
    await expect(dec(huge, wrappedKey)).rejects.toThrow(/frame/);
  });
});
