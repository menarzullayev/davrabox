// LiveKit end-to-end encryption wiring for one meeting.
//
// Verified against the installed livekit-client (2.25.0), not memory:
//  - `ExternalE2EEKeyProvider` (shared key for every participant) and the E2EE worker `livekit-client/e2ee-worker`
//    (SFrame-style frame encryption through insertable streams / RTCRtpScriptTransform, AES-GCM).
//  - `Room.setE2EEEnabled(true)` turns encryption on for the local participant.
//  - Data channel encryption (chat, reactions, hand signals) is ON when the room is configured with the `encryption`
//    option and OFF when it is configured with the deprecated `e2ee` option (`dcEncryptionEnabled = !room.options.e2ee`
//    in the SDK). That is why this module returns `encryption`, not `e2ee`.
//  - `setKey(ArrayBuffer)` derives the AES key with HKDF; `setKey(string)` would use PBKDF2. Our key is 32 random
//    bytes, so the HKDF path is the right one and needs no password stretching.
import { ExternalE2EEKeyProvider, type RoomOptions } from 'livekit-client';
import E2EEWorker from 'livekit-client/e2ee-worker?worker';
import { keyToBytes } from './keys';

export interface E2eeSetup {
  /** Spread into `new Room({...})`. */
  options: Pick<RoomOptions, 'encryption'>;
  keyProvider: ExternalE2EEKeyProvider;
  worker: Worker;
  /** Derives the media key from the meeting key. Resolves before the room connects. */
  installKey(): Promise<void>;
  /** Stops the worker. Safe to call more than once. */
  dispose(): void;
}

/**
 * Builds the room options for an E2EE meeting from the meeting key.
 * The worker is a same-origin module worker emitted by Vite (`worker-src 'self' blob:` in the CSP covers both the
 * emitted file and the blob: form used by some browsers); it is never loaded from another origin.
 */
export function createE2eeRoomOptions(key: string, makeWorker: () => Worker = () => new E2EEWorker()): E2eeSetup {
  const bytes = keyToBytes(key); // throws on anything that is not a valid key: no silent fallback to "no encryption"
  const worker = makeWorker();
  const keyProvider = new ExternalE2EEKeyProvider();
  let disposed = false;
  return {
    options: { encryption: { keyProvider, worker } },
    keyProvider,
    worker,
    installKey: () => keyProvider.setKey(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      worker.terminate();
    },
  };
}
