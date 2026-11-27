import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { KeycloakAdmin } from '../src/admin/identity-admin.js';

// Integration against the REAL running Keycloak (dev realm) and the local Mailpit catcher: the onboarding identity calls.
// Needs KEYCLOAK_ADMIN_URL / KEYCLOAK_ADMIN_CLIENT_SECRET (scripts/devenv.sh), KEYCLOAK_ADMIN_PASSWORD (to add a throw-away
// identity provider for the link tests) and the realm prepared by scripts/keycloak-onboarding.mjs with KC_SMTP_HOST=mailpit.
// MAILPIT_URL defaults to http://127.0.0.1:58025. Without them the suite is reported as skipped.
const cfg = loadConfig();
const MAILPIT = process.env.MAILPIT_URL ?? 'http://127.0.0.1:58025';
const ADMIN_PASSWORD = process.env.KEYCLOAK_ADMIN_PASSWORD;
const enabled = Boolean(cfg.KEYCLOAK_ADMIN_URL && cfg.KEYCLOAK_ADMIN_CLIENT_SECRET && ADMIN_PASSWORD);

async function mailpitUp(): Promise<boolean> {
  try {
    return (await fetch(`${MAILPIT}/api/v1/info`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

const mailpitOk = enabled && (await mailpitUp());

describe.skipIf(!enabled)('onboarding identity calls (real Keycloak + Mailpit)', () => {
  const kc = new KeycloakAdmin({ baseUrl: cfg.KEYCLOAK_ADMIN_URL ?? '', realm: cfg.KEYCLOAK_ADMIN_REALM, clientId: cfg.KEYCLOAK_ADMIN_REALM_CLIENT_ID, clientSecret: cfg.KEYCLOAK_ADMIN_CLIENT_SECRET! });
  const sfx = Math.random().toString(36).slice(2, 8);
  const idpAlias = `t-oidc-${sfx}`;
  const created: string[] = [];
  let admin: Record<string, string> = {};
  const realm = () => `${cfg.KEYCLOAK_ADMIN_URL}/admin/realms/${cfg.KEYCLOAK_ADMIN_REALM}`;

  beforeAll(async () => {
    const t = await fetch(`${cfg.KEYCLOAK_ADMIN_URL}/realms/master/protocol/openid-connect/token`, {
      method: 'POST',
      body: new URLSearchParams({ client_id: 'admin-cli', grant_type: 'password', username: 'admin', password: ADMIN_PASSWORD! }),
    });
    admin = { Authorization: `Bearer ${((await t.json()) as { access_token: string }).access_token}`, 'Content-Type': 'application/json' };
    // A throw-away OIDC provider, only so that a user can carry a federated identity link (never used to sign in).
    const r = await fetch(`${realm()}/identity-provider/instances`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({
        alias: idpAlias,
        providerId: 'oidc',
        enabled: true,
        config: { clientId: 'x', clientSecret: 'y', authorizationUrl: 'https://idp.invalid/auth', tokenUrl: 'https://idp.invalid/token', hideOnLogin: 'true' },
      }),
    });
    expect(r.status).toBe(201);
  });

  afterAll(async () => {
    for (const id of created) await kc.deleteUser(id).catch(() => undefined);
    await fetch(`${realm()}/identity-provider/instances/${idpAlias}`, { method: 'DELETE', headers: admin });
  });

  async function brokeredUser(email: string): Promise<string> {
    const r = await fetch(`${realm()}/users`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ username: email, email, firstName: 'Social', lastName: 'Person', enabled: true, emailVerified: true }),
    });
    expect(r.status).toBe(201);
    const id = r.headers.get('location')!.split('/').pop()!;
    created.push(id);
    const link = await fetch(`${realm()}/users/${id}/federated-identity/${idpAlias}`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ identityProvider: idpAlias, userId: `ext-${sfx}`, userName: email }),
    });
    expect(link.status).toBe(204);
    return id;
  }

  it('account(): a brokered account without organization is reported with its provider', async () => {
    const id = await brokeredUser(`ob1-${sfx}@onboarding-test.example.org`);
    expect(await kc.account(id)).toEqual({ email: `ob1-${sfx}@onboarding-test.example.org`, emailVerified: true, orgSlug: null, providers: [idpAlias] });
    expect(await kc.account('00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('attachOrgAdmin puts the account into the organization with both roles; detachOrg undoes it', async () => {
    const id = await brokeredUser(`ob2-${sfx}@onboarding-test.example.org`);
    await kc.attachOrgAdmin(id, `ob2-${sfx}`);
    const after = await kc.account(id);
    expect(after?.orgSlug).toBe(`ob2-${sfx}`);
    const roles = (await (await fetch(`${realm()}/users/${id}/role-mappings/realm`, { headers: admin })).json()) as Array<{ name: string }>;
    expect(roles.map((r) => r.name)).toEqual(expect.arrayContaining(['member', 'org_admin']));
    const user = (await (await fetch(`${realm()}/users/${id}`, { headers: admin })).json()) as { firstName: string; email: string };
    expect(user).toMatchObject({ firstName: 'Social', email: `ob2-${sfx}@onboarding-test.example.org` }); // nothing else lost
    // Another organization cannot be attached on top.
    await expect(kc.attachOrgAdmin(id, `other-${sfx}`)).rejects.toMatchObject({ status: 409 });
    // detachOrg refuses a slug the account does not carry, and removes its own.
    await kc.detachOrg(id, `other-${sfx}`);
    expect((await kc.account(id))?.orgSlug).toBe(`ob2-${sfx}`);
    await kc.detachOrg(id, `ob2-${sfx}`);
    expect((await kc.account(id))?.orgSlug).toBeNull();
    const rolesAfter = (await (await fetch(`${realm()}/users/${id}/role-mappings/realm`, { headers: admin })).json()) as Array<{ name: string }>;
    expect(rolesAfter.map((r) => r.name)).not.toContain('org_admin');
  });

  it('signInProviders lists only google/microsoft that are enabled and shown', async () => {
    const list = await kc.signInProviders();
    expect(list.every((p) => p === 'google' || p === 'microsoft')).toBe(true);
    expect(list).not.toContain(idpAlias as never);
  });

  it.runIf(mailpitOk)('sendVerifyEmail delivers the branded Uzbek email with a working link; the click verifies the address', async () => {
    const email = `ob3-${sfx}@onboarding-test.example.org`;
    const { id } = await kc.createOrgAdmin({ email, name: 'Malika Qodirova', orgSlug: `ob3-${sfx}`, password: `Pw-${sfx}-correct-horse` });
    created.push(id);
    expect(await kc.emailVerified(id)).toBe(false);
    await kc.sendVerifyEmail(id, null);
    let msg: { ID: string; Subject: string } | undefined;
    for (let i = 0; i < 40 && !msg; i++) {
      const list = (await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`)).json()) as { messages: Array<{ ID: string; Subject: string }> };
      msg = list.messages[0];
      if (!msg) await new Promise((r) => setTimeout(r, 250));
    }
    expect(msg?.Subject).toBe('DavraBox uchun emailingizni tasdiqlang'); // realm default locale uz
    const full = (await (await fetch(`${MAILPIT}/api/v1/message/${msg!.ID}`)).json()) as { HTML: string; Text: string; From: { Address: string } };
    expect(full.HTML).toContain('Emailni tasdiqlash');
    expect(full.HTML).toContain('#087069'); // branded layout, not the bare base template
    expect(full.Text).toContain('Email manzilingizni tasdiqlang');
    const link = /https?:\/\/[^\s"<]+action-token[^\s"<]+/.exec(full.Text)?.[0];
    expect(link).toBeTruthy();
    // Follow the link the way a mail client would (the dev Keycloak is reachable on the admin port too).
    const direct = link!.replace(/^https?:\/\/[^/]+\/auth/, cfg.KEYCLOAK_ADMIN_URL!);
    const res = await fetch(direct, { redirect: 'manual' });
    expect([200, 302, 303]).toContain(res.status);
    // Keycloak may ask to confirm with a button ("Click here to proceed") before applying the action: follow it if shown.
    if (res.status === 200) {
      const html = await res.text();
      const proceed = /href="([^"]*action-token[^"]*)"/.exec(html)?.[1]?.replace(/&amp;/g, '&');
      if (proceed) await fetch(proceed.replace(/^https?:\/\/[^/]+\/auth/, cfg.KEYCLOAK_ADMIN_URL!), { redirect: 'manual', headers: { cookie: res.headers.get('set-cookie') ?? '' } });
    }
    expect(await kc.emailVerified(id)).toBe(true);
    await fetch(`${MAILPIT}/api/v1/messages`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ IDs: [msg!.ID] }) });
  });
});
