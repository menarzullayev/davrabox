// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dictionaries } from '../i18n';
import { ControlBar, type ControlBarProps } from './ControlBar';
import { CallView, type CallViewProps } from './CallView';
import { Stage } from './Stage';
import { ParticipantTile, tileDescription, tileSize } from './Tile';
import type { ManageActions, ParticipantView } from './types';

afterEach(cleanup);

const person = (i: number, over: Partial<ParticipantView> = {}): ParticipantView => ({
  id: `p${i}`,
  name: ['Nodir Aliyev', 'Aziz Karimov', 'Dilnoza Yusupova', 'Jasur Rahimov'][i] ?? `Person ${i}`,
  local: i === 0,
  speaking: false,
  micMuted: false,
  camOn: true,
  handUp: false,
  reaction: null,
  isCohost: false,
  ...over,
});
const people = (n: number) => Array.from({ length: n }, (_, i) => person(i));
const manage: ManageActions = { isHost: true, onMute: vi.fn(), onRemove: vi.fn(), onToggleCohost: vi.fn() };

// jsdom has no layout: give every element a 1280 x 560 box and a ResizeObserver that never fires.
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

describe('Tile', () => {
  const base = { rect: { x: 10, y: 20, w: 120, h: 120 }, shape: 'circle' as const, slot: 'ring' as const, hidden: false, featured: false, lang: 'en' as const, animate: false, reduced: true, media: null, manage };

  it('is a labelled group whose name carries every state in words', () => {
    const p = person(2, { speaking: true, micMuted: true, camOn: false, handUp: true, isCohost: true });
    render(<ParticipantTile p={p} {...base} />);
    const g = screen.getByRole('group');
    expect(g.getAttribute('aria-label')).toBe('Dilnoza Yusupova, speaking, muted, camera off, hand raised, Co-host');
    expect(tileDescription(person(0), 'en')).toBe('Nodir Aliyev (You)');
  });

  it('keeps the text markers of the e2e contract inside .label and hides the label from assistive technology', () => {
    render(<ParticipantTile p={person(1, { micMuted: true, handUp: true })} {...base} />);
    const label = document.querySelector('.label')!;
    expect(label.getAttribute('aria-hidden')).toBe('true');
    expect(label.textContent).toContain('🔇');
    expect(label.textContent).toContain('✋');
    expect(document.querySelectorAll('.tile .label').length).toBe(1);
  });

  it('gives the speaker the speaking class and shows initials without a camera', () => {
    const { container } = render(<ParticipantTile p={person(1, { speaking: true, camOn: false })} {...base} />);
    expect(container.querySelector('.tile.speaking')).toBeTruthy();
    expect(container.querySelector('.tile-avatar')?.textContent).toBe('AK');
  });

  it('shows manager actions on remote tiles only, by accessible name', () => {
    const { rerender } = render(<ParticipantTile p={person(1)} {...base} />);
    const tile = document.querySelector('.tile') as HTMLElement;
    fireEvent.click(within(tile).getByRole('button', { name: 'Mute' }));
    fireEvent.click(within(tile).getByRole('button', { name: 'Remove' }));
    fireEvent.click(within(tile).getByTestId('cohost-toggle'));
    expect(manage.onMute).toHaveBeenCalledWith('p1');
    expect(manage.onRemove).toHaveBeenCalledWith('p1');
    expect(manage.onToggleCohost).toHaveBeenCalledWith('p1');
    rerender(<ParticipantTile p={person(0)} {...base} />);
    expect(document.querySelectorAll('.tile-actions').length).toBe(0);
    rerender(<ParticipantTile p={person(1)} {...base} manage={{ ...manage, isHost: false }} />);
    expect(screen.queryByTestId('cohost-toggle')).toBeNull(); // a co-host cannot appoint co-hosts
    rerender(<ParticipantTile p={person(1)} {...base} manage={null} />);
    expect(document.querySelectorAll('.tile-actions').length).toBe(0);
  });

  it('shows a reaction as [data-testid=reaction] holding exactly the emoji', () => {
    render(<ParticipantTile p={person(1, { reaction: '🎉' })} {...base} />);
    expect(screen.getByTestId('reaction').textContent).toBe('🎉');
  });

  it('classifies tile sizes for the compact styles', () => {
    expect([tileSize(50, 50), tileSize(80, 80), tileSize(150, 150), tileSize(400, 300)]).toEqual(['xs', 'sm', 'md', 'lg']);
  });
});

describe('Stage', () => {
  const props = (n: number, over: Partial<React.ComponentProps<typeof Stage>> = {}) => ({
    lang: 'en' as const,
    requested: 'davra' as const,
    participants: people(n),
    featuredId: n > 1 ? 'p1' : 'p0',
    sharer: null,
    renderMedia: () => null,
    manage: null,
    ...over,
  });

  it('draws Davra with the featured participant in the centre and the others on the ring, in DOM order', () => {
    render(<Stage {...props(5)} />);
    const grid = screen.getByTestId('grid');
    expect(grid.getAttribute('data-layout')).toBe('davra');
    const tiles = Array.from(grid.querySelectorAll<HTMLElement>('.tile[data-identity]'));
    expect(tiles.map((t) => t.dataset.identity)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4']);
    expect(tiles.filter((t) => t.dataset.slot === 'center').map((t) => t.dataset.identity)).toEqual(['p1']);
    expect(tiles.filter((t) => t.dataset.slot === 'ring')).toHaveLength(4);
    expect(grid.querySelectorAll('.tile.featured')).toHaveLength(1);
    expect(grid.getAttribute('aria-label')).toContain('5');
  });

  it('positions tiles with transforms and explicit sizes inside the measured stage', () => {
    render(<Stage {...props(3)} />);
    for (const t of document.querySelectorAll<HTMLElement>('.tile')) {
      expect(t.style.transform).toMatch(/^translate3d\(/);
      expect(parseInt(t.style.width, 10)).toBeGreaterThan(0);
    }
  });

  it('falls back to the grid above 12 people and says why', () => {
    const onResolved = vi.fn();
    render(<Stage {...props(13)} onResolved={onResolved} />);
    expect(screen.getByTestId('grid').getAttribute('data-layout')).toBe('gallery');
    expect(screen.getByTestId('grid').getAttribute('data-requested')).toBe('davra');
    expect(onResolved).toHaveBeenLastCalledWith({ mode: 'gallery', reason: 'too-many', overflow: 0 });
  });

  it('does not fall back when the user asked for the grid or the speaker view', () => {
    const { rerender } = render(<Stage {...props(13, { requested: 'speaker' })} />);
    expect(screen.getByTestId('grid').getAttribute('data-layout')).toBe('speaker');
    rerender(<Stage {...props(13, { requested: 'gallery' })} />);
    expect(screen.getByTestId('grid').getAttribute('data-layout')).toBe('gallery');
  });

  it('shows a shared screen as a tile without data-identity in the centre', () => {
    render(<Stage {...props(4, { sharer: person(2) })} />);
    const share = document.querySelector('.tile.share') as HTMLElement;
    expect(share.dataset.identity).toBeUndefined();
    expect(share.dataset.slot).toBe('center');
    expect(share.getAttribute('aria-label')).toBe('Dilnoza Yusupova’s screen');
    expect(document.querySelectorAll('.tile[data-identity]')).toHaveLength(4);
  });

  it('marks the featured speaker tile in speaker view as main', () => {
    render(<Stage {...props(4, { requested: 'speaker', featuredId: 'p2' })} />);
    expect((document.querySelector('.tile.featured') as HTMLElement).dataset.identity).toBe('p2');
    expect((document.querySelector('.tile.featured') as HTMLElement).dataset.slot).toBe('main');
  });
});

describe('ControlBar', () => {
  const noop = () => undefined;
  const bar = (over: Partial<ControlBarProps> = {}): ControlBarProps => ({
    lang: 'en', mic: true, cam: true, sharing: false, canShare: true, handUp: false, panel: null, unread: 0, waiting: 0,
    layout: 'davra', fallback: null, noiseOn: true, blurOn: false, relay: false,
    onMic: noop, onCam: noop, onShare: noop, onHand: noop, onReact: noop, onPanel: noop, onLayout: noop, onNoise: noop, onBlur: noop, onMoreOpen: noop, onLeave: noop, ...over,
  });

  it('is a labelled toolbar with one tab stop and arrow-key navigation', () => {
    render(<ControlBar {...bar()} />);
    const tb = screen.getByRole('toolbar');
    expect(tb.getAttribute('aria-label')).toBe('Meeting controls');
    const items = Array.from(tb.querySelectorAll<HTMLElement>('[data-roving]'));
    expect(items.length).toBeGreaterThanOrEqual(9);
    expect(items.filter((b) => b.tabIndex === 0)).toHaveLength(1);
    items[0]!.focus();
    fireEvent.keyDown(items[0]!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1]!, { key: 'End' });
    expect(document.activeElement).toBe(items[items.length - 1]);
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(items[0]);
    expect(items.filter((b) => b.tabIndex === 0)).toHaveLength(1);
  });

  it('every button name contains its visible text and icon-only buttons are named by hidden text', () => {
    render(<ControlBar {...bar({ unread: 3, waiting: 2 })} />);
    for (const b of screen.getAllByRole('button')) {
      const name = b.textContent ?? '';
      expect(name.trim().length, `button ${b.getAttribute('data-testid')}`).toBeGreaterThan(0);
    }
    expect(screen.getByRole('button', { name: /^Microphone, turn off/ })).toBeTruthy();
    expect(screen.getByTestId('chat-toggle').textContent).toContain('(3)');
    expect(screen.getByTestId('people-toggle').textContent).toContain('(2)');
  });

  it('reports the state with the words of the action', () => {
    render(<ControlBar {...bar({ mic: false, cam: false, handUp: true })} />);
    expect(screen.getByRole('button', { name: /Microphone, turn on/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Camera, turn on/ })).toBeTruthy();
    expect(screen.getByTestId('hand').getAttribute('aria-pressed')).toBe('true');
  });

  it('opens the reactions popover with focus inside and closes it after a choice', async () => {
    const onReact = vi.fn();
    render(<ControlBar {...bar({ onReact })} />);
    fireEvent.click(screen.getByTestId('reactions'));
    const first = await screen.findByTestId('react-👍');
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(screen.getByTestId('react-👏'));
    fireEvent.click(screen.getByTestId('react-🎉'));
    expect(onReact).toHaveBeenCalledWith('🎉');
    expect(screen.queryByTestId('react-🎉')).toBeNull();
  });

  it('puts noise and blur in the More panel and wires their state attributes', () => {
    const onNoise = vi.fn();
    const onBlur = vi.fn();
    const onMoreOpen = vi.fn();
    render(<ControlBar {...bar({ onNoise, onBlur, onMoreOpen, noiseOn: false, blurOn: true, relay: true })} />);
    expect(screen.queryByTestId('noise')).toBeNull();
    fireEvent.click(screen.getByTestId('more'));
    expect(onMoreOpen).toHaveBeenCalled();
    expect(screen.getByTestId('noise').getAttribute('data-state')).toBe('false');
    expect(screen.getByTestId('blur').getAttribute('data-state')).toBe('true');
    fireEvent.click(screen.getByTestId('noise'));
    fireEvent.click(screen.getByTestId('blur'));
    expect(onNoise).toHaveBeenCalledTimes(1);
    expect(onBlur).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('firewall-info').textContent).toContain('On');
  });

  it('disables blur without a camera and noise without a microphone', () => {
    render(<ControlBar {...bar({ mic: false, cam: false })} />);
    fireEvent.click(screen.getByTestId('more'));
    expect((screen.getByTestId('noise') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId('blur') as HTMLInputElement).disabled).toBe(true);
  });

  it('offers Davra, Grid and Speaker as a radio group and reports the choice', () => {
    const onLayout = vi.fn();
    render(<ControlBar {...bar({ onLayout })} />);
    fireEvent.click(screen.getByTestId('layout'));
    const group = screen.getByRole('radiogroup', { name: 'View' });
    const radios = within(group).getAllByRole('radio') as HTMLInputElement[];
    expect(radios.map((r) => r.value)).toEqual(['davra', 'gallery', 'speaker']);
    expect(radios.find((r) => r.checked)?.value).toBe('davra');
    fireEvent.click(screen.getByTestId('layout-speaker').querySelector('input')!);
    expect(onLayout).toHaveBeenCalledWith('speaker');
  });
});

describe('CallView', () => {
  const view = (over: Partial<CallViewProps> = {}): CallViewProps => ({
    lang: 'en', title: 'Weekly sync', connected: true, reconnecting: false, quality: 'good', error: null, onDismissError: vi.fn(),
    participants: people(4), speakerId: 'p1', sharer: null, renderMedia: () => null,
    role: 'host', manage, locked: false, onLock: vi.fn(), requests: [], onDecide: vi.fn(),
    mic: true, cam: true, sharing: false, canShare: true, handUp: false, noiseOn: true, blurOn: false, relay: false,
    onMic: vi.fn(), onCam: vi.fn(), onShare: vi.fn(), onHand: vi.fn(), onReact: vi.fn(), onNoise: vi.fn(), onBlur: vi.fn(), onMoreOpen: vi.fn(), onLeave: vi.fn(),
    panel: null, onPanel: vi.fn(), unread: 0,
    chat: { lines: [], target: '', onTarget: vi.fn(), draft: '', onDraft: vi.fn(), onSend: vi.fn((e) => e.preventDefault()), onAttach: vi.fn(), onSave: vi.fn(), onKeep: undefined } as never,
    layout: 'davra', onLayout: vi.fn(), ...over,
  });

  it('has landmarks: banner with one h1, a labelled main stage, the controls region, and one polite live region', () => {
    render(<CallView {...view()} />);
    expect(screen.getByRole('banner')).toBeTruthy();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('main').getAttribute('aria-label')).toBe('Meeting participants');
    expect(screen.getByRole('region', { name: 'Meeting controls' })).toBeTruthy();
    expect(screen.getByTestId('call-live').getAttribute('aria-live')).toBe('polite');
  });

  it('shows the role badge only to managers, with exactly one .badge, and the lock toggle with aria-pressed', () => {
    const { rerender } = render(<CallView {...view()} />);
    expect(document.querySelectorAll('.badge')).toHaveLength(1);
    expect(screen.getByTestId('role-badge').textContent).toBe('Host');
    expect(screen.getByTestId('lock').getAttribute('aria-pressed')).toBe('false');
    rerender(<CallView {...view({ role: 'cohost', locked: true })} />);
    expect(screen.getByTestId('role-badge').textContent).toBe('Co-host');
    expect(screen.getByTestId('lock').getAttribute('aria-pressed')).toBe('true');
    rerender(<CallView {...view({ role: 'member', manage: null, onLock: undefined })} />);
    expect(document.querySelectorAll('.badge')).toHaveLength(0);
    expect(screen.queryByTestId('lock')).toBeNull();
    expect(screen.queryByTestId('role-badge')).toBeNull();
  });

  it('shows the participant count', () => {
    render(<CallView {...view({ participants: people(3) })} />);
    expect(screen.getByTestId('count').textContent).toBe('3');
  });

  it('shows the connecting ring until connected', () => {
    const { rerender } = render(<CallView {...view({ connected: false })} />);
    expect(document.querySelector('.dv-connecting')).toBeTruthy();
    rerender(<CallView {...view()} />);
    expect(document.querySelector('.dv-connecting')).toBeNull();
  });

  it('shows an error in an .error alert that can be dismissed', () => {
    const onDismissError = vi.fn();
    render(<CallView {...view({ error: 'Something failed', onDismissError })} />);
    const err = document.querySelector('.error') as HTMLElement;
    expect(err.getAttribute('role')).toBe('alert');
    expect(err.textContent).toContain('Something failed');
    fireEvent.click(within(err).getByRole('button'));
    expect(onDismissError).toHaveBeenCalled();
  });

  it('shows a dismissible hint when Davra falls back to the grid, and shows it again after the count drops and rises', () => {
    const { rerender } = render(<CallView {...view({ participants: people(13) })} />);
    const hint = screen.getByText(/Davra shows up to 12 people/);
    fireEvent.click(within(hint.closest('.dx-alert') as HTMLElement).getByRole('button'));
    expect(screen.queryByText(/Davra shows up to 12 people/)).toBeNull();
    rerender(<CallView {...view({ participants: people(14) })} />);
    expect(screen.queryByText(/Davra shows up to 12 people/)).toBeNull(); // still dismissed while above 12
    rerender(<CallView {...view({ participants: people(6) })} />);
    rerender(<CallView {...view({ participants: people(13) })} />);
    expect(screen.getByText(/Davra shows up to 12 people/)).toBeTruthy();
  });

  it('does not show the hint when the user picked the grid themselves', () => {
    render(<CallView {...view({ participants: people(13), layout: 'gallery' })} />);
    expect(screen.queryByText(/Davra shows up to 12 people/)).toBeNull();
  });

  it('lists waiting-room requests for managers only, with Admit (.primary) and Deny', () => {
    const onDecide = vi.fn();
    const { rerender } = render(<CallView {...view({ requests: [{ id: 'r1', name: 'Nargiza' }], onDecide })} />);
    const card = screen.getByTestId('join-request');
    fireEvent.click(card.querySelector('button.primary')!);
    fireEvent.click(card.querySelector('button:not(.primary)')!);
    expect(onDecide).toHaveBeenNthCalledWith(1, 'r1', true);
    expect(onDecide).toHaveBeenNthCalledWith(2, 'r1', false);
    rerender(<CallView {...view({ role: 'member', manage: null, requests: [{ id: 'r1', name: 'Nargiza' }] })} />);
    expect(screen.queryByTestId('join-request')).toBeNull();
  });

  it('opens the chat as a labelled drawer, sends with the form, closes with Escape and returns focus to the toggle', async () => {
    const onPanel = vi.fn();
    const onSend = vi.fn((e: React.FormEvent) => e.preventDefault());
    const chat = { lines: [{ id: 1, from: 'Aziz Karimov', text: '<b>hi</b>', mine: false, priv: false }, { id: 2, from: 'Aziz Karimov', text: '', mine: false, priv: true, file: { id: 'f', name: 'plan.xlsx', size: 2048 } }], target: '', onTarget: vi.fn(), draft: 'hello', onDraft: vi.fn(), onSend, onAttach: vi.fn(), onSave: vi.fn() };
    render(<CallView {...view({ panel: 'chat', onPanel, chat })} />);
    const panel = screen.getByTestId('chat-panel');
    expect(panel.tagName).toBe('ASIDE');
    expect(panel.getAttribute('aria-label')).toBe('Chat');
    expect(screen.getAllByTestId('chat-line')).toHaveLength(2);
    expect(screen.getAllByText('<b>hi</b>')).toHaveLength(1); // literal text, no markup parsed
    expect(document.querySelectorAll('[data-testid=chat-lines] b, [data-testid=chat-lines] img')).toHaveLength(0);
    expect(screen.getByTestId('file-chip').textContent).toContain('plan.xlsx');
    expect(screen.getByTestId('chat-lines').getAttribute('role')).toBe('log');
    expect(screen.getByTestId('chat-lines').getAttribute('aria-live')).toBe('off');
    fireEvent.submit(screen.getByTestId('chat-input').closest('form')!);
    expect(onSend).toHaveBeenCalled();
    const toggle = screen.getByTestId('chat-toggle');
    fireEvent.keyDown(screen.getByTestId('chat-input'), { key: 'Escape' });
    expect(onPanel).toHaveBeenCalledWith(null);
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(document.activeElement).toBe(toggle);
  });

  it('lists everyone in the People panel with state and manager actions that do not touch yourself', () => {
    const m: ManageActions = { isHost: true, onMute: vi.fn(), onRemove: vi.fn(), onToggleCohost: vi.fn() };
    render(<CallView {...view({ panel: 'people', manage: m, participants: [person(0), person(1, { micMuted: true, handUp: true, isCohost: true }), person(2)] })} />);
    const rows = screen.getAllByTestId('roster-person');
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).queryAllByRole('button')).toHaveLength(0);
    expect(rows[1]!.textContent).toContain('muted');
    expect(rows[1]!.textContent).toContain('hand raised');
    fireEvent.click(within(rows[1]!).getByRole('button', { name: /^Mute: Aziz Karimov/ }));
    expect(m.onMute).toHaveBeenCalledWith('p1');
  });
});

describe('call strings', () => {
  const keys = Object.keys(dictionaries.uz).filter((k) => k.startsWith('cl'));
  const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(',');
  it('keeps the same placeholders in uz, ru and en', () => {
    expect(keys.length).toBeGreaterThan(50);
    for (const k of keys) {
      const key = k as keyof typeof dictionaries.uz;
      expect(ph(dictionaries.ru[key]), `ru.${k}`).toBe(ph(dictionaries.uz[key]));
      expect(ph(dictionaries.en[key]), `en.${k}`).toBe(ph(dictionaries.uz[key]));
    }
  });
  it('writes no exclamation marks in call copy', () => {
    for (const lang of ['uz', 'ru', 'en'] as const) for (const k of keys) expect(dictionaries[lang][k as keyof typeof dictionaries.uz], `${lang}.${k}`).not.toContain('!');
  });
});

describe('announcements through the live region', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const live = () => screen.getByTestId('call-live').textContent;
  const mk = (over: Partial<CallViewProps> = {}) => ({
    lang: 'en', title: 'T', connected: true, reconnecting: false, quality: 'good', error: null, onDismissError: vi.fn(),
    participants: people(3), speakerId: 'p1', sharer: null, renderMedia: () => null,
    role: 'member', manage: null, locked: false, requests: [], onDecide: vi.fn(),
    mic: true, cam: true, sharing: false, canShare: false, handUp: false, noiseOn: true, blurOn: false, relay: false,
    onMic: vi.fn(), onCam: vi.fn(), onShare: vi.fn(), onHand: vi.fn(), onReact: vi.fn(), onNoise: vi.fn(), onBlur: vi.fn(), onMoreOpen: vi.fn(), onLeave: vi.fn(),
    panel: null, onPanel: vi.fn(), unread: 0,
    chat: { lines: [], target: '', onTarget: vi.fn(), draft: '', onDraft: vi.fn(), onSend: vi.fn(), onAttach: vi.fn(), onSave: vi.fn() },
    layout: 'davra', onLayout: vi.fn(), ...over,
  }) as CallViewProps;
  const settle = async (ms: number) => { await act(async () => { vi.advanceTimersByTime(ms); }); await act(async () => { vi.advanceTimersByTime(20); }); };

  it('stays silent on the first render and announces a join, a raised hand and a new message once each, calmly', async () => {
    const { rerender } = render(<CallView {...mk()} />);
    await settle(3000);
    expect(live()).toBe('');
    rerender(<CallView {...mk({ participants: [...people(3), person(3)] })} />);
    await settle(1000);
    expect(live()).toBe('Jasur Rahimov joined');
    rerender(<CallView {...mk({ participants: [person(0), person(1, { handUp: true }), person(2), person(3)] })} />);
    await settle(1000);
    expect(live()).toBe('Aziz Karimov raised a hand');
    const line = { id: 1, from: 'Aziz Karimov', text: 'hi', mine: false, priv: false };
    rerender(<CallView {...mk({ participants: [person(0), person(1, { handUp: true }), person(2), person(3)], chat: { ...mk().chat, lines: [line] } })} />);
    await settle(1500);
    expect(live()).toBe('Message from Aziz Karimov');
  });

  it('does not announce your own actions and speaks the new speaker only after a pause', async () => {
    const { rerender } = render(<CallView {...mk()} />);
    await settle(100);
    rerender(<CallView {...mk({ participants: [person(0, { handUp: true }), person(1), person(2)] })} />);
    await settle(1500);
    expect(live()).toBe('');
    rerender(<CallView {...mk({ speakerId: 'p2' })} />);
    await settle(500);
    expect(live()).toBe('');
    rerender(<CallView {...mk({ speakerId: 'p1' })} />);
    await settle(500);
    rerender(<CallView {...mk({ speakerId: 'p2' })} />);
    await settle(2200);
    expect(live()).toBe('Dilnoza Yusupova is speaking');
  });
});
