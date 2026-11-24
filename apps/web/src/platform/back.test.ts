// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleBack, pushBack, resetBackForTests } from './back';
import { watchBackButton } from './back-button';

afterEach(() => resetBackForTests());

describe('back stack', () => {
  it('asks the newest layer first and reports false when nothing is open', () => {
    expect(handleBack()).toBe(false);
    const order: string[] = [];
    const a = pushBack(() => order.push('a'));
    const b = pushBack(() => order.push('b'));
    expect(handleBack()).toBe(true);
    b();
    expect(handleBack()).toBe(true);
    a();
    expect(handleBack()).toBe(false);
    expect(order).toEqual(['b', 'a']);
  });
});

function shell() {
  let cb: ((e: { canGoBack?: boolean }) => void) | undefined;
  const remove = vi.fn();
  const App = { addListener: vi.fn(async (_n: string, f: (e: { canGoBack?: boolean }) => void) => { cb = f; return { remove }; }), exitApp: vi.fn() };
  const history = { back: vi.fn() };
  const win = { Capacitor: { isNativePlatform: () => true, Plugins: { App } }, history };
  return { win, App, history, remove, press: (canGoBack: boolean) => cb!({ canGoBack }) };
}

describe('watchBackButton', () => {
  it('does nothing outside the Android shell', () => {
    const s = shell();
    s.win.Capacitor.isNativePlatform = () => false;
    watchBackButton(s.win)();
    expect(s.App.addListener).not.toHaveBeenCalled();
  });

  it('does nothing when the shell has no App plugin (older shell keeps its default)', () => {
    expect(() => watchBackButton({ Capacitor: { isNativePlatform: () => true, Plugins: {} } })()).not.toThrow();
  });

  it('a layer takes the press; otherwise history goes back; otherwise the app exits', async () => {
    const s = shell();
    watchBackButton(s.win);
    await Promise.resolve();
    const layer = vi.fn();
    const off = pushBack(layer);
    s.press(true);
    expect(layer).toHaveBeenCalledTimes(1);
    expect(s.history.back).not.toHaveBeenCalled();
    off();
    s.press(true);
    expect(s.history.back).toHaveBeenCalledTimes(1);
    expect(s.App.exitApp).not.toHaveBeenCalled();
    s.press(false);
    expect(s.App.exitApp).toHaveBeenCalledTimes(1);
  });

  it('stopping removes the native listener', async () => {
    const s = shell();
    const stop = watchBackButton(s.win);
    await Promise.resolve();
    await Promise.resolve();
    stop();
    expect(s.remove).toHaveBeenCalled();
  });
});
