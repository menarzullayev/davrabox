import { createConnection } from 'node:net';

export interface ScanResult {
  clean: boolean;
  signature?: string;
}

/**
 * Scans a buffer with clamd over TCP (INSTREAM protocol). Fails closed: any connection problem, timeout or
 * unexpected answer rejects, and the caller must refuse the upload.
 */
export function scanBuffer(data: Buffer, host: string, port: number, timeoutMs = 30_000, deadlineMs = 90_000): Promise<ScanResult> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    const chunks: Buffer[] = [];
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(hard);
      socket.destroy();
      fn();
    };
    // The idle timer alone is beaten by a peer that trickles a byte now and then: also bound the whole scan.
    const hard = setTimeout(() => done(() => reject(new Error('clamd timeout (deadline)'))), deadlineMs);
    socket.setTimeout(timeoutMs, () => done(() => reject(new Error('clamd timeout'))));
    socket.on('error', (e) => done(() => reject(e)));
    socket.on('data', (d) => chunks.push(d));
    socket.on('end', () => {
      const answer = Buffer.concat(chunks).toString('utf8').replace(/\0/g, '').trim();
      if (/\bOK$/.test(answer)) return done(() => resolve({ clean: true }));
      const m = /^stream:\s*(.+?)\s+FOUND$/.exec(answer);
      if (m) return done(() => resolve({ clean: false, signature: m[1] }));
      done(() => reject(new Error(`unexpected clamd answer: ${answer.slice(0, 80)}`)));
    });
    socket.on('connect', () => {
      socket.write('zINSTREAM\0');
      const CHUNK = 64 * 1024;
      for (let off = 0; off < data.length; off += CHUNK) {
        const part = data.subarray(off, Math.min(off + CHUNK, data.length));
        const len = Buffer.alloc(4);
        len.writeUInt32BE(part.length);
        socket.write(len);
        socket.write(part);
      }
      socket.write(Buffer.alloc(4)); // a zero-length chunk ends the stream
    });
  });
}
