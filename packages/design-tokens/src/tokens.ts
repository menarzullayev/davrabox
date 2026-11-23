/** Single source of truth for DavraBox colours. Both themes must satisfy WCAG 2.1 AA (see tokens.test.ts). */
export const themes = {
  dark: {
    bg: '#0f1419',
    panel: '#1a212b',
    line: '#2b3542',
    text: '#e8edf3',
    muted: '#9aa7b8',
    accent: '#4c96ff',
    accentText: '#06101f',
    danger: '#ff6b70',
    dangerText: '#1a0405',
    success: '#3fc98a',
  },
  light: {
    bg: '#f6f8fb',
    panel: '#ffffff',
    line: '#d3dbe6',
    text: '#14202e',
    muted: '#4a5a6e',
    accent: '#0b5cd5',
    accentText: '#ffffff',
    danger: '#b3262d',
    dangerText: '#ffffff',
    success: '#13724a',
  },
} as const;

export type ThemeName = keyof typeof themes;
export type TokenName = keyof (typeof themes)['dark'];

/** Foreground/background pairs that carry text and must reach 4.5:1 (normal text). */
export const textPairs: ReadonlyArray<readonly [TokenName, TokenName]> = [
  ['text', 'bg'],
  ['text', 'panel'],
  ['muted', 'bg'],
  ['muted', 'panel'],
  ['accentText', 'accent'],
  ['dangerText', 'danger'],
];

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
