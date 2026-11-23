// @vitest-environment jsdom
// The E2EE room options, against the REAL installed livekit-client (only the Worker is faked): the options use the
// `encryption` slot (data channel encryption stays on), the key goes to the SDK as raw bytes (HKDF), an invalid key
// throws instead of producing a room without encryption, and the SDK really turns data-channel encryption on.
import { Room } from 'livekit-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createE2eeRoomOptions } from './provider';
import { generateMeetingKey, keyToBytes } from './keys';

vi.mock('livekit-client/e2ee-worker?worker', () => ({
  default: class FakeWorker {
    postMessage = vi.fn();
    terminate = vi.fn();
    addEventListener = vi.fn();
    removeEventListener = vi.fn();
    onmessage: unknown = null;
    onerror: unknown = null;
  },
}));

const fakeWorker = () => new (class { postMessage = vi.fn(); terminate = vi.fn(); addEventListener = vi.fn(); removeEventListener = vi.fn(); onmessage: unknown = null; onerror: unknown = null; })() as unknown as Worker;

describe('createE2eeRoomOptions', () => {
  it('returns the `encryption` option, never the deprecated `e2ee` (which would switch data-channel encryption off)', () => {
    const s = createE2eeRoomOptions(generateMeetingKey(), fakeWorker);
    expect(Object.keys(s.options)).toEqual(['encryption']);
    expect('e2ee' in s.options).toBe(false);
  });

  it('throws on an invalid key instead of building a room that would run unencrypted', () => {
    for (const bad of ['', 'abc', 'A'.repeat(44), '+'.repeat(43)]) expect(() => createE2eeRoomOptions(bad, fakeWorker), bad).toThrow();
  });

  it('hands the SDK the raw key bytes (HKDF path), exactly 32 of them, never a string', async () => {
    const key = generateMeetingKey();
    const s = createE2eeRoomOptions(key, fakeWorker);
    const spy = vi.spyOn(s.keyProvider, 'setKey').mockResolvedValue(undefined);
    await s.installKey();
    const arg = spy.mock.calls[0]![0];
    expect(typeof arg).not.toBe('string');
    expect(new Uint8Array(arg as ArrayBuffer)).toEqual(keyToBytes(key));
    expect((arg as ArrayBuffer).byteLength).toBe(32);
  });

  it('derives an AES key in the provider (real WebCrypto, no mock)', async () => {
    const s = createE2eeRoomOptions(generateMeetingKey(), fakeWorker);
    await s.installKey();
    const keys = s.keyProvider.getKeys();
    expect(keys.length).toBe(1);
    expect(keys[0]!.key).toBeDefined();
  });

  it('terminates the worker once, however often dispose is called', () => {
    const s = createE2eeRoomOptions(generateMeetingKey(), fakeWorker);
    s.dispose();
    s.dispose();
    expect((s.worker.terminate as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('the default worker factory builds the bundled E2EE worker', () => {
    const s = createE2eeRoomOptions(generateMeetingKey());
    expect(typeof s.worker.postMessage).toBe('function');
  });
});

describe('what the installed SDK does with those options', () => {
  // jsdom has no WebRTC: pretend the browser can transform encoded frames, as every supported browser can.
  beforeEach(() => vi.stubGlobal('RTCRtpScriptTransform', class {}));
  afterEach(() => vi.unstubAllGlobals());
  type Mgr = { dataChannelEncryptionEnabled: boolean };
  const managerOf = (room: Room) => (room.engine as unknown as { e2eeManager: Mgr | undefined }).e2eeManager;

  it('`encryption` enables data-channel encryption (chat and reactions are encrypted), the deprecated `e2ee` does not', () => {
    const s = createE2eeRoomOptions(generateMeetingKey(), fakeWorker);
    const withEncryption = new Room({ ...s.options });
    expect(managerOf(withEncryption)?.dataChannelEncryptionEnabled).toBe(true);

    const legacy = new Room({ e2ee: s.options.encryption as never });
    expect(managerOf(legacy)?.dataChannelEncryptionEnabled).toBe(false);
  });

  it('a browser that cannot transform encoded frames makes Room throw: the caller must show a message, never fall back to plaintext', () => {
    vi.unstubAllGlobals();
    expect(() => new Room({ ...createE2eeRoomOptions(generateMeetingKey(), fakeWorker).options })).toThrow(/unsupported browser/);
  });

  it('exposes setE2EEEnabled on the room', () => {
    const room = new Room({ ...createE2eeRoomOptions(generateMeetingKey(), fakeWorker).options });
    expect(typeof (room as unknown as { setE2EEEnabled: unknown }).setE2EEEnabled).toBe('function');
  });
});
