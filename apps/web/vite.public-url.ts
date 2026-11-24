import type { Plugin } from 'vite';

/**
 * Build-time public origin (VITE_PUBLIC_URL), used for absolute URLs that crawlers read from index.html (og:image).
 * Empty (the default) keeps them relative to the host that serves the page.
 */
export function normalizePublicUrl(raw: string | undefined): string {
  const v = (raw ?? '').trim();
  if (v === '') return '';
  // A plain http(s) URL only: no quotes, angle brackets or whitespace can reach the HTML attribute.
  if (!/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~%/-]*)?$/.test(v)) {
    throw new Error(`VITE_PUBLIC_URL must be an http(s) URL without query or fragment, got: ${v}`);
  }
  return v.replace(/\/+$/, '');
}

export function applyPublicUrl(html: string, base: string): string {
  return html.split('%DAVRA_PUBLIC_URL%').join(base);
}

export function publicUrlPlugin(raw: string | undefined): Plugin {
  const base = normalizePublicUrl(raw);
  return { name: 'davrabox-public-url', transformIndexHtml: { order: 'pre', handler: (html) => applyPublicUrl(html, base) } };
}
