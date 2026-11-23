import type { CapacitorConfig } from '@capacitor/cli';

// The app is a thin shell around the hosted web client. The URL is fixed at build time (DAVRA_APP_URL) and the
// shell may only navigate inside that origin; everything else opens in the system browser.
const DEFAULT_APP_URL = 'https://davrabox.bugvector.uz/app';

function resolveAppUrl(raw: string | undefined): URL {
  const u = new URL(raw && raw.trim() !== '' ? raw.trim() : DEFAULT_APP_URL);
  if (u.protocol !== 'https:') throw new Error('DAVRA_APP_URL must be an https URL (cleartext is disabled)');
  if (u.username || u.password) throw new Error('DAVRA_APP_URL must not contain credentials');
  return u;
}

const appUrl = resolveAppUrl(process.env.DAVRA_APP_URL);

const config: CapacitorConfig = {
  appId: 'uz.davrabox.app',
  appName: 'DavraBox',
  webDir: 'www', // offline placeholder only; the real UI is loaded from server.url
  server: {
    url: appUrl.toString(),
    cleartext: false,
    androidScheme: 'https',
    allowNavigation: [appUrl.hostname],
  },
  android: {
    allowMixedContent: false,
    webContentsDebuggingEnabled: false,
  },
};

export default config;
