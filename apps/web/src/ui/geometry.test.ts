import { describe, expect, it } from 'vitest';
import { nextEnabled } from './Menu';
import { computePlacement } from './Popover';

const vp = { width: 1000, height: 800 };
const panel = { width: 200, height: 160 };
const box = (left: number, top: number, w = 80, h = 36) => ({ left, top, right: left + w, bottom: top + h });

describe('popover placement', () => {
  it('opens below and start-aligned when it fits', () => {
    expect(computePlacement(box(100, 100), panel, vp)).toEqual({ left: 100, top: 142, side: 'bottom' });
  });
  it('aligns to the end edge', () => {
    expect(computePlacement(box(500, 100), panel, vp, 'end').left).toBe(580 - 200);
  });
  it('flips above when there is not enough room below but more above', () => {
    const r = computePlacement(box(100, 700), panel, vp);
    expect(r.side).toBe('top');
    expect(r.top).toBe(700 - 6 - 160);
  });
  it('clamps inside the viewport horizontally', () => {
    expect(computePlacement(box(950, 100), panel, vp).left).toBe(1000 - 200 - 8);
    expect(computePlacement(box(-40, 100), panel, vp).left).toBe(8);
  });
  it('never goes above the top margin', () => {
    expect(computePlacement(box(0, 40), { width: 100, height: 700 }, { width: 500, height: 600 }).top).toBeGreaterThanOrEqual(8);
  });
});

describe('menu item navigation', () => {
  const items = [{ disabled: true }, {}, { disabled: true }, {}, {}];
  it('skips disabled items and wraps', () => {
    expect(nextEnabled(items, -1, 1)).toBe(1);
    expect(nextEnabled(items, 1, 1)).toBe(3);
    expect(nextEnabled(items, 4, 1)).toBe(1);
    expect(nextEnabled(items, 1, -1)).toBe(4);
    expect(nextEnabled(items, 3, -1)).toBe(1);
  });
  it('returns -1 when nothing is enabled', () => {
    expect(nextEnabled([{ disabled: true }, { disabled: true }], 0, 1)).toBe(-1);
  });
});
