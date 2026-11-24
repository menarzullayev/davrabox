// The single owner of the person's display preferences (language, theme, style, density). One state for the whole page:
// reading, validating, saving, applying to <html> (lang, data-theme, data-style, data-density, theme-color) and following
// changes made in another tab all happen here. Screens only read it (usePrefs) and call set().
import { useSyncExternalStore } from 'react';
import { detectLang, type Lang } from '../i18n';
import { DEFAULTS, THEME_COLOR, isDensity, isLang, isStyle, isTheme, type DensityId, type StyleId, type ThemeChoice } from './options';

export interface Prefs {
  lang: Lang;
  theme: ThemeChoice;
  style: StyleId;
  density: DensityId;
}
type Key = keyof Prefs;

const STORAGE_KEY: Record<Key, string> = { lang: 'lang', theme: 'theme', style: 'style', density: 'density' };

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // storage unavailable: the defaults apply for this visit
  }
}
function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: the choice lasts for this visit only */
  }
}

function load(): Prefs {
  const attr = typeof document === 'undefined' ? null : document.documentElement.getAttribute('data-theme'); // theme-init.js ran first
  const savedTheme = read(STORAGE_KEY.theme);
  const savedStyle = read(STORAGE_KEY.style);
  const savedDensity = read(STORAGE_KEY.density);
  return {
    lang: detectLang(),
    theme: isTheme(attr) ? attr : isTheme(savedTheme) ? savedTheme : DEFAULTS.theme,
    style: isStyle(savedStyle) ? savedStyle : DEFAULTS.style,
    density: isDensity(savedDensity) ? savedDensity : DEFAULTS.density,
  };
}

let state: Prefs | null = null;
const listeners = new Set<() => void>();

function apply(p: Prefs): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.lang = p.lang; // what a screen reader speaks the page in
  root.setAttribute('data-theme', p.theme);
  root.setAttribute('data-style', p.style);
  root.setAttribute('data-density', p.density);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[p.theme]);
}

function emit(): void {
  for (const l of listeners) l();
}

/** The current preferences (read from storage on first use, then kept in memory). */
export function getPrefs(): Prefs {
  if (!state) {
    state = load();
    apply(state);
  }
  return state;
}

/**
 * Changes one preference. An invalid value is ignored. `persist: false` is for lab pages that take the value from the URL and
 * must not overwrite what the person saved.
 */
export function setPref<K extends Key>(key: K, value: Prefs[K], opts: { persist?: boolean } = {}): void {
  const valid = key === 'lang' ? isLang(value) : key === 'theme' ? isTheme(value) : key === 'style' ? isStyle(value) : isDensity(value);
  if (!valid) return;
  const cur = getPrefs();
  if (cur[key] === value) {
    // An explicit choice equal to the detected default is still a choice: remember it (nothing else changes).
    if (opts.persist !== false) write(STORAGE_KEY[key], String(value));
    return;
  }
  state = { ...cur, [key]: value };
  apply(state);
  if (opts.persist !== false) write(STORAGE_KEY[key], String(value));
  emit();
}

export function subscribePrefs(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
    // Nobody is showing preferences any more (the page unmounted): the next reader starts from storage again, so a value
    // saved meanwhile (another tab, a test) is never shadowed by an old in-memory copy.
    if (listeners.size === 0) state = null;
  };
}

/** Follows a change made in another tab or window of the same browser. */
function onStorage(e: StorageEvent): void {
  if (e.storageArea !== localStorage || !state) return;
  const key = (Object.keys(STORAGE_KEY) as Key[]).find((k) => STORAGE_KEY[k] === e.key);
  if (!key) return;
  const v = e.newValue;
  const next: Prefs[Key] =
    key === 'lang' ? (isLang(v) ? v : detectLang()) : key === 'theme' ? (isTheme(v) ? v : DEFAULTS.theme) : key === 'style' ? (isStyle(v) ? v : DEFAULTS.style) : isDensity(v) ? v : DEFAULTS.density;
  if (next === state[key]) return;
  state = { ...state, [key]: next };
  apply(state);
  emit();
}
if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);

/** Test helper: forget the in-memory state so the next read starts from storage again. */
export function resetPrefsForTests(): void {
  state = null;
  listeners.clear();
}

export function usePrefs(): Prefs & { setLang: (l: Lang) => void; setTheme: (v: ThemeChoice) => void; setStyle: (v: StyleId) => void; setDensity: (v: DensityId) => void } {
  const p = useSyncExternalStore(subscribePrefs, getPrefs, getPrefs);
  return {
    ...p,
    setLang: (l) => setPref('lang', l),
    setTheme: (v) => setPref('theme', v),
    setStyle: (v) => setPref('style', v),
    setDensity: (v) => setPref('density', v),
  };
}
