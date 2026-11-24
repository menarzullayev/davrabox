import { UserManager, WebStorageStateStore, type User } from 'oidc-client-ts';
import { detectLang, type Lang } from './i18n';

// Same-origin deployment: Caddy serves the app, /auth (Keycloak), /api and /livekit on one HTTPS origin.
export const manager = new UserManager({
  authority: `${location.origin}/auth/realms/davrabox`,
  client_id: 'davrabox-web',
  redirect_uri: `${location.origin}/app`, // the application lives at /app; "/" is the landing page
  post_logout_redirect_uri: `${location.origin}/app`,
  response_type: 'code', // authorization code + PKCE (S256 is the library default)
  scope: 'openid profile email',
  userStore: new WebStorageStateStore({ store: window.sessionStorage }),
  automaticSilentRenew: true,
});

/**
 * Starts the sign-in redirect in the language the user already sees in the app (saved choice, else the device language), so the
 * identity provider's page does not fall back to its own default. `ui_locales` is the standard OIDC parameter Keycloak reads.
 */
export function signIn(opts: { lang?: Lang; loginHint?: string } = {}): Promise<void> {
  return manager.signinRedirect({
    ...(opts.loginHint ? { login_hint: opts.loginHint } : {}),
    extraQueryParams: { ui_locales: opts.lang ?? detectLang() },
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
    const user = await manager.getUser();
    return user && !user.expired ? user : null;
  })();
  return pending;
}
