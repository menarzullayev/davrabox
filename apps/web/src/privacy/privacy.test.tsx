// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import { createAdminClient, type AdminClient, type AdminUser } from '../admin/client';
import { AdminCtx } from '../admin/ui';
import { SignInScreen } from '../home/AuthScreens';
import { dictionaries, type Key, type Lang } from '../i18n';
import { isPrivacyPath, isTermsPath } from '../routes';
import { Privacy } from '../admin/Privacy';
import { confirmMatches, ERASED_EMAIL, isErased, privacyErrorKey } from '../admin/privacy-helpers';
import { PrivacyPage } from './PrivacyPage';
import { PRIVACY_TEXT } from './legal-privacy';
import { TERMS_TEXT } from './legal-terms';
import { PRIVACY_CONTACT } from './legal-types';
import { pickOption } from '../ui/testing';

// jsdom has no modal <dialog>: a minimal stand-in for showModal/close (the real element is covered by the browser e2e).
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
  };
});

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

const LANGS: Lang[] = ['uz', 'ru', 'en'];

describe('routes', () => {
  it('recognises /privacy and /terms (with a trailing slash) and nothing that merely looks like them', () => {
    expect(isPrivacyPath('/privacy')).toBe(true);
    expect(isPrivacyPath('/privacy/')).toBe(true);
    expect(isTermsPath('/terms')).toBe(true);
    expect(isTermsPath('/terms/')).toBe(true);
    for (const p of ['/', '/app', '/privacy-policy', '/privacy/x', '/x/privacy', '/termsandconditions', '/admin/privacy']) {
      expect(isPrivacyPath(p), p).toBe(false);
      expect(isTermsPath(p), p).toBe(false);
    }
  });
});

describe('legal texts', () => {
  const docs = [['privacy', PRIVACY_TEXT], ['terms', TERMS_TEXT]] as const;
  it.each(docs)('%s: all three languages have the same sections in the same order', (_n, texts) => {
    const ids = texts.en.sections.map((s) => s.id);
    expect(ids.length).toBeGreaterThanOrEqual(6);
    for (const l of LANGS) expect(texts[l].sections.map((s) => s.id), l).toEqual(ids);
  });
  it.each(docs)('%s: every section has a heading and some body in every language', (_n, texts) => {
    for (const l of LANGS) {
      expect(texts[l].title.trim()).not.toBe('');
      for (const s of texts[l].sections) {
        expect(s.heading.trim(), `${l}/${s.id}`).not.toBe('');
        expect((s.paragraphs?.length ?? 0) + (s.items?.length ?? 0), `${l}/${s.id}`).toBeGreaterThan(0);
      }
    }
  });
  it('the privacy notice is honest about where the servers run, the assistant and the retention periods, in every language', () => {
    for (const l of LANGS) {
      const text = JSON.stringify(PRIVACY_TEXT[l]);
      // production runs on Oracle Cloud in Frankfurt with its own media server (moved from LiveKit Cloud on 2026-11-26)
      expect(text, l).toContain('Oracle Cloud Infrastructure');
      expect(text, l).toMatch(/Frankfurt|Франкфурт/);
      expect(text, l).toContain('Anthropic');
      expect(PRIVACY_TEXT[l].sections.some((s) => s.id === 'assistant'), l).toBe(true);
      for (const n of ['90', '365', '30']) expect(text, `${l} ${n}`).toContain(n);
    }
    // the statement must not claim there is no third party
    expect(JSON.stringify(PRIVACY_TEXT.en)).toMatch(/outside Uzbekistan/);
  });
  it('the contact address is the placeholder and is marked as to be confirmed', () => {
    expect(PRIVACY_CONTACT).toBe('privacy@davrabox.uz');
    for (const l of LANGS) {
      const body = JSON.stringify([PRIVACY_TEXT[l], TERMS_TEXT[l]]);
      expect(body, l).toContain(PRIVACY_CONTACT);
    }
    expect(JSON.stringify(PRIVACY_TEXT.en)).toMatch(/privacy@davrabox\.uz \(to be confirmed/);
    expect(JSON.stringify(PRIVACY_TEXT.ru)).toMatch(/privacy@davrabox\.uz \(уточняется/);
    expect(JSON.stringify(PRIVACY_TEXT.uz)).toMatch(/privacy@davrabox\.uz \(aniqlanadi/);
  });
});

describe('PrivacyPage', () => {
  it.each(LANGS)('renders the privacy notice in %s, one h1 and labelled sections', (lang) => {
    render(<PrivacyPage kind="privacy" initialLang={lang} />);
    const doc = PRIVACY_TEXT[lang];
    expect(screen.getByRole('heading', { level: 1, name: doc.title })).toBeTruthy();
    expect(screen.getAllByRole('heading', { level: 1 }).length).toBe(1);
    expect(screen.getAllByRole('heading', { level: 2 }).length).toBeGreaterThanOrEqual(doc.sections.length);
    expect(document.documentElement.lang).toBe(lang);
    expect(document.title).toContain(doc.title);
    const main = screen.getByRole('main');
    expect(within(main).getAllByRole('region').length).toBe(doc.sections.length);
  });
  it('renders the terms and links to the privacy notice and back to the start page', () => {
    render(<PrivacyPage kind="terms" initialLang="en" />);
    expect(screen.getByRole('heading', { level: 1, name: TERMS_TEXT.en.title })).toBeTruthy();
    const links = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(links).toContain('/privacy');
    expect(links).toContain('/');
  });
  it('switches the language without leaving the page and remembers it', () => {
    render(<PrivacyPage kind="privacy" initialLang="en" />);
    fireEvent.click(screen.getByTestId('settings'));
    pickOption('Language', 'ru');
    expect(screen.getByRole('heading', { level: 1, name: PRIVACY_TEXT.ru.title })).toBeTruthy();
    expect(localStorage.getItem('lang')).toBe('ru');
  });
});

describe('sign-in screen', () => {
  it('links to the privacy notice and the terms', () => {
    render(<SignInScreen lang="en" onLang={vi.fn()} theme="light" onTheme={vi.fn()} onSignIn={vi.fn()} />);
    const nav = screen.getByRole('navigation', { name: dictionaries.en.privLegalNav });
    expect(within(nav).getByRole('link', { name: dictionaries.en.privLinkPrivacy }).getAttribute('href')).toBe('/privacy');
    expect(within(nav).getByRole('link', { name: dictionaries.en.privLinkTerms }).getAttribute('href')).toBe('/terms');
  });
});

describe('admin privacy helpers', () => {
  it('the typed confirmation must equal the e-mail address, ignoring case and surrounding spaces, and never an empty string', () => {
    expect(confirmMatches(' Ann@Example.com ', 'ann@example.com')).toBe(true);
    expect(confirmMatches('ann@example.co', 'ann@example.com')).toBe(false);
    expect(confirmMatches('', '')).toBe(false);
    expect(confirmMatches('ann', 'ann@example.com')).toBe(false);
  });
  it('knows a tombstone', () => {
    expect(isErased({ email: ERASED_EMAIL })).toBe(true);
    expect(isErased({ email: 'a@b.c' })).toBe(false);
  });
  it('maps failures to messages that tell the admin what to do', () => {
    expect(privacyErrorKey(new ApiError(409, ''))).toBe('admPrivErrConflict');
    expect(privacyErrorKey(new ApiError(502, ''))).toBe('admPrivErrUpstream');
    expect(privacyErrorKey(new ApiError(410, ''))).toBe('admPrivErrGone');
    expect(privacyErrorKey(new ApiError(429, ''))).toBe('errTooMany');
    expect(privacyErrorKey(new ApiError(400, ''))).toBe('admPrivErrMismatch');
    expect(privacyErrorKey(new Error('x'))).toBe('errGeneric');
  });
});

describe('admin client', () => {
  function fakeFetch(responses: Array<{ status?: number; body?: unknown; headers?: Record<string, string> }>) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fn = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const r = responses.shift() ?? { status: 200, body: {} };
      return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'Content-Type': 'application/json', ...(r.headers ?? {}) } });
    });
    return { fn, calls };
  }
  it('exports through fetch (bearer token) and erases with the confirmation in the body', async () => {
    const f = fakeFetch([{ body: { format: 'x' }, headers: { 'Content-Disposition': 'attachment; filename="davrabox-export-u1.json"' } }, { body: { status: 'erased', alreadyErased: false } }]);
    const c = createAdminClient(async () => 'tok', f.fn);
    const out = await c.exportUserData('u 1');
    expect(out.filename).toBe('davrabox-export-u1.json');
    expect(JSON.parse(await out.blob.text())).toEqual({ format: 'x' });
    expect((await c.eraseUser('u 1', 'a@b.c')).status).toBe('erased');
    expect(f.calls.map((x) => `${x.init?.method ?? 'GET'} ${x.url}`)).toEqual(['GET /api/v1/admin/users/u%201/export', 'DELETE /api/v1/admin/users/u%201']);
    expect((f.calls[0]!.init!.headers as Record<string, string>)['Authorization']).toBe('Bearer tok');
    expect(JSON.parse(f.calls[1]!.init!.body as string)).toEqual({ confirm: 'a@b.c' });
  });
});

describe('Privacy section of the admin console', () => {
  const users: AdminUser[] = [
    { id: 'u1', email: 'ann@example.com', displayName: 'Ann', role: 'member', department: null, disabled: false, createdAt: '2026-11-01T00:00:00Z' },
    { id: 'u2', email: ERASED_EMAIL, displayName: 'Erased user', role: 'member', department: null, disabled: true, createdAt: '2026-11-01T00:00:00Z' },
  ];
  function setup(over: Partial<Record<'eraseUser' | 'exportUserData', ReturnType<typeof vi.fn>>> = {}) {
    const client = {
      listUsers: vi.fn(async () => ({ items: users, next: null })),
      exportUserData: over.exportUserData ?? vi.fn(async () => ({ blob: new Blob(['{}']), filename: 'e.json' })),
      eraseUser: over.eraseUser ?? vi.fn(async () => ({ status: 'erased', alreadyErased: false })),
    } as unknown as AdminClient;
    const save = vi.fn();
    const report = (e: unknown) => privacyErrorKey(e) as Key;
    render(
      <AdminCtx.Provider value={{ client, lang: 'en', report }}>
        <Privacy save={save} />
      </AdminCtx.Provider>,
    );
    return { client: client as unknown as Record<string, ReturnType<typeof vi.fn>>, save };
  }

  it('exports a person and hands the file to the browser', async () => {
    const { client, save } = setup();
    fireEvent.click(await screen.findByRole('button', { name: /Export data: ann@example.com/ }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(client.exportUserData).toHaveBeenCalledWith('u1');
    expect(save.mock.calls[0]![1]).toBe('e.json');
  });

  it('shows an erased account as erased and offers no action for it', async () => {
    setup();
    await screen.findByText('ann@example.com');
    const row = screen.getByText(ERASED_EMAIL).closest('tr')!;
    expect(within(row).getByText('Erased')).toBeTruthy();
    expect(within(row).queryAllByRole('button').length).toBe(0);
  });

  it('erasure needs the typed e-mail address: the button stays disabled until it matches, then calls the API once', async () => {
    const { client } = setup();
    fireEvent.click(await screen.findByRole('button', { name: /Erase: ann@example.com/ }));
    const dialog = await screen.findByRole('dialog');
    const go = within(dialog).getByRole('button', { name: dictionaries.en.admPrivEraseGo }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    const input = within(dialog).getByLabelText(/type the e-mail address/i);
    fireEvent.change(input, { target: { value: 'ann@example' } });
    expect(go.disabled).toBe(true);
    fireEvent.click(go);
    expect(client.eraseUser).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: 'Ann@Example.com' } });
    expect(go.disabled).toBe(false);
    fireEvent.click(go);
    await waitFor(() => expect(client.eraseUser).toHaveBeenCalledTimes(1));
    expect(client.eraseUser).toHaveBeenCalledWith('u1', 'Ann@Example.com');
    await waitFor(() => expect(screen.getByText(/was erased/)).toBeTruthy());
    // the row now shows the tombstone: the address is gone from the page
    expect(screen.queryByText('ann@example.com')).toBeNull();
    expect(screen.getAllByText('Erased').length).toBe(2);
  });

  it('the last-admin refusal is explained and the dialog stays open for another try', async () => {
    const eraseUser = vi.fn(async () => {
      throw new ApiError(409, 'the last organization admin cannot be erased');
    });
    setup({ eraseUser });
    fireEvent.click(await screen.findByRole('button', { name: /Erase: ann@example.com/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/type the e-mail address/i), { target: { value: 'ann@example.com' } });
    fireEvent.click(within(dialog).getByRole('button', { name: dictionaries.en.admPrivEraseGo }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(dictionaries.en.admPrivErrConflict);
    expect(screen.queryByRole('dialog')).toBeTruthy();
  });
});

describe('PrivacyPage: Back button', () => {
  it('goes back in the history when there is one, and to the application when the page was opened directly', () => {
    const back = vi.spyOn(history, 'back').mockImplementation(() => undefined);
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    render(<PrivacyPage kind="privacy" initialLang="en" />);
    Object.defineProperty(history, 'length', { value: 3, configurable: true });
    fireEvent.click(screen.getByTestId('legal-back'));
    expect(back).toHaveBeenCalledTimes(1);
    expect(assign).not.toHaveBeenCalled();
    Object.defineProperty(history, 'length', { value: 1, configurable: true });
    fireEvent.click(screen.getByTestId('legal-back'));
    expect(assign).toHaveBeenCalledWith('/app');
    vi.unstubAllGlobals();
    back.mockRestore();
  });
});
