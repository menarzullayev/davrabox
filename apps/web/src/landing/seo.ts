import type { Lang } from '../i18n';

const LANGS: Lang[] = ['uz', 'ru', 'en'];

/** Language URLs of the landing page: the page renders the language named by ?lang= (see detectLang). */
export function languageUrl(origin: string, lang: Lang): string {
  return `${origin}/?lang=${lang}`;
}

/** schema.org description of the product and its publisher, built only from facts the page itself states. */
export function structuredData(origin: string, name: string, description: string, lang: Lang): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebSite', '@id': `${origin}/#site`, url: `${origin}/`, name, inLanguage: lang },
      {
        '@type': 'SoftwareApplication',
        '@id': `${origin}/#app`,
        name,
        description,
        url: `${origin}/`,
        applicationCategory: 'BusinessApplication',
        operatingSystem: 'Web',
        inLanguage: LANGS,
      },
    ],
  };
}

/** Adds (or refreshes) the canonical, hreflang alternates and JSON-LD of the landing page. Idempotent. Returns a cleanup. */
export function applyLandingSeo(doc: Document, origin: string, lang: Lang, name: string, description: string): () => void {
  const added: Element[] = [];
  const add = (el: Element) => {
    doc.head.appendChild(el);
    added.push(el);
  };
  const link = (rel: string, href: string, hreflang?: string) => {
    const el = doc.createElement('link');
    el.rel = rel;
    el.href = href;
    if (hreflang) el.hreflang = hreflang;
    el.dataset.seo = 'landing';
    add(el);
  };
  link('canonical', languageUrl(origin, lang));
  for (const l of LANGS) link('alternate', languageUrl(origin, l), l);
  link('alternate', `${origin}/`, 'x-default');
  const s = doc.createElement('script');
  s.type = 'application/ld+json';
  s.dataset.seo = 'landing';
  s.textContent = JSON.stringify(structuredData(origin, name, description, lang));
  add(s);
  return () => added.forEach((e) => e.remove());
}
