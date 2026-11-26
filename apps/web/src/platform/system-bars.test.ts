// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { barStyleFor, watchSystemBars } from './system-bars';

afterEach(() => document.documentElement.removeAttribute('data-theme'));

describe('barStyleFor', () => {
  it('light page = dark icons, anything else = light icons (dark is the default)', () => {
    expect(barStyleFor('light')).toBe('LIGHT');
    expect(barStyleFor('dark')).toBe('DARK');
    expect(barStyleFor(null)).toBe('DARK');
    expect(barStyleFor('weird')).toBe('DARK');
  });
});

describe('watchSystemBars', () => {
  const shell = (setStyle: (o: { style: 'DARK' | 'LIGHT' }) => unknown) => ({ Capacitor: { isNativePlatform: () => true, Plugins: { SystemBars: { setStyle } } } });

  it('does nothing outside the Android shell', () => {
    const setStyle = vi.fn();
    const stop = watchSystemBars({ Capacitor: { isNativePlatform: () => false, Plugins: { SystemBars: { setStyle } } } }, document);
    document.documentElement.setAttribute('data-theme', 'light');
    expect(setStyle).not.toHaveBeenCalled();
    stop();
    expect(() => watchSystemBars(undefined, document)()).not.toThrow();
  });

  it('sets the style at once and again on each theme change, never twice for the same style', async () => {
    const setStyle = vi.fn(async () => undefined);
    const stop = watchSystemBars(shell(setStyle), document);
    expect(setStyle).toHaveBeenLastCalledWith({ style: 'DARK' });
    document.documentElement.setAttribute('data-theme', 'light');
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(setStyle).toHaveBeenLastCalledWith({ style: 'LIGHT' });
    document.documentElement.setAttribute('data-theme', 'light'); // same value again
    await new Promise((r) => setTimeout(r, 0));
    document.documentElement.setAttribute('data-theme', 'dark');
    await new Promise((r) => setTimeout(r, 0));
    expect(setStyle.mock.calls.map((c) => (c as unknown as [{ style: string }])[0].style)).toEqual(['DARK', 'LIGHT', 'DARK']);
    stop();
    document.documentElement.setAttribute('data-theme', 'light');
    await new Promise((r) => setTimeout(r, 0));
    expect(setStyle).toHaveBeenCalledTimes(3);
  });

  it('survives an older shell without the plugin and a plugin that rejects or throws', async () => {
    expect(() => watchSystemBars({ Capacitor: { isNativePlatform: () => true } }, document)()).not.toThrow();
    expect(() => watchSystemBars(shell(vi.fn(async () => Promise.reject(new Error('no')))), document)()).not.toThrow();
    expect(() => watchSystemBars(shell(vi.fn(() => { throw new Error('boom'); })), document)()).not.toThrow();
    await new Promise((r) => setTimeout(r, 0)); // no unhandled rejection
  });
});

describe('watchSystemBars: ThemeBars (window colour and icons together)', () => {
  it('prefers ThemeBars and sends only the two theme names; SystemBars is the fallback of an older shell', async () => {
    const setTheme = vi.fn(async (_o: { theme: 'dark' | 'light' }) => undefined);
    const setStyle = vi.fn(async (_o: { style: 'DARK' | 'LIGHT' }) => undefined);
    const stop = watchSystemBars({ Capacitor: { isNativePlatform: () => true, Plugins: { ThemeBars: { setTheme }, SystemBars: { setStyle } } } }, document);
    document.documentElement.setAttribute('data-theme', 'light');
    await new Promise((r) => setTimeout(r, 0));
    document.documentElement.setAttribute('data-theme', 'bogus"; drop');
    await new Promise((r) => setTimeout(r, 0));
    expect(setTheme.mock.calls.map((c) => c[0])).toEqual([{ theme: 'dark' }, { theme: 'light' }, { theme: 'dark' }]);
    expect(setStyle).not.toHaveBeenCalled();
    stop();
    const old = vi.fn(async (_o: { style: 'DARK' | 'LIGHT' }) => undefined);
    watchSystemBars({ Capacitor: { isNativePlatform: () => true, Plugins: { SystemBars: { setStyle: old } } } }, document)();
    expect(old).toHaveBeenCalledWith({ style: 'DARK' });
  });
});

describe('desktop title bar', () => {
  it('sends the page colour mode to the desktop shell once per change, and does nothing in a browser', async () => {
    const { watchDesktopTitleBar } = await import('./system-bars');
    const setTheme = vi.fn();
    document.documentElement.removeAttribute('data-theme');
    const stop = watchDesktopTitleBar({ davraDesktop: { isDesktop: true, setTheme } }, document);
    expect(setTheme).toHaveBeenLastCalledWith('dark');
    document.documentElement.setAttribute('data-theme', 'light');
    await new Promise((r) => setTimeout(r, 0));
    expect(setTheme).toHaveBeenLastCalledWith('light');
    document.documentElement.setAttribute('data-theme', 'light');
    await new Promise((r) => setTimeout(r, 0));
    expect(setTheme).toHaveBeenCalledTimes(2);
    stop();
    document.documentElement.removeAttribute('data-theme');
    expect(watchDesktopTitleBar({}, document)).toBeTypeOf('function');
  });
});
