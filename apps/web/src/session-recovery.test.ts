// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recoverSession } from './session-recovery';
import { api, onSessionLost } from './api';

afterEach(() => {
  onSessionLost(null);
  vi.unstubAllGlobals();
});

function deps(now: number, last?: string) {
  const store = { v: last as string | undefined, getItem: () => store.v ?? null, setItem: (_k: string, x: string) => void (store.v = x) };
  const removeUser = vi.fn(async () => undefined);
  const goHome = vi.fn();
  return { d: { now: () => now, store, removeUser, goHome }, removeUser, goHome };
}

describe('recoverSession', () => {
  it('forgets the dead session and goes home, once', async () => {
    const { d, removeUser, goHome } = deps(1_000_000);
    expect(recoverSession(d)).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(removeUser).toHaveBeenCalledTimes(1);
    expect(goHome).toHaveBeenCalledTimes(1);
  });

  it('does nothing when it just happened (no reload loop)', () => {
    const { d, removeUser, goHome } = deps(1_000_000, String(1_000_000 - 5_000));
    expect(recoverSession(d)).toBe(false);
    expect(removeUser).not.toHaveBeenCalled();
    expect(goHome).not.toHaveBeenCalled();
  });

  it('acts again after the quiet period', () => {
    const { d } = deps(1_000_000, String(1_000_000 - 20_000));
    expect(recoverSession(d)).toBe(true);
  });
});

describe('API 401', () => {
  it('tells the app which token was refused, and still throws the error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: 'expired' }), { status: 401 })));
    const seen: string[] = [];
    onSessionLost((t) => seen.push(t));
    await expect(api.getPrefs('tok-1')).rejects.toMatchObject({ status: 401 });
    expect(seen).toEqual(['tok-1']);
  });
});
