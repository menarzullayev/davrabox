// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dictionaries, type Lang } from '../i18n';
import { HELP } from '../help/content';
import { parseManifest, sizeMb } from './downloads';
import { lnMoreEn, lnMoreRu, lnMoreUz } from './i18n-landing-more';
import { MENU, PRICING_LINK, REPO_URL } from './menu';
import { MegaMenu, MenuSheet } from './sections/MegaMenu';
import { DEMOS, Demos, Downloads, Pricing, TRUST, Trust } from './sections/More';

const SHA = 'a'.repeat(64);
const RUN = `${REPO_URL}/actions/runs/45838432442`;
const good = {
  items: [
    { platform: 'android', file: 'davrabox-0.1.0-beta.apk', url: '/downloads/davrabox-0.1.0-beta.apk', size: 3_805_566, sha256: SHA, version: '0.1.0-beta', commit: 'e5ac17d0', runUrl: RUN, builtAt: '2026-11-26T14:22:56Z' },
    { platform: 'windows', file: 'DavraBox-Setup-0.1.0.exe', url: '/downloads/DavraBox-Setup-0.1.0.exe', size: 98_000_000, sha256: SHA.replace(/a/g, 'b'), version: '0.1.0', commit: '329f9ce', runUrl: RUN, builtAt: '2026-11-26T14:22:56Z' },
  ],
};

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe('landing package dictionaries', () => {
  it('has the same keys in uz, ru and en, all non-empty', () => {
    const keys = Object.keys(lnMoreUz).sort();
    expect(Object.keys(lnMoreRu).sort()).toEqual(keys);
    expect(Object.keys(lnMoreEn).sort()).toEqual(keys);
    for (const d of [lnMoreUz, lnMoreRu, lnMoreEn]) for (const k of keys) expect((d as Record<string, string>)[k]!.trim(), k).not.toBe('');
  });

  it('every menu label and description exists in every language', () => {
    for (const lang of ['uz', 'ru', 'en'] as Lang[]) {
      for (const it of [...MENU.flatMap((g) => g.items), PRICING_LINK]) {
        expect(dictionaries[lang][it.title], `${lang}.${it.title}`).toBeTruthy();
        expect(dictionaries[lang][it.desc], `${lang}.${it.desc}`).toBeTruthy();
      }
    }
  });
});

describe('mega-menu (desktop)', () => {
  it('opens one panel at a time, each link with a description, and closes with Escape returning focus', () => {
    render(<MegaMenu lang="en" />);
    const product = screen.getByTestId('menu-trigger-product');
    const resources = screen.getByTestId('menu-trigger-resources');
    expect(product.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(product);
    expect(product.getAttribute('aria-expanded')).toBe('true');
    const panel = document.getElementById(product.getAttribute('aria-controls')!)!;
    expect(panel.hidden).toBe(false);
    const links = within(panel).getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toEqual(MENU[0]!.items.map((i) => i.href));
    expect(within(panel).getByText('Encryption, audit and facts you can check')).toBeTruthy();
    fireEvent.click(resources);
    expect(product.getAttribute('aria-expanded')).toBe('false');
    expect(resources.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(resources.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(resources);
  });

  it('closes on a click outside and when a link is followed; the external docs link opens a new tab', () => {
    render(
      <div>
        <MegaMenu lang="en" />
        <p>outside</p>
      </div>,
    );
    const resources = screen.getByTestId('menu-trigger-resources');
    fireEvent.click(resources);
    const docs = screen.getByTestId('menu-docs');
    expect(docs.getAttribute('target')).toBe('_blank');
    expect(docs.getAttribute('rel')).toContain('noopener');
    fireEvent.pointerDown(screen.getByText('outside'));
    expect(resources.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(resources);
    fireEvent.click(screen.getByTestId('menu-help'));
    expect(resources.getAttribute('aria-expanded')).toBe('false');
  });

  it('pricing is a plain link', () => {
    render(<MegaMenu lang="ru" />);
    const a = screen.getByTestId('menu-pricing');
    expect(a.tagName).toBe('A');
    expect(a.getAttribute('href')).toBe('/#pricing');
    expect(a.textContent).toBe('Тарифы');
  });
});

describe('menu sheet (narrow screens)', () => {
  it('is a modal dialog with every group, closes with Escape and gives focus back to the menu button', async () => {
    render(<MenuSheet lang="uz" />);
    const open = screen.getByTestId('menu-open');
    fireEvent.click(open);
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const hrefs = within(dialog).getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual([...MENU.flatMap((g) => g.items.map((i) => i.href)), PRICING_LINK.href]);
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(open));
    expect(document.body.style.overflow).toBe('');
  });
});

describe('pricing', () => {
  it('shows trial, Business and Enterprise; the trial lists the real limits, paid plans say "Contact us"', () => {
    render(<Pricing lang="en" />);
    const plans = screen.getAllByTestId('plan');
    expect(plans.map((p) => p.getAttribute('data-plan'))).toEqual(['trial', 'business', 'enterprise']);
    const trial = plans[0]!;
    // the trial limits of apps/api/src/signup/limits.ts (TRIAL = 7 days, 10 participants, 30 minutes) and the 25 MB file cap
    expect(trial.textContent).toMatch(/7 days/);
    expect(trial.textContent).toMatch(/Up to 10 participants/);
    expect(trial.textContent).toMatch(/up to 30 minutes/);
    expect(trial.textContent).toMatch(/25 MB/);
    expect(within(trial).getByRole('link', { name: 'Start free' }).getAttribute('href')).toBe('/app/signup');
    for (const p of plans.slice(1)) {
      const a = within(p).getByRole('link', { name: 'Contact us' });
      expect(a.getAttribute('href')).toMatch(/^mailto:hello@davrabox\.uz\?subject=/);
      expect(p.textContent).toMatch(/Price on agreement/);
      expect(p.textContent).not.toMatch(/\$|сум|so‘m|\d+\s?(participants|accounts)/);
    }
  });
});

describe('trust facts', () => {
  it('lists six facts, each with an evidence link to the public repository opening in a new tab', () => {
    render(<Trust lang="en" />);
    const facts = screen.getAllByTestId('trust-fact');
    expect(facts).toHaveLength(TRUST.length);
    for (const f of facts) {
      const a = within(f).getByRole('link');
      expect(a.getAttribute('href')!.startsWith(REPO_URL)).toBe(true);
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.textContent).toMatch(/opens on GitHub/);
    }
  });
});

describe('demo clips', () => {
  it('four silent, looping clips that load nothing until they are near the viewport, each with a pause control', () => {
    render(<Demos lang="en" />);
    const cards = screen.getAllByTestId('demo');
    expect(cards).toHaveLength(DEMOS.length);
    for (const c of cards) {
      const v = c.querySelector('video')!;
      expect(v.muted).toBe(true);
      expect(v.loop).toBe(true);
      expect(v.getAttribute('preload')).toBe('none');
      expect(v.getAttribute('src')).toBeNull();
      expect(v.getAttribute('poster')).toMatch(/^\/landing\/demo\/.+\.webp$/);
    }
    const toggle = screen.getByTestId('demo-toggle-join');
    const before = toggle.getAttribute('aria-pressed');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).not.toBe(before);
  });
});

describe('downloads', () => {
  it('parseManifest keeps only well-formed entries served from /downloads/ and tied to a CI run of this repository', () => {
    expect(parseManifest(good)).toHaveLength(2);
    expect(parseManifest(null)).toEqual([]);
    expect(parseManifest({ items: 'x' })).toEqual([]);
    const bad = (patch: Record<string, unknown>) => parseManifest({ items: [{ ...good.items[0], ...patch }] });
    expect(bad({ url: 'https://evil.example/x.apk' })).toEqual([]);
    expect(bad({ file: '../x.apk', url: '/downloads/../x.apk' })).toEqual([]);
    expect(bad({ file: 'x.exe', url: '/downloads/x.exe' })).toEqual([]); // wrong extension for android
    expect(bad({ sha256: 'zz' })).toEqual([]);
    expect(bad({ runUrl: 'https://github.com/someone/else/actions/runs/1' })).toEqual([]);
    expect(bad({ size: -1 })).toEqual([]);
    expect(bad({ commit: 'not-a-sha' })).toEqual([]);
    expect(parseManifest({ items: [good.items[0], { ...good.items[0], file: 'b.apk', url: '/downloads/b.apk' }] })).toHaveLength(1);
  });

  it('shows the files with size, CI build link, SHA-256 and the unsigned-beta warning with the install guides', async () => {
    render(<Downloads lang="en" fetchManifest={() => Promise.resolve(good)} />);
    const android = await screen.findByTestId('download-link-android');
    expect(android.getAttribute('href')).toBe('/downloads/davrabox-0.1.0-beta.apk');
    expect(android.getAttribute('download')).toBe('davrabox-0.1.0-beta.apk');
    expect(screen.getByTestId('sha-android').textContent).toBe(SHA);
    const card = screen.getByTestId('download-android');
    expect(card.textContent).toContain(`${sizeMb(3_805_566, 'en')} MB`);
    expect(within(card).getByRole('link', { name: /CI build e5ac17d/ }).getAttribute('href')).toBe(RUN);
    const warn = screen.getByTestId('beta-warning');
    expect(warn.textContent).toMatch(/not signed yet/);
    const guide = within(warn).getByRole('link', { name: 'Android install guide' }).getAttribute('href')!;
    const verify = within(warn).getByRole('link', { name: 'How to check the SHA-256' }).getAttribute('href')!;
    expect(HELP.guides.some((g) => guide === `/help#guide-${g.id}`)).toBe(true);
    expect(HELP.faq.some((e) => verify === `/help#faq-${e.id}`)).toBe(true);
  });

  it('says so when no files are published (manifest missing), never shows a dead link', async () => {
    render(<Downloads lang="uz" fetchManifest={() => Promise.reject(new Error('404'))} />);
    await waitFor(() => expect(screen.getAllByText(dictionaries.uz.lnDlUnavailable)).toHaveLength(2));
    expect(screen.queryByTestId('download-link-android')).toBeNull();
    await act(async () => undefined);
  });

  it('copies the checksum', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    render(<Downloads lang="en" fetchManifest={() => Promise.resolve(good)} />);
    const card = await screen.findByTestId('download-windows');
    fireEvent.click(within(card).getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('b'.repeat(64));
    await within(card).findByRole('button', { name: 'Copied' });
  });
});
