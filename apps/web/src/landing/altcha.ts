// Client side of the ALTCHA proof of work (protocol v1, SHA-256), written for this product: no dependency, nothing fetched at
// run time. The server (apps/api/src/signup/altcha.ts) issues {challenge, salt, signature, maxnumber}; the browser finds the
// number n in 0..maxnumber with SHA-256(salt + n) == challenge and sends base64(JSON {algorithm, challenge, number, salt,
// signature}). The search runs in a Web Worker so the page stays responsive, and gives up after 30 seconds.

export interface AltchaChallenge {
  algorithm: 'SHA-256';
  challenge: string;
  salt: string;
  signature: string;
  maxnumber: number;
}

export const SOLVE_TIMEOUT_MS = 30_000;
const BATCH = 512;

export class SolveTimeoutError extends Error {
  constructor() {
    super('the proof of work took too long');
  }
}

const hex = (b: ArrayBuffer): string => {
  let s = '';
  for (const x of new Uint8Array(b)) s += x.toString(16).padStart(2, '0');
  return s;
};

export interface SolveOptions {
  signal?: AbortSignal;
  /** Fraction of the search range covered so far, 0..1. */
  onProgress?: (fraction: number) => void;
}

/** Finds the secret number, or null when it is not in range or the search was aborted. */
export async function solveChallenge(ch: AltchaChallenge, opts: SolveOptions = {}): Promise<number | null> {
  const enc = new TextEncoder();
  for (let start = 0; start <= ch.maxnumber; start += BATCH) {
    if (opts.signal?.aborted) return null;
    const end = Math.min(start + BATCH - 1, ch.maxnumber);
    const digests: Promise<ArrayBuffer>[] = [];
    for (let n = start; n <= end; n++) digests.push(crypto.subtle.digest('SHA-256', enc.encode(ch.salt + n)));
    const done = await Promise.all(digests);
    for (let i = 0; i < done.length; i++) if (hex(done[i]!) === ch.challenge) return start + i;
    opts.onProgress?.(Math.min(1, (end + 1) / (ch.maxnumber + 1)));
  }
  return null;
}

export function buildPayload(ch: AltchaChallenge, number: number): string {
  const json = JSON.stringify({ algorithm: ch.algorithm, challenge: ch.challenge, number, salt: ch.salt, signature: ch.signature });
  return btoa(String.fromCharCode(...new TextEncoder().encode(json)));
}

export type Solver = (ch: AltchaChallenge, opts: { signal: AbortSignal; onProgress?: (f: number) => void }) => Promise<string>;

/** Solves in a Web Worker (falls back to the page when workers are unavailable). Resolves with the payload to send. */
export const solveInWorker: Solver = (ch, { signal, onProgress }) =>
  new Promise<string>((resolve, reject) => {
    const fail = () => reject(new Error('aborted'));
    if (signal.aborted) return fail();
    if (typeof Worker === 'undefined') {
      void solveChallenge(ch, { signal, onProgress }).then((n) => (n === null ? fail() : resolve(buildPayload(ch, n))));
      return;
    }
    const worker = new Worker(new URL('./altcha.worker.ts', import.meta.url), { type: 'module' });
    const stop = () => {
      worker.terminate();
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      stop();
      fail();
    };
    signal.addEventListener('abort', onAbort);
    worker.onmessage = (e: MessageEvent<{ progress?: number; number?: number | null }>) => {
      if (typeof e.data.progress === 'number') return onProgress?.(e.data.progress);
      stop();
      if (typeof e.data.number === 'number') resolve(buildPayload(ch, e.data.number));
      else fail();
    };
    worker.onerror = () => {
      stop();
      fail();
    };
    worker.postMessage(ch);
  });

/** Runs a solver with the time limit; rejects with SolveTimeoutError (and aborts the search) when it is exceeded. */
export async function solveWithTimeout(
  ch: AltchaChallenge,
  solver: Solver = solveInWorker,
  timeoutMs: number = SOLVE_TIMEOUT_MS,
  onProgress?: (f: number) => void,
): Promise<string> {
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, timeoutMs);
  try {
    return await solver(ch, { signal: ctl.signal, onProgress });
  } catch (e) {
    if (timedOut) throw new SolveTimeoutError();
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
