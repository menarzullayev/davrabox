import { describe, expect, it } from 'vitest';
import { COMPACT_RING_MAX, RING_MAX, SHARE_KEY, computeLayout, ellipsePoints, pickFeatured, resolveMode, type LayoutMode, type Placement, type Size } from './layout';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`);
const SIZES: Size[] = [
  { width: 360, height: 480 }, // phone portrait (stage under the bars)
  { width: 360, height: 640 },
  { width: 640, height: 360 },
  { width: 768, height: 900 },
  { width: 1280, height: 560 },
  { width: 1920, height: 940 },
  { width: 3840, height: 2160 },
  { width: 2560, height: 400 }, // ultra wide and short
  { width: 420, height: 2000 }, // very tall
];
const visible = (ps: Placement[]) => ps.filter((p) => !p.hidden);
const overlap = (a: Placement, b: Placement) => a.rect.x < b.rect.x + b.rect.w && b.rect.x < a.rect.x + a.rect.w && a.rect.y < b.rect.y + b.rect.h && b.rect.y < a.rect.y + a.rect.h;

function expectSound(mode: LayoutMode, n: number, size: Size, extra: { hasShare?: boolean; featuredId?: string | null } = {}) {
  const participants = ids(n);
  const r = computeLayout({ mode, participants, featuredId: extra.featuredId ?? participants[1] ?? participants[0] ?? null, hasShare: extra.hasShare ?? false, size });
  const vis = visible(r.placements);
  const label = `${mode} n=${n} ${size.width}x${size.height} share=${extra.hasShare ?? false}`;
  for (const p of vis) {
    expect(Number.isInteger(p.rect.x) && Number.isInteger(p.rect.y) && Number.isInteger(p.rect.w) && Number.isInteger(p.rect.h), `${label} integer ${p.key}`).toBe(true);
    expect(p.rect.w, `${label} width ${p.key}`).toBeGreaterThan(0);
    expect(p.rect.h, `${label} height ${p.key}`).toBeGreaterThan(0);
    expect(p.rect.x, `${label} left ${p.key}`).toBeGreaterThanOrEqual(0);
    expect(p.rect.y, `${label} top ${p.key}`).toBeGreaterThanOrEqual(0);
    expect(p.rect.x + p.rect.w, `${label} right ${p.key}`).toBeLessThanOrEqual(size.width);
    expect(p.rect.y + p.rect.h, `${label} bottom ${p.key}`).toBeLessThanOrEqual(size.height);
  }
  for (let i = 0; i < vis.length; i++) for (let j = i + 1; j < vis.length; j++) expect(overlap(vis[i]!, vis[j]!), `${label} overlap ${vis[i]!.key}/${vis[j]!.key}`).toBe(false);
  return r;
}

describe('ring geometry', () => {
  it('spaces points by equal arc length, starting at the top, clockwise', () => {
    const pts = ellipsePoints(300, 100, 8);
    expect(pts[0]!.x).toBeCloseTo(0, 6);
    expect(pts[0]!.y).toBeCloseTo(-100, 6);
    expect(pts[2]!.x).toBeGreaterThan(0); // clockwise: the second quarter is on the right
    const d = pts.map((p, i) => Math.hypot(p.x - pts[(i + 1) % 8]!.x, p.y - pts[(i + 1) % 8]!.y));
    // chord lengths are close to each other (arc length is equal; chords differ only through curvature)
    expect(Math.max(...d) / Math.min(...d)).toBeLessThan(1.15);
  });
});

describe('Davra layout properties', () => {
  for (const size of SIZES) {
    for (let n = 1; n <= RING_MAX; n++) {
      it(`n=${n} at ${size.width}x${size.height}: inside the stage, no overlap, all tiles present`, () => {
        const r = expectSound('davra', n, size);
        // every participant is drawn except the featured one's own seat (n>1): ring tiles + centre = n
        expect(r.placements.length).toBe(n);
        expect(r.seats.length).toBe(n > 1 ? 1 : 0);
        const ring = r.placements.filter((p) => p.slot === 'ring');
        for (const p of ring) {
          expect(p.rect.w).toBe(p.rect.h);
          expect(p.rect.w, 'ring tile is still usable').toBeGreaterThanOrEqual(36);
          expect(p.shape).toBe('circle');
        }
        const centre = r.placements.find((p) => p.slot === 'center')!;
        expect(centre).toBeTruthy();
        if (size.height >= 400 && n > 1) expect(centre.rect.h, 'centre keeps a real size').toBeGreaterThanOrEqual(Math.min(size.width, size.height) * 0.25);
      });
    }
  }

  it('is deterministic: the same input gives the same output', () => {
    const input = { mode: 'davra' as const, participants: ids(9), featuredId: 'p4', hasShare: false, size: { width: 1337, height: 701 } };
    expect(computeLayout(input)).toEqual(computeLayout(structuredClone(input)));
  });

  it('puts a screen share in the centre and keeps everybody on the ring', () => {
    for (const size of SIZES) {
      for (const n of [1, 2, 5, 12]) {
        const r = expectSound('davra', n, size, { hasShare: true });
        const centre = r.placements.find((p) => p.slot === 'center')!;
        expect(centre.key).toBe(SHARE_KEY);
        expect(r.placements.filter((p) => p.slot === 'ring')).toHaveLength(n);
        expect(r.seats).toHaveLength(0);
      }
    }
  });

  it('a speaker change moves exactly the previous and the new speaker', () => {
    const size = { width: 1280, height: 560 };
    const a = computeLayout({ mode: 'davra', participants: ids(8), featuredId: 'p2', hasShare: false, size });
    const b = computeLayout({ mode: 'davra', participants: ids(8), featuredId: 'p5', hasShare: false, size });
    const moved = a.placements.filter((p) => JSON.stringify(p.rect) !== JSON.stringify(b.placements.find((q) => q.key === p.key)!.rect)).map((p) => p.key).sort();
    // p2 and p5 swap roles; the centre rectangle itself is identical, so only those two differ
    expect(moved).toEqual(['p2', 'p5']);
  });

  it('keeps the cyclic order and moves existing tiles by less than one seat when someone joins', () => {
    for (const size of [SIZES[4]!, SIZES[1]!, SIZES[6]!]) {
      for (let n = 2; n < RING_MAX; n++) {
        const before = computeLayout({ mode: 'davra', participants: ids(n), featuredId: 'p1', hasShare: true, size });
        const after = computeLayout({ mode: 'davra', participants: ids(n + 1), featuredId: 'p1', hasShare: true, size });
        const angle = (r: typeof before, k: string) => {
          const p = r.placements.find((x) => x.key === k)!;
          return Math.atan2(p.rect.y + p.rect.h / 2 - size.height / 2, p.rect.x + p.rect.w / 2 - size.width / 2);
        };
        // ring order (clockwise from the top) equals input order
        const clock = (r: typeof before) =>
          r.placements
            .filter((p) => p.slot === 'ring')
            .map((p) => ({ k: p.key, a: (angle(r, p.key) + Math.PI / 2 + 2 * Math.PI + 1e-9) % (2 * Math.PI) }))
            .sort((x, y) => x.a - y.a)
            .map((x) => x.k);
        expect(clock(after)).toEqual(ids(n + 1));
        expect(clock(before)).toEqual(ids(n));
        // nobody jumps across the ring: the angular shift of a tile is below one old seat
        for (const k of ids(n)) {
          let d = Math.abs(angle(after, k) - angle(before, k));
          d = Math.min(d, 2 * Math.PI - d);
          expect(d, `${k} ${n}->${n + 1}`).toBeLessThan((2 * Math.PI) / n + 0.2);
        }
      }
    }
  });

  it('a participant leaving from the end does not move the tile order', () => {
    const size = { width: 1280, height: 560 };
    const full = computeLayout({ mode: 'davra', participants: ids(6), featuredId: 'p1', hasShare: true, size });
    const less = computeLayout({ mode: 'davra', participants: ids(5), featuredId: 'p1', hasShare: true, size });
    expect(full.placements.filter((p) => p.slot === 'ring').map((p) => p.key)).toEqual(ids(6));
    expect(less.placements.filter((p) => p.slot === 'ring').map((p) => p.key)).toEqual(ids(5));
  });

  it('falls back to a valid featured participant when the requested one is gone', () => {
    const r = expectSound('davra', 4, SIZES[4]!, { featuredId: 'gone' });
    expect(r.placements.find((p) => p.slot === 'center')!.key).toBe('p1');
  });

  it('returns an empty layout for a stage that has no size yet', () => {
    expect(computeLayout({ mode: 'davra', participants: ids(3), featuredId: 'p1', hasShare: false, size: { width: 0, height: 0 } }).placements).toEqual([]);
  });
});

describe('fallback policy', () => {
  it('uses the grid above 12 people and keeps Davra up to 12', () => {
    const size = { width: 1280, height: 560 };
    expect(resolveMode('davra', RING_MAX, size)).toEqual({ mode: 'davra', reason: null });
    expect(resolveMode('davra', RING_MAX + 1, size)).toEqual({ mode: 'gallery', reason: 'too-many' });
    expect(resolveMode('davra', 30, size)).toEqual({ mode: 'gallery', reason: 'too-many' });
  });
  it('uses the speaker view on a phone stage with more than 8 people', () => {
    const phone = { width: 360, height: 520 };
    expect(resolveMode('davra', COMPACT_RING_MAX, phone).mode).toBe('davra');
    expect(resolveMode('davra', COMPACT_RING_MAX + 1, phone)).toEqual({ mode: 'speaker', reason: 'compact' });
  });
  it('draws the speaker view instead of Davra while a screen is shared', () => {
    expect(resolveMode('davra', 3, { width: 1200, height: 700 }, true)).toEqual({ mode: 'speaker', reason: 'share' });
    expect(resolveMode('gallery', 3, { width: 1200, height: 700 }, true).mode).toBe('gallery');
  });
  it('never replaces a mode the user picked explicitly', () => {
    expect(resolveMode('gallery', 3, { width: 300, height: 300 }).mode).toBe('gallery');
    expect(resolveMode('speaker', 30, { width: 300, height: 300 }).mode).toBe('speaker');
  });
});

describe('gallery layout', () => {
  for (const size of SIZES) {
    for (const n of [1, 2, 3, 5, 9, 13, 30]) {
      it(`n=${n} at ${size.width}x${size.height} fits and never overlaps`, () => {
        const r = expectSound('gallery', n, size);
        expect(r.placements).toHaveLength(n);
      });
    }
  }
  it('adds the shared screen as the first cell', () => {
    const r = expectSound('gallery', 4, SIZES[4]!, { hasShare: true });
    expect(r.placements[0]!.key).toBe(SHARE_KEY);
    expect(r.placements).toHaveLength(5);
  });
  it('is deterministic', () => {
    const i = { mode: 'gallery' as const, participants: ids(7), featuredId: null, hasShare: false, size: { width: 999, height: 555 } };
    expect(computeLayout(i)).toEqual(computeLayout(i));
  });
});

describe('speaker layout', () => {
  for (const size of SIZES) {
    for (const n of [1, 2, 4, 12, 30]) {
      it(`n=${n} at ${size.width}x${size.height} fits, the featured tile is the biggest`, () => {
        const r = expectSound('speaker', n, size);
        const main = r.placements.find((p) => p.slot === 'main')!;
        expect(main).toBeTruthy();
        for (const p of visible(r.placements).filter((x) => x.slot === 'strip')) expect(main.rect.w * main.rect.h).toBeGreaterThan(p.rect.w * p.rect.h);
        expect(r.overflow).toBe(r.placements.filter((p) => p.hidden).length);
      });
    }
  }
  it('puts the "+N" chip into a free slot of the strip, inside the stage and clear of every visible tile', () => {
    let seen = 0;
    for (const size of SIZES) {
      const r = expectSound('speaker', 30, size);
      if (r.overflow === 0) continue; // everybody fits on a very large stage
      seen++;
      const c = r.overflowRect;
      if (!c) continue; // a strip with a single slot has no room for a chip: the CSS fallback places it
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.y).toBeGreaterThanOrEqual(0);
      expect(c.x + c.w).toBeLessThanOrEqual(size.width);
      expect(c.y + c.h).toBeLessThanOrEqual(size.height);
      for (const p of visible(r.placements)) expect(overlap({ ...p, rect: c }, p), `chip over ${p.key} at ${size.width}x${size.height}`).toBe(false);
    }
    expect(seen).toBeGreaterThan(3);
  });
  it('shows every participant in the strip while a screen is shared', () => {
    const r = expectSound('speaker', 5, SIZES[4]!, { hasShare: true });
    expect(r.placements.find((p) => p.slot === 'main')!.key).toBe(SHARE_KEY);
    expect(r.placements.filter((p) => p.slot === 'strip')).toHaveLength(5);
  });
});

describe('pickFeatured', () => {
  it('prefers the screen sharer, then the active speaker, then the first remote', () => {
    const list = ['me', 'a', 'b', 'c'];
    expect(pickFeatured(list, { sharerId: 'c', speakerId: 'b' })).toBe('c');
    expect(pickFeatured(list, { sharerId: null, speakerId: 'b' })).toBe('b');
    expect(pickFeatured(list, { speakerId: 'gone' })).toBe('a');
    expect(pickFeatured(['me'], {})).toBe('me');
    expect(pickFeatured([], {})).toBeNull();
  });
});
