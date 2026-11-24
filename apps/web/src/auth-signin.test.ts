// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { manager, signIn } from './auth';

describe('signIn language hand-off', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('passes the language the user sees as ui_locales', async () => {
    const spy = vi.spyOn(manager, 'signinRedirect').mockResolvedValue();
    await signIn({ lang: 'ru' });
    expect(spy).toHaveBeenCalledWith({ extraQueryParams: { ui_locales: 'ru' } });
  });

  it('falls back to the saved choice, then keeps the login hint', async () => {
    localStorage.setItem('lang', 'en');
    const spy = vi.spyOn(manager, 'signinRedirect').mockResolvedValue();
    await signIn({ loginHint: 'a@b.uz' });
    expect(spy).toHaveBeenCalledWith({ login_hint: 'a@b.uz', extraQueryParams: { ui_locales: 'en' } });
  });

  it('never sends an unsupported locale', async () => {
    localStorage.setItem('lang', 'xx');
    const spy = vi.spyOn(manager, 'signinRedirect').mockResolvedValue();
    await signIn();
    const sent = (spy.mock.calls[0]?.[0] as { extraQueryParams: { ui_locales: string } }).extraQueryParams.ui_locales;
    expect(['uz', 'ru', 'en']).toContain(sent);
  });
});
