/**
 * Call layout engine (pure, deterministic, no DOM). Given the participants in a stable order, the featured one,
 * whether a screen share is on and the stage size, it returns an integer rectangle per tile.
 *
 * Davra mode: tiles sit on an ellipse (a circle on a square stage) spaced by equal arc length, the centre stage
 * shows the shared screen or the active speaker, and the speaker's own seat on the ring stays free (the "empty
 * chair"), so a speaker change moves exactly two tiles. Sizes come from the available space, never from constants:
 * the ring tile size is the largest that keeps every pair of tiles apart, the centre stage the largest rectangle
 * that clears the ring.
 */
export type LayoutMode = 'davra' | 'gallery' | 'speaker';
export type TileShape = 'circle' | 'rect';
export type TileSlot = 'center' | 'ring' | 'main' | 'strip' | 'cell';

export interface Size {
  width: number;
  height: number;
}
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Placement {
  /** Participant identity, or SHARE_KEY for the screen-share tile. */
  key: string;
  rect: Rect;
  shape: TileShape;
  slot: TileSlot;
  /** True when the tile does not fit (speaker strip overflow): it is not drawn, the count is in `overflow`. */
  hidden: boolean;
}
export interface LayoutInput {
  mode: LayoutMode;
  /** Stable order (join order). Ring seats follow this order, so tiles never reshuffle when others come and go. */
  participants: readonly string[];
  featuredId: string | null;
  hasShare: boolean;
  size: Size;
}
export interface LayoutResult {
  /** The mode actually used (a requested mode can be replaced by resolveMode before computing). */
  mode: LayoutMode;
  placements: Placement[];
  /** Free seats on the ring (the featured participant's own seat); decoration only. */
  seats: Rect[];
  overflow: number;
  /** Speaker strip overflow: the slot where the "+N" chip goes (it takes the place of the last tile that would not fit). */
  overflowRect?: Rect;
  /** The ellipse the ring seats sit on (Davra only), for the faint guide line. */
  track?: { cx: number; cy: number; rx: number; ry: number };
}

export const SHARE_KEY = '::share';
/** Largest number of people on the ring. */
export const RING_MAX = 12;
/** On a phone-sized stage the ring is only used up to this many people, then the speaker view takes over. */
export const COMPACT_RING_MAX = 8;
/** A stage narrower than this (CSS px) counts as a phone. */
export const COMPACT_WIDTH = 520;

/** Translation key of the note explaining why another view than the requested one is drawn. */
export function hintKey(r: FallbackReason): 'clHintTooMany' | 'clHintCompact' | 'clHintShare' {
  return r === 'too-many' ? 'clHintTooMany' : r === 'share' ? 'clHintShare' : 'clHintCompact';
}

export type FallbackReason = 'too-many' | 'compact' | 'share' | null;

/** Pure policy: which mode to draw for a requested one. Only Davra is ever replaced. */
export function resolveMode(requested: LayoutMode, count: number, size: Size, hasShare = false): { mode: LayoutMode; reason: FallbackReason } {
  if (requested !== 'davra') return { mode: requested, reason: null };
  // A shared screen needs the room: the ring would shrink it to about a fifth of the stage (critic D-04).
  if (hasShare) return { mode: 'speaker', reason: 'share' };
  if (count > RING_MAX) return { mode: 'gallery', reason: 'too-many' };
  if (size.width < COMPACT_WIDTH && count > COMPACT_RING_MAX) return { mode: 'speaker', reason: 'compact' };
  return { mode: 'davra', reason: null };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const rect = (x: number, y: number, w: number, h: number): Rect => ({ x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) });

/** Points on an ellipse (relative to its centre) spaced by equal arc length, starting at the top, clockwise. */
export function ellipsePoints(rx: number, ry: number, count: number): Array<{ x: number; y: number }> {
  const STEPS = 1440;
  const cum = new Float64Array(STEPS + 1);
  let px = 0;
  let py = -ry;
  for (let i = 1; i <= STEPS; i++) {
    const th = (i / STEPS) * Math.PI * 2;
    const x = rx * Math.sin(th);
    const y = -ry * Math.cos(th);
    cum[i] = cum[i - 1]! + Math.hypot(x - px, y - py);
    px = x;
    py = y;
  }
  const total = cum[STEPS]!;
  const out: Array<{ x: number; y: number }> = [];
  let seg = 0;
  for (let k = 0; k < count; k++) {
    const s = (k / count) * total;
    while (seg < STEPS - 1 && cum[seg + 1]! < s) seg++;
    const span = cum[seg + 1]! - cum[seg]!;
    const f = span > 0 ? (s - cum[seg]!) / span : 0;
    const th = ((seg + f) / STEPS) * Math.PI * 2;
    out.push({ x: rx * Math.sin(th), y: -ry * Math.cos(th) });
  }
  return out;
}

/** Smallest Chebyshev distance between any two points: the boxes of side d are apart when this is >= d + gap. */
function minSeparation(pts: ReadonlyArray<{ x: number; y: number }>): number {
  let best = Infinity;
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++) best = Math.min(best, Math.max(Math.abs(pts[i]!.x - pts[j]!.x), Math.abs(pts[i]!.y - pts[j]!.y)));
  return best;
}

/** Largest centred rectangle of the given aspect that stays `margin` inside the stage and `gap` away from every ring box. */
function centerRect(W: number, H: number, aspect: number, ring: ReadonlyArray<{ x: number; y: number }>, d: number, margin: number, gap: number): { w: number; h: number } {
  const maxH = Math.min(H - 2 * margin, (W - 2 * margin) / aspect);
  const fits = (h: number) => {
    const hw = (h * aspect) / 2;
    const hh = h / 2;
    return ring.every((p) => Math.abs(p.x) >= hw + d / 2 + gap || Math.abs(p.y) >= hh + d / 2 + gap);
  };
  if (fits(maxH)) return { w: maxH * aspect, h: maxH };
  let lo = 0;
  let hi = maxH;
  for (let i = 0; i < 28; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return { w: lo * aspect, h: lo };
}

function davra(input: LayoutInput): LayoutResult {
  const { participants, hasShare, size } = input;
  const W = size.width;
  const H = size.height;
  const short = Math.min(W, H);
  const margin = clamp(short * 0.025, 6, 20);
  const gap = clamp(short * 0.024, 8, 20); // air between the ring and the centre stage
  const n = participants.length;
  const featured = !hasShare ? (input.featuredId && participants.includes(input.featuredId) ? input.featuredId : (participants[1] ?? participants[0] ?? null)) : null;
  const placements: Placement[] = [];
  const seats: Rect[] = [];
  const centerKey = hasShare ? SHARE_KEY : featured;

  // The centre stage follows the stage's own shape (portrait phones get a portrait centre); a share keeps 16:9.
  const aspect = hasShare ? 16 / 9 : clamp(W / H, 0.72, 16 / 9);

  if (n === 0 && !hasShare) return { mode: 'davra', placements, seats, overflow: 0 };
  const ringed = hasShare ? n : n - 1;
  if (ringed <= 0) {
    const c = centerRect(W, H, aspect, [], 0, margin, gap);
    if (centerKey) placements.push({ key: centerKey, rect: rect((W - c.w) / 2, (H - c.h) / 2, c.w, c.h), shape: 'rect', slot: 'center', hidden: false });
    return { mode: 'davra', placements, seats, overflow: 0 };
  }

  // Ring seats: one per participant (the featured participant's seat stays free).
  const dMax = clamp(Math.round(short * 0.17), 44, 150);
  const dMin = 36;
  const minCenterH = short * 0.42;
  let best: { d: number; pts: Array<{ x: number; y: number }>; c: { w: number; h: number } } | null = null;
  for (let d = dMax; d >= dMin; d -= 2) {
    const rx = W / 2 - margin - d / 2;
    const ry = H / 2 - margin - d / 2;
    if (rx <= 0 || ry <= 0) continue;
    const pts = ellipsePoints(rx, ry, n);
    if (n > 1 && minSeparation(pts) < d + gap) continue;
    const c = centerRect(W, H, aspect, pts, d, margin, gap);
    if (!best || c.h > best.c.h) best = { d, pts, c };
    if (c.h >= minCenterH) {
      best = { d, pts, c };
      break;
    }
  }
  if (!best) {
    // Degenerate stage (tiny container): smallest tiles on the largest possible ellipse, centre may vanish.
    const d = dMin;
    const rx = Math.max(1, W / 2 - margin - d / 2);
    const ry = Math.max(1, H / 2 - margin - d / 2);
    const pts = ellipsePoints(rx, ry, n);
    best = { d, pts, c: centerRect(W, H, aspect, pts, d, margin, gap) };
  }
  const { d, pts, c } = best;
  const cx = W / 2;
  const cy = H / 2;
  participants.forEach((id, i) => {
    const p = pts[i]!;
    const r = rect(cx + p.x - d / 2, cy + p.y - d / 2, d, d);
    if (id === featured) {
      seats.push(r);
      return;
    }
    placements.push({ key: id, rect: r, shape: 'circle', slot: 'ring', hidden: false });
  });
  if (centerKey) placements.push({ key: centerKey, rect: rect(cx - c.w / 2, cy - c.h / 2, c.w, c.h), shape: 'rect', slot: 'center', hidden: false });
  return { mode: 'davra', placements, seats, overflow: 0, track: { cx, cy, rx: W / 2 - margin - d / 2, ry: H / 2 - margin - d / 2 } };
}

const GRID_ASPECTS: ReadonlyArray<readonly [number, number]> = [
  [16 / 9, 1],
  [4 / 3, 0.94],
  [1, 0.86],
];

function gallery(input: LayoutInput): LayoutResult {
  const { participants, hasShare, size } = input;
  const W = size.width;
  const H = size.height;
  const short = Math.min(W, H);
  const margin = clamp(short * 0.02, 6, 16);
  const gap = clamp(short * 0.014, 4, 12);
  const keys = [...(hasShare ? [SHARE_KEY] : []), ...participants];
  const n = keys.length;
  const placements: Placement[] = [];
  if (n === 0) return { mode: 'gallery', placements, seats: [], overflow: 0 };
  let best: { cols: number; rows: number; w: number; h: number; score: number } | null = null;
  for (const [aspect, weight] of GRID_ASPECTS) {
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      const cw = (W - 2 * margin - (cols - 1) * gap) / cols;
      const ch = (H - 2 * margin - (rows - 1) * gap) / rows;
      if (cw <= 0 || ch <= 0) continue;
      const w = Math.min(cw, ch * aspect);
      const h = w / aspect;
      const score = w * h * weight * (1 - 0.02 * (cols * rows - n));
      if (!best || score > best.score + 1e-6) best = { cols, rows, w, h, score };
    }
  }
  const b = best ?? { cols: 1, rows: n, w: 1, h: 1, score: 0 };
  const totalH = b.rows * b.h + (b.rows - 1) * gap;
  const top = (H - totalH) / 2;
  keys.forEach((key, i) => {
    const row = Math.floor(i / b.cols);
    const inRow = row === b.rows - 1 ? n - row * b.cols : b.cols;
    const col = i - row * b.cols;
    const rowW = inRow * b.w + (inRow - 1) * gap;
    const left = (W - rowW) / 2;
    placements.push({ key, rect: rect(left + col * (b.w + gap), top + row * (b.h + gap), b.w, b.h), shape: 'rect', slot: 'cell', hidden: false });
  });
  return { mode: 'gallery', placements, seats: [], overflow: 0 };
}

function speaker(input: LayoutInput): LayoutResult {
  const { participants, hasShare, size } = input;
  const W = size.width;
  const H = size.height;
  const short = Math.min(W, H);
  const margin = clamp(short * 0.02, 6, 16);
  const gap = clamp(short * 0.012, 4, 10);
  const featured = !hasShare ? (input.featuredId && participants.includes(input.featuredId) ? input.featuredId : (participants[1] ?? participants[0] ?? null)) : null;
  const mainKey = hasShare ? SHARE_KEY : featured;
  const others = participants.filter((id) => id !== featured || hasShare);
  const placements: Placement[] = [];
  if (!mainKey) return { mode: 'speaker', placements, seats: [], overflow: 0 };
  if (others.length === 0) {
    placements.push({ key: mainKey, rect: rect(margin, margin, W - 2 * margin, H - 2 * margin), shape: 'rect', slot: 'main', hidden: false });
    return { mode: 'speaker', placements, seats: [], overflow: 0 };
  }
  const landscape = W / H >= 1.1;
  let shown = others.length;
  let mainRect: Rect;
  const strip: Rect[] = [];
  if (landscape) {
    // Filmstrip as one to three columns on the right, 16:9 tiles.
    const aspect = 16 / 9;
    const availH = H - 2 * margin;
    const maxTw = clamp(W * 0.2, 120, 260);
    const minTw = 88;
    let pick: { cols: number; tw: number; th: number; shown: number } | null = null;
    for (let cols = 1; cols <= 3; cols++) {
      const rows = Math.ceil(others.length / cols);
      let tw = Math.min(maxTw, (W * 0.34 - (cols - 1) * gap) / cols);
      let th = tw / aspect;
      if (rows * th + (rows - 1) * gap > availH) {
        th = (availH - (rows - 1) * gap) / rows;
        tw = th * aspect;
      }
      if (tw >= minTw && (!pick || tw > pick.tw + 1e-6)) pick = { cols, tw, th, shown: others.length };
    }
    if (!pick) {
      const tw = minTw;
      const th = tw / aspect;
      const cols = 2;
      const rowsFit = Math.max(1, Math.floor((availH + gap) / (th + gap)));
      pick = { cols, tw, th, shown: Math.min(others.length, rowsFit * cols) };
    }
    const colsUsed = Math.min(pick.cols, others.length);
    const stripW = colsUsed * pick.tw + (colsUsed - 1) * gap;
    const rows = Math.ceil(pick.shown / colsUsed);
    const stripH = rows * pick.th + (rows - 1) * gap;
    const x0 = W - margin - stripW;
    const y0 = margin + (availH - stripH) / 2;
    for (let i = 0; i < others.length; i++) {
      const row = Math.floor(i / colsUsed);
      const col = i % colsUsed;
      strip.push(rect(x0 + col * (pick.tw + gap), y0 + row * (pick.th + gap), pick.tw, pick.th));
    }
    shown = pick.shown;
    mainRect = rect(margin, margin, x0 - gap - margin, availH);
  } else {
    // Filmstrip as one row along the bottom.
    const availW = W - 2 * margin;
    let th = clamp(H * 0.17, 64, 130);
    let tw = th * (4 / 3);
    const minTh = 52;
    for (;;) {
      const cap = Math.floor((availW + gap) / (tw + gap));
      if (cap >= others.length) break;
      if (th - 4 < minTh) {
        shown = Math.max(1, cap);
        break;
      }
      th -= 4;
      tw = th * (4 / 3);
    }
    const rowW = shown * tw + (shown - 1) * gap;
    const x0 = margin + (availW - rowW) / 2;
    const y0 = H - margin - th;
    for (let i = 0; i < others.length; i++) strip.push(rect(x0 + i * (tw + gap), y0, tw, th));
    mainRect = rect(margin, margin, availW, y0 - gap - margin);
  }
  // The last slot that fits carries the "+N" chip instead of a tile.
  let overflowRect: Rect | undefined;
  if (shown < others.length && shown > 1) {
    shown -= 1;
    overflowRect = strip[shown];
  }
  const overflow = others.length - shown;
  placements.push({ key: mainKey, rect: mainRect, shape: 'rect', slot: 'main', hidden: false });
  others.forEach((id, i) => placements.push({ key: id, rect: strip[i]!, shape: 'rect', slot: 'strip', hidden: i >= shown }));
  return { mode: 'speaker', placements, seats: [], overflow, overflowRect };
}

/** Computes the layout for an already resolved mode (see resolveMode). Placements follow the input order. */
export function computeLayout(input: LayoutInput): LayoutResult {
  const size = { width: Math.max(0, Math.floor(input.size.width)), height: Math.max(0, Math.floor(input.size.height)) };
  const safe: LayoutInput = { ...input, size };
  if (size.width < 40 || size.height < 40) return { mode: input.mode, placements: [], seats: [], overflow: 0 };
  const result = input.mode === 'davra' ? davra(safe) : input.mode === 'gallery' ? gallery(safe) : speaker(safe);
  // Re-order to the input order (share first) so DOM order and layout order agree and output is deterministic.
  const order = new Map<string, number>([[SHARE_KEY, -1], ...input.participants.map((id, i) => [id, i] as const)]);
  result.placements.sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));
  return result;
}

/** Share > last active speaker (while still present) > first remote participant > anyone. `local` is index 0. */
export function pickFeatured(participants: readonly string[], opts: { sharerId?: string | null; speakerId?: string | null }): string | null {
  if (opts.sharerId && participants.includes(opts.sharerId)) return opts.sharerId;
  if (opts.speakerId && participants.includes(opts.speakerId)) return opts.speakerId;
  return participants[1] ?? participants[0] ?? null;
}
