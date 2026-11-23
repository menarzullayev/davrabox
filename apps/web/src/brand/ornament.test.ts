import { describe, expect, it } from 'vitest';
import { DAVRA_LIMITS, davraGeometry, davraSvg, resolveDavraParams } from './ornament';

describe('davra ornament generator', () => {
  it('is deterministic: same parameters give byte-identical output', () => {
    const a = davraSvg({ rings: 4, petals: 14, rotation: 8 });
    const b = davraSvg({ rings: 4, petals: 14, rotation: 8 });
    expect(a).toBe(b);
    expect(davraGeometry({ rings: 2, petals: 5 })).toEqual(davraGeometry({ rings: 2, petals: 5 }));
  });
  it('produces rings circles and rings x petals petal paths', () => {
    for (const [rings, petals] of [[1, 3], [3, 12], [6, 24]] as const) {
      const g = davraGeometry({ rings, petals });
      expect(g.circles).toHaveLength(rings);
      expect(g.petals).toHaveLength(rings * petals);
      expect(new Set(g.petals.map((p) => p.band)).size).toBe(rings);
    }
  });
  it('uses defaults and normalises rotation into [0, 360)', () => {
    expect(resolveDavraParams()).toEqual({ rings: 3, petals: 12, rotation: 0 });
    expect(resolveDavraParams({ rotation: 360 }).rotation).toBe(0);
    expect(resolveDavraParams({ rotation: -90 }).rotation).toBe(270);
    expect(davraSvg({ rotation: 360 })).toBe(davraSvg({ rotation: 0 }));
  });
  it('different parameters change the output', () => {
    expect(davraSvg({ petals: 8 })).not.toBe(davraSvg({ petals: 9 }));
    expect(davraSvg({ rotation: 0 })).not.toBe(davraSvg({ rotation: 10 }));
  });
  it('never emits NaN or Infinity and keeps petal coordinates inside the 200 box', () => {
    const g = davraGeometry({ rings: 6, petals: 24, rotation: 123.456 });
    const all = g.petals.map((p) => p.d).join(' ');
    expect(all).not.toMatch(/NaN|Infinity/);
    for (const m of all.matchAll(/-?\d+(?:\.\d+)?/g)) {
      const n = Number(m[0]);
      expect(n).toBeGreaterThan(-10);
      expect(n).toBeLessThan(210);
    }
  });
  it('rejects invalid parameters', () => {
    expect(() => davraGeometry({ rings: 0 })).toThrow(RangeError);
    expect(() => davraGeometry({ rings: DAVRA_LIMITS.ringsMax + 1 })).toThrow(RangeError);
    expect(() => davraGeometry({ rings: 2.5 })).toThrow(RangeError);
    expect(() => davraGeometry({ petals: 2 })).toThrow(RangeError);
    expect(() => davraGeometry({ petals: 25 })).toThrow(RangeError);
    expect(() => davraGeometry({ rotation: Number.NaN })).toThrow(RangeError);
    expect(() => davraGeometry({ rotation: Infinity })).toThrow(RangeError);
  });
});
