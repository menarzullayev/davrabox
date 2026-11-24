// The ONE place that lists what a person can choose: languages, themes (modes), styles and densities. Every picker, every
// validator and every default reads from here, so adding a language or a style is a change in this file and its dictionary.
import type { Lang } from '../i18n';
import { THEME_COLOR as GENERATED_THEME_COLOR } from './theme-colors.generated';

export type ThemeChoice = 'dark' | 'light';
export type StyleId = 'dashboard';
export type DensityId = 'comfortable';

export const LANGS: ReadonlyArray<{ id: Lang; short: string; name: string }> = [
  { id: 'uz', short: 'UZ', name: 'O‘zbekcha' },
  { id: 'ru', short: 'RU', name: 'Русский' },
  { id: 'en', short: 'EN', name: 'English' },
];
export const THEMES: readonly ThemeChoice[] = ['dark', 'light'];
export const STYLES: readonly StyleId[] = ['dashboard'];
export const DENSITIES: readonly DensityId[] = ['comfortable'];

export const DEFAULTS = { theme: 'dark', style: 'dashboard', density: 'comfortable' } as const satisfies { theme: ThemeChoice; style: StyleId; density: DensityId };

/** Colour of the browser / system bars per theme (the page background of that theme): generated from the design tokens. */
export const THEME_COLOR: Readonly<Record<ThemeChoice, string>> = GENERATED_THEME_COLOR;

export const isLang = (v: unknown): v is Lang => LANGS.some((l) => l.id === v);
export const isTheme = (v: unknown): v is ThemeChoice => THEMES.includes(v as ThemeChoice);
export const isStyle = (v: unknown): v is StyleId => STYLES.includes(v as StyleId);
export const isDensity = (v: unknown): v is DensityId => DENSITIES.includes(v as DensityId);
