#!/usr/bin/env node
// Sign-up and onboarding settings of the davrabox realm (owner decisions 1, 2 and 4 of 2026-11-27), applied through the admin
// REST API. Idempotent: rerunning with the same environment changes nothing. Never prints a secret.
//
//   node scripts/keycloak-onboarding.mjs            apply
//   node scripts/keycloak-onboarding.mjs --check    report what would change (exit 1 when something differs)
//   node scripts/keycloak-onboarding.mjs --force-secrets   also send the SMTP password / client secrets again (after a rotation:
//                                                          Keycloak never shows a stored secret, so a change cannot be detected)
//
// What it sets:
//  - mail: the realm's SMTP server from KC_SMTP_* (below). Without KC_SMTP_HOST the mail settings are left as they are.
//  - "Forgot password?" on (resetPasswordAllowed), verify-email NOT required at sign-in (decision 2: nothing is blocked),
//    the branded email theme (emailTheme=davrabox, uz/ru/en).
//  - Google and Microsoft identity providers from IDP_GOOGLE_CLIENT_ID/_SECRET and IDP_MICROSOFT_CLIENT_ID/_SECRET. A provider
//    whose two values are not set is left untouched (never created half-configured).
//      Google:    trustEmail on (Google returns verified addresses only) -> the person's email counts as verified.
//      Microsoft: trustEmail OFF. A Microsoft (Entra) directory administrator can put any address into an account, so an
//                 address from Microsoft is never trusted to take over an existing DavraBox account: linking it to an existing
//                 account always needs the existing account's password or a link sent to that mailbox (built-in first
//                 broker login flow, with SMTP now working). New Microsoft people verify their address like form sign-ups.
//  - the API's service account may read the identity providers (to show only configured buttons on the sign-up page).
//
// Environment (the server's .env; nothing is ever typed on the command line):
//   KEYCLOAK_URL (default http://127.0.0.1:8180/auth), KEYCLOAK_REALM (default davrabox), KEYCLOAK_ADMIN_PASSWORD (required)
//   KC_SMTP_HOST, KC_SMTP_PORT (587), KC_SMTP_USER, KC_SMTP_PASSWORD, KC_SMTP_FROM, KC_SMTP_FROM_NAME (DavraBox),
//   KC_SMTP_STARTTLS (true unless port 465 or 1025), KC_SMTP_SSL (true for port 465), KC_SMTP_REPLY_TO (optional)
//   IDP_GOOGLE_CLIENT_ID, IDP_GOOGLE_CLIENT_SECRET, IDP_MICROSOFT_CLIENT_ID, IDP_MICROSOFT_CLIENT_SECRET
import { pathToFileURL } from 'node:url';

export const MASK = '**********'; // what Keycloak returns instead of a stored secret

/** Realm attributes this script owns, given the environment. Pure (unit-tested in keycloak-onboarding.test.mjs). */
export function desiredRealm(env) {
  const r = { resetPasswordAllowed: true, verifyEmail: false, emailTheme: 'davrabox' };
  if (env.KC_SMTP_HOST) {
    const port = String(env.KC_SMTP_PORT || '587');
    const smtp = {
      host: env.KC_SMTP_HOST,
      port,
      from: env.KC_SMTP_FROM || '',
      fromDisplayName: env.KC_SMTP_FROM_NAME || 'DavraBox',
      starttls: String(env.KC_SMTP_STARTTLS ?? (port !== '465' && port !== '1025')),
      ssl: String(env.KC_SMTP_SSL ?? port === '465'),
    };
    if (!smtp.from) throw new Error('KC_SMTP_FROM is required with KC_SMTP_HOST');
    if (env.KC_SMTP_REPLY_TO) smtp.replyTo = env.KC_SMTP_REPLY_TO;
    if (env.KC_SMTP_USER) Object.assign(smtp, { auth: 'true', user: env.KC_SMTP_USER, password: env.KC_SMTP_PASSWORD || '' });
    else smtp.auth = 'false';
    if (smtp.auth === 'true' && !smtp.password) throw new Error('KC_SMTP_PASSWORD is required with KC_SMTP_USER');
    r.smtpServer = smtp;
  }
  return r;
}

const PROVIDERS = [
  { alias: 'google', env: 'GOOGLE', trustEmail: true, guiOrder: '1', extra: { defaultScope: 'openid profile email', prompt: 'select_account' } },
  { alias: 'microsoft', env: 'MICROSOFT', trustEmail: false, guiOrder: '2', extra: { defaultScope: 'openid profile email User.Read', prompt: 'select_account' } },
];

/** Identity providers to create or update (only fully configured ones). Pure. */
export function desiredProviders(env) {
  const out = [];
  for (const p of PROVIDERS) {
    const id = env[`IDP_${p.env}_CLIENT_ID`];
    const secret = env[`IDP_${p.env}_CLIENT_SECRET`];
    if (!id && !secret) continue;
    if (!id || !secret) throw new Error(`IDP_${p.env}_CLIENT_ID and IDP_${p.env}_CLIENT_SECRET must be set together`);
    out.push({
      alias: p.alias,
      providerId: p.alias,
      displayName: p.alias === 'google' ? 'Google' : 'Microsoft',
      enabled: true,
      trustEmail: p.trustEmail,
      storeToken: false,
      addReadTokenRoleOnCreate: false,
      linkOnly: false,
      firstBrokerLoginFlowAlias: 'first broker login',
      config: { clientId: id, clientSecret: secret, syncMode: 'IMPORT', hideOnLogin: 'false', guiOrder: p.guiOrder, ...p.extra },
    });
  }
  return out;
}

/** Fields of `want` that differ from `have` (secrets compared only when Keycloak shows them; a mask counts as equal). */
export function diff(have, want, prefix = '', forceSecrets = false) {
  const out = [];
  for (const [k, v] of Object.entries(want)) {
    const h = have?.[k];
    if (v && typeof v === 'object') out.push(...diff(h ?? {}, v, `${prefix}${k}.`, forceSecrets));
    else if (/password|secret/i.test(k)) {
      if (forceSecrets || (h !== v && h !== MASK)) out.push(`${prefix}${k}`);
    } else if (String(h ?? '') !== String(v)) out.push(`${prefix}${k}`);
  }
  return out;
}

async function main() {
  const BASE = (process.env.KEYCLOAK_URL ?? 'http://127.0.0.1:8180/auth').replace(/\/+$/, '');
  const REALM = process.env.KEYCLOAK_REALM ?? 'davrabox';
  const check = process.argv.includes('--check');
  const force = process.argv.includes('--force-secrets');
  const password = process.env.KEYCLOAK_ADMIN_PASSWORD;
  if (!password) throw new Error('KEYCLOAK_ADMIN_PASSWORD is required');
  const tr = await fetch(`${BASE}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({ client_id: 'admin-cli', grant_type: 'password', username: 'admin', password }),
  });
  if (!tr.ok) throw new Error(`admin token failed: ${tr.status}`);
  const h = { Authorization: `Bearer ${(await tr.json()).access_token}`, 'Content-Type': 'application/json' };
  const api = (path, init = {}) => fetch(`${BASE}/admin/realms/${REALM}${path}`, { headers: h, ...init });
  const must = async (res, what) => {
    if (!res.ok) throw new Error(`${what} failed: ${res.status}`); // the body is not printed: it may echo submitted values
    return res;
  };
  let changes = 0;
  const note = (what, fields) => {
    changes += fields.length ? 1 : 0;
    console.log(`${fields.length ? (check ? 'DIFFERS' : 'UPDATED') : 'OK     '} ${what}${fields.length ? ': ' + fields.join(', ') : ''}`);
  };

  // 1. Realm: reset password, no blocking verify-email, email theme, SMTP.
  const realm = await (await must(await api(''), 'read realm')).json();
  const want = desiredRealm(process.env);
  const realmDiff = diff(realm, want, '', force);
  if (!process.env.KC_SMTP_HOST) console.log(`SKIP    smtp: KC_SMTP_HOST not set (current host: ${realm.smtpServer?.host || 'none'})`);
  if (realmDiff.length && !check) {
    // A masked password must be sent back unchanged (Keycloak keeps the stored one); a new one replaces it.
    await must(await api('', { method: 'PUT', body: JSON.stringify({ ...realm, ...want, smtpServer: { ...(realm.smtpServer ?? {}), ...(want.smtpServer ?? {}) } }) }), 'update realm');
  }
  note('realm (resetPasswordAllowed, verifyEmail=false, emailTheme, smtp)', realmDiff);

  // 2. Identity providers.
  const wanted = desiredProviders(process.env);
  for (const p of PROVIDERS) if (!wanted.some((w) => w.alias === p.alias)) console.log(`SKIP    identity provider ${p.alias}: IDP_${p.env}_CLIENT_ID/_SECRET not set`);
  for (const idp of wanted) {
    const cur = await api(`/identity-provider/instances/${idp.alias}`);
    if (cur.status === 404) {
      if (!check) await must(await api('/identity-provider/instances', { method: 'POST', body: JSON.stringify(idp) }), `create ${idp.alias}`);
      note(`identity provider ${idp.alias}`, ['created']);
      continue;
    }
    const have = await (await must(cur, `read ${idp.alias}`)).json();
    const d = diff(have, idp, '', force);
    if (d.length && !check) {
      await must(await api(`/identity-provider/instances/${idp.alias}`, { method: 'PUT', body: JSON.stringify({ ...have, ...idp, config: { ...have.config, ...idp.config } }) }), `update ${idp.alias}`);
    }
    note(`identity provider ${idp.alias}`, d);
  }

  // 3. The API's service account may list identity providers (sign-up page buttons).
  const clients = await (await must(await api('/clients?clientId=davrabox-admin-api'), 'find service client')).json();
  const rm = await (await must(await api('/clients?clientId=realm-management'), 'find realm-management')).json();
  if (clients[0] && rm[0]) {
    const sa = await (await must(await api(`/clients/${clients[0].id}/service-account-user`), 'read service account')).json();
    const mapped = await (await must(await api(`/users/${sa.id}/role-mappings/clients/${rm[0].id}`), 'read service roles')).json();
    const missing = mapped.some((r) => r.name === 'view-identity-providers') ? [] : ['view-identity-providers'];
    if (missing.length && !check) {
      const role = await (await must(await api(`/clients/${rm[0].id}/roles/view-identity-providers`), 'read role')).json();
      await must(await api(`/users/${sa.id}/role-mappings/clients/${rm[0].id}`, { method: 'POST', body: JSON.stringify([role]) }), 'grant role');
    }
    note('service account role view-identity-providers', missing);
  }

  if (check && changes) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => {
    console.error(`keycloak-onboarding: ${e.message}`);
    process.exit(1);
  });
}
