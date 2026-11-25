// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { User } from 'oidc-client-ts';
import { restoreUser, userStorage } from './auth';

const user = (over: Partial<User>) => ({ expired: false, refresh_token: 'r', access_token: 'a', ...over }) as unknown as User;
const mgr = (stored: User | null, renewed?: User | Error) => ({
  getUser: vi.fn().mockResolvedValue(stored),
  signinSilent: vi.fn(() => (renewed instanceof Error ? Promise.reject(renewed) : Promise.resolve(renewed ?? null))),
  removeUser: vi.fn().mockResolvedValue(undefined),
});

describe('restoreUser', () => {
  it('returns a valid stored user without a network call', async () => {
    const m = mgr(user({}));
    expect(await restoreUser(m)).toEqual(user({}));
    expect(m.signinSilent).not.toHaveBeenCalled();
  });
  it('renews an expired user with its refresh token instead of signing out', async () => {
    const fresh = user({ access_token: 'new' });
    const m = mgr(user({ expired: true }), fresh);
    expect(await restoreUser(m)).toBe(fresh);
    expect(m.signinSilent).toHaveBeenCalledOnce();
  });
  it('drops the stored user when the renewal is refused', async () => {
    const m = mgr(user({ expired: true }), new Error('invalid_grant'));
    expect(await restoreUser(m)).toBeNull();
    expect(m.removeUser).toHaveBeenCalledOnce();
  });
  it('is signed out when nothing is stored or there is no refresh token', async () => {
    expect(await restoreUser(mgr(null))).toBeNull();
    const m = mgr(user({ expired: true, refresh_token: undefined }));
    expect(await restoreUser(m)).toBeNull();
    expect(m.signinSilent).not.toHaveBeenCalled();
  });
});

describe('userStorage', () => {
  it('keeps the user in the tab in a browser and in app storage in the Android app', () => {
    expect(userStorage(window)).toBe(window.sessionStorage);
    const local = {} as Storage, session = {} as Storage;
    const app = { Capacitor: { isNativePlatform: () => true }, localStorage: local, sessionStorage: session } as unknown as Window;
    expect(userStorage(app)).toBe(local);
    expect(userStorage({ localStorage: local, sessionStorage: session } as unknown as Window)).toBe(session);
  });
});
