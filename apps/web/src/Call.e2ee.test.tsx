// @vitest-environment jsdom
// The call screen in an end-to-end encrypted meeting, with a fake LiveKit room and a fake E2EE provider:
//  - without a key nothing is connected and the person sees an explanatory gate (never a blank or garbled screen);
//  - with a key the order is: derive key -> enable encryption -> connect -> only then publish media;
//  - any failure of that sequence fails closed (no plaintext fallback).
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  rooms: [] as Array<{ emit(e: string, ...a: unknown[]): boolean; connect: ReturnType<typeof import('vitest').vi.fn>; options: Record<string, unknown>; localParticipant: { setMicrophoneEnabled: ReturnType<typeof import('vitest').vi.fn>; setCameraEnabled: ReturnType<typeof import('vitest').vi.fn>; publishData: ReturnType<typeof import('vitest').vi.fn> }; setE2EEEnabled: ReturnType<typeof import('vitest').vi.fn> }>,
  log: [] as string[],
  unsupported: false,
  installFails: false,
  providerCalls: [] as string[],
}));

vi.mock('livekit-client', async () => {
  const { EventEmitter } = await import('node:events');
  class FakeParticipant extends EventEmitter {
    isSpeaking = false;
    constructor(public identity: string, public name: string, public isLocal = false) {
      super();
    }
    getTrackPublication() {
      return undefined;
    }
    setMicrophoneEnabled = vi.fn(async () => void h.log.push('mic'));
    setCameraEnabled = vi.fn(async () => void h.log.push('cam'));
    setScreenShareEnabled = vi.fn(async () => undefined);
    publishData = vi.fn(async () => undefined);
  }
  class Room extends EventEmitter {
    localParticipant = new FakeParticipant('me', 'Nodir Aliyev', true);
    remoteParticipants = new Map();
    metadata = '';
    connect = vi.fn(async () => void h.log.push('connect'));
    disconnect = vi.fn(async () => undefined);
    setE2EEEnabled = vi.fn(async (on: boolean) => void h.log.push(`enable:${on}`));
    constructor(public options: Record<string, unknown>) {
      super();
      if (h.unsupported && options.encryption) throw new Error('tried to setup end-to-end encryption on an unsupported browser');
      h.rooms.push(this as never);
    }
  }
  return {
    Room,
    RoomEvent: {
      ParticipantConnected: 'participantConnected',
      ParticipantDisconnected: 'participantDisconnected',
      DataReceived: 'dataReceived',
      ActiveSpeakersChanged: 'activeSpeakersChanged',
      ConnectionQualityChanged: 'connectionQualityChanged',
      Reconnecting: 'reconnecting',
      Reconnected: 'reconnected',
      Disconnected: 'disconnected',
      RoomMetadataChanged: 'roomMetadataChanged',
      EncryptionError: 'encryptionError',
      ParticipantEncryptionStatusChanged: 'participantEncryptionStatusChanged',
    },
    Track: { Source: { Camera: 'camera', Microphone: 'microphone', ScreenShare: 'screen_share' } },
    ConnectionQuality: { Excellent: 'excellent', Good: 'good', Poor: 'poor', Lost: 'lost', Unknown: 'unknown' },
  };
});
vi.mock('@livekit/track-processors', () => ({ BackgroundProcessor: vi.fn(), supportsBackgroundProcessors: () => false }));
vi.mock('./e2ee/provider', () => ({
  createE2eeRoomOptions: (key: string) => {
    h.providerCalls.push(key);
    return {
      options: { encryption: { keyProvider: {}, worker: {} } },
      keyProvider: {},
      worker: {},
      installKey: vi.fn(async () => {
        if (h.installFails) throw new Error('crypto failed');
        h.log.push('installKey');
      }),
      dispose: vi.fn(() => void h.log.push('dispose')),
    };
  },
}));
vi.mock('./api', () => ({
  ApiError: class extends Error {},
  api: {
    me: vi.fn(async () => ({ role: 'host' })),
    listRequests: vi.fn(async () => []),
    cohosts: vi.fn(async () => []),
    recordingStatus: vi.fn(async () => ({ enabled: true, e2ee: true, active: false, canRecord: false })),
    recordings: vi.fn(async () => []),
    uploadFile: vi.fn(),
  },
}));

import { Call } from './Call';
import { generateMeetingKey, storeKey } from './e2ee/keys';

const CODE = '12345678901';
const join = { status: 'joined' as const, token: 'tok', url: 'wss://x', meetingId: 'm', title: 'Board call', isHost: true, e2ee: true };
const flush = async () => act(async () => { await new Promise((r) => setTimeout(r, 5)); });
const mount = (over: Partial<typeof join> = {}, onLeave = vi.fn()) => {
  render(<Call join={{ ...join, ...over }} code={CODE} getToken={async () => 'jwt'} lang="en" onLeave={onLeave} />);
  return onLeave;
};
let key = '';
let consoleSpies: Array<ReturnType<typeof vi.spyOn>> = [];

beforeEach(() => {
  h.rooms.length = 0;
  h.log.length = 0;
  h.providerCalls.length = 0;
  h.unsupported = false;
  h.installFails = false;
  sessionStorage.clear();
  localStorage.clear();
  key = generateMeetingKey();
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 1280, bottom: 560, width: 1280, height: 560, toJSON: () => ({}) });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: /min-width: 1180px/.test(q), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }));
  consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('E2EE meeting without a key', () => {
  it('shows the explanatory gate, builds no room and requests no media', async () => {
    mount();
    await flush();
    expect(screen.getByTestId('e2ee-gate')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('This meeting is encrypted');
    expect(screen.getByText(/Without it video and audio cannot be decrypted/)).toBeTruthy();
    expect(screen.getByText('Board call')).toBeTruthy();
    expect(h.rooms.length).toBe(0); // no Room, so no connect, no getUserMedia, no publish
    expect(h.log).toEqual([]);
    expect(h.providerCalls).toEqual([]);
    expect(document.querySelector('.dv-connecting')).toBeNull();
  });

  it('a tab holding the key of ANOTHER meeting still gets the gate', async () => {
    storeKey('99999999999', key);
    mount();
    await flush();
    expect(screen.getByTestId('e2ee-gate')).toBeTruthy();
    expect(h.rooms.length).toBe(0);
  });

  it('rejects text without a valid key and stays gated; leaving works', async () => {
    const onLeave = mount();
    await flush();
    fireEvent.change(screen.getByTestId('e2ee-gate-input'), { target: { value: 'https://x.example/app?join=12345678901' } });
    fireEvent.click(screen.getByTestId('e2ee-gate-submit'));
    expect(screen.getByText(/No valid key was found/)).toBeTruthy();
    fireEvent.change(screen.getByTestId('e2ee-gate-input'), { target: { value: 'a'.repeat(43) + '!' } });
    fireEvent.click(screen.getByTestId('e2ee-gate-submit'));
    expect(h.rooms.length).toBe(0);
    fireEvent.click(screen.getByTestId('e2ee-gate-leave'));
    expect(onLeave).toHaveBeenCalled();
  });

  it('a pasted full link stores the key for this meeting and the call then starts encrypted', async () => {
    mount();
    await flush();
    fireEvent.change(screen.getByTestId('e2ee-gate-input'), { target: { value: `https://davra.example/app?join=${CODE}#k=${key}` } });
    fireEvent.click(screen.getByTestId('e2ee-gate-submit'));
    await flush();
    await waitFor(() => expect(h.rooms.length).toBe(1));
    expect(sessionStorage.getItem(`davra.e2ee.${CODE}`)).toBe(key);
    expect(h.providerCalls).toEqual([key]);
    expect(screen.queryByTestId('e2ee-gate')).toBeNull();
  });

  it('a browser that cannot encrypt gets a clear message and never a plaintext call', async () => {
    h.unsupported = true;
    storeKey(CODE, key);
    mount();
    await flush();
    expect(h.rooms.length).toBe(0);
    expect(h.log).not.toContain('connect');
    expect(screen.getByTestId('e2ee-unsupported').textContent).toMatch(/does not support encrypted meetings/);
  });
});

describe('E2EE meeting with a key', () => {
  beforeEach(() => storeKey(CODE, key));

  it('derives the key, enables encryption, connects, and only then publishes media', async () => {
    mount();
    await flush();
    await waitFor(() => expect(h.log).toContain('cam'));
    expect(h.log.slice(0, 5)).toEqual(['installKey', 'enable:true', 'connect', 'mic', 'cam']);
    const room = h.rooms[0]!;
    expect(Object.keys(room.options)).toContain('encryption');
    expect(Object.keys(room.options)).not.toContain('e2ee'); // the legacy slot would switch data-channel encryption off
    expect(h.providerCalls).toEqual([key]);
  });

  it('shows a persistent E2EE badge, announces the state, and the record button explains why it is off', async () => {
    mount();
    await flush();
    const badge = await screen.findByTestId('e2ee-badge');
    expect(badge.textContent).toContain('E2EE');
    act(() => void h.rooms[0]!.emit('participantEncryptionStatusChanged', true, { isLocal: true }));
    expect(document.querySelector('[data-testid="e2ee-status"]')?.textContent).toBe('End-to-end encryption is on');
    expect(screen.getByTestId('e2ee-status').getAttribute('aria-live')).toBe('polite');
  });

  it('file sharing is switched off with an explanation', async () => {
    mount();
    await flush();
    fireEvent.click(screen.getByTestId('chat-toggle'));
    expect(screen.queryByTestId('attach')).toBeNull();
    expect(screen.getByTestId('e2ee-nofiles').textContent).toMatch(/File sharing is turned off/);
  });

  it('fails closed: if the key cannot be installed nothing connects and an error is shown', async () => {
    h.installFails = true;
    mount();
    await flush();
    expect(h.log).not.toContain('connect');
    expect(h.log).not.toContain('mic');
    expect(h.log).not.toContain('cam');
    expect(document.body.textContent).toMatch(/Something went wrong|could not/i);
  });

  it('tells the person when decryption fails (wrong key) instead of leaving garbled or black tiles unexplained', async () => {
    mount();
    await flush();
    act(() => void h.rooms[0]!.emit('encryptionError', new Error('InvalidKey'), { identity: 'x' }));
    expect(await screen.findByText(/could not be decrypted/)).toBeTruthy();
  });

  it('disposes the E2EE worker when the call ends', async () => {
    mount();
    await flush();
    cleanup();
    await new Promise((r) => setTimeout(r, 5));
    expect(h.log).toContain('dispose');
  });

  it('never writes the key to the console', async () => {
    mount();
    await flush();
    act(() => void h.rooms[0]!.emit('encryptionError', new Error('InvalidKey'), undefined));
    for (const s of consoleSpies) for (const c of s.mock.calls) expect(JSON.stringify(c)).not.toContain(key);
    expect(document.body.innerHTML).not.toContain(key);
  });
});

describe('a normal meeting is untouched', () => {
  it('does not load the E2EE provider, shows no badge and keeps file sharing', async () => {
    mount({ e2ee: false });
    await flush();
    expect(h.providerCalls).toEqual([]);
    expect(Object.keys(h.rooms[0]!.options)).not.toContain('encryption');
    expect(h.log.slice(0, 3)).toEqual(['connect', 'mic', 'cam']);
    expect(screen.queryByTestId('e2ee-badge')).toBeNull();
    fireEvent.click(screen.getByTestId('chat-toggle'));
    expect(screen.getByTestId('attach')).toBeTruthy();
  });

  it('treats a missing e2ee field (an API that predates the feature) as a normal meeting', async () => {
    const { e2ee: _drop, ...plain } = join;
    render(<Call join={plain} code={CODE} getToken={async () => 'jwt'} lang="en" onLeave={vi.fn()} />);
    await flush();
    expect(h.log).toContain('connect');
  });
});
