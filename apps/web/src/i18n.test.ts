import { describe, expect, it } from 'vitest';
import { dictionaries } from './i18n';

describe('i18n dictionaries', () => {
  const keys = Object.keys(dictionaries.uz).sort();
  it.each(['ru', 'en'] as const)('%s has exactly the same keys as uz', (lang) => {
    expect(Object.keys(dictionaries[lang]).sort()).toEqual(keys);
  });
  it.each(['uz', 'ru', 'en'] as const)('%s has no empty strings', (lang) => {
    for (const [k, v] of Object.entries(dictionaries[lang])) expect(v.trim(), `${lang}.${k}`).not.toBe('');
  });
});
