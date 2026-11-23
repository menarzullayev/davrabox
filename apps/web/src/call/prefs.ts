import type { LayoutMode } from './layout';

const KEY = 'callLayout';
const MODES: readonly LayoutMode[] = ['davra', 'gallery', 'speaker'];

/** The layout the user picked last time (Davra by default). Storage may be unavailable: never throws. */
export function loadLayout(): LayoutMode {
  try {
    const v = localStorage.getItem(KEY);
    if (v && (MODES as readonly string[]).includes(v)) return v as LayoutMode;
  } catch {
    /* storage unavailable */
  }
  return 'davra';
}

export function saveLayout(m: LayoutMode): void {
  try {
    localStorage.setItem(KEY, m);
  } catch {
    /* storage unavailable */
  }
}
