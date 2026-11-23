import { describe, expect, it } from 'vitest';
import {
  NON_TEXT_MIN,
  TEXT_MIN,
  avatarPalette,
  contrast,
  cssName,
  failingPairs,
  legacyAliases,
  luminance,
  nonTextPairs,
  scales,
  textPairs,
  themes,
  type ThemeName,
} from './tokens.js';

const names = Object.keys(themes) as ThemeName[];

describe('design tokens meet WCAG 2.1 AA in both themes', () => {
  for (const theme of names) {
    it(`${theme}: all ${textPairs.length} text pairs reach ${TEXT_MIN}:1`, () => {
      expect(failingPairs(themes[theme], textPairs, TEXT_MIN)).toEqual([]);
    });
    it(`${theme}: all ${nonTextPairs.length} focus ring / control border / glow pairs reach ${NON_TEXT_MIN}:1`, () => {
      expect(failingPairs(themes[theme], nonTextPairs, NON_TEXT_MIN)).toEqual([]);
    });
  }
  it('avatar initials reach 4.5:1 on every avatar colour', () => {
    for (const { bg, fg } of avatarPalette) expect(contrast(fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(TEXT_MIN);
  });
});

describe('negative tests: the check really fails on bad pairs', () => {
  it('reports a muted text colour that equals the surface', () => {
    const bad = { ...themes.dark, textMuted: themes.dark.surface1 };
    const fails = failingPairs(bad, textPairs, TEXT_MIN);
    expect(fails.length).toBeGreaterThan(0);
    expect(fails.some((f) => f.fg === 'textMuted' && f.bg === 'surface1')).toBe(true);
  });
  it('reports a focus ring that is too close to the canvas', () => {
    const bad = { ...themes.light, focusRing: '#e0e3f5' };
    const fails = failingPairs(bad, nonTextPairs, NON_TEXT_MIN);
    expect(fails.some((f) => f.fg === 'focusRing')).toBe(true);
  });
  it('the 4.5 boundary: #767676 on white passes, #777777 on white fails', () => {
    expect(contrast('#767676', '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#777777', '#ffffff')).toBeLessThan(4.5);
  });
  it('rejects values that are not 6-hex-character colours (alpha or names would silently skew the maths)', () => {
    expect(() => luminance('red')).toThrow();
    expect(() => luminance('#fff')).toThrow();
    expect(() => luminance('#ffffff80')).toThrow();
  });
});

describe('structure', () => {
  it('contrast helper is correct for black on white (21:1) and symmetric', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#123456', '#fedcba')).toBe(contrast('#fedcba', '#123456'));
  });
  it('both themes define the same token names', () => {
    expect(Object.keys(themes.light).sort()).toEqual(Object.keys(themes.dark).sort());
  });
  it('every colour is a 6-character hex value', () => {
    for (const t of names) for (const [k, v] of Object.entries(themes[t])) expect(v, `${t}.${k}`).toMatch(/^#[0-9a-f]{6}$/);
  });
  it('motion stays inside the 150-400 ms brief', () => {
    for (const v of Object.values(scales.duration)) {
      const ms = parseInt(v, 10);
      expect(ms).toBeGreaterThanOrEqual(150);
      expect(ms).toBeLessThanOrEqual(400);
    }
  });
  it('cssName makes readable custom property names', () => {
    expect(cssName('surface1')).toBe('surface-1');
    expect(cssName('textOnAccent')).toBe('text-on-accent');
    expect(cssName('accent')).toBe('accent');
  });
  it('legacy aliases point at tokens that exist', () => {
    const all = new Set(Object.keys(themes.dark).map(cssName));
    for (const target of Object.values(legacyAliases)) expect(all.has(target), target).toBe(true);
  });
});
