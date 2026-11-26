import { describe, expect, it } from 'vitest';
import { initialWindowSize, parseThemeMessage } from '../src/window';

describe('main window helpers', () => {
  it('opens at 1280x800 on a roomy screen and fits smaller work areas without going under the minimum', () => {
    expect(initialWindowSize({ width: 1920, height: 1032 })).toEqual({ width: 1280, height: 800 });
    expect(initialWindowSize({ width: 1366, height: 728 })).toEqual({ width: 1229, height: 655 });
    expect(initialWindowSize({ width: 800, height: 600 })).toEqual({ width: 800, height: 560 });
  });
  it('accepts only light or dark from the page', () => {
    expect(parseThemeMessage('light')).toBe('light');
    expect(parseThemeMessage('dark')).toBe('dark');
    for (const bad of ['system', '', null, undefined, 1, { theme: 'dark' }, 'DARK']) expect(parseThemeMessage(bad)).toBeNull();
  });
});
