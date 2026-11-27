import { describe, expect, it } from 'vitest';
import { MASK, desiredProviders, desiredRealm, diff } from './keycloak-onboarding.mjs';

describe('desiredRealm', () => {
  it('always turns reset password on, keeps verify-email non-blocking and sets the branded email theme', () => {
    expect(desiredRealm({})).toEqual({ resetPasswordAllowed: true, verifyEmail: false, emailTheme: 'davrabox' });
  });
  it('builds an authenticated STARTTLS server from the environment (Brevo style)', () => {
    const r = desiredRealm({ KC_SMTP_HOST: 'smtp-relay.brevo.com', KC_SMTP_PORT: '587', KC_SMTP_USER: 'u', KC_SMTP_PASSWORD: 'p', KC_SMTP_FROM: 'no-reply@mail.davrabox.bugvector.uz' });
    expect(r.smtpServer).toEqual({
      host: 'smtp-relay.brevo.com',
      port: '587',
      from: 'no-reply@mail.davrabox.bugvector.uz',
      fromDisplayName: 'DavraBox',
      starttls: 'true',
      ssl: 'false',
      auth: 'true',
      user: 'u',
      password: 'p',
    });
  });
  it('a local catcher (port 1025) gets no TLS and no auth; port 465 gets implicit TLS', () => {
    expect(desiredRealm({ KC_SMTP_HOST: 'mailpit', KC_SMTP_PORT: '1025', KC_SMTP_FROM: 'a@b.c' }).smtpServer).toMatchObject({ starttls: 'false', ssl: 'false', auth: 'false' });
    expect(desiredRealm({ KC_SMTP_HOST: 'h', KC_SMTP_PORT: '465', KC_SMTP_FROM: 'a@b.c' }).smtpServer).toMatchObject({ starttls: 'false', ssl: 'true' });
  });
  it('refuses a half configuration instead of writing a broken mail server', () => {
    expect(() => desiredRealm({ KC_SMTP_HOST: 'h' })).toThrow(/KC_SMTP_FROM/);
    expect(() => desiredRealm({ KC_SMTP_HOST: 'h', KC_SMTP_FROM: 'a@b.c', KC_SMTP_USER: 'u' })).toThrow(/KC_SMTP_PASSWORD/);
  });
});

describe('desiredProviders', () => {
  it('creates nothing without credentials', () => {
    expect(desiredProviders({})).toEqual([]);
  });
  it('Google trusts the email, Microsoft never does (no account takeover through an Entra-set address)', () => {
    const p = desiredProviders({ IDP_GOOGLE_CLIENT_ID: 'g', IDP_GOOGLE_CLIENT_SECRET: 'gs', IDP_MICROSOFT_CLIENT_ID: 'm', IDP_MICROSOFT_CLIENT_SECRET: 'ms' });
    expect(p.map((x) => [x.alias, x.trustEmail, x.firstBrokerLoginFlowAlias])).toEqual([
      ['google', true, 'first broker login'],
      ['microsoft', false, 'first broker login'],
    ]);
    expect(p[0].config).toMatchObject({ clientId: 'g', clientSecret: 'gs', syncMode: 'IMPORT' });
  });
  it('refuses an id without its secret', () => {
    expect(() => desiredProviders({ IDP_GOOGLE_CLIENT_ID: 'g' })).toThrow(/together/);
  });
});

describe('diff', () => {
  it('reports changed plain fields and nested ones', () => {
    expect(diff({ a: 1, s: { host: 'x' } }, { a: 1, s: { host: 'y' } })).toEqual(['s.host']);
  });
  it('a masked stored secret counts as equal unless secrets are forced', () => {
    expect(diff({ smtp: { password: MASK } }, { smtp: { password: 'new' } })).toEqual([]);
    expect(diff({ smtp: { password: MASK } }, { smtp: { password: 'new' } }, '', true)).toEqual(['smtp.password']);
    expect(diff({}, { config: { clientSecret: 's' } })).toEqual(['config.clientSecret']);
  });
  it('compares booleans and numbers as Keycloak returns them (strings in config maps)', () => {
    expect(diff({ resetPasswordAllowed: true, port: '587' }, { resetPasswordAllowed: true, port: 587 })).toEqual([]);
  });
});
