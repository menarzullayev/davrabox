import { useEffect } from 'react';
import { t, type Key } from '../i18n';
import { usePrefs as useStore } from '../prefs';

/** Language and theme of the public pages (the shared preferences store, so the choice carries over to /app) plus the page title and description. */
export function usePrefs(titleKey?: Key, descKey?: Key) {
  const { lang, theme, setLang, setTheme } = useStore();
  useEffect(() => {
    if (titleKey) document.title = t(lang, titleKey);
    if (descKey) document.querySelector('meta[name="description"]')?.setAttribute('content', t(lang, descKey));
  }, [lang, titleKey, descKey]);
  return { lang, setLang, theme, setTheme };
}
