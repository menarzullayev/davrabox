// Connects the Android shell's hardware Back button to the layer stack (platform/back.ts). The shell's App plugin
// (@capacitor/app) only reports the press; this decides what it means: close the innermost layer, otherwise go back in the
// page history, otherwise leave the app. Outside the shell this does nothing.
import { isCapacitorShell } from './capacitor';
import { handleBack } from './back';

interface AppListenerHandle {
  remove?: () => unknown;
}
interface AppPlugin {
  addListener?: (event: 'backButton', cb: (e: { canGoBack?: boolean }) => void) => Promise<AppListenerHandle> | AppListenerHandle;
  exitApp?: () => unknown;
}
interface ShellWindow {
  Capacitor?: { isNativePlatform?: () => boolean; Plugins?: { App?: AppPlugin } };
  history?: { back: () => void };
}

/** Starts listening. Returns a function that stops. An older shell without the App plugin keeps the system default. */
export function watchBackButton(win: ShellWindow | undefined = typeof window === 'undefined' ? undefined : (window as unknown as ShellWindow)): () => void {
  if (!win || !isCapacitorShell(win)) return () => undefined;
  const app = win.Capacitor?.Plugins?.App;
  if (!app?.addListener) return () => undefined;
  let handle: AppListenerHandle | undefined;
  let stopped = false;
  const onBack = (e: { canGoBack?: boolean }) => {
    if (handleBack()) return;
    if (e?.canGoBack) win.history?.back();
    else void app.exitApp?.();
  };
  try {
    const r = app.addListener('backButton', onBack);
    void Promise.resolve(r).then((h) => {
      if (stopped) void h?.remove?.();
      else handle = h;
    });
  } catch {
    /* the plugin is not there: the shell keeps its own Back behaviour */
  }
  return () => {
    stopped = true;
    void handle?.remove?.();
  };
}
