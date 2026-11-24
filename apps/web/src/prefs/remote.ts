// Keeps the preferences store and the server in step for a signed-in person: the saved choices follow them to every device, and
// the organization's guard rails (default look, allowed styles) apply. The store stays the single owner of the state; this
// module only reads it, writes it through setPref, and sends changes to the server.
import { api } from '../api';
import { isDensity, isLang, isStyle, isTheme } from './options';
import { getPrefs, setOrgPolicy, setPref, subscribePrefs, type Prefs } from './store';

const SEND_DELAY_MS = 600;
const KEYS = ['lang', 'theme', 'style', 'density'] as const;

/**
 * Loads the server copy and applies it, then sends later changes. Returns a function that stops sending.
 * Safe to call again after a new sign-in. Failures are silent: the local choice always keeps working.
 */
export async function startPrefsSync(getToken: () => Promise<string>): Promise<() => void> {
  let stopped = false;
  let view;
  try {
    view = await api.getPrefs(await getToken());
  } catch {
    return () => undefined;
  }
  if (stopped) return () => undefined;

  const { prefs, org } = view;
  setOrgPolicy({ allowedStyles: org.allowedStyles, defaultStyle: org.defaultStyle, defaultDensity: org.defaultDensity });
  const hadLocal = (k: 'style' | 'density') => {
    try {
      return localStorage.getItem(k) !== null;
    } catch {
      return false;
    }
  };
  // What the person chose on another device wins; where they never chose, the organization's default applies (this visit only).
  if (isLang(prefs.lang)) setPref('lang', prefs.lang);
  if (isTheme(prefs.theme)) setPref('theme', prefs.theme);
  if (isStyle(prefs.style)) setPref('style', prefs.style);
  else if (!hadLocal('style') && isStyle(org.defaultStyle)) setPref('style', org.defaultStyle, { persist: false });
  if (isDensity(prefs.density)) setPref('density', prefs.density);
  else if (!hadLocal('density') && isDensity(org.defaultDensity)) setPref('density', org.defaultDensity, { persist: false });
  // A locally saved style the organization does not allow falls back to its default.
  if (org.allowedStyles && !org.allowedStyles.includes(getPrefs().style) && isStyle(org.defaultStyle)) setPref('style', org.defaultStyle, { persist: false });

  let sent: Prefs = { ...getPrefs() };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = async () => {
    const now = getPrefs();
    const patch: Partial<Record<(typeof KEYS)[number], string>> = {};
    for (const k of KEYS) if (now[k] !== sent[k]) patch[k] = now[k];
    if (!Object.keys(patch).length) return;
    sent = { ...now };
    try {
      await api.putPrefs(await getToken(), patch);
    } catch (e) {
      // The organization refused the style (it changed meanwhile): go back to its default.
      if ((e as { status?: number }).status === 403 && isStyle(org.defaultStyle)) setPref('style', org.defaultStyle, { persist: false });
    }
  };
  const off = subscribePrefs(() => {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(() => void flush(), SEND_DELAY_MS);
  });
  return () => {
    stopped = true;
    clearTimeout(timer);
    off();
  };
}
