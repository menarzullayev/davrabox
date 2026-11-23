// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAnnouncer, fmt } from './announcer';
import { GLIDE_MS, glideDuration, glideKeyframes, prefersReducedMotion, sameRect } from './motion';
import { applyRoving, handleRovingKey, nextRovingIndex, rovingItems } from './roving';

describe('reduced motion helper', () => {
  it('reads the media query and is safe without matchMedia', () => {
    expect(prefersReducedMotion({ matchMedia: () => ({ matches: true }) })).toBe(true);
    expect(prefersReducedMotion({ matchMedia: () => ({ matches: false }) })).toBe(false);
    expect(prefersReducedMotion({})).toBe(false);
    expect(prefersReducedMotion(undefined)).toBe(false);
    expect(prefersReducedMotion({ matchMedia: () => { throw new Error('x'); } })).toBe(false);
  });
  it('makes the glide instant under reduced motion and keeps it in the 150-400 ms window otherwise', () => {
    expect(glideDuration(true)).toBe(0);
    expect(glideDuration(false)).toBe(GLIDE_MS);
    expect(glideDuration(false, 10)).toBe(150);
    expect(glideDuration(false, 9000)).toBe(400);
  });
  it('builds FLIP keyframes that start at the old box and end at the new one using transforms only', () => {
    const k = glideKeyframes({ x: 10, y: 20, w: 100, h: 100 }, { x: 300, y: 200, w: 400, h: 200 }, 'circle', 'rect');
    expect(k.tile[0]).toEqual({ transform: 'translate3d(10px, 20px, 0) scale(0.25, 0.5)' });
    expect(k.tile[1]).toEqual({ transform: 'translate3d(300px, 200px, 0) scale(1, 1)' });
    expect(Object.keys(k.tile[0]!)).toEqual(['transform']);
    expect(k.media[0]).toEqual({ borderRadius: '50%' });
  });
  it('compares rects', () => {
    expect(sameRect({ x: 1, y: 2, w: 3, h: 4 }, { x: 1, y: 2, w: 3, h: 4 })).toBe(true);
    expect(sameRect({ x: 1, y: 2, w: 3, h: 4 }, { x: 1, y: 2, w: 3, h: 5 })).toBe(false);
    expect(sameRect(undefined, undefined)).toBe(false);
  });
});

describe('live-region announcer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('waits for the settle time and then speaks once', () => {
    const out: string[] = [];
    const a = createAnnouncer((t) => out.push(t), { settle: 500 });
    a.say('join:a', 'Aziz joined');
    vi.advanceTimersByTime(499);
    expect(out).toEqual([]);
    vi.advanceTimersByTime(2);
    expect(out).toEqual(['Aziz joined']);
  });
  it('lets the latest message of a key win (speaker changing quickly)', () => {
    const out: string[] = [];
    const a = createAnnouncer((t) => out.push(t), { settle: 500 });
    a.say('speaker', 'Aziz is speaking');
    vi.advanceTimersByTime(300);
    a.say('speaker', 'Dilnoza is speaking');
    vi.advanceTimersByTime(300);
    expect(out).toEqual([]);
    vi.advanceTimersByTime(300);
    expect(out).toEqual(['Dilnoza is speaking']);
  });
  it('merges messages that settle together, caps the count and summarises the rest', () => {
    const out: string[] = [];
    const a = createAnnouncer((t) => out.push(t), { settle: 500, maxParts: 2, more: (n) => `and ${n} more` });
    for (const n of ['a', 'b', 'c', 'd']) a.say(`join:${n}`, `${n} joined`);
    vi.advanceTimersByTime(600);
    expect(out).toEqual(['a joined. b joined. and 2 more']);
  });
  it('does not repeat the same text within the dedupe window but does afterwards', () => {
    const out: string[] = [];
    const a = createAnnouncer((t) => out.push(t), { settle: 100, dedupeMs: 3000 });
    a.say('x', 'New message');
    vi.advanceTimersByTime(150);
    a.say('x', 'New message');
    vi.advanceTimersByTime(150);
    expect(out).toEqual(['New message']);
    vi.advanceTimersByTime(3500);
    a.say('x', 'New message');
    vi.advanceTimersByTime(150);
    expect(out).toEqual(['New message', 'New message']);
  });
  it('supports a longer settle for the speaker and cancel', () => {
    const out: string[] = [];
    const a = createAnnouncer((t) => out.push(t), { settle: 100 });
    a.say('speaker', 'A speaks', 1500);
    a.say('hand', 'B raised a hand');
    vi.advanceTimersByTime(200);
    expect(out).toEqual(['B raised a hand']);
    a.cancel('speaker');
    vi.advanceTimersByTime(3000);
    expect(out).toHaveLength(1);
    a.dispose();
  });
  it('fills placeholders', () => {
    expect(fmt('{name} joined, {n} total', { name: 'Aziz', n: 3 })).toBe('Aziz joined, 3 total');
    expect(fmt('{missing}', {})).toBe('{missing}');
  });
});

describe('roving tabindex', () => {
  it('wraps with the arrow keys and supports Home and End', () => {
    expect(nextRovingIndex(4, 3, 'ArrowRight')).toBe(0);
    expect(nextRovingIndex(4, 0, 'ArrowLeft')).toBe(3);
    expect(nextRovingIndex(4, 2, 'Home')).toBe(0);
    expect(nextRovingIndex(4, 1, 'End')).toBe(3);
    expect(nextRovingIndex(4, 1, 'a')).toBeNull();
    expect(nextRovingIndex(0, 0, 'ArrowRight')).toBeNull();
  });
  it('keeps exactly one tab stop, skips disabled buttons and moves focus on key presses', () => {
    document.body.innerHTML = '<div id="tb"><button data-roving>a</button><button data-roving disabled>b</button><button data-roving>c</button><button>x</button></div>';
    const root = document.getElementById('tb')!;
    const [a, , c] = Array.from(root.querySelectorAll<HTMLButtonElement>('button'));
    expect(applyRoving(root, null)).toBe(a);
    expect(Array.from(root.querySelectorAll('button')).map((b) => b.tabIndex)).toEqual([0, -1, -1, 0]); // the untagged button keeps its default
    expect(rovingItems(root)).toEqual([a, c]);
    a!.focus();
    const e = { key: 'ArrowRight', target: a!, preventDefault: vi.fn() };
    expect(handleRovingKey(root, e)).toBe(true);
    expect(document.activeElement).toBe(c);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(handleRovingKey(root, { key: 'Tab', target: c!, preventDefault: vi.fn() })).toBe(false);
    expect(applyRoving(root, c!)).toBe(c);
    expect(c!.tabIndex).toBe(0);
    expect(a!.tabIndex).toBe(-1);
  });
});
