/**
 * Single source of truth for the DavraBox design tokens (docs/DESIGN.md).
 * Palette: deep night-indigo base, Samarkand turquoise (firuza) accent, amber/gold for emphasis only.
 * Dark is the default theme. Every text and control pairing below is checked against WCAG 2.1 AA in tokens.test.ts.
 *
 * Colour values are 6-digit hex on purpose: the contrast helpers need opaque colours. Semi-transparent values
 * (scrim, shadows) live in the `effects` group and never carry text.
 */

import { styleDefs } from './style-defs.js';

const dark = {
  // Surfaces: canvas < card < raised (popovers, dialogs) < interactive (hover, selected, input fill)
  bg: '#0a0d21',
  surface1: '#10142f',
  surface2: '#171c3d',
  surface3: '#20264d',
  videoBg: '#05060f',
  textOnVideo: '#eef0fc',
  // Text levels
  text: '#eef0fc',
  textMuted: '#b4b9de',
  textSubtle: '#9ca2cb',
  // Borders and focus
  border: '#2a3163',
  borderStrong: '#6f78b9',
  focusRing: '#7ee9df',
  // Samarkand turquoise
  accent: '#3dd6c8',
  accentHover: '#6fe5da',
  accentActive: '#2bb8ab',
  accentSoft: '#0e3a43',
  textOnAccent: '#04211f',
  // Amber / gold: raised hand, active speaker, primary call-to-action highlight
  gold: '#f4c24f',
  goldRing: '#f4c24f',
  goldFg: '#f4c24f',
  goldSoft: '#3b2f10',
  textOnGold: '#2b1d00',
  // Status
  success: '#46d392',
  successSoft: '#0d3326',
  textOnSuccess: '#04210f',
  warning: '#ff9f4a',
  warningSoft: '#3b2410',
  textOnWarning: '#2b1400',
  danger: '#ff6b7a',
  dangerHover: '#ff8d99',
  dangerSoft: '#3d1220',
  textOnDanger: '#2a0309',
  // Inverse surface (tooltips)
  inverseBg: '#e6e9fb',
  inverseText: '#10142f',
} as const;

type ThemeColours = { [K in keyof typeof dark]: string };

const light: ThemeColours = {
  bg: '#f4f5fb',
  surface1: '#ffffff',
  surface2: '#ffffff',
  surface3: '#eceef8',
  videoBg: '#05060f',
  textOnVideo: '#eef0fc',
  text: '#12163a',
  textMuted: '#454c7a',
  textSubtle: '#575e8c',
  border: '#d5d9ee',
  borderStrong: '#767ea9',
  focusRing: '#4e59d6',
  accent: '#087069',
  accentHover: '#06605a',
  accentActive: '#054d48',
  accentSoft: '#d6f2ee',
  textOnAccent: '#ffffff',
  gold: '#f2b42a',
  goldRing: '#a86f00',
  goldFg: '#7a4f00',
  goldSoft: '#fdf0cf',
  textOnGold: '#2b1d00',
  success: '#0e7449',
  successSoft: '#d8f3e6',
  textOnSuccess: '#ffffff',
  warning: '#955800',
  warningSoft: '#fdebd3',
  textOnWarning: '#ffffff',
  danger: '#b3202f',
  dangerHover: '#8f1824',
  dangerSoft: '#fbe0e4',
  textOnDanger: '#ffffff',
  inverseBg: '#171c3d',
  inverseText: '#eef0fc',
};

/** Non-colour, theme-dependent effects (may be semi-transparent; never carry text). */
const effects = {
  dark: {
    scrim: 'rgba(4, 6, 18, 0.72)',
    hoverOverlay: 'rgba(238, 240, 252, 0.06)',
    shadow1: '0 1px 2px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(111, 120, 185, 0.12)',
    shadow2: '0 6px 18px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(111, 120, 185, 0.16)',
    shadow3: '0 18px 48px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(111, 120, 185, 0.2)',
    glowGold: '0 0 0 3px rgba(244, 194, 79, 0.35), 0 0 22px rgba(244, 194, 79, 0.45)',
  },
  light: {
    scrim: 'rgba(18, 22, 58, 0.5)',
    hoverOverlay: 'rgba(18, 22, 58, 0.05)',
    shadow1: '0 1px 2px rgba(18, 22, 58, 0.1), 0 0 0 1px rgba(18, 22, 58, 0.05)',
    shadow2: '0 6px 18px rgba(18, 22, 58, 0.12), 0 0 0 1px rgba(18, 22, 58, 0.06)',
    shadow3: '0 18px 48px rgba(18, 22, 58, 0.2), 0 0 0 1px rgba(18, 22, 58, 0.08)',
    glowGold: '0 0 0 3px rgba(168, 111, 0, 0.3), 0 0 22px rgba(242, 180, 42, 0.5)',
  },
} as const;

export const themes: { dark: ThemeColours; light: ThemeColours } = { dark, light };
export const themeEffects = effects;

export type ThemeName = keyof typeof themes;
export type TokenName = keyof ThemeColours;

/** Theme-independent scales: spacing (4 px grid), radii, motion, stacking, type. Emitted once on :root. */
export const scales = {
  space: { 1: '4px', 2: '8px', 3: '12px', 4: '16px', 5: '20px', 6: '24px', 8: '32px', 10: '40px', 12: '48px', 16: '64px', 20: '80px' },
  radius: { xs: '4px', sm: '6px', md: '10px', lg: '14px', xl: '20px', pill: '999px' },
  /** Calm, 150-400 ms (docs/DESIGN.md). */
  duration: { 1: '150ms', 2: '220ms', 3: '320ms', 4: '400ms' },
  ease: {
    standard: 'cubic-bezier(0.2, 0, 0, 1)',
    out: 'cubic-bezier(0.16, 1, 0.3, 1)',
    inOut: 'cubic-bezier(0.65, 0, 0.35, 1)',
  },
  z: { base: '0', sticky: '100', dropdown: '200', overlay: '300', dialog: '400', toast: '500', tooltip: '600' },
  /** Type scale: [font-size, line-height]; sizes in rem so user font settings are respected. */
  text: {
    xs: ['0.75rem', '1rem'],
    sm: ['0.875rem', '1.25rem'],
    base: ['1rem', '1.5rem'],
    md: ['1.125rem', '1.625rem'],
    lg: ['1.25rem', '1.75rem'],
    xl: ['1.5rem', '2rem'],
    '2xl': ['1.875rem', '2.375rem'],
    '3xl': ['2.375rem', '2.75rem'],
    '4xl': ['3rem', '3.375rem'],
  },
  weight: { regular: '400', medium: '500', semibold: '600', bold: '700' },
  font: {
    sans: "'Onest', system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
    mono: "ui-monospace, 'Cascadia Mono', 'SF Mono', Consolas, 'Liberation Mono', monospace",
  },
  /** Minimum touch target on coarse pointers (WCAG 2.5.5 / platform guidance). */
  target: { coarse: '44px', touch: '48px', fine: '36px' },
  /** Look variables a style may change without any component change: border width, blur behind surfaces, a sheen laid over surfaces and buttons, a page background image, the heading font. */
  look: { borderW: '1px', blur: '0px', sheen: 'none', bgImage: 'none', fontHeading: 'var(--font-sans)' },
  /** Height of buttons and fields; a density changes it together with the spacing scale. */
  control: { h: '40px' },
} as const;

/** Avatar colours are theme independent (initials on a hashed hue); fg/bg pairs checked in the tests. */
export const avatarPalette: ReadonlyArray<{ bg: string; fg: string }> = [
  { bg: '#3dd6c8', fg: '#04211f' },
  { bg: '#f4c24f', fg: '#2b1d00' },
  { bg: '#8fa2ff', fg: '#0b1240' },
  { bg: '#ff9fb2', fg: '#3a0614' },
  { bg: '#9be08c', fg: '#0a2a06' },
  { bg: '#c3a2ff', fg: '#21093f' },
  { bg: '#ffb27a', fg: '#3a1700' },
  { bg: '#6ad1ff', fg: '#02263a' },
];

/** Normal text: foreground on background, needs >= 4.5:1 (WCAG 1.4.3). */
export const textPairs: ReadonlyArray<readonly [TokenName, TokenName]> = [
  ...(['text', 'textMuted', 'textSubtle'] as const).flatMap((fg) =>
    (['bg', 'surface1', 'surface2', 'surface3'] as const).map((bg) => [fg, bg] as const),
  ),
  ...(['accent', 'success', 'warning', 'danger', 'goldFg'] as const).flatMap((fg) =>
    (['bg', 'surface1', 'surface2'] as const).map((bg) => [fg, bg] as const),
  ),
  ['accent', 'accentSoft'],
  ['goldFg', 'goldSoft'],
  ['success', 'successSoft'],
  ['warning', 'warningSoft'],
  ['danger', 'dangerSoft'],
  ['text', 'accentSoft'],
  ['text', 'dangerSoft'],
  ['textOnAccent', 'accent'],
  ['textOnAccent', 'accentHover'],
  ['textOnAccent', 'accentActive'],
  ['textOnGold', 'gold'],
  ['textOnSuccess', 'success'],
  ['textOnWarning', 'warning'],
  ['textOnDanger', 'danger'],
  ['textOnDanger', 'dangerHover'],
  ['inverseText', 'inverseBg'],
  ['textOnVideo', 'videoBg'],
];

/** Focus indicators, control borders and state glows: non-text contrast, needs >= 3:1 (WCAG 1.4.11, 2.4.11). */
export const nonTextPairs: ReadonlyArray<readonly [TokenName, TokenName]> = [
  ...(['focusRing', 'borderStrong', 'accent', 'goldRing'] as const).flatMap((fg) =>
    (['bg', 'surface1', 'surface2', 'surface3'] as const).map((bg) => [fg, bg] as const),
  ),
  ['focusRing', 'videoBg'],
  ['goldRing', 'videoBg'],
  ['accent', 'videoBg'],
];

export const TEXT_MIN = 4.5;
export const NON_TEXT_MIN = 3;

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

export function luminance(hex: string): number {
  if (!HEX.test(hex)) throw new Error(`not a 6-digit hex colour: ${hex}`);
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

export interface PairFailure {
  fg: TokenName;
  /** A token name, or `glass-<tier>@<backdrop>` for glass over an extreme backdrop. */
  bg: TokenName | `glass-${string}`;
  ratio: number;
  min: number;
}

/** Returns every pair of a theme that does not reach `min`. Empty array = theme is compliant. */
export function failingPairs(
  theme: ThemeColours,
  pairs: ReadonlyArray<readonly [TokenName, TokenName]>,
  min: number,
): PairFailure[] {
  const out: PairFailure[] = [];
  for (const [fg, bg] of pairs) {
    const ratio = contrast(theme[fg], theme[bg]);
    if (ratio < min) out.push({ fg, bg, ratio, min });
  }
  return out;
}

/** camelCase / digit boundary to kebab-case: surface1 -> surface-1, textOnAccent -> text-on-accent. */
export function cssName(key: string): string {
  return key.replace(/([a-z])([A-Z0-9])/g, '$1-$2').toLowerCase();
}

/** Old variable names kept so screens written before the design system keep working. */
export const legacyAliases: Readonly<Record<string, string>> = {
  panel: 'surface-1',
  line: 'border',
  muted: 'text-muted',
  'accent-text': 'text-on-accent',
  'danger-text': 'text-on-danger',
};

// ---------------------------------------------------------------------------------------------------------------------
// Style and density axes. A look is three independent choices: STYLE (the family: radius, borders, shadows, type, effects),
// MODE (dark / light) and DENSITY (spacing scale). The page carries them as data-style / data-theme / data-density on <html>.
// `dashboard` and `comfortable` are the base the whole product was built on: they override nothing. Adding a style is adding
// an entry here (colour overrides per mode, plus plain CSS variables); components never change. Every entry is held to the
// same WCAG tests as the base (see tokens.test.ts), per style and mode.

export const STYLE_IDS = ['dashboard', 'swiss', 'flat', 'material', 'editorial', 'neobrutalism', 'terminal', 'glassmorphism', 'neumorphism', 'claymorphism', 'aurora', 'skeuomorphism', 'liquid-glass'] as const;
export type StyleId = (typeof STYLE_IDS)[number];
export const DENSITY_IDS = ['compact', 'comfortable', 'spacious'] as const;
export type DensityId = (typeof DENSITY_IDS)[number];

export interface StyleDef {
  /** Per-mode colour overrides; the merged result must still pass the contrast tests. */
  colours?: Partial<Record<ThemeName, Partial<ThemeColours>>>;
  /** Plain CSS variables (camelCase names) set for this style in every mode: radius, border width, shadow, font... */
  vars?: Readonly<Record<string, string>>;
  /** Plain CSS variables per mode (shadows and effects usually differ between dark and light). */
  modeVars?: Partial<Record<ThemeName, Readonly<Record<string, string>>>>;
  /**
   * Translucent glass materials (liquid-glass). `tint` is the opaque colour of the material, `clear` and `regular` its
   * opacity for bars/controls and for panels. The page behind glass can be anything (live video, a white shared screen), so
   * the tests composite the tint over pure black AND pure white and hold text and controls on the result to WCAG AA.
   */
  glass?: Partial<Record<ThemeName, GlassMaterial>>;
  /** The system chrome (browser bar, Android bars, desktop window) takes this style's page background instead of the base one. */
  ownChrome?: boolean;
}

export interface GlassMaterial {
  /** 6-digit hex. */
  tint: string;
  /** Opacity of bars, capsules and floating controls (text on them: primary text only). */
  clear: number;
  /** Opacity of panels, sheets, menus and dialogs (every text level). */
  regular: number;
}

export const styles: Record<StyleId, StyleDef> = styleDefs;

/** Spacing/size variables per density, merged over the base scale. `comfortable` is the base. */
const SPACE = [4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80] as const;
const SPACE_KEYS = ['space1', 'space2', 'space3', 'space4', 'space5', 'space6', 'space8', 'space10', 'space12', 'space16', 'space20'] as const;
const scaled = (k: number, controlH: string): Record<string, string> => ({
  ...Object.fromEntries(SPACE_KEYS.map((name, i) => [name, `${Math.round(SPACE[i]! * k)}px`])),
  controlH,
});
export const densities: Record<DensityId, Readonly<Record<string, string>>> = {
  compact: scaled(0.75, '32px'),
  comfortable: {},
  spacious: scaled(1.25, '48px'),
};

/** The colours of one style in one mode: the base theme with the style's overrides applied. */
export function resolveColours(style: StyleId, mode: ThemeName): ThemeColours {
  return { ...themes[mode], ...(styles[style].colours?.[mode] ?? {}) };
}

/** Where the system chrome (browser bar, Android status bar, window background) takes its colour from: the page background of the style and mode. */
export function chromeColour(mode: ThemeName, style: StyleId = 'dashboard'): string {
  return styles[style].ownChrome ? resolveColours(style, mode).bg : themes[mode].bg;
}

/** Styles with their own chrome colour in at least one mode (the platforms keep a table of these). */
export function chromeOverrides(): Array<{ style: StyleId; dark: string; light: string }> {
  return STYLE_IDS.filter((id) => (['dark', 'light'] as const).some((m) => chromeColour(m, id) !== chromeColour(m))).map((style) => ({
    style,
    dark: chromeColour('dark', style),
    light: chromeColour('light', style),
  }));
}

/** sRGB alpha compositing of an opaque colour at `alpha` over an opaque backdrop (what the browser paints). */
export function composite(fg: string, alpha: number, backdrop: string): string {
  const parse = (hex: string) => {
    if (!HEX.test(hex)) throw new Error(`not a 6-digit hex colour: ${hex}`);
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255] as const;
  };
  const a = parse(fg);
  const b = parse(backdrop);
  return '#' + a.map((v, i) => Math.round(alpha * v + (1 - alpha) * b[i]!).toString(16).padStart(2, '0')).join('');
}

/** What must stay legible on each glass tier. Clear glass carries primary text and focus/accent marks; regular carries all text. */
export const glassTextPairs = {
  clear: { text: ['text'] as const, nonText: ['focusRing', 'accent'] as const },
  regular: { text: ['text', 'textMuted', 'textSubtle', 'accent', 'success', 'warning', 'danger', 'goldFg'] as const, nonText: ['focusRing', 'borderStrong', 'accent', 'goldRing'] as const },
} as const;

/** The two extreme backdrops any glass can end up over (a black video frame, a white shared document). */
export const GLASS_BACKDROPS = ['#000000', '#ffffff'] as const;

/** Every glass tier x backdrop x pair of one style and mode that misses WCAG AA. Empty = legible over anything. */
export function glassFailures(style: StyleId, mode: ThemeName, def: StyleDef = styles[style]): PairFailure[] {
  const g = def.glass?.[mode];
  if (!g) return [];
  const c = { ...themes[mode], ...(def.colours?.[mode] ?? {}) };
  const out: PairFailure[] = [];
  for (const tier of ['clear', 'regular'] as const) {
    for (const backdrop of GLASS_BACKDROPS) {
      const surface = composite(g.tint, g[tier], backdrop);
      for (const fg of glassTextPairs[tier].text) {
        const ratio = contrast(c[fg], surface);
        if (ratio < TEXT_MIN) out.push({ fg, bg: `glass-${tier}@${backdrop}`, ratio, min: TEXT_MIN });
      }
      for (const fg of glassTextPairs[tier].nonText) {
        const ratio = contrast(c[fg], surface);
        if (ratio < NON_TEXT_MIN) out.push({ fg, bg: `glass-${tier}@${backdrop}`, ratio, min: NON_TEXT_MIN });
      }
    }
  }
  return out;
}

/** The only viewport widths a stylesheet may switch layout at (px). `design-lint.test.ts` in the web app holds new code to this list. */
export const breakpoints = { sm: 480, md: 640, lg: 960, xl: 1280, xxl: 1920 } as const;
