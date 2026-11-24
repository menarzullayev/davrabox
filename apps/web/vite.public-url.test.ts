import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyPublicUrl, normalizePublicUrl } from './vite.public-url';

describe('VITE_PUBLIC_URL (critic D-17)', () => {
  it('defaults to empty, which makes the og:image path relative', () => {
    expect(normalizePublicUrl(undefined)).toBe('');
    expect(normalizePublicUrl('  ')).toBe('');
  });
  it('accepts an http(s) origin and drops trailing slashes', () => {
    expect(normalizePublicUrl('https://example.test/')).toBe('https://example.test');
    expect(normalizePublicUrl('https://example.test/base///')).toBe('https://example.test/base');
  });
  it('refuses anything that is not a plain http(s) URL', () => {
    expect(() => normalizePublicUrl('javascript:alert(1)')).toThrow(/VITE_PUBLIC_URL/);
    expect(() => normalizePublicUrl('example.test')).toThrow(/VITE_PUBLIC_URL/);
    expect(() => normalizePublicUrl('https://a.test/"><script>')).toThrow(/VITE_PUBLIC_URL/);
  });
  it('replaces every placeholder in the page', () => {
    const html = '<meta content="%DAVRA_PUBLIC_URL%/brand/a.png"><meta content="%DAVRA_PUBLIC_URL%/b">';
    expect(applyPublicUrl(html, '')).toBe('<meta content="/brand/a.png"><meta content="/b">');
    expect(applyPublicUrl(html, 'https://x.test')).toBe('<meta content="https://x.test/brand/a.png"><meta content="https://x.test/b">');
  });
  it('index.html carries the placeholder, not a hard-coded host', () => {
    const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
    expect(html).toContain('%DAVRA_PUBLIC_URL%/brand/social-preview.png');
    expect(html).not.toMatch(/https?:\/\/davrabox\.bugvector\.uz/);
  });
});
