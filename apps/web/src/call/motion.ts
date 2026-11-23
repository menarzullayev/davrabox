import { useEffect, useState } from 'react';
import type { Rect, TileShape } from './layout';

/** Duration of the speaker glide, inside the 150-400 ms window set by docs/DESIGN.md (token --dur-3 is 320 ms). */
export const GLIDE_MS = 280;
export const GLIDE_EASING = 'cubic-bezier(0.2, 0, 0, 1)';

/** True when the user asked the system for less motion. Safe without a window (tests, SSR). */
export function prefersReducedMotion(win: { matchMedia?: (q: string) => { matches: boolean } } | undefined = typeof window === 'undefined' ? undefined : window): boolean {
  try {
    return win?.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    return false;
  }
}

/** Effective glide time: instant under reduced motion, otherwise clamped to 150-400 ms. */
export function glideDuration(reduced: boolean, ms: number = GLIDE_MS): number {
  return reduced ? 0 : Math.min(400, Math.max(150, ms));
}

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => prefersReducedMotion());
  useEffect(() => {
    const mq = typeof window !== 'undefined' ? window.matchMedia?.('(prefers-reduced-motion: reduce)') : undefined;
    if (!mq) return undefined;
    const on = () => setReduced(mq.matches);
    mq.addEventListener?.('change', on);
    on();
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return reduced;
}

const radius = (shape: TileShape) => (shape === 'circle' ? '50%' : '20px');

/**
 * FLIP keyframes for a tile that moved from `prev` to `next`: the element is already laid out at `next`, so the
 * animation starts with the transform that makes it look like `prev` and ends at its resting transform. Only
 * transform (compositor) is animated; the corner radius morph is paint-only.
 */
export function glideKeyframes(prev: Rect, next: Rect, prevShape: TileShape = 'rect', nextShape: TileShape = 'rect'): { tile: Keyframe[]; media: Keyframe[] } {
  const sx = next.w > 0 ? prev.w / next.w : 1;
  const sy = next.h > 0 ? prev.h / next.h : 1;
  return {
    tile: [
      { transform: `translate3d(${prev.x}px, ${prev.y}px, 0) scale(${sx}, ${sy})` },
      { transform: `translate3d(${next.x}px, ${next.y}px, 0) scale(1, 1)` },
    ],
    media: [{ borderRadius: radius(prevShape) }, { borderRadius: radius(nextShape) }],
  };
}

export const sameRect = (a: Rect | undefined, b: Rect | undefined): boolean => !!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
