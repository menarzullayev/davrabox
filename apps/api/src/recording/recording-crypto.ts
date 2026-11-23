import { Transform, type TransformCallback } from 'node:stream';
import { gcmDecrypt, gcmEncrypt, newDataKey, unwrapDataKey } from '../files/crypto.js';

/**
 * Stream envelope encryption for recordings, built on the AES-256-GCM helpers of files/crypto.ts. A recording is too
 * large to hold in memory (seal() works on whole buffers), so it is cut into chunks, each sealed with the recording's
 * own data key (itself wrapped by the master key, exactly like a shared file).
 *
 * Frame: [u32 BE length of blob][u8 final flag][blob = iv | ciphertext | tag]. The additional authenticated data of a
 * frame is `<recording id>:<chunk index>:<final flag>`, so chunks cannot be reordered, moved to another recording,
 * duplicated or have their flag flipped, and a stream that stops before its final chunk is reported as truncated.
 */
export const CHUNK_BYTES = 4 * 1024 * 1024;
const OVERHEAD = 12 + 16;
const HEADER = 5;

export function newRecordingKey(master: Buffer, recordingId: string): { dataKey: Buffer; wrappedKey: string } {
  return newDataKey(master, recordingId);
}

export function unwrapRecordingKey(master: Buffer, recordingId: string, wrappedKey: string): Buffer {
  return unwrapDataKey(master, recordingId, wrappedKey);
}

function aad(id: string, index: number, last: boolean): Buffer {
  return Buffer.from(`${id}:${index}:${last ? 1 : 0}`, 'utf8');
}

export function encryptStream(dataKey: Buffer, recordingId: string, chunkBytes: number = CHUNK_BYTES): Transform {
  let buf: Buffer = Buffer.alloc(0);
  let index = 0;
  const frame = (plain: Buffer, last: boolean): Buffer => {
    const blob = gcmEncrypt(dataKey, plain, aad(recordingId, index++, last));
    const head = Buffer.alloc(HEADER);
    head.writeUInt32BE(blob.length, 0);
    head.writeUInt8(last ? 1 : 0, 4);
    return Buffer.concat([head, blob]);
  };
  return new Transform({
    transform(chunk: Buffer, _enc, cb: TransformCallback) {
      try {
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
        // Strictly greater: the last frame is emitted at flush and is never empty unless the whole input is.
        while (buf.length > chunkBytes) {
          this.push(frame(buf.subarray(0, chunkBytes), false));
          buf = buf.subarray(chunkBytes);
        }
        cb();
      } catch (e) {
        cb(e as Error);
      }
    },
    flush(cb: TransformCallback) {
      try {
        this.push(frame(buf, true));
        cb();
      } catch (e) {
        cb(e as Error);
      }
    },
  });
}

export function decryptStream(dataKey: Buffer, recordingId: string, maxChunkBytes: number = CHUNK_BYTES): Transform {
  let buf: Buffer = Buffer.alloc(0);
  let index = 0;
  let finished = false;
  const maxBlob = maxChunkBytes + OVERHEAD;
  return new Transform({
    transform(chunk: Buffer, _enc, cb: TransformCallback) {
      try {
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
        for (;;) {
          if (finished) {
            if (buf.length > 0) throw new Error('unexpected data after the final frame');
            break;
          }
          if (buf.length < HEADER) break;
          const len = buf.readUInt32BE(0);
          const flag = buf.readUInt8(4);
          if (len < OVERHEAD || len > maxBlob || flag > 1) throw new Error('invalid frame header');
          if (buf.length < HEADER + len) break;
          const last = flag === 1;
          this.push(gcmDecrypt(dataKey, buf.subarray(HEADER, HEADER + len), aad(recordingId, index++, last)));
          buf = buf.subarray(HEADER + len);
          if (last) finished = true;
        }
        cb();
      } catch (e) {
        cb(e as Error);
      }
    },
    flush(cb: TransformCallback) {
      cb(finished && buf.length === 0 ? null : new Error('recording stream is truncated'));
    },
  });
}
