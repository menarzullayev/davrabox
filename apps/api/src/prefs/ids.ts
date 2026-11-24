// The choices a person can store. The style list is owned by the design tokens (packages/design-tokens); prefs-ids.test.ts
// fails when this copy drifts from it.
export const STYLE_IDS = ['dashboard', 'swiss', 'flat', 'material', 'editorial', 'neobrutalism', 'terminal', 'glassmorphism', 'neumorphism', 'claymorphism', 'aurora', 'skeuomorphism'] as const;
export const DENSITY_IDS = ['compact', 'comfortable', 'spacious'] as const;
export const LANG_IDS = ['uz', 'ru', 'en'] as const;
export const THEME_IDS = ['dark', 'light'] as const;
export type StyleId = (typeof STYLE_IDS)[number];
