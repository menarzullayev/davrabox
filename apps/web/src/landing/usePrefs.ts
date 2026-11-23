import { useCallback, useEffect, useState } from 'react';
import { detectLang, t, type Key, type Lang } from '../i18n';
import { applyTheme, readTheme, type ThemeChoice } from '../ui';

const THEME_COLOR: Record<ThemeChoice, string> = { dark: '#0a0d21', light: '#f4f5fb' };

/** Language and theme of the public pages (same storage keys as the application, so the choice carries over to /app). */
export function usePrefs(titleKey?: Key, descKey?: Key) {
  const [lang, setLangState] = useState<Lang>(detectLang);
  const [theme, setThemeState] = useState<ThemeChoice>(readTheme);

  useEffect(() => {
    document.documentElement.lang = lang;
    if (titleKey) document.title = t(lang, titleKey);
    if (descKey) document.querySelector('meta[name="description"]')?.setAttribute('content', t(lang, descKey));
  }, [lang, titleKey, descKey]);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem('lang', l);
    } catch {
      /* storage unavailable: the choice lasts for this visit only */
    }
  }, []);

  const setTheme = useCallback((v: ThemeChoice) => {
    setThemeState(v);
    applyTheme(v);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[v]);
  }, []);

  return { lang, setLang, theme, setTheme };
}
