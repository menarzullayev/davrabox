import { IconButton, IconMoon, IconSun, type ThemeChoice } from '../ui';
import { usePrefs } from '../prefs';
import { t } from '../i18n';
import type { AppearanceOverrides } from './AppearanceFields';
import { SettingsMenu, type SettingsMenuProps } from './SettingsMenu';

export { AppearanceFields } from './AppearanceFields';

/** One-press Dark/Light switch: the same button, in the same place, on every screen. */
export function ThemeToggle(o: AppearanceOverrides) {
  const prefs = usePrefs();
  const lang = o.lang ?? prefs.lang;
  const theme = o.theme ?? prefs.theme;
  const onTheme = o.onTheme ?? prefs.setTheme;
  const next: ThemeChoice = theme === 'dark' ? 'light' : 'dark';
  return (
    <IconButton
      label={t(lang, next === 'light' ? 'uiThemeLight' : 'uiThemeDark')}
      icon={theme === 'dark' ? <IconSun /> : <IconMoon />}
      data-testid="theme-toggle"
      onClick={() => onTheme(next)}
    />
  );
}

/** The single entry point for language and appearance on every screen: a Dark/Light button plus the settings panel. */
export function AppearanceControls({ relay, ...o }: Pick<SettingsMenuProps, 'relay'> & AppearanceOverrides) {
  const prefs = usePrefs();
  const lang = o.lang ?? prefs.lang;
  const theme = o.theme ?? prefs.theme;
  const onLang = o.onLang ?? prefs.setLang;
  const onTheme = o.onTheme ?? prefs.setTheme;
  return (
    <>
      <ThemeToggle lang={lang} theme={theme} onTheme={onTheme} />
      <SettingsMenu lang={lang} onLang={onLang} theme={theme} onTheme={onTheme} relay={relay} />
    </>
  );
}
