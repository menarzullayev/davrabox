import { avatarPalette } from '@davrabox/design-tokens';
import { describe, expect, it } from 'vitest';
import { avatarColor, hashId, initials } from './Avatar';

describe('avatar colour mapping', () => {
  it('is stable for the same id and always inside the palette', () => {
    expect(avatarColor('user-1')).toEqual(avatarColor('user-1'));
    for (const id of ['', 'a', 'user-1', 'ЮСУПОВА', 'o‘ktam', 'x'.repeat(500)]) {
      expect(avatarPalette).toContainEqual(avatarColor(id));
    }
  });
  it('spreads ids over the palette (every colour is reachable)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) seen.add(avatarColor(`id-${i}`).bg);
    expect(seen.size).toBe(avatarPalette.length);
  });
  it('hash matches known FNV-1a vectors', () => {
    expect(hashId('')).toBe(0x811c9dc5);
    expect(hashId('a')).toBe(0xe40c292c);
    expect(hashId('foobar')).toBe(0xbf9cf968);
  });
});

describe('initials', () => {
  it('takes the first letters of the first and last word', () => {
    expect(initials('Aziza Karimova')).toBe('AK');
    expect(initials('  bobur  ')).toBe('B');
    expect(initials('Anna Maria van Dijk')).toBe('AD');
    expect(initials('Дилноза Юсупова')).toBe('ДЮ');
  });
  it('keeps Uzbek modifier apostrophes out of the way', () => {
    expect(initials('O‘ktam G‘ulomov')).toBe('OG');
    expect(initials('ʻAbdulla')).toBe('A');
  });
  it('falls back to ? for empty or symbol-only names and keeps combining marks', () => {
    expect(initials('')).toBe('?');
    expect(initials('   ')).toBe('?');
    expect(initials('--- !!!')).toBe('?');
    expect(initials('émile')).toBe('É');
  });
});
