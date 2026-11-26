// The ONE place that lists what a person can choose: languages, themes (modes), styles and densities. Every picker, every
// validator and every default reads from here, so adding a language or a style is a change in this file and its dictionary.
import { DENSITY_IDS, STYLE_IDS, type DensityId, type StyleId } from '@davrabox/design-tokens';
import type { Key, Lang } from '../i18n';

export type { DensityId, StyleId };
import { STYLE_THEME_COLOR, THEME_COLOR as GENERATED_THEME_COLOR } from './theme-colors.generated';

export type ThemeChoice = 'dark' | 'light';

export const LANGS: ReadonlyArray<{ id: Lang; short: string; name: string }> = [
  { id: 'uz', short: 'UZ', name: 'O‘zbekcha' },
  { id: 'ru', short: 'RU', name: 'Русский' },
  { id: 'en', short: 'EN', name: 'English' },
];
export const THEMES: readonly ThemeChoice[] = ['dark', 'light'];
/** Every style and density the design tokens define (the one list); the person's organisation may allow fewer. */
export const STYLES: readonly StyleId[] = STYLE_IDS;
export const DENSITIES: readonly DensityId[] = DENSITY_IDS;

/** Dictionary keys of the visible names. */
const STYLE_KEY: Record<StyleId, Key> = {
  dashboard: 'stDashboard', swiss: 'stSwiss', flat: 'stFlat', material: 'stMaterial', editorial: 'stEditorial', neobrutalism: 'stNeobrutalism',
  terminal: 'stTerminal', glassmorphism: 'stGlassmorphism', neumorphism: 'stNeumorphism', claymorphism: 'stClaymorphism', aurora: 'stAurora', skeuomorphism: 'stSkeuomorphism',
  'liquid-glass': 'stLiquidGlass',
};
const DENSITY_KEY: Record<DensityId, Key> = { compact: 'uiDensitycompact', comfortable: 'uiDensitycomfortable', spacious: 'uiDensityspacious' };
export const styleLabelKey = (id: StyleId): Key => STYLE_KEY[id];
export const densityLabelKey = (id: DensityId): Key => DENSITY_KEY[id];

export const DEFAULTS = { theme: 'dark', style: 'dashboard', density: 'comfortable' } as const satisfies { theme: ThemeChoice; style: StyleId; density: DensityId };

/** Colour of the browser / system bars per theme (the page background of that theme): generated from the design tokens. */
export const THEME_COLOR: Readonly<Record<ThemeChoice, string>> = GENERATED_THEME_COLOR;
/** The bar colour for a theme and style: a style with its own page background (liquid-glass) has its own. */
export const themeColorFor = (theme: ThemeChoice, style: StyleId): string => (STYLE_THEME_COLOR[style] ?? THEME_COLOR)[theme];
/** True when the style has its own system-chrome colour (the native shells are told the style then). */
export const hasOwnChrome = (style: string | null): boolean => style !== null && Object.prototype.hasOwnProperty.call(STYLE_THEME_COLOR, style);

export const isLang = (v: unknown): v is Lang => LANGS.some((l) => l.id === v);
export const isTheme = (v: unknown): v is ThemeChoice => THEMES.includes(v as ThemeChoice);
export const isStyle = (v: unknown): v is StyleId => STYLES.includes(v as StyleId);
export const isDensity = (v: unknown): v is DensityId => DENSITIES.includes(v as DensityId);
