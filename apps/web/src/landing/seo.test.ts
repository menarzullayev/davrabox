// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { applyLandingSeo, languageUrl, structuredData } from './seo';
import { detectLang } from '../i18n';

describe('landing SEO', () => {
  afterEach(() => {
    document.head.innerHTML = '';
    localStorage.clear();
    history.replaceState({}, '', '/');
  });

  it('adds a canonical, one alternate per language and x-default', () => {
    applyLandingSeo(document, 'https://example.uz', 'ru', 'DavraBox', 'desc');
    expect(document.querySelector('link[rel=canonical]')?.getAttribute('href')).toBe('https://example.uz/?lang=ru');
    const alt = [...document.querySelectorAll('link[rel=alternate]')].map((l) => `${l.getAttribute('hreflang')}=${l.getAttribute('href')}`);
    expect(alt).toEqual(['uz=https://example.uz/?lang=uz', 'ru=https://example.uz/?lang=ru', 'en=https://example.uz/?lang=en', 'x-default=https://example.uz/']);
  });

  it('is idempotent: the cleanup removes everything it added', () => {
    const off = applyLandingSeo(document, 'https://example.uz', 'uz', 'DavraBox', 'desc');
    off();
    expect(document.head.children.length).toBe(0);
    applyLandingSeo(document, 'https://example.uz', 'uz', 'DavraBox', 'desc')();
    expect(document.head.children.length).toBe(0);
  });

  it('JSON-LD parses and states only what the page states', () => {
    applyLandingSeo(document, 'https://example.uz', 'en', 'DavraBox', 'A description');
    const data = JSON.parse(document.querySelector('script[type="application/ld+json"]')!.textContent!);
    const app = data['@graph'].find((g: { '@type': string }) => g['@type'] === 'SoftwareApplication');
    expect(app.name).toBe('DavraBox');
    expect(app.description).toBe('A description');
    expect(app.inLanguage).toEqual(['uz', 'ru', 'en']);
    expect(JSON.stringify(structuredData('https://x', 'n', 'd', 'uz'))).not.toMatch(/aggregateRating|offers|review/);
  });

  it('?lang= wins over the saved choice, and an unknown value is ignored', () => {
    localStorage.setItem('lang', 'en');
    history.replaceState({}, '', '/?lang=ru');
    expect(detectLang()).toBe('ru');
    history.replaceState({}, '', '/?lang=xx');
    expect(detectLang()).toBe('en');
    expect(languageUrl('https://a', 'uz')).toBe('https://a/?lang=uz');
  });
});
