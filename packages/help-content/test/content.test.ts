import { describe, expect, it } from 'vitest';
import content from '../faq.json' with { type: 'json' };
import { faqAsText, isConfident, searchFaq, tokenize, type HelpContent } from '../search.mjs';

const help = content as HelpContent;
const LANGS = ['uz', 'ru', 'en'] as const;

describe('help content', () => {
  it('every FAQ entry and guide is complete in uz, ru and en', () => {
    const ids = new Set<string>();
    const cats = new Set(help.categories.map((c) => c.id));
    for (const e of help.faq) {
      expect(ids.has(e.id), e.id).toBe(false);
      ids.add(e.id);
      expect(cats.has(e.cat), `${e.id} category`).toBe(true);
      for (const l of LANGS) {
        expect(e[l].q.trim().length, `${e.id}.${l}.q`).toBeGreaterThan(5);
        expect(e[l].a.trim().length, `${e.id}.${l}.a`).toBeGreaterThan(20);
        expect(e[l].k.trim().length, `${e.id}.${l}.k`).toBeGreaterThan(2);
      }
    }
    for (const g of help.guides) {
      const n = g.en.steps.length;
      for (const l of LANGS) {
        expect(g[l].title.trim(), `${g.id}.${l}`).not.toBe('');
        expect(g[l].steps.length, `${g.id}.${l} steps`).toBe(n);
      }
    }
    for (const c of help.categories) for (const l of LANGS) expect(c[l].trim()).not.toBe('');
  });

  it('every category is used', () => {
    for (const c of help.categories) expect(help.faq.some((e) => e.cat === c.id), c.id).toBe(true);
  });
});

describe('tokenize', () => {
  it('folds case, apostrophes and ё, and drops stop words', () => {
    expect(tokenize('Qo‘shilish QANDAY?')).toEqual(['qoshilish']);
    expect(tokenize("Qo'shilish")).toEqual(['qoshilish']);
    expect(tokenize('Ещё ёлка')).toEqual(['еще', 'елка']);
    expect(tokenize('How do I join?')).toEqual(['join']);
  });
});

describe('searchFaq', () => {
  const top = (lang: (typeof LANGS)[number], q: string) => searchFaq(help, lang, q)[0];

  it.each([
    ['uz', 'kamera ishlamayapti', 'camera-mic'],
    ['uz', 'Android telefonga qanday o‘rnataman', 'android'],
    ['uz', 'parolni unutdim', 'password-reset'],
    ['ru', 'не работает микрофон', 'camera-mic'],
    ['ru', 'как установить на андроид apk', 'android'],
    ['ru', 'сколько стоит тариф', 'pricing'],
    ['en', 'I forgot my password', 'password-reset'],
    ['en', 'how to share screen', 'screen-share'],
    ['en', 'windows smartscreen warning', 'windows'],
    ['en', 'where is data stored', 'data-location'],
  ] as const)('%s "%s" finds %s', (lang, q, id) => {
    const hit = top(lang, q);
    expect(hit?.id).toBe(id);
    expect(isConfident(hit)).toBe(true);
  });

  it('an off-topic question has no confident answer', () => {
    expect(isConfident(top('en', 'give me a recipe for plov with lamb'))).toBe(false);
    expect(isConfident(top('ru', 'напиши стихотворение про осень'))).toBe(false);
    expect(searchFaq(help, 'en', '   ')).toEqual([]);
  });

  it('faqAsText lists every entry in a stable order', () => {
    const text = faqAsText(help, 'en');
    expect(text.split('\n\nQ: ').length).toBe(help.faq.length);
    expect(text).toBe(faqAsText(help, 'en'));
  });
});
