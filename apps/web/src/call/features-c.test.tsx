// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseRoomSpotlight } from '../signals';
import { BackgroundPicker } from './effects/BackgroundPicker';
import { BUILT_IN_BACKGROUNDS, coverCrop, isBgChoice, loadFx, saveFx } from './effects/backgrounds';
import { BRIGHT_ENOUGH, meanLuma, smoothGamma, targetGamma } from './effects/lowlight';
import { pickFeatured } from './layout';
import { PeoplePanel } from './Panels';
import { ParticipantTile, tileDescription } from './Tile';
import type { ManageActions, ParticipantView } from './types';

afterEach(cleanup);
beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const person = (i: number, over: Partial<ParticipantView> = {}): ParticipantView => ({
  id: `p${i}`,
  name: ['Nodir', 'Aziz', 'Dilnoza'][i] ?? `P${i}`,
  local: i === 0,
  speaking: false,
  micMuted: false,
  camOn: true,
  handUp: false,
  reaction: null,
  isCohost: false,
  ...over,
});

describe('featured participant precedence', () => {
  const ids = ['me', 'a', 'b', 'c'];
  it('shared screen, then the host spotlight, then my pin, then the speaker', () => {
    expect(pickFeatured(ids, { sharerId: 'a', spotlightId: 'b', pinnedId: 'c', speakerId: 'c' })).toBe('a');
    expect(pickFeatured(ids, { spotlightId: 'b', pinnedId: 'c', speakerId: 'a' })).toBe('b');
    expect(pickFeatured(ids, { pinnedId: 'c', speakerId: 'a' })).toBe('c');
    expect(pickFeatured(ids, { speakerId: 'a' })).toBe('a');
  });
  it('ignores a spotlight or pin of someone who left', () => {
    expect(pickFeatured(ids, { spotlightId: 'gone', pinnedId: 'gone2', speakerId: 'b' })).toBe('b');
  });
});

describe('spotlight from room metadata', () => {
  it('reads only a short string; everything else is no spotlight', () => {
    expect(parseRoomSpotlight('{"spotlight":"u1","recording":true}')).toBe('u1');
    expect(parseRoomSpotlight('{"recording":true}')).toBeNull();
    expect(parseRoomSpotlight('{"spotlight":42}')).toBeNull();
    expect(parseRoomSpotlight(`{"spotlight":"${'x'.repeat(81)}"}`)).toBeNull();
    expect(parseRoomSpotlight('not json')).toBeNull();
    expect(parseRoomSpotlight(undefined)).toBeNull();
  });
});

describe('low-light correction maths', () => {
  it('measures BT.709 luma', () => {
    expect(meanLuma(new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]))).toBeCloseTo(0.5, 3);
    expect(meanLuma(new Uint8ClampedArray([]))).toBe(1);
  });
  it('leaves a bright picture alone and lifts a dark one, never beyond the limit', () => {
    expect(targetGamma(BRIGHT_ENOUGH)).toBe(1);
    expect(targetGamma(0.8)).toBe(1);
    const g = targetGamma(0.2);
    expect(g).toBeLessThan(1);
    expect(Math.pow(0.2, g)).toBeCloseTo(0.45, 2);
    expect(targetGamma(0.001)).toBe(0.45);
    expect(targetGamma(Number.NaN)).toBe(1);
  });
  it('moves towards the target gradually and settles', () => {
    let g = 1;
    for (let i = 0; i < 3; i++) g = smoothGamma(g, 0.5);
    expect(g).toBeGreaterThan(0.5);
    expect(g).toBeLessThan(1);
    for (let i = 0; i < 60; i++) g = smoothGamma(g, 0.5);
    expect(g).toBe(0.5);
  });
});

describe('virtual backgrounds', () => {
  it('accepts only known choices', () => {
    expect(isBgChoice('none')).toBe(true);
    expect(isBgChoice('blur')).toBe(true);
    expect(isBgChoice('img:aurora')).toBe(true);
    expect(isBgChoice('img:../../etc')).toBe(false);
    expect(isBgChoice('custom:0f8e2d3c-aaaa-4bbb-8ccc-123456789abc')).toBe(true);
    expect(isBgChoice('custom:<script>')).toBe(false);
    expect(isBgChoice('https://evil.example/x.png')).toBe(false);
    expect(isBgChoice(42)).toBe(false);
  });
  it('crops to cover 1280x720 without ever upscaling', () => {
    const big = coverCrop(4000, 3000);
    expect(big.dw).toBe(1280);
    expect(big.dh).toBe(720);
    expect(big.sw / big.sh).toBeCloseTo(16 / 9, 2);
    expect(big.sy).toBeGreaterThan(0);
    const small = coverCrop(640, 360);
    expect(small).toMatchObject({ dw: 640, dh: 360, sx: 0, sy: 0 });
  });
  it('remembers the choice per device and drops anything tampered with', () => {
    saveFx({ bg: 'img:girih', lowLight: true });
    expect(loadFx()).toEqual({ bg: 'img:girih', lowLight: true });
    localStorage.setItem('davra.camfx', JSON.stringify({ bg: 'javascript:alert(1)', lowLight: 'yes' }));
    expect(loadFx()).toEqual({ bg: 'none', lowLight: false });
    localStorage.setItem('davra.camfx', '{broken');
    expect(loadFx()).toEqual({ bg: 'none', lowLight: false });
  });
  it('the chooser shows none, blur and every built-in image, and reports the choice', () => {
    const onChange = vi.fn();
    HTMLDialogElement.prototype.showModal = function () {
      this.setAttribute('open', '');
    };
    render(<BackgroundPicker lang="en" open onClose={() => {}} value="blur" onChange={onChange} customs={[]} onUpload={() => {}} onRemoveCustom={() => {}} supported camOn />);
    expect(screen.getByTestId('bg-option-blur').getAttribute('aria-pressed')).toBe('true');
    for (const id of BUILT_IN_BACKGROUNDS) expect(screen.getByTestId(`bg-option-${id}`)).toBeTruthy();
    fireEvent.click(screen.getByTestId('bg-option-aurora'));
    expect(onChange).toHaveBeenCalledWith('img:aurora');
    expect(screen.getByText(/never sent to the server/)).toBeTruthy();
  });
  it('explains when the browser cannot do it and disables the choices', () => {
    HTMLDialogElement.prototype.showModal = function () {
      this.setAttribute('open', '');
    };
    render(<BackgroundPicker lang="en" open onClose={() => {}} value="none" onChange={() => {}} customs={[]} onUpload={() => {}} onRemoveCustom={() => {}} supported={false} camOn />);
    expect(screen.getByTestId('bg-unsupported')).toBeTruthy();
    expect((screen.getByTestId('bg-option-aurora') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('pin and spotlight on tiles and in the roster', () => {
  const base = { rect: { x: 0, y: 0, w: 240, h: 240 }, shape: 'rounded' as const, slot: 'ring' as const, hidden: false, featured: false, lang: 'en' as const, animate: false, reduced: true, media: null };
  it('everyone can pin another tile; only managers get the spotlight button; nobody pins themselves', () => {
    const onPin = vi.fn();
    const { unmount } = render(<ParticipantTile p={person(1)} manage={null} onPin={onPin} {...base} />);
    fireEvent.click(screen.getByTestId('pin-toggle'));
    expect(onPin).toHaveBeenCalledWith('p1');
    expect(screen.queryByTestId('spotlight-toggle')).toBeNull();
    unmount();
    render(<ParticipantTile p={person(0)} manage={null} onPin={onPin} {...base} />);
    expect(screen.queryByTestId('pin-toggle')).toBeNull();
  });
  it('a manager spotlights and clears; the state is part of the tile name', () => {
    const onSpotlight = vi.fn();
    const manage: ManageActions = { isHost: true, onMute: vi.fn(), onRemove: vi.fn(), onToggleCohost: vi.fn(), onSpotlight };
    render(<ParticipantTile p={person(2, { spotlit: true })} manage={manage} onPin={vi.fn()} {...base} />);
    fireEvent.click(screen.getByTestId('spotlight-toggle'));
    expect(onSpotlight).toHaveBeenCalledWith(null);
    expect(tileDescription(person(2, { spotlit: true }), 'en')).toContain('spotlight');
    expect(tileDescription(person(2, { pinned: true }), 'en')).toContain('pinned');
    expect(screen.getByTestId('tile-spotlit')).toBeTruthy();
  });
  it('the roster offers mute-all to managers only', () => {
    const onMuteAll = vi.fn();
    const manage: ManageActions = { isHost: true, onMute: vi.fn(), onRemove: vi.fn(), onToggleCohost: vi.fn(), onMuteAll, onSpotlight: vi.fn() };
    const { unmount } = render(<PeoplePanel lang="en" participants={[person(0), person(1)]} manage={manage} onPin={vi.fn()} onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('mute-all'));
    expect(onMuteAll).toHaveBeenCalled();
    expect(screen.getAllByTestId('roster-pin')).toHaveLength(1);
    expect(screen.getAllByTestId('roster-spotlight')).toHaveLength(1);
    unmount();
    render(<PeoplePanel lang="en" participants={[person(0), person(1)]} manage={null} onPin={vi.fn()} onClose={() => {}} />);
    expect(screen.queryByTestId('mute-all')).toBeNull();
    expect(screen.getAllByTestId('roster-pin')).toHaveLength(1);
    expect(screen.queryByTestId('roster-mute')).toBeNull();
  });
});
