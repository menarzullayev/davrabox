// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULTS, LANGS, THEME_COLOR, isDensity, isLang, isStyle, isTheme } from './options';
import { getPrefs, setPref, subscribePrefs } from './store';

function reset() {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-style');
  document.documentElement.removeAttribute('data-density');
  document.documentElement.lang = '';
  document.head.innerHTML = '<meta name="theme-color" content="#000000">';
  // drop any in-memory state: a subscribe + unsubscribe cycle forgets it
  subscribePrefs(() => undefined)();
}
beforeEach(reset);
afterEach(reset);

describe('options: the one list of choices', () => {
  it('lists the three languages once, with a short code and a name', () => {
    expect(LANGS.map((l) => l.id)).toEqual(['uz', 'ru', 'en']);
    for (const l of LANGS) expect(l.short).toBe(l.id.toUpperCase());
  });
  it('validators accept only listed values', () => {
    expect(isLang('ru')).toBe(true);
    expect(isLang('de')).toBe(false);
    expect(isLang(undefined)).toBe(false);
    expect(isTheme('light')).toBe(true);
    expect(isTheme('sepia')).toBe(false);
    expect(isStyle('dashboard')).toBe(true);
    expect(isStyle('<script>')).toBe(false);
    expect(isDensity('comfortable')).toBe(true);
    expect(isDensity('tiny')).toBe(false);
  });
});

describe('prefs store', () => {
  it('starts from the defaults and applies them to <html>', () => {
    const p = getPrefs();
    expect(p.theme).toBe(DEFAULTS.theme);
    expect(p.style).toBe(DEFAULTS.style);
    expect(p.density).toBe(DEFAULTS.density);
    const root = document.documentElement;
    expect(root.lang).toBe(p.lang);
    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(root.getAttribute('data-style')).toBe('dashboard');
    expect(root.getAttribute('data-density')).toBe('comfortable');
  });

  it('reads valid saved values and ignores corrupted ones', () => {
    localStorage.setItem('lang', 'ru');
    localStorage.setItem('theme', 'light');
    localStorage.setItem('style', 'not-a-style');
    localStorage.setItem('density', '<img onerror=x>');
    const p = getPrefs();
    expect(p.lang).toBe('ru');
    expect(p.theme).toBe('light');
    expect(p.style).toBe(DEFAULTS.style);
    expect(p.density).toBe(DEFAULTS.density);
  });

  it('a change updates <html>, the theme-color, storage and every subscriber once', () => {
    const fn = vi.fn();
    const off = subscribePrefs(fn);
    setPref('lang', 'ru');
    setPref('theme', 'light');
    expect(document.documentElement.lang).toBe('ru');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(document.querySelector('meta[name="theme-color"]')!.getAttribute('content')).toBe(THEME_COLOR.light);
    expect(localStorage.getItem('lang')).toBe('ru');
    expect(localStorage.getItem('theme')).toBe('light');
    expect(fn).toHaveBeenCalledTimes(2);
    setPref('theme', 'light'); // same value: nothing happens
    expect(fn).toHaveBeenCalledTimes(2);
    off();
  });

  it('ignores an invalid value completely', () => {
    const off = subscribePrefs(() => undefined);
    setPref('lang', 'xx' as never);
    setPref('theme', 'neon' as never);
    expect(getPrefs().theme).toBe('dark');
    expect(localStorage.getItem('theme')).toBeNull();
    off();
  });

  it('persist:false changes this visit only', () => {
    const off = subscribePrefs(() => undefined);
    setPref('lang', 'ru', { persist: false });
    expect(getPrefs().lang).toBe('ru');
    expect(document.documentElement.lang).toBe('ru');
    expect(localStorage.getItem('lang')).toBeNull();
    off();
  });

  it('follows a change made in another tab', () => {
    const fn = vi.fn();
    const off = subscribePrefs(fn);
    getPrefs();
    localStorage.setItem('theme', 'light');
    window.dispatchEvent(new StorageEvent('storage', { key: 'theme', newValue: 'light', storageArea: localStorage }));
    expect(getPrefs().theme).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(fn).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated', newValue: 'x', storageArea: localStorage }));
    expect(fn).toHaveBeenCalledTimes(1);
    off();
  });

  it('forgets its memory when nobody shows preferences, so saved values are never shadowed', () => {
    const off = subscribePrefs(() => undefined);
    setPref('lang', 'ru');
    off();
    localStorage.setItem('lang', 'uz');
    expect(getPrefs().lang).toBe('uz');
  });
});

describe('styles and densities come from the design tokens', () => {
  it('offers every token style and density, and a chosen style lands on <html> and in storage', async () => {
    const { STYLES, DENSITIES } = await import('./options');
    const { STYLE_IDS, DENSITY_IDS } = await import('@davrabox/design-tokens');
    expect([...STYLES]).toEqual([...STYLE_IDS]);
    expect([...DENSITIES]).toEqual([...DENSITY_IDS]);
    expect(STYLES.length).toBe(12);
    const off = subscribePrefs(() => undefined);
    setPref('style', 'terminal');
    setPref('density', 'compact');
    expect(document.documentElement.getAttribute('data-style')).toBe('terminal');
    expect(document.documentElement.getAttribute('data-density')).toBe('compact');
    expect(localStorage.getItem('style')).toBe('terminal');
    setPref('style', 'nope' as never);
    expect(getPrefs().style).toBe('terminal');
    off();
  });

  it('every style and density has a visible name in all three languages', async () => {
    const { STYLES, DENSITIES, styleLabelKey, densityLabelKey } = await import('./options');
    const { dictionaries } = await import('../i18n');
    for (const lang of ['uz', 'ru', 'en'] as const) {
      for (const id of STYLES) expect(dictionaries[lang][styleLabelKey(id)]?.length, `${lang} ${id}`).toBeGreaterThan(3);
      for (const id of DENSITIES) expect(dictionaries[lang][densityLabelKey(id)]?.length, `${lang} ${id}`).toBeGreaterThan(1);
    }
  });
});
