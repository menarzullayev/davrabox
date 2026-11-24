// Keeps the Android status-bar icons readable on the app's own background. In the Android shell (Capacitor) the icon colour
// follows the phone's theme by default, so a dark app on a phone in light mode got dark icons on a dark bar. The shell's
// ThemeBars plugin sets the window colour and the icon colour together; an older shell without it falls back to the built-in
// SystemBars plugin (style 'DARK' = light icons, 'LIGHT' = dark icons).
// Outside the shell this does nothing. The page theme is read from `data-theme` on <html> (set by theme-init.js and applyTheme);
// no attribute means the default, dark.
import { isCapacitorShell } from './capacitor';

interface SystemBarsPlugin {
  setStyle?: (o: { style: 'DARK' | 'LIGHT' }) => unknown;
}
/** The shell's own plugin (ThemeBarsPlugin.java): window colour and icon colour together. */
interface ThemeBarsPlugin {
  setTheme?: (o: { theme: 'dark' | 'light' }) => unknown;
}
interface ShellWindow {
  Capacitor?: { isNativePlatform?: () => boolean; Plugins?: { SystemBars?: SystemBarsPlugin; ThemeBars?: ThemeBarsPlugin } };
}

export function barStyleFor(theme: string | null): 'DARK' | 'LIGHT' {
  return theme === 'light' ? 'LIGHT' : 'DARK';
}

/** Applies the style now and on every theme change. Returns a function that stops watching. */
export function watchSystemBars(win: ShellWindow | undefined = typeof window === 'undefined' ? undefined : (window as unknown as ShellWindow), doc: Document | undefined = typeof document === 'undefined' ? undefined : document): () => void {
  if (!win || !doc || !isCapacitorShell(win)) return () => undefined;
  let last: string | null = null;
  const apply = () => {
    const style = barStyleFor(doc.documentElement.getAttribute('data-theme'));
    if (style === last) return;
    last = style;
    try {
      const plugins = win.Capacitor?.Plugins;
      // ThemeBars sets the window colour too (a light page needs a light band, not only dark icons); an older shell only has SystemBars.
      const r = plugins?.ThemeBars?.setTheme ? plugins.ThemeBars.setTheme({ theme: style === 'LIGHT' ? 'light' : 'dark' }) : plugins?.SystemBars?.setStyle?.({ style });
      if (r && typeof (r as Promise<unknown>).catch === 'function') void (r as Promise<unknown>).catch(() => undefined);
    } catch {
      /* the plugin is not there (an older shell): the bar keeps its default colour */
    }
  };
  apply();
  const mo = new MutationObserver(apply);
  mo.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => mo.disconnect();
}
