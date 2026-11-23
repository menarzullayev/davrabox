// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dictionaries, type Lang } from '../i18n';
import { landingEn, landingRu, landingUz } from './i18n-landing';
import Landing from './Landing';

const LANGS: Lang[] = ['uz', 'ru', 'en'];

function renderLanding(lang: Lang = 'en', navigate = vi.fn()) {
  localStorage.setItem('lang', lang);
  const view = render(<Landing navigate={navigate} />);
  return { ...view, navigate };
}

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe('landing dictionaries', () => {
  it('has the same ln* keys in uz, ru and en, all non-empty, and the main dictionaries contain them', () => {
    const keys = Object.keys(landingUz).sort();
    expect(keys.every((k) => k.startsWith('ln'))).toBe(true);
    expect(Object.keys(landingRu).sort()).toEqual(keys);
    expect(Object.keys(landingEn).sort()).toEqual(keys);
    for (const lang of LANGS) {
      for (const k of keys) {
        const v = (dictionaries[lang] as Record<string, string>)[k];
        expect(v, `${lang}.${k}`).toBeTruthy();
        expect(v!.trim(), `${lang}.${k}`).not.toBe('');
      }
    }
  });
  it('states no statistics: no digit-plus-suffix claims such as "50K+" and no customer names', () => {
    for (const lang of LANGS) {
      for (const [k, v] of Object.entries(dictionaries[lang])) {
        if (!k.startsWith('ln')) continue;
        expect(v, `${lang}.${k}`).not.toMatch(/\d+\s?[KkМмM]\+|\d+\s?%|\d+\s?(000|тыс)/);
      }
    }
  });
});

describe('landing page', () => {
  it('renders exactly one h1 and a heading per section, in every language, with no untranslated key', () => {
    for (const lang of LANGS) {
      const { container, unmount } = renderLanding(lang);
      expect(container.querySelectorAll('h1')).toHaveLength(1);
      expect(container.querySelectorAll('h2').length).toBeGreaterThanOrEqual(6);
      expect(container.textContent).not.toMatch(/\bln[A-Z][A-Za-z0-9]+\b/);
      expect(document.documentElement.lang).toBe(lang);
      expect(document.title).toBe(dictionaries[lang].lnPageTitle);
      unmount();
    }
  });

  it('the Start free buttons lead to the sign-up page', () => {
    renderLanding('en');
    const links = screen.getAllByRole('link', { name: 'Start free' });
    expect(links.length).toBeGreaterThanOrEqual(2); // header, hero and final call to action
    for (const a of links) expect(a.getAttribute('href')).toBe('/app/signup');
  });

  it('the Sign in link leads to the application', () => {
    renderLanding('en');
    for (const a of screen.getAllByRole('link', { name: 'Sign in' })) expect(a.getAttribute('href')).toBe('/app');
  });

  it('the join field accepts an 11-digit code and opens the application with it', () => {
    const { navigate } = renderLanding('en');
    const form = document.querySelector('[data-testid=landing-join]') as HTMLFormElement;
    const input = within(form).getByRole('textbox');
    fireEvent.change(input, { target: { value: '308 1234 5678' } });
    fireEvent.submit(form);
    expect(navigate).toHaveBeenCalledWith('/app?join=30812345678');
  });

  it('the join field also understands a pasted meeting link', () => {
    const { navigate } = renderLanding('en');
    const form = document.querySelector('[data-testid=landing-join]') as HTMLFormElement;
    fireEvent.change(within(form).getByRole('textbox'), { target: { value: 'https://davrabox.example.test/app?join=30812345678' } });
    fireEvent.submit(form);
    expect(navigate).toHaveBeenCalledWith('/app?join=30812345678');
  });

  it('refuses a short or malformed code, explains why, and does not navigate', () => {
    const { navigate } = renderLanding('en');
    const form = document.querySelector('[data-testid=landing-join]') as HTMLFormElement;
    const input = within(form).getByRole('textbox');
    for (const bad of ['', '123', '12ab', '1234567890123456', 'https://evil.example/']) {
      fireEvent.change(input, { target: { value: bad } });
      fireEvent.submit(form);
      expect(form.querySelector('[role=alert], .dx-field__error')).not.toBeNull();
    }
    expect(navigate).not.toHaveBeenCalled();
  });

  it('loads nothing from another site: every src and href is local, a fragment or mailto:', () => {
    for (const lang of LANGS) {
      const { container, unmount } = renderLanding(lang);
      const urls = [...container.querySelectorAll('[src],[href],[srcset],[action],[poster],[data]')].flatMap((el) =>
        ['src', 'href', 'srcset', 'action', 'poster', 'data'].map((a) => el.getAttribute(a)).filter((v): v is string => !!v),
      );
      expect(urls.length).toBeGreaterThan(5);
      for (const u of urls) {
        expect(/^(\/(?!\/)|#|mailto:)/.test(u), `${lang}: ${u}`).toBe(true);
      }
      unmount();
    }
  });

  it('names all twelve capabilities in equal tiles, in the order of the plan', () => {
    const { container } = renderLanding('en');
    const tiles = [...container.querySelectorAll('[data-testid=capability]')];
    expect(tiles).toHaveLength(12);
    expect(tiles.map((t) => t.querySelector('h3')?.firstChild?.textContent)).toEqual([
      'Video meetings', 'Waiting room and host control', 'Chat and files', 'SSO and admin console', 'Audit trail', 'End-to-end encryption',
      'Recording', 'Calendar', 'REST API and webhooks', 'Your own keys', 'Mobile', 'Desktop app',
    ]);
    // truthful state: only what a visitor cannot use today (recording on the pilot, calendar, mobile, desktop) says so
    const soon = tiles.map((t, i) => (t.querySelector('[data-testid=capability-soon]') ? i : -1)).filter((i) => i >= 0);
    expect(soon).toEqual([6, 7, 10, 11]);
  });

  it('the coming-soon marker is translated in every language', () => {
    for (const [lang, word] of [['uz', 'Tez orada'], ['ru', 'Скоро'], ['en', 'Coming soon']] as const) {
      const { container, unmount } = renderLanding(lang);
      expect(container.querySelector('[data-testid=capability-soon]')?.textContent).toBe(word);
      unmount();
    }
  });

  it('switching the language updates the page text and the document language', () => {
    renderLanding('en');
    fireEvent.click(screen.getByTestId('settings'));
    fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'ru' } });
    expect(document.documentElement.lang).toBe('ru');
    expect(screen.getAllByRole('link', { name: dictionaries.ru.lnStartFree }).length).toBeGreaterThan(0);
    expect(localStorage.getItem('lang')).toBe('ru');
  });

  it('shows the contact address as a mailto link and the legal pages as plain text until they are published', () => {
    renderLanding('en');
    const footer = document.querySelector('footer')!;
    const mail = within(footer).getByRole('link', { name: 'Contact' });
    expect(mail.getAttribute('href')).toMatch(/^mailto:[^@\s]+@[^@\s]+$/);
    expect(within(footer).getByText('Privacy policy').closest('a')).toBeNull();
    expect(within(footer).getByText('Terms of use').closest('a')).toBeNull();
  });
});
