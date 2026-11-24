import { DENSITIES, LANGS, STYLES, densityLabelKey, styleLabelKey, usePrefs, type StyleId } from '../prefs';
import { IconMoon, IconSun, Segmented, Select, type ThemeChoice } from '../ui';
import { t, type Lang } from '../i18n';

const THEMES: ReadonlyArray<{ id: ThemeChoice; key: 'uiThemeDark' | 'uiThemeLight'; Icon: typeof IconMoon }> = [
  { id: 'dark', key: 'uiThemeDark', Icon: IconMoon },
  { id: 'light', key: 'uiThemeLight', Icon: IconSun },
];

/** Optional overrides: a screen that already owns the value (tests, lab pages) can pass it; otherwise the preferences store is used. */
export interface AppearanceOverrides {
  lang?: Lang;
  onLang?: (l: Lang) => void;
  theme?: ThemeChoice;
  onTheme?: (v: ThemeChoice) => void;
}

/** The one set of display controls: language, style, theme, density. Shown in the settings panel and in the call's More panel. */
export function AppearanceFields(o: AppearanceOverrides) {
  const prefs = usePrefs();
  const lang = o.lang ?? prefs.lang;
  const theme = o.theme ?? prefs.theme;
  const onLang = o.onLang ?? prefs.setLang;
  const onTheme = o.onTheme ?? prefs.setTheme;
  return (
    <>
      <Select label={t(lang, 'lang')} value={lang} onChange={(e) => onLang(e.target.value as Lang)}>
        {LANGS.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
      </Select>
      <Select label={t(lang, 'uiStyle')} value={prefs.style} data-testid="style-select" onChange={(e) => prefs.setStyle(e.target.value as StyleId)}>
        {STYLES.filter((id) => !prefs.allowedStyles || prefs.allowedStyles.includes(id)).map((id) => (
          <option key={id} value={id}>
            {t(lang, styleLabelKey(id))}
          </option>
        ))}
      </Select>
      <div className="hm-settings__group">
        <span className="dx-field__label">{t(lang, 'uiTheme')}</span>
        <Segmented
          label={t(lang, 'uiTheme')}
          value={theme}
          onChange={onTheme}
          options={THEMES.map(({ id, key, Icon }) => ({ id, label: (<><Icon size={18} />{t(lang, key)}</>) }))}
        />
      </div>
      <div className="hm-settings__group">
        <span className="dx-field__label">{t(lang, 'uiDensity')}</span>
        <Segmented
          label={t(lang, 'uiDensity')}
          value={prefs.density}
          onChange={prefs.setDensity}
          options={DENSITIES.map((id) => ({ id, label: t(lang, densityLabelKey(id)) }))}
        />
      </div>
    </>
  );
}
