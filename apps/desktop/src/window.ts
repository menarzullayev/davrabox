// Pure helpers for the main window (no Electron import, so they can be tested directly).

/** The first window: 1280x800 when the screen has room, otherwise 90% of the work area, never below the minimum. */
export function initialWindowSize(work: { width: number; height: number }, min = { width: 800, height: 560 }): { width: number; height: number } {
  const fit = (want: number, avail: number, floor: number) => Math.max(floor, Math.min(want, Math.floor(avail * 0.9)));
  return { width: fit(1280, work.width, min.width), height: fit(800, work.height, min.height) };
}

/** The only message the page may send: its colour mode, so the native title bar matches. Anything else is ignored. */
export function parseThemeMessage(v: unknown): 'light' | 'dark' | null {
  return v === 'light' || v === 'dark' ? v : null;
}

/** Window background per mode (the design tokens' page background), shown before the page paints and behind the title bar. */
export const WINDOW_BG = { dark: '#0a0d21', light: '#f4f5fb' } as const;
