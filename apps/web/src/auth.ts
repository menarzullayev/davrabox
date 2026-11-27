import { UserManager, WebStorageStateStore, type User } from 'oidc-client-ts';
import { detectLang, type Lang } from './i18n';
import { isCapacitorShell } from './platform/capacitor';

/**
 * Where the signed-in user (tokens) is kept. A browser tab keeps it for the tab's life only. The Android app keeps it in
 * the app's private storage, so reopening the app does not ask for the password again (Android ends the WebView's session
 * storage with the app).
 */
export function userStorage(win: (Window & { Capacitor?: unknown }) | undefined = typeof window === 'undefined' ? undefined : window): Storage | undefined {
  if (!win) return undefined;
  return isCapacitorShell(win as Parameters<typeof isCapacitorShell>[0]) ? win.localStorage : win.sessionStorage;
}

// Same-origin deployment: Caddy serves the app, /auth (Keycloak), /api and /livekit on one HTTPS origin.
export const manager = new UserManager({
  authority: `${location.origin}/auth/realms/davrabox`,
  client_id: 'davrabox-web',
  redirect_uri: `${location.origin}/app`, // the application lives at /app; "/" is the landing page
  post_logout_redirect_uri: `${location.origin}/app`,
  response_type: 'code', // authorization code + PKCE (S256 is the library default)
  scope: 'openid profile email',
  userStore: new WebStorageStateStore({ store: userStorage() ?? window.sessionStorage }),
  automaticSilentRenew: true,
});

/**
 * Starts the sign-in redirect in the language the user already sees in the app (saved choice, else the device language), so the
 * identity provider's page does not fall back to its own default. `ui_locales` is the standard OIDC parameter Keycloak reads.
 */
export function signIn(opts: { lang?: Lang; loginHint?: string; idpHint?: 'google' | 'microsoft' } = {}): Promise<void> {
  return manager.signinRedirect({
    ...(opts.loginHint ? { login_hint: opts.loginHint } : {}),
    // kc_idp_hint skips Keycloak's own form and goes straight to Google / Microsoft (sign-up page buttons, decision 4).
    extraQueryParams: { ui_locales: opts.lang ?? detectLang(), ...(opts.idpHint ? { kc_idp_hint: opts.idpHint } : {}) },
  });
}

/** Fresh access token for long-lived screens (the library renews it silently). */
export async function freshToken(): Promise<string> {
  const u = await manager.getUser();
  if (!u || u.expired) throw new Error('signed out');
  return u.access_token;
}

let pending: Promise<User | null> | null = null;

/**
 * Completes the redirect callback if present and returns the current user, if any.
 * Single-flight: an authorization code is one-time, so a second concurrent call
 * (React StrictMode runs effects twice in development) must reuse the first result.
 */
export function currentUser(): Promise<User | null> {
  pending ??= (async () => {
    const params = new URLSearchParams(location.search);
    if (params.has('code') && params.has('state')) {
      const user = await manager.signinRedirectCallback();
      history.replaceState({}, document.title, location.pathname); // drop code/state from the URL
      return user;
    }
    return restoreUser(manager);
  })();
  return pending;
}

/**
 * The stored user. When the access token has expired (an app reopened later, a tab left idle) and a refresh token is
 * kept, it is renewed instead of signing the person out; a refused renewal drops the stored user.
 */
export async function restoreUser(mgr: Pick<UserManager, 'getUser' | 'signinSilent' | 'removeUser'>): Promise<User | null> {
  const user = await mgr.getUser();
  if (!user) return null;
  if (!user.expired) return user;
  if (!user.refresh_token) return null;
  try {
    return await mgr.signinSilent();
  } catch {
    await mgr.removeUser();
    return null;
  }
}
