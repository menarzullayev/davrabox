import { getPrefs, setPref } from '../prefs/store';
export type { ThemeChoice } from '../prefs/options';
import type { ThemeChoice } from '../prefs/options';

/** The current theme (kept by the preferences store). */
export function readTheme(): ThemeChoice {
  return getPrefs().theme;
}

/** Sets the theme through the store; `persist: false` is for lab pages that take it from the URL. */
export function applyTheme(theme: ThemeChoice, persist = true): void {
  setPref('theme', theme, { persist });
}
