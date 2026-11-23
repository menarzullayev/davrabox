import { describe, expect, it } from 'vitest';
import * as S from './sso.mjs';
import { loadConfig, parseCli } from '../keycloak-sso.mjs';

const ldapBase = {
  tenant: 'acme',
  connectionUrl: 'ldaps://dc1.corp.example:636',
  bindDn: 'cn=svc,ou=services,dc=corp,dc=example',
  usersDn: 'ou=people,dc=corp,dc=example',
};
const oidcBase = { tenant: 'acme', provider: 'generic', discoveryUrl: 'https://idp.example/.well-known/openid-configuration', clientId: 'davrabox' };
const samlBase = { tenant: 'acme', metadataUrl: 'https://idp.example/metadata' };

describe('tenant and secrets', () => {
  it('rejects bad tenant slugs', () => {
    for (const t of ['', 'A', 'a', 'Acme', 'a b', '-acme', 'x'.repeat(64), 'acme_corp']) {
      expect(() => S.validateLdapConfig({ ...ldapBase, tenant: t })).toThrow(S.ConfigError);
    }
    expect(S.validateLdapConfig({ ...ldapBase, tenant: 'acme-2' }).tenant).toBe('acme-2');
  });
  it('rejects secrets in the config file but accepts *Env names', () => {
    expect(() => S.validateLdapConfig({ ...ldapBase, bindCredential: 'x' })).toThrow(/secrets must not be put/);
    expect(() => S.validateOidcConfig({ ...oidcBase, clientSecret: 'x' })).toThrow(/secrets must not be put/);
    expect(() => S.validateOidcConfig({ ...oidcBase, clientSecretEnv: 'not an env name' })).toThrow(/environment variable name/);
    expect(S.validateOidcConfig({ ...oidcBase, clientSecretEnv: 'MY_SECRET' }).clientSecretEnv).toBe('MY_SECRET');
  });
  it('rejects unknown keys', () => {
    expect(() => S.validateSamlConfig({ ...samlBase, orgSlug: 'other' })).toThrow(/unknown config key/);
    expect(() => S.validateSamlConfig({ ...samlBase, org_slug: 'other' })).toThrow(/unknown config key/);
  });
});

describe('ldap config', () => {
  it('applies AD and generic defaults', () => {
    const ad = S.validateLdapConfig({ ...ldapBase, vendor: 'ad' });
    expect(ad.usernameAttribute).toBe('sAMAccountName');
    expect(ad.uuidAttribute).toBe('objectGUID');
    expect(ad.userObjectClasses).toContain('user');
    const other = S.validateLdapConfig(ldapBase);
    expect(other.usernameAttribute).toBe('uid');
    expect(other.name).toBe('ldap-acme');
    expect(other.importUsers).toBe(true);
    expect(other.connectionPooling).toBe(true);
  });
  it('refuses cleartext ldap:// unless startTls or explicitly allowed', () => {
    const plain = { ...ldapBase, connectionUrl: 'ldap://dc:389' };
    expect(() => S.validateLdapConfig(plain)).toThrow(/clear text/);
    expect(S.validateLdapConfig({ ...plain, startTls: true }).startTls).toBe(true);
    expect(S.validateLdapConfig({ ...plain, allowInsecureLdap: true }).allowInsecureLdap).toBe(true);
    expect(() => S.validateLdapConfig({ ...ldapBase, startTls: true })).toThrow(/ldaps/);
  });
  it('validates urls, DNs, filters and groups', () => {
    expect(() => S.validateLdapConfig({ ...ldapBase, connectionUrl: 'http://dc' })).toThrow(S.ConfigError);
    expect(() => S.validateLdapConfig({ ...ldapBase, bindDn: 'admin' })).toThrow(/DN/);
    expect(() => S.validateLdapConfig({ ...ldapBase, userFilter: 'employeeType=x' })).toThrow(/parenthesised/);
    expect(() => S.validateLdapConfig({ ...ldapBase, adminGroups: ['a'] })).toThrow(/groupsDn/);
    expect(() => S.validateLdapConfig({ ...ldapBase, fullSyncPeriod: 'daily' })).toThrow(/integer/);
    expect(() => S.validateLdapConfig({ ...ldapBase, vendor: 'novell' })).toThrow(/one of/);
  });
  it('builds a read-only component with sync periods and pooling', () => {
    const c = S.validateLdapConfig({ ...ldapBase, userFilter: '(!(employeeType=suspended))' });
    const comp = S.buildLdapComponent(c, 'realm-id', 's3cret');
    expect(comp.parentId).toBe('realm-id');
    expect(comp.config.editMode).toEqual(['READ_ONLY']);
    expect(comp.config.bindCredential).toEqual(['s3cret']);
    expect(comp.config.connectionPooling).toEqual(['true']);
    expect(comp.config.fullSyncPeriod).toEqual(['86400']);
    expect(comp.config.customUserSearchFilter).toEqual(['(!(employeeType=suspended))']);
    expect(comp.config.cachePolicy).toEqual(['MAX_LIFESPAN']);
    expect(comp.config.maxLifespan).toEqual(['600000']);
    expect(S.buildLdapComponent(S.validateLdapConfig({ ...ldapBase, cacheMaxLifespanSeconds: 0 }), 'r', 'x').config.cachePolicy).toEqual(['NO_CACHE']);
    expect(() => S.validateLdapConfig({ ...ldapBase, cacheMaxLifespanSeconds: -5 })).toThrow(S.ConfigError);
    const noImport = S.buildLdapComponent(S.validateLdapConfig({ ...ldapBase, importUsers: false }), 'r', 'x');
    expect(noImport.config.importEnabled).toEqual(['false']);
    expect(noImport.config.fullSyncPeriod).toEqual(['-1']);
  });
  it('maps every user into the tenant group and admin groups under it', () => {
    const c = S.validateLdapConfig({ ...ldapBase, groupsDn: 'ou=groups,dc=corp,dc=example', adminGroups: ['DavraBox Admins', 'IT (core)*'] });
    const ms = S.buildLdapMappers(c, 'fed');
    const tenant = ms.find((m) => m.providerId === 'hardcoded-ldap-group-mapper');
    expect(tenant.config.group).toEqual(['/sso-acme']);
    const admin = ms.find((m) => m.providerId === 'group-ldap-mapper');
    expect(admin.config['groups.path']).toEqual(['/sso-acme']);
    expect(admin.config['groups.ldap.filter'][0]).toBe('(|(cn=DavraBox Admins)(cn=IT \\28core\\29\\2a))');
    expect(ms.every((m) => m.parentId === 'fed')).toBe(true);
    // No admin groups: no admin mapper (nobody becomes org_admin).
    expect(S.buildLdapMappers(S.validateLdapConfig(ldapBase), 'fed').some((m) => m.providerId === 'group-ldap-mapper')).toBe(false);
  });
  it('never maps an LDAP attribute to org_slug', () => {
    const c = S.validateLdapConfig({ ...ldapBase, emailAttribute: 'org_slug' });
    expect(() => S.buildLdapMappers(c, 'fed')).toThrow(/org_slug/);
  });
  it('escapes LDAP filter metacharacters', () => {
    expect(S.ldapFilterEscape('a*)(uid=*))(|(x=')).toBe('a\\2a\\29\\28uid=\\2a\\29\\29\\28|\\28x=');
    expect(S.ldapFilterEscape('back\\slash')).toBe('back\\5cslash');
  });
});

describe('oidc config', () => {
  it('builds discovery urls for presets', () => {
    expect(S.validateOidcConfig({ tenant: 'acme', provider: 'entra', azureTenantId: '11111111-2222-3333-4444-555555555555', clientId: 'c' }).discoveryUrl).toBe(
      'https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0/.well-known/openid-configuration',
    );
    expect(S.validateOidcConfig({ tenant: 'acme', provider: 'okta', oktaDomain: 'acme.okta.com', clientId: 'c' }).discoveryUrl).toBe('https://acme.okta.com/oauth2/default/.well-known/openid-configuration');
    expect(S.validateOidcConfig({ tenant: 'acme', provider: 'okta', oktaDomain: 'acme.okta.com', oktaAuthorizationServer: 'org', clientId: 'c' }).discoveryUrl).toBe('https://acme.okta.com/.well-known/openid-configuration');
    expect(S.validateOidcConfig({ tenant: 'acme', provider: 'okta', oktaDomain: 'acme.okta.com', clientId: 'c' }).scopes).toContain('groups');
  });
  it('refuses multi-tenant Entra endpoints, http discovery and Google without a domain', () => {
    for (const t of ['common', 'organizations', 'consumers']) {
      expect(() => S.validateOidcConfig({ tenant: 'acme', provider: 'entra', azureTenantId: t, clientId: 'c' })).toThrow(/accept any directory/);
    }
    expect(() => S.validateOidcConfig({ ...oidcBase, discoveryUrl: 'http://idp.example/.well-known/openid-configuration' })).toThrow(/https/);
    expect(S.validateOidcConfig({ ...oidcBase, discoveryUrl: 'http://idp.example/x', allowInsecureHttp: true }).discoveryUrl).toBe('http://idp.example/x');
    expect(() => S.validateOidcConfig({ tenant: 'acme', provider: 'google', clientId: 'c' })).toThrow(/hostedDomain/);
    expect(() => S.validateOidcConfig({ ...oidcBase, hostedDomain: 'example.com' })).toThrow(/only applies/);
  });
  it('cannot map any claim to org_slug (either direction)', () => {
    expect(() => S.validateOidcConfig({ ...oidcBase, claimMappings: { org_slug: 'org_slug' } })).toThrow(/org_slug/);
    expect(() => S.validateOidcConfig({ ...oidcBase, claimMappings: { tenant: 'org_slug' } })).toThrow(/org_slug/);
    expect(() => S.validateOidcConfig({ ...oidcBase, claimMappings: { org_slug: 'department' } })).toThrow(/org_slug/);
    expect(() => S.validateOidcConfig({ ...oidcBase, claimMappings: { ORG_SLUG: 'x' } })).toThrow(/org_slug/);
    expect(() => S.validateOidcConfig({ ...oidcBase, adminRule: { claim: 'org_slug', value: 'x' } })).toThrow(/org_slug/);
  });
  it('google has no claim or role mapping', () => {
    const g = { tenant: 'acme', provider: 'google', hostedDomain: 'example.com', clientId: 'c' };
    expect(S.validateOidcConfig(g).alias).toBe('google-acme');
    expect(() => S.validateOidcConfig({ ...g, adminRule: { claim: 'groups', value: 'a' } })).toThrow(/Google sends no group claims/);
  });
  it('builds an IdP with signature validation, PKCE and a hardcoded tenant mapper', () => {
    const c = S.validateOidcConfig({ ...oidcBase, adminRule: { claim: 'groups', value: 'DavraBox-Admins' } });
    const imported = { authorizationUrl: 'https://idp/auth', tokenUrl: 'https://idp/token', jwksUrl: 'https://idp/jwks', issuer: 'https://idp' };
    const idp = S.buildOidcIdp(c, imported, 'sec');
    expect(idp.providerId).toBe('oidc');
    expect(idp.trustEmail).toBe(false);
    expect(idp.config).toMatchObject({ validateSignature: 'true', useJwksUrl: 'true', pkceEnabled: 'true', clientSecret: 'sec', syncMode: 'FORCE' });
    expect(idp.firstBrokerLoginFlowAlias).toBe('sso-broker-oidc-acme');
    const ms = S.buildIdpMappers(c);
    expect(ms.find((m) => m.identityProviderMapper === 'hardcoded-attribute-idp-mapper').config).toMatchObject({ attribute: 'org_slug', 'attribute.value': 'acme', syncMode: 'FORCE' });
    expect(ms.find((m) => m.name === 'davra: admin role').config).toMatchObject({ claim: 'groups', 'claim.value': 'DavraBox-Admins', role: 'org_admin' });
    expect(ms.find((m) => m.name === 'davra: default role').config.role).toBe('member');
    expect(S.unsafeOrgSlugMappers(ms)).toEqual([]);
    expect(() => S.buildOidcIdp(c, { issuer: 'x' }, 's')).toThrow(/cannot validate signatures/);
  });
  it('without an adminRule nobody can become org_admin', () => {
    const ms = S.buildIdpMappers(S.validateOidcConfig(oidcBase));
    expect(ms.some((m) => m.config.role === 'org_admin')).toBe(false);
  });
});

describe('saml config', () => {
  it('needs exactly one metadata source', () => {
    expect(() => S.validateSamlConfig({ tenant: 'acme' })).toThrow(/exactly one/);
    expect(() => S.validateSamlConfig({ ...samlBase, metadataFile: 'm.xml' })).toThrow(/exactly one/);
    expect(S.validateSamlConfig({ tenant: 'acme', metadataFile: 'm.xml' }).metadataFile).toBe('m.xml');
    expect(() => S.validateSamlConfig({ tenant: 'acme', metadataUrl: 'http://idp/m' })).toThrow(/https/);
  });
  it('uses preset attribute names and refuses org_slug', () => {
    expect(S.validateSamlConfig({ ...samlBase, preset: 'adfs' }).attributeNames.email).toMatch(/emailaddress$/);
    expect(S.validateSamlConfig(samlBase).attributeNames.email).toBe('email');
    expect(() => S.validateSamlConfig({ ...samlBase, attributeNames: { email: 'org_slug' } })).toThrow(/org_slug/);
    expect(() => S.validateSamlConfig({ ...samlBase, adminRule: { attribute: 'org_slug', value: 'x' } })).toThrow(/org_slug/);
    expect(() => S.validateSamlConfig({ ...samlBase, nameIdFormat: 'kerberos' })).toThrow(/one of/);
  });
  it('always validates signatures and refuses metadata without a signing certificate', () => {
    const c = S.validateSamlConfig({ ...samlBase, adminRule: { attribute: 'groups', value: 'Admins' } });
    const imported = { singleSignOnServiceUrl: 'https://idp/sso', signingCertificate: 'MIIC' };
    const idp = S.buildSamlIdp(c, imported);
    expect(idp.config).toMatchObject({ validateSignature: 'true', wantAssertionsSigned: 'true', signingCertificate: 'MIIC', nameIDPolicyFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress' });
    expect(() => S.buildSamlIdp(c, { singleSignOnServiceUrl: 'https://idp/sso' })).toThrow(/signing certificate/);
    expect(() => S.buildSamlIdp(c, { signingCertificate: 'x' })).toThrow(/SingleSignOnService/);
    const ms = S.buildIdpMappers(c);
    expect(ms.find((m) => m.name === 'davra: admin role')).toMatchObject({ identityProviderMapper: 'saml-role-idp-mapper', config: { 'attribute.name': 'groups', 'attribute.value': 'Admins', role: 'org_admin' } });
    expect(ms.filter((m) => m.identityProviderMapper === 'saml-user-attribute-idp-mapper')).toHaveLength(3);
  });
  it('prints the service provider endpoints for the customer', () => {
    expect(S.spInfo('https://sso.example/auth/', 'davrabox', 'saml-acme')).toEqual({
      entityId: 'https://sso.example/auth/realms/davrabox',
      acsUrl: 'https://sso.example/auth/realms/davrabox/broker/saml-acme/endpoint',
      metadataUrl: 'https://sso.example/auth/realms/davrabox/broker/saml-acme/endpoint/descriptor',
      singleLogoutUrl: 'https://sso.example/auth/realms/davrabox/broker/saml-acme/endpoint',
      nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    });
  });
});

describe('first broker login flow', () => {
  it('auto-links only behind a tenant guard when email is trusted', () => {
    const sig = S.specSignature(S.brokerFlowSpec('oidc-acme', 'acme', true));
    expect(sig).toEqual([
      '0|idp-create-user-if-unique|ALTERNATIVE',
      '0|flow:sso-broker-oidc-acme link existing|ALTERNATIVE',
      '1|idp-auto-link|REQUIRED',
      '1|flow:sso-broker-oidc-acme tenant guard|CONDITIONAL',
      '2|conditional-user-attribute|REQUIRED',
      '2|deny-access-authenticator|REQUIRED',
    ]);
    const guard = S.brokerFlowSpec('oidc-acme', 'acme', true).find((e) => e.provider === 'conditional-user-attribute');
    expect(guard.config).toEqual({ attribute_name: 'org_slug', attribute_expected_value: 'acme', not: 'true' });
  });
  it('has no auto-link and no profile review page when email is not trusted', () => {
    const spec = S.brokerFlowSpec('saml-acme', 'acme', false);
    expect(spec.some((e) => e.provider === 'idp-auto-link')).toBe(false);
    expect(spec.some((e) => e.provider === 'idp-review-profile')).toBe(false);
    expect(spec.at(-1).provider).toBe('deny-access-authenticator');
  });
  it('compares Keycloak execution lists with the spec', () => {
    const spec = S.brokerFlowSpec('a', 't1', false);
    const actual = spec.map((e) => ({ level: e.level, authenticationFlow: e.type === 'flow', displayName: e.alias, providerId: e.provider, requirement: e.requirement }));
    expect(S.executionsSignature(actual)).toEqual(S.specSignature(spec));
    actual[0].requirement = 'DISABLED';
    expect(S.executionsSignature(actual)).not.toEqual(S.specSignature(spec));
  });
});

describe('idempotent diffing', () => {
  it('compares only desired keys and normalises scalars/arrays', () => {
    expect(S.diffConfig({ a: ['1'], b: 'x', extra: ['k'] }, { a: '1', b: ['x'] })).toEqual([]);
    expect(S.diffConfig({ a: ['1'] }, { a: ['2'], c: 'n' })).toEqual(['a', 'c']);
    expect(S.diffConfig({}, { a: 'true' })).toEqual(['a']);
  });
  it('treats a masked stored secret as unchanged unless forced', () => {
    const existing = { bindCredential: [S.MASK], bindDn: ['cn=x'] };
    expect(S.diffConfig(existing, { bindCredential: ['new'], bindDn: ['cn=x'] }, { secretKeys: ['bindCredential'] })).toEqual([]);
    expect(S.diffConfig(existing, { bindCredential: ['new'] }, { secretKeys: ['bindCredential'], forceSecrets: true })).toEqual(['bindCredential']);
  });
  it('plans create / update / same / remove for managed mappers only', () => {
    const c = S.validateOidcConfig({ ...oidcBase, adminRule: { claim: 'groups', value: 'A' } });
    const want = S.buildIdpMappers(c);
    const asExisting = want.map((m, i) => ({ ...m, id: `id${i}` }));
    const first = S.planNamed([], want, { kindOf: S.idpMapperKind });
    expect(first.create).toHaveLength(want.length);
    const again = S.planNamed(asExisting, want, { kindOf: S.idpMapperKind });
    expect(again.create.concat(again.update, again.remove)).toEqual([]);
    expect(again.same).toHaveLength(want.length);
    // The admin rule disappears from the config: the managed admin mapper is removed, a foreign mapper is kept.
    const without = S.buildIdpMappers(S.validateOidcConfig(oidcBase));
    const foreign = { name: 'customer own mapper', identityProviderMapper: 'oidc-hardcoded-role-idp-mapper', config: { role: 'x' }, id: 'f' };
    const p = S.planNamed([...asExisting, foreign], without, { kindOf: S.idpMapperKind });
    expect(p.remove.map((m) => m.name)).toEqual(['davra: admin role']);
    // Changed claim value -> update with the changed key.
    const changed = asExisting.map((m) => (m.name === 'davra: admin role' ? { ...m, config: { ...m.config, 'claim.value': 'OLD' } } : m));
    const u = S.planNamed(changed, want, { kindOf: S.idpMapperKind });
    expect(u.update).toHaveLength(1);
    expect(u.update[0].changes).toEqual(['claim.value']);
    // Kind change = remove + create.
    const k = S.planNamed([{ ...asExisting[0], identityProviderMapper: 'oidc-user-attribute-idp-mapper' }], [want[0]], { kindOf: S.idpMapperKind });
    expect(k.remove).toHaveLength(1);
    expect(k.create).toHaveLength(1);
  });
  it('refuses to move a provider to another tenant', () => {
    expect(() => S.assertTenantUnchanged('acme', 'other-org', 'identity provider "x"')).toThrow(/exactly one organization/);
    expect(() => S.assertTenantUnchanged(undefined, 'acme', 'x')).not.toThrow();
    expect(() => S.assertTenantUnchanged('acme', 'acme', 'x')).not.toThrow();
  });
  it('detects the tenant of an IdP and unsafe org_slug mappers', () => {
    const ms = S.buildIdpMappers(S.validateOidcConfig(oidcBase));
    expect(S.idpTenant(ms)).toBe('acme');
    const evil = { name: 'x', identityProviderMapper: 'oidc-user-attribute-idp-mapper', config: { claim: 'org_slug', 'user.attribute': 'org_slug' } };
    expect(S.unsafeOrgSlugMappers([...ms, evil])).toEqual([evil]);
  });
});

describe('cli helpers', () => {
  it('parses flags and merges --set over the json file', () => {
    const { cmd, flags } = parseCli(['oidc', '--config', 'c.json', '--set', 'tenant=beta', '--set', 'claimMappings={"email":"email"}', '--dry-run']);
    expect(cmd).toBe('oidc');
    expect(flags.realm).toBe('davrabox');
    const cfg = loadConfig(flags, () => '{"tenant":"acme","clientId":"x"}');
    expect(cfg).toEqual({ tenant: 'beta', clientId: 'x', claimMappings: { email: 'email' } });
    expect(() => loadConfig({ config: 'c.json' }, () => '{bad')).toThrow(S.ConfigError);
    expect(() => loadConfig({ set: ['novalue'] })).toThrow(/key=value/);
  });
  it('a --set cannot smuggle a secret into the config', () => {
    const cfg = loadConfig({ set: ['clientSecret=abc'] });
    expect(() => S.validateOidcConfig({ ...oidcBase, ...cfg })).toThrow(/secrets must not be put/);
  });
});
