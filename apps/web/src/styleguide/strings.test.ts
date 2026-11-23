import { describe, expect, it } from 'vitest';
import { sgDictionaries } from './strings';

describe('styleguide strings', () => {
  const keys = Object.keys(sgDictionaries.uz).sort();
  it.each(['ru', 'en'] as const)('%s has exactly the same keys as uz', (lang) => {
    expect(Object.keys(sgDictionaries[lang]).sort()).toEqual(keys);
  });
  it.each(['uz', 'ru', 'en'] as const)('%s has no empty strings', (lang) => {
    for (const [k, v] of Object.entries(sgDictionaries[lang])) expect(v.trim(), `${lang}.${k}`).not.toBe('');
  });
});
