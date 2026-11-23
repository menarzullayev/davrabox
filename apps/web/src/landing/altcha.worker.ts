import { solveChallenge, type AltchaChallenge } from './altcha';

// Web Worker: runs the proof-of-work search off the main thread. Messages out: {progress} while searching, then {number}
// (null when not found). Terminated by the page on abort or timeout.
self.onmessage = async (e: MessageEvent<AltchaChallenge>) => {
  if (e.origin && e.origin !== self.location.origin) return; // a dedicated worker only hears its own page
  const number = await solveChallenge(e.data, { onProgress: (progress) => (self as unknown as Worker).postMessage({ progress }) });
  (self as unknown as Worker).postMessage({ number });
};
