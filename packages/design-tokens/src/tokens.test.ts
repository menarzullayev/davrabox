import { describe, expect, it } from 'vitest';
import { contrast, textPairs, themes, type ThemeName } from './tokens.js';

describe('design tokens meet WCAG 2.1 AA', () => {
  for (const theme of Object.keys(themes) as ThemeName[]) {
    for (const [fg, bg] of textPairs) {
      it(`${theme}: ${fg} on ${bg} >= 4.5:1`, () => {
        expect(contrast(themes[theme][fg], themes[theme][bg])).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
  it('contrast helper is correct for black on white (21:1)', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
  });
  it('both themes define the same token names', () => {
    expect(Object.keys(themes.light).sort()).toEqual(Object.keys(themes.dark).sort());
  });
});
