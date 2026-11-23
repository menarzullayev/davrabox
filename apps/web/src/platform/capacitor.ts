// Detection of the Android (Capacitor) shell. The shell injects `window.Capacitor` into the hosted web client.
// Pure and DOM-free apart from the optional `win` argument, so it can be tested.
import type { Lang } from '../i18n';
import { t } from '../i18n';

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
}

export function isCapacitorShell(win: { Capacitor?: CapacitorGlobal } | undefined = typeof window === 'undefined' ? undefined : (window as unknown as { Capacitor?: CapacitorGlobal })): boolean {
  const cap = win?.Capacitor;
  if (!cap) return false;
  return typeof cap.isNativePlatform === 'function' ? cap.isNativePlatform() === true : true;
}

/** Shown when camera or microphone access fails. In the app the user must enable it in Android settings. */
export function mediaErrorText(lang: Lang, win?: Parameters<typeof isCapacitorShell>[0]): string {
  return t(lang, isCapacitorShell(win) ? 'errMediaApp' : 'errMedia');
}
