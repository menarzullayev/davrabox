// @vitest-environment jsdom
// The real Call component with a fake LiveKit room: lifecycle (including the React StrictMode guard), participants,
// data-channel signals (chat, hand, reaction), role handling and host actions are wired into the new call screen.
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const rooms: Array<{ emit(e: string, ...a: unknown[]): boolean; connect: ReturnType<typeof import('vitest').vi.fn>; disconnect: ReturnType<typeof import('vitest').vi.fn>; localParticipant: unknown; remoteParticipants: Map<string, unknown> }> = [];
  return { rooms, failConnect: false, roomMetadata: '' };
});

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
    setMicrophoneEnabled = vi.fn(async () => undefined);
    setCameraEnabled = vi.fn(async () => undefined);
    setScreenShareEnabled = vi.fn(async () => undefined);
    publishData = vi.fn(async () => undefined);
  }
  class Room extends EventEmitter {
    localParticipant = new FakeParticipant('me', 'Nodir Aliyev', true);
    remoteParticipants = new Map<string, FakeParticipant>();
    metadata = h.roomMetadata;
    connect = vi.fn(async () => {
      if (h.failConnect) throw new Error('no');
    });
    disconnect = vi.fn(async () => undefined);
    constructor() {
      super();
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
    },
    Track: { Source: { Camera: 'camera', Microphone: 'microphone', ScreenShare: 'screen_share' } },
    ConnectionQuality: { Excellent: 'excellent', Good: 'good', Poor: 'poor', Lost: 'lost', Unknown: 'unknown' },
    __FakeParticipant: FakeParticipant,
  };
});
vi.mock('@livekit/track-processors', () => ({ BackgroundProcessor: vi.fn(), supportsBackgroundProcessors: () => false }));
vi.mock('./api', () => ({
  ApiError: class extends Error {},
  api: {
    me: vi.fn(async () => ({ role: 'host' })),
    listRequests: vi.fn(async () => [{ id: 'r1', user_id: 'u', display_name: 'Nargiza Boboqulova', email: 'n@x.uz' }]),
    cohosts: vi.fn(async () => []),
    decide: vi.fn(async () => ({ status: 'ok' })),
    mute: vi.fn(async () => ({ muted: 1 })),
    remove: vi.fn(async () => ({ removed: true })),
    setCohost: vi.fn(async () => ({ cohost: true })),
    lock: vi.fn(async (_t: string, _c: string, locked: boolean) => ({ locked })),
    uploadFile: vi.fn(),
    downloadFile: vi.fn(),
    recordingStatus: vi.fn(async () => ({ enabled: false, e2ee: false, active: false, canRecord: false })),
    startRecording: vi.fn(async () => ({ id: 'rec1', status: 'active' })),
    stopRecording: vi.fn(async () => ({ id: 'rec1', status: 'stopping' })),
    recordings: vi.fn(async () => []),
    downloadRecording: vi.fn(),
  },
}));

import * as lk from 'livekit-client';
import { api } from './api';
import { Call } from './Call';
import { encode } from './signals';
import { pickOption } from './ui/testing';
import { handleBack, resetBackForTests } from './platform/back';

const Fake = (lk as unknown as { __FakeParticipant: new (id: string, name: string) => import('node:events').EventEmitter & { identity: string; name: string; publishData: ReturnType<typeof vi.fn> } }).__FakeParticipant;
const join = { status: 'joined' as const, token: 'tok', url: 'wss://x', meetingId: 'm', title: 'Weekly sync', isHost: true };
const flush = async () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

beforeEach(() => {
  h.rooms.length = 0;
  h.failConnect = false;
  h.roomMetadata = '';
  localStorage.clear();
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 1280, bottom: 560, width: 1280, height: 560, toJSON: () => ({}) });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: /min-width: 1180px/.test(q), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount(onLeave = vi.fn(), strict = false) {
  const el = <Call join={join} code="12345678901" getToken={async () => 'jwt'} lang="en" onLeave={onLeave} />;
  render(strict ? <StrictMode>{el}</StrictMode> : el);
  return onLeave;
}
const room = () => h.rooms[h.rooms.length - 1]!;
const lkRoom = () => room() as unknown as import('node:events').EventEmitter & { remoteParticipants: Map<string, unknown>; localParticipant: { publishData: ReturnType<typeof vi.fn> } };

describe('Call and the Android Back button', () => {
  beforeEach(() => resetBackForTests());
  const back = (): boolean => {
    let handled = false;
    act(() => {
      handled = handleBack();
    });
    return handled;
  };

  it('with nothing open Back asks before leaving; Stay keeps the call, Leave ends it', async () => {
    const onLeave = mount();
    await flush();
    await waitFor(() => expect(document.querySelector('.dv-connecting')).toBeNull());
    expect(back()).toBe(true);
    expect(screen.getByRole('dialog', { name: 'Leave the call?' })).toBeTruthy();
    expect(onLeave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('leave-stay'));
    expect(screen.queryByRole('dialog', { name: 'Leave the call?' })).toBeNull();
    expect(onLeave).not.toHaveBeenCalled();
    expect(back()).toBe(true);
    fireEvent.click(screen.getByTestId('leave-confirm'));
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it('Back closes the open chat panel first, then the next press asks about leaving', async () => {
    const onLeave = mount();
    await flush();
    await waitFor(() => expect(document.querySelector('.dv-connecting')).toBeNull());
    fireEvent.click(screen.getByTestId('chat-toggle'));
    expect(screen.queryByTestId('chat-panel')).not.toBeNull();
    expect(back()).toBe(true);
    expect(screen.queryByTestId('chat-panel')).toBeNull();
    expect(screen.queryByRole('dialog', { name: 'Leave the call?' })).toBeNull();
    expect(back()).toBe(true);
    expect(screen.getByRole('dialog', { name: 'Leave the call?' })).toBeTruthy();
    expect(onLeave).not.toHaveBeenCalled();
  });

  it('Back closes an open menu before anything else', async () => {
    mount();
    await flush();
    await waitFor(() => expect(document.querySelector('.dv-connecting')).toBeNull());
    fireEvent.click(screen.getByTestId('more'));
    expect(screen.queryByTestId('noise')).not.toBeNull();
    expect(back()).toBe(true);
    expect(screen.queryByTestId('noise')).toBeNull();
    expect(screen.queryByRole('dialog', { name: 'Leave the call?' })).toBeNull();
  });
});

describe('Call with a fake room', () => {
  it('connects once, shows the connecting ring first and then the local tile with the host controls', async () => {
    mount();
    expect(document.querySelector('.dv-connecting')).toBeTruthy();
    await flush();
    await waitFor(() => expect(document.querySelector('.dv-connecting')).toBeNull());
    expect(room().connect).toHaveBeenCalledWith('wss://x', 'tok', undefined);
    expect(document.querySelectorAll('.grid .tile[data-identity]')).toHaveLength(1);
    expect(screen.getByTestId('role-badge').textContent).toBe('Host');
    expect(screen.getByTestId('count').textContent).toBe('1');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Weekly sync');
  });

  it('uses the relay (firewall) mode from the browser storage', async () => {
    localStorage.setItem('relayMode', '1');
    mount();
    await flush();
    expect(room().connect).toHaveBeenCalledWith('wss://x', 'tok', { rtcConfig: { iceTransportPolicy: 'relay' } });
    fireEvent.click(screen.getByTestId('more'));
    expect(screen.getByTestId('firewall-info').textContent).toContain('On');
  });

  it('under StrictMode only the disconnect of the current room leaves the call', async () => {
    const onLeave = mount(vi.fn(), true);
    await flush();
    expect(h.rooms.length).toBe(2); // mounted, unmounted, mounted again
    act(() => void h.rooms[0]!.emit('disconnected'));
    expect(onLeave).not.toHaveBeenCalled();
    act(() => void h.rooms[1]!.emit('disconnected'));
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it('adds and removes participants as tiles and keeps join order (yourself first)', async () => {
    mount();
    await flush();
    const r = lkRoom();
    const a = new Fake('a', 'Aziz Karimov');
    const b = new Fake('b', 'Dilnoza Yusupova');
    act(() => {
      r.remoteParticipants.set('a', a);
      r.remoteParticipants.set('b', b);
      r.emit('participantConnected', a);
      r.emit('participantConnected', b);
    });
    expect(Array.from(document.querySelectorAll<HTMLElement>('.grid .tile[data-identity]')).map((t) => t.dataset.identity)).toEqual(['me', 'a', 'b']);
    expect(screen.getByTestId('count').textContent).toBe('3');
    act(() => {
      r.remoteParticipants.delete('a');
      r.emit('participantDisconnected', a);
    });
    expect(Array.from(document.querySelectorAll<HTMLElement>('.grid .tile[data-identity]')).map((t) => t.dataset.identity)).toEqual(['me', 'b']);
  });

  it('features the last active speaker in the centre and keeps them there when everyone is silent', async () => {
    mount();
    await flush();
    const r = lkRoom();
    const a = new Fake('a', 'Aziz Karimov');
    const b = new Fake('b', 'Dilnoza Yusupova');
    act(() => {
      r.remoteParticipants.set('a', a);
      r.remoteParticipants.set('b', b);
      r.emit('participantConnected', a);
      r.emit('participantConnected', b);
    });
    expect((document.querySelector('.tile.featured') as HTMLElement).dataset.identity).toBe('a'); // first remote
    act(() => void r.emit('activeSpeakersChanged', [b]));
    expect((document.querySelector('.tile.featured') as HTMLElement).dataset.identity).toBe('b');
    act(() => void r.emit('activeSpeakersChanged', []));
    expect((document.querySelector('.tile.featured') as HTMLElement).dataset.identity).toBe('b');
  });

  it('handles chat signals: unread counter while closed, a literal line when open, private tag', async () => {
    mount();
    await flush();
    const r = lkRoom();
    const a = new Fake('a', 'Aziz Karimov');
    act(() => {
      r.remoteParticipants.set('a', a);
      r.emit('participantConnected', a);
    });
    act(() => void r.emit('dataReceived', encode({ t: 'chat', text: '<b>hello</b>' }), a, undefined, 'chat'));
    expect(screen.getByTestId('chat-toggle').textContent).toContain('(1)');
    fireEvent.click(screen.getByTestId('chat-toggle'));
    expect(screen.queryByTestId('chat-toggle')!.textContent).not.toContain('(1)');
    expect(screen.getAllByTestId('chat-line')).toHaveLength(1);
    expect(document.querySelector('.chat-text')!.textContent).toBe('<b>hello</b>');
    act(() => void r.emit('dataReceived', encode({ t: 'chat', text: 'psst' }), a, undefined, 'chat-private'));
    expect(screen.getAllByTestId('chat-line')).toHaveLength(2);
    expect(screen.getAllByTestId('chat-line')[1]!.textContent).toMatch(/private/);
    // chat-toggle stays at zero while the chat is open
    expect(screen.getByTestId('chat-toggle').textContent).not.toMatch(/\(\d\)/);
  });

  it('sends a chat message to everyone and a private one to the chosen participant, ignoring whitespace', async () => {
    mount();
    await flush();
    const r = lkRoom();
    const a = new Fake('a', 'Aziz Karimov');
    act(() => {
      r.remoteParticipants.set('a', a);
      r.emit('participantConnected', a);
    });
    fireEvent.click(screen.getByTestId('chat-toggle'));
    const input = screen.getByTestId('chat-input');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.submit(input.closest('form')!);
    await flush();
    expect(r.localParticipant.publishData).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: 'hello all' } });
    fireEvent.submit(input.closest('form')!);
    await flush();
    expect(r.localParticipant.publishData).toHaveBeenCalledTimes(1);
    expect(r.localParticipant.publishData.mock.calls[0]![1]).toMatchObject({ reliable: true, topic: 'chat', destinationIdentities: undefined });
    pickOption('chat-target', 'a');
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'only you' } });
    fireEvent.submit(screen.getByTestId('chat-input').closest('form')!);
    await flush();
    expect(r.localParticipant.publishData.mock.calls[1]![1]).toMatchObject({ topic: 'chat-private', destinationIdentities: ['a'] });
    expect(screen.getAllByTestId('chat-line')).toHaveLength(2);
  });

  it('shows a raised hand and a reaction of a remote participant on their tile', async () => {
    mount();
    await flush();
    const r = lkRoom();
    const a = new Fake('a', 'Aziz Karimov');
    act(() => {
      r.remoteParticipants.set('a', a);
      r.emit('participantConnected', a);
    });
    act(() => void r.emit('dataReceived', encode({ t: 'hand', up: true }), a));
    const tile = document.querySelector('.tile[data-identity="a"]') as HTMLElement;
    expect(tile.querySelector('.label')!.textContent).toContain('✋');
    act(() => void r.emit('dataReceived', encode({ t: 'react', e: '🎉' }), a));
    expect(within(tile).getByTestId('reaction').textContent).toBe('🎉');
    act(() => void r.emit('dataReceived', encode({ t: 'hand', up: false }), a));
    expect(tile.querySelector('.label')!.textContent).not.toContain('✋');
  });

  it('ignores data from an unknown sender and malformed payloads', async () => {
    mount();
    await flush();
    const r = lkRoom();
    act(() => void r.emit('dataReceived', encode({ t: 'chat', text: 'ghost' }), undefined));
    const a = new Fake('a', 'A');
    act(() => {
      r.remoteParticipants.set('a', a);
      r.emit('participantConnected', a);
    });
    act(() => void r.emit('dataReceived', new TextEncoder().encode('not json'), a));
    fireEvent.click(screen.getByTestId('chat-toggle'));
    expect(screen.queryAllByTestId('chat-line')).toHaveLength(0);
  });

  it('sends hand and reaction signals through the data channel', async () => {
    mount();
    await flush();
    const r = lkRoom();
    fireEvent.click(screen.getByTestId('hand'));
    await flush();
    expect(r.localParticipant.publishData).toHaveBeenCalledTimes(1);
    expect(new TextDecoder().decode(r.localParticipant.publishData.mock.calls[0]![0])).toBe(JSON.stringify({ t: 'hand', up: true }));
    expect(document.querySelector('.tile[data-identity="me"] .label')!.textContent).toContain('✋');
    fireEvent.click(screen.getByTestId('reactions'));
    fireEvent.click(await screen.findByTestId('react-🎉'));
    await flush();
    expect(new TextDecoder().decode(r.localParticipant.publishData.mock.calls[1]![0])).toBe(JSON.stringify({ t: 'react', e: '🎉' }));
    expect(screen.getByTestId('reaction').textContent).toBe('🎉');
  });

  it('turns the microphone and camera off and on through the room', async () => {
    mount();
    await flush();
    const r = lkRoom() as unknown as { localParticipant: { setMicrophoneEnabled: ReturnType<typeof vi.fn>; setCameraEnabled: ReturnType<typeof vi.fn> } };
    r.localParticipant.setMicrophoneEnabled.mockClear();
    fireEvent.click(screen.getByTestId('mic'));
    await flush();
    expect(r.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(false);
    expect(screen.getByRole('button', { name: /Microphone, turn on/ })).toBeTruthy();
    fireEvent.click(screen.getByTestId('cam'));
    await flush();
    expect(r.localParticipant.setCameraEnabled).toHaveBeenLastCalledWith(false);
  });

  it('shows the waiting-room request to the host and answers it through the API', async () => {
    mount();
    await flush();
    await waitFor(() => expect(screen.getByTestId('join-request')).toBeTruthy());
    expect(screen.getByTestId('join-request').textContent).toContain('Nargiza Boboqulova');
    fireEvent.click(screen.getByTestId('join-request').querySelector('button.primary')!);
    await flush();
    expect(api.decide).toHaveBeenCalledWith('jwt', '12345678901', 'r1', true);
    await waitFor(() => expect(screen.queryByTestId('join-request')).toBeNull());
  });

  it('locks the meeting through the API and mutes, removes and promotes a participant', async () => {
    mount();
    await flush();
    await waitFor(() => expect(screen.getByTestId('lock')).toBeTruthy());
    fireEvent.click(screen.getByTestId('lock'));
    await waitFor(() => expect(screen.getByTestId('lock').getAttribute('aria-pressed')).toBe('true'));
    expect(api.lock).toHaveBeenCalledWith('jwt', '12345678901', true);
    const r = lkRoom();
    const a = new Fake('a', 'Aziz Karimov');
    act(() => {
      r.remoteParticipants.set('a', a);
      r.emit('participantConnected', a);
    });
    const tile = document.querySelector('.tile[data-identity="a"]') as HTMLElement;
    fireEvent.click(within(tile).getByRole('button', { name: /^Mute/ }));
    await flush();
    expect(api.mute).toHaveBeenCalledWith('jwt', '12345678901', 'a');
    fireEvent.click(within(tile).getByTestId('cohost-toggle'));
    await flush();
    expect(api.setCohost).toHaveBeenCalledWith('jwt', '12345678901', 'a', true);
    await waitFor(() => expect(within(document.querySelector('.tile[data-identity="a"]') as HTMLElement).getByTestId('cohost-toggle').getAttribute('aria-label')).toMatch(/^Remove co-host/));
    fireEvent.click(within(tile).getByRole('button', { name: /^Remove(?! co-host)/ }));
    await flush();
    expect(api.remove).not.toHaveBeenCalled(); // asks for confirmation first
    fireEvent.click(screen.getByTestId('remove-confirm'));
    await flush();
    expect(api.remove).toHaveBeenCalledWith('jwt', '12345678901', 'a');
  });

  it('shows a plain member no manager controls', async () => {
    (api.me as ReturnType<typeof vi.fn>).mockResolvedValue({ role: 'member' });
    render(<Call join={{ ...join, isHost: false }} code="1" getToken={async () => 'jwt'} lang="en" onLeave={vi.fn()} />);
    await flush();
    expect(screen.queryByTestId('lock')).toBeNull();
    expect(screen.queryByTestId('role-badge')).toBeNull();
    expect(document.querySelectorAll('.badge')).toHaveLength(0);
    (api.me as ReturnType<typeof vi.fn>).mockResolvedValue({ role: 'host' });
  });

  it('follows a promotion to co-host while connected', async () => {
    (api.me as ReturnType<typeof vi.fn>).mockResolvedValue({ role: 'cohost' });
    render(<Call join={{ ...join, isHost: false }} code="1" getToken={async () => 'jwt'} lang="en" onLeave={vi.fn()} />);
    await flush();
    await waitFor(() => expect(screen.getByTestId('role-badge').textContent).toBe('Co-host'));
    expect(screen.getByTestId('lock')).toBeTruthy();
    (api.me as ReturnType<typeof vi.fn>).mockResolvedValue({ role: 'host' });
  });

  it('shows the reconnecting notice and the connection quality, and an error when the room cannot be joined', async () => {
    mount();
    await flush();
    const r = lkRoom();
    act(() => void r.emit('connectionQualityChanged', 'poor', { isLocal: true }));
    expect(screen.getByTestId('quality').getAttribute('data-q')).toBe('poor');
    act(() => void r.emit('reconnecting'));
    expect(screen.getByText('Reconnecting…')).toBeTruthy();
    expect(screen.getByTestId('quality').getAttribute('data-q')).toBe('lost');
    act(() => void r.emit('reconnected'));
    expect(screen.queryByText('Reconnecting…')).toBeNull();
    cleanup();
    h.rooms.length = 0;
    h.failConnect = true;
    mount();
    await flush();
    await waitFor(() => expect(document.querySelector('.error')).toBeTruthy());
  });

  it('remembers the chosen layout in the browser', async () => {
    mount();
    await flush();
    fireEvent.click(screen.getByTestId('layout'));
    fireEvent.click(screen.getByTestId('layout-speaker').querySelector('input')!);
    expect(localStorage.getItem('callLayout')).toBe('speaker');
    expect(screen.getByTestId('grid').getAttribute('data-layout')).toBe('speaker');
    cleanup();
    mount();
    await flush();
    expect(screen.getByTestId('grid').getAttribute('data-layout')).toBe('speaker');
  });
});

describe('recording in the call', () => {
  const status = (api.recordingStatus as ReturnType<typeof vi.fn>);
  const asMember = () => (api.me as ReturnType<typeof vi.fn>).mockResolvedValue({ role: 'member' });
  beforeEach(() => {
    for (const f of [api.startRecording, api.stopRecording, api.recordings]) (f as ReturnType<typeof vi.fn>).mockClear();
  });
  afterEach(() => {
    (api.me as ReturnType<typeof vi.fn>).mockResolvedValue({ role: 'host' });
    status.mockResolvedValue({ enabled: false, e2ee: false, active: false, canRecord: false });
  });
  const memberCall = () => render(<Call join={{ ...join, isHost: false }} code="1" getToken={async () => 'jwt'} lang="en" onLeave={vi.fn()} />);

  it('a participant who joins while a recording runs sees the badge at once and gets the announcement; a member has no record control', async () => {
    asMember();
    h.roomMetadata = '{"recording":true}';
    memberCall();
    await flush();
    await waitFor(() => expect(screen.getByTestId('rec-badge')).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId('rec-live').textContent).toBe('Recording started. This meeting is being recorded'));
    expect(screen.queryByTestId('record')).toBeNull();
  });

  it('follows the room metadata for everyone, and a forged data message cannot hide the badge', async () => {
    asMember();
    memberCall();
    await flush();
    expect(screen.queryByTestId('rec-badge')).toBeNull();
    act(() => void lkRoom().emit('roomMetadataChanged', '{"recording":true}'));
    await waitFor(() => expect(screen.getByTestId('rec-badge')).toBeTruthy());
    const fake = new Fake('evil', 'Mallory');
    act(() => {
      lkRoom().remoteParticipants.set('evil', fake);
      lkRoom().emit('participantConnected', fake);
      lkRoom().emit('dataReceived', encode({ t: 'hand', up: false }), fake);
      lkRoom().emit('dataReceived', new TextEncoder().encode('{"t":"rec","on":false}'), fake);
    });
    await flush();
    expect(screen.getByTestId('rec-badge')).toBeTruthy();
    act(() => void lkRoom().emit('roomMetadataChanged', '{}'));
    await waitFor(() => expect(screen.queryByTestId('rec-badge')).toBeNull());
    await waitFor(() => expect(screen.getByTestId('rec-live').textContent).toBe('Recording stopped'));
  });

  it('the host starts and stops recording through the API; the badge follows the server, not the click', async () => {
    status.mockResolvedValue({ enabled: true, e2ee: false, active: false, canRecord: true });
    mount();
    await flush();
    await waitFor(() => expect(screen.getByTestId('record')).toBeTruthy());
    fireEvent.click(screen.getByTestId('record'));
    await flush();
    expect(api.startRecording).toHaveBeenCalledWith('jwt', '12345678901');
    expect(screen.queryByTestId('rec-badge')).toBeNull();
    act(() => void lkRoom().emit('roomMetadataChanged', '{"recording":true}'));
    await waitFor(() => expect(screen.getByTestId('record').textContent).toContain('Stop recording'));
    fireEvent.click(screen.getByTestId('record'));
    await flush();
    expect(api.stopRecording).toHaveBeenCalledWith('jwt', '12345678901');
  });

  it('in an E2EE meeting the host cannot start a recording and sees why', async () => {
    status.mockResolvedValue({ enabled: true, e2ee: true, active: false, canRecord: false });
    mount();
    await flush();
    await waitFor(() => expect(screen.getByTestId('record').getAttribute('aria-disabled')).toBe('true'));
    expect(screen.getByTestId('record').textContent).toContain('End-to-end encrypted meetings cannot be recorded');
    fireEvent.click(screen.getByTestId('record'));
    await flush();
    expect(api.startRecording).not.toHaveBeenCalled();
  });

  it('shows no record control when recording is not available on the server', async () => {
    mount();
    await flush();
    await waitFor(() => expect(screen.getByTestId('role-badge')).toBeTruthy());
    expect(screen.queryByTestId('record')).toBeNull();
  });
});

describe('Call as a guest (no account)', () => {
  const guestJoin = { status: 'joined' as const, token: 'gtok', url: 'wss://x', meetingId: 'm', title: 'Weekly sync', isHost: false, guest: true, guestToken: 'gs' };
  function mountGuest() {
    return render(<Call join={guestJoin} code="12345678901" guest getToken={async () => 'gs'} lang="en" onLeave={vi.fn()} />);
  }

  it('makes none of the member-only calls (role, requests, co-hosts, recording) and shows no host controls', async () => {
    mountGuest();
    await flush();
    await waitFor(() => expect(document.querySelector('.dv-connecting')).toBeNull());
    await act(async () => { await new Promise((r) => setTimeout(r, 2300)); }); // longer than one poll interval
    expect(api.me).not.toHaveBeenCalled();
    expect(api.listRequests).not.toHaveBeenCalled();
    expect(api.cohosts).not.toHaveBeenCalled();
    expect(api.recordingStatus).not.toHaveBeenCalled();
    expect(screen.queryByTestId('record')).toBeNull();
    expect(screen.queryByTestId('lock')).toBeNull();
    expect(screen.queryByTestId('join-request')).toBeNull();
  });

  it('labels another guest in the participant list', async () => {
    mountGuest();
    await flush();
    const p = new Fake('guest:00000000-0000-4000-8000-000000000001', 'Ali Valiyev');
    act(() => {
      (lkRoom().remoteParticipants as Map<string, unknown>).set(p.identity, p);
      lkRoom().emit('participantConnected', p);
    });
    await waitFor(() => expect(document.body.textContent).toContain('Ali Valiyev (guest)'));
  });
});

describe('Call as a member with a guest in the waiting room', () => {
  it('labels the guest request so the host can tell who has no account', async () => {
    (api.listRequests as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{ id: 'g1', user_id: null, display_name: 'Waiting Wendy', email: null, guest: true }]);
    mount();
    await flush();
    await waitFor(() => expect(screen.getByTestId('join-request').textContent).toContain('Waiting Wendy (guest)'));
  });
});
