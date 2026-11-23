// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dictionaries } from '../i18n';
import { ControlBar, type ControlBarProps } from './ControlBar';
import { CallView, type CallViewProps } from './CallView';
import { RecordingBadge, RecordingLive } from './RecordingBadge';
import type { ParticipantView, RecordingView } from './types';

afterEach(cleanup);

const person = (i: number): ParticipantView => ({
  id: `p${i}`, name: ['Nodir Aliyev', 'Aziz Karimov', 'Dilnoza Yusupova'][i]!, local: i === 0, speaking: false, micMuted: false, camOn: true, handUp: false, reaction: null, isCohost: false,
});
const noop = () => undefined;
const rec = (over: Partial<RecordingView> = {}): RecordingView => ({ on: false, e2ee: false, busy: false, ...over });

beforeEach(() => {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 1280, bottom: 560, width: 1280, height: 560, toJSON: () => ({}) });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: /min-width: 1180px/.test(q), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }));
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const settle = async () => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
};

describe('consent badge and announcement', () => {
  it('shows nothing and says nothing while no recording runs', async () => {
    render(<><RecordingBadge lang="en" on={false} /><RecordingLive lang="en" on={false} /></>);
    await settle();
    expect(screen.queryByTestId('rec-badge')).toBeNull();
    expect(screen.getByTestId('rec-live').textContent).toBe('');
  });

  it('a visible badge with words appears when recording starts and is announced politely; stopping removes it and is announced', async () => {
    const { rerender } = render(<><RecordingBadge lang="en" on={false} /><RecordingLive lang="en" on={false} /></>);
    rerender(<><RecordingBadge lang="en" on /><RecordingLive lang="en" on /></>);
    await settle();
    const badge = screen.getByTestId('rec-badge');
    expect(badge.textContent).toContain('Recording');
    expect(screen.getByTestId('rec-live').getAttribute('aria-live')).toBe('polite');
    expect(screen.getByTestId('rec-live').getAttribute('role')).toBe('status');
    expect(screen.getByTestId('rec-live').textContent).toBe(dictionaries.en.clAnnRecOn);
    rerender(<><RecordingBadge lang="en" on={false} /><RecordingLive lang="en" on={false} /></>);
    await settle();
    expect(screen.queryByTestId('rec-badge')).toBeNull();
    expect(screen.getByTestId('rec-live').textContent).toBe(dictionaries.en.clAnnRecOff);
  });

  it('a participant who joins while recording is already running sees the badge and hears the announcement', async () => {
    render(<RecordingLive lang="uz" on />);
    await settle();
    expect(screen.getByTestId('rec-live').textContent).toBe(dictionaries.uz.clAnnRecOn);
  });
});

describe('call screen', () => {
  const mk = (over: Partial<CallViewProps> = {}) => ({
    lang: 'en', title: 'T', connected: true, reconnecting: false, quality: 'good', error: null, onDismissError: noop,
    participants: [person(0), person(1), person(2)], speakerId: 'p1', sharer: null, renderMedia: () => null,
    role: 'member', manage: null, locked: false, requests: [], onDecide: noop,
    mic: true, cam: true, sharing: false, canShare: false, handUp: false, noiseOn: true, blurOn: false, relay: false,
    onMic: noop, onCam: noop, onShare: noop, onHand: noop, onReact: noop, onNoise: noop, onBlur: noop, onMoreOpen: noop, onLeave: noop,
    panel: null, onPanel: noop, unread: 0,
    chat: { lines: [], target: '', onTarget: noop, draft: '', onDraft: noop, onSend: noop, onAttach: noop, onSave: noop },
    layout: 'davra', onLayout: noop, ...over,
  }) as CallViewProps;

  it('every participant, including a plain member, sees the badge and gets the announcement; nobody sees a record control', async () => {
    const { rerender } = render(<CallView {...mk()} />);
    expect(screen.queryByTestId('rec-badge')).toBeNull();
    rerender(<CallView {...mk({ recording: rec({ on: true }) })} />);
    await settle();
    expect(screen.getByTestId('rec-badge')).toBeTruthy();
    expect(screen.getByTestId('rec-live').textContent).toBe(dictionaries.en.clAnnRecOn);
    expect(screen.queryByTestId('record')).toBeNull();
    rerender(<CallView {...mk({ recording: rec({ on: false }) })} />);
    await settle();
    expect(screen.queryByTestId('rec-badge')).toBeNull();
    expect(screen.getByTestId('rec-live').textContent).toBe(dictionaries.en.clAnnRecOff);
  });
});

describe('record control', () => {
  const bar = (over: Partial<ControlBarProps> = {}): ControlBarProps => ({
    lang: 'en', mic: true, cam: true, sharing: false, canShare: true, handUp: false, panel: null, unread: 0, waiting: 0,
    layout: 'davra', fallback: null, noiseOn: true, blurOn: false, relay: false,
    onMic: noop, onCam: noop, onShare: noop, onHand: noop, onReact: noop, onPanel: noop, onLayout: noop, onNoise: noop, onBlur: noop, onMoreOpen: noop, onLeave: noop, ...over,
  });

  it('exists only when the user may record (host or co-host): a member and an unavailable service get no button', () => {
    const { rerender } = render(<ControlBar {...bar()} />);
    expect(screen.queryByTestId('record')).toBeNull();
    rerender(<ControlBar {...bar({ recording: rec() })} />); // no onToggle: member, or recording not configured
    expect(screen.queryByTestId('record')).toBeNull();
    rerender(<ControlBar {...bar({ recording: rec({ onToggle: noop }) })} />);
    expect(screen.getByTestId('record')).toBeTruthy();
  });

  it('starts and stops, naming the action in words', () => {
    const onToggle = vi.fn();
    const { rerender } = render(<ControlBar {...bar({ recording: rec({ onToggle }) })} />);
    fireEvent.click(screen.getByTestId('record'));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('record').textContent).toContain('Record');
    rerender(<ControlBar {...bar({ recording: rec({ onToggle, on: true }) })} />);
    expect(screen.getByTestId('record').textContent).toContain('Stop recording');
    expect(screen.getByTestId('record').getAttribute('aria-pressed')).toBe('true');
  });

  it('in an E2EE meeting it is unavailable, still focusable, explains why, and does nothing when activated', () => {
    const onToggle = vi.fn();
    render(<ControlBar {...bar({ recording: rec({ onToggle, e2ee: true }) })} />);
    const b = screen.getByTestId('record');
    expect(b.getAttribute('aria-disabled')).toBe('true');
    expect((b as HTMLButtonElement).disabled).toBe(false);
    expect(b.textContent).toContain(dictionaries.en.clRecE2ee);
    fireEvent.click(b);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('is blocked while a start or stop is in flight', () => {
    const onToggle = vi.fn();
    render(<ControlBar {...bar({ recording: rec({ onToggle, busy: true }) })} />);
    fireEvent.click(screen.getByTestId('record'));
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('the More panel of a manager lists recordings and offers a download only for finished ones', async () => {
    const onDownload = vi.fn();
    const items = [
      { id: 'r1', status: 'ready', startedAt: '2026-11-24T10:00:00Z', sizeBytes: 2048 },
      { id: 'r2', status: 'stopping', startedAt: '2026-11-24T11:00:00Z', sizeBytes: null },
    ];
    render(<ControlBar {...bar({ recording: rec({ onToggle: noop, items, onDownload }) })} />);
    fireEvent.click(screen.getByTestId('more'));
    await settle();
    const rows = screen.getAllByTestId('rec-item');
    expect(rows).toHaveLength(2);
    fireEvent.click(within(rows[0]!).getByRole('button', { name: /Download/ }));
    expect(onDownload).toHaveBeenCalledWith('r1');
    expect(within(rows[1]!).queryByRole('button')).toBeNull();
  });
});

describe('recording strings', () => {
  it('exist in all three languages without exclamation marks', () => {
    const keys = Object.keys(dictionaries.uz).filter((k) => k.startsWith('clRec') || k.startsWith('clAnnRec'));
    expect(keys.length).toBeGreaterThan(8);
    for (const lang of ['uz', 'ru', 'en'] as const) for (const k of keys) {
      const v = dictionaries[lang][k as keyof typeof dictionaries.uz];
      expect(v.trim(), `${lang}.${k}`).not.toBe('');
      expect(v, `${lang}.${k}`).not.toContain('!');
    }
  });
});
