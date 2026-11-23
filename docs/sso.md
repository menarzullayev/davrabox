# Enterprise SSO (LDAP / Active Directory, OIDC, SAML)

DavraBox delegates identity to Keycloak (realm `davrabox`). A customer organization ("tenant") signs in with its own
directory or identity provider. `scripts/keycloak-sso.mjs` configures that in Keycloak through the admin REST API.
It is idempotent: rerunning it with the same config changes nothing, and `--dry-run` shows what would change.

## 1. What the API requires from a token

`apps/api/src/auth/jwt.ts` accepts an access token only if it has `sub`, `email`, `azp=davrabox-web`, a string claim
`org_slug` matching `^[a-z0-9][a-z0-9-]{1,62}$`, and `realm_access.roles` containing `org_admin` or `member`
(`org_admin` wins when both are present). Every SSO path below must therefore end with exactly those claims, and
the tooling guarantees it as described next.

## 2. Tenant and role rules (read this first)

| Rule | How it is enforced | Why |
|---|---|---|
| One organization per identity provider / LDAP federation | `tenant` is mandatory in every config. IdP: a **hardcoded** attribute mapper `davra: org_slug` (sync mode FORCE) writes `org_slug=<tenant>` on every login. LDAP: every user of the federation is put into the Keycloak group `/sso-<tenant>`, which carries the group attribute `org_slug` and the role `member`; the protocol mapper resolves the claim from there. | The org must come from DavraBox configuration, never from the customer's system. |
| An external system can never assert another org | No config key can map a claim, SAML attribute or LDAP attribute to `org_slug` (validation error, also for `claimMappings`, `attributeNames`, `adminRule`, LDAP attributes). An `org_slug` sent by the IdP is not read; FORCE re-applies the hardcoded value at each login. `list` marks any hand-made mapper that writes `org_slug` as `UNSAFE` and `oidc`/`saml` refuse to run while one exists. | A malicious or compromised customer IdP must not be able to join another tenant. |
| A provider is bound to its tenant for life | Re-running with a different `tenant` for an existing alias/federation is refused; `remove` it first. | Prevents silently moving users between tenants. |
| Roles | Everybody from a provider gets `member`. `org_admin` is granted only by an explicit rule you configure: `adminRule` (OIDC claim / SAML attribute equals a value) or `adminGroups` (LDAP groups). No rule, nobody is admin. Rules use mapper sync mode FORCE, so losing the claim/group removes `org_admin` at the next login (LDAP: within `cacheMaxLifespanSeconds`). | Least privilege; deprovisioning of admins. |
| No cross-tenant account takeover through email | The per-IdP first-login flow `sso-broker-<alias>` (a) never shows the profile review page, (b) creates a new user when the email is unknown, (c) when the email matches an existing account: with `trustEmail=true` auto-links it **only if that account's `org_slug` equals this IdP's tenant**, otherwise denies; with `trustEmail=false` (default) it always denies. | Otherwise one customer's IdP could assert `ceo@other-customer.example` and land in that customer's account. |
| Signatures are always validated | OIDC: discovery + JWKS, `validateSignature=true`, PKCE S256. SAML: `validateSignature=true`, `wantAssertionsSigned=true`; metadata without a signing certificate is refused. Entra `common`/`organizations` and Google without a hosted domain are refused. | Unsigned or multi-directory identity is accepted nowhere. |
| No secrets in files | The config JSON may not contain secrets; the bind credential / client secret are read from the environment variable named by `bindCredentialEnv` / `clientSecretEnv`. Output never prints them. Plain `ldap://` without StartTLS is refused unless `allowInsecureLdap` (tests only). | Public repository, least exposure. |

Choose usernames so that two tenants cannot collide: Keycloak usernames are unique per realm. Use the mail address or
`userPrincipalName` as `usernameAttribute` for LDAP/AD when several tenants are federated into one realm.

## 3. Running the tool

```
export KEYCLOAK_URL=https://<host>/auth          # admin API base (default http://127.0.0.1:8180/auth)
export KEYCLOAK_ADMIN_PASSWORD=...               # KEYCLOAK_ADMIN_USER defaults to admin
export KEYCLOAK_PUBLIC_URL=https://<public host>/auth   # what the customer sees (SAML endpoints); default KEYCLOAK_URL
node scripts/keycloak-sso.mjs ldap --config acme-ldap.json  [--realm davrabox] [--dry-run] [--sync]
node scripts/keycloak-sso.mjs oidc --config acme-oidc.json  [--realm davrabox] [--dry-run]
node scripts/keycloak-sso.mjs saml --config acme-saml.json  [--realm davrabox] [--dry-run]
node scripts/keycloak-sso.mjs list   [--realm davrabox]
node scripts/keycloak-sso.mjs remove <alias-or-federation-name> --yes [--realm davrabox]
```

Config is a JSON file and/or repeated `--set key=value` (dotted keys, JSON values). `--force-secrets` pushes the secret
again (the admin API masks stored secrets, so a rotated secret is otherwise not detected). Keep config files out of the
repo if they hold customer hostnames. Exit codes: 0 ok, 1 runtime error, 2 invalid config.

Prerequisite: the realm has the realm roles `member` and `org_admin`, and its client `davrabox-web` has a protocol mapper
that puts the user attribute `org_slug` into the access token (the shipped realm does). The login flow `browser-admin-2fa`
(TOTP for `org_admin`, `scripts/keycloak-admin-2fa.mjs`) applies to SSO logins too, but not to external-IdP logins
(brokered logins use the customer's own MFA); see "Known limits".

## 4. What each customer type needs

### 4.1 Active Directory / LDAP (`ldap`)

Ask the customer for: LDAP(S) URL reachable from Keycloak (firewall!), a read-only service account DN and password,
users DN, the AD or directory vendor, the group(s) whose members are DavraBox admins, and the CA certificate if
`ldaps://` uses a private CA (add it to the Keycloak truststore; not automated by the tool).

| Field | Meaning | Default |
|---|---|---|
| `tenant` (required) | organization slug | |
| `name` | federation name | `ldap-<tenant>` |
| `vendor` | `ad` or `other` | `other` |
| `connectionUrl` (required) | `ldaps://host:636` or `ldap://host:389` | |
| `startTls` / `allowInsecureLdap` | StartTLS; allow cleartext (tests only) | false / false |
| `bindDn` (required), `bindCredentialEnv` | service account, env var holding its password | `SSO_LDAP_BIND_CREDENTIAL` |
| `usersDn` (required), `searchScope` | where users live; `onelevel` or `subtree` | `onelevel` |
| `usernameAttribute`, `rdnAttribute`, `uuidAttribute` | AD: `sAMAccountName`/`cn`/`objectGUID`; other: `uid`/`uid`/`entryUUID` | by vendor |
| `emailAttribute`, `firstNameAttribute`, `lastNameAttribute` | `mail`, `givenName`, `sn` | |
| `userObjectClasses` | list | by vendor |
| `userFilter` | extra LDAP filter, e.g. `(!(employeeType=suspended))` | none |
| `importUsers` | `true` imports users into Keycloak (needed for sync); `false` reads on demand (not covered by tests) | true |
| `connectionPooling` | pooled connections | true |
| `fullSyncPeriod`, `changedSyncPeriod` | seconds, `-1` off | 86400 / 600 |
| `cacheMaxLifespanSeconds` | how long cached group membership may be stale; `0` = no cache | 600 |
| `groupsDn`, `adminGroups` | LDAP groups (by `cn`) whose members become `org_admin`; `groupObjectClass`, `groupMemberAttribute` default `group`/`member` (AD) or `groupOfNames`/`member` | no admins |
| `trustEmail` | mark LDAP emails as verified | false |

Federation is always `READ_ONLY`: DavraBox never writes to the customer directory. Passwords are verified by an LDAP
bind. Active Directory: disabled accounts are handled by Keycloak's built-in AD account-controls mapper (created for
`vendor: ad`); this is not verified against a real AD (see section 7).

```json
{ "tenant": "acme", "vendor": "ad", "connectionUrl": "ldaps://dc1.corp.example:636",
  "bindDn": "CN=svc-davrabox,OU=Service,DC=corp,DC=example",
  "usersDn": "OU=Staff,DC=corp,DC=example", "usernameAttribute": "userPrincipalName",
  "groupsDn": "OU=Groups,DC=corp,DC=example", "adminGroups": ["DavraBox Admins"] }
```
`SSO_LDAP_BIND_CREDENTIAL=... node scripts/keycloak-sso.mjs ldap --config acme-ldap.json --sync`

### 4.2 OIDC: Microsoft Entra ID, Google Workspace, Okta, generic (`oidc`)

Customer registers DavraBox as an application and gives you client id and secret. Give the customer the redirect URI
printed by the tool: `<public>/realms/<realm>/broker/<alias>/endpoint` (alias default `<provider>-<tenant>`, `oidc-<tenant>` for generic).

| Field | Meaning |
|---|---|
| `tenant` (required), `alias`, `displayName` | slug; IdP alias also used as `kc_idp_hint`; button text |
| `provider` | `generic`, `entra`, `okta`, `google` |
| `discoveryUrl` | generic only; https URL of `.well-known/openid-configuration` |
| `azureTenantId` | entra: directory (tenant) GUID or primary domain. `common`/`organizations` refused |
| `oktaDomain`, `oktaAuthorizationServer` | okta: `example.okta.com`; server `default` (custom) or `org` |
| `hostedDomain` | google: Workspace domain, required (restricts sign-in to that domain) |
| `clientId`, `clientSecretEnv` | secret from env, default `SSO_OIDC_CLIENT_SECRET` |
| `scopes` | default `openid email profile` (`... groups` for Okta) |
| `trustEmail` | the IdP's emails are verified (see section 2); default false |
| `claimMappings` | `{claim: userAttribute}`, default email/given_name/family_name; `org_slug` is refused |
| `adminRule` | `{ "claim": "groups", "value": "DavraBox-Admins" }` grants `org_admin` when the claim equals/contains the value |
| `hideOnLogin` | hide the login-page button; users enter through `kc_idp_hint` only |

Per provider on the customer side: **Entra ID**: App registration, Web redirect URI above, client secret; for admin by
group add the optional `groups` claim (token configuration, group IDs) and set `adminRule.claim=groups`, `value=<group
object id>` (or define an App Role and use claim `roles`). **Google Workspace**: OAuth client (Web), `hostedDomain` is the
domain; Google sends no groups, so grant `org_admin` in Keycloak manually. **Okta**: OIDC web app, assign users/groups,
add a `groups` claim to the authorization server, `adminRule.claim=groups`. **Generic**: any OIDC provider with
discovery, signed ID tokens and a client secret.

Direct link to the customer IdP: add `kc_idp_hint=<alias>` to the authorization request (the web app can pass it from
the organization's sign-in page); otherwise the realm login page shows the button.

### 4.3 SAML 2.0, e.g. ADFS, Entra, Okta SAML (`saml`)

Give the customer the values printed by the tool (also `list`): **entity ID / Audience** `<public>/realms/<realm>`,
**ACS URL** (POST) `<public>/realms/<realm>/broker/<alias>/endpoint`, **single logout URL** (same), **SP metadata**
`.../broker/<alias>/endpoint/descriptor`, **NameID format** emailAddress. They give you their IdP metadata.

| Field | Meaning |
|---|---|
| `tenant` (required), `alias` (default `saml-<tenant>`), `displayName` | |
| `metadataUrl` (https) **or** `metadataFile` (path to XML) | exactly one; must contain a signing certificate |
| `preset` | `generic`, `okta` (attribute names `email`/`firstName`/`lastName`), `adfs`, `entra` (Microsoft claim URIs) |
| `attributeNames` | override `{email, firstName, lastName}` attribute names |
| `nameIdFormat` | `email` (default), `persistent`, `transient`, `unspecified` |
| `adminRule` | `{ "attribute": "groups", "value": "DavraBox-Admins" }` |
| `trustEmail`, `signAuthnRequests`, `forceAuthn`, `hideOnLogin` | defaults false |

ADFS: add a Relying Party Trust from the SP metadata URL, send claims E-Mail Address, Given-Name, Surname (and a group
claim), sign the assertion. If the customer uses `signAuthnRequests`, upload the SP signing certificate from the SP metadata.

## 5. Testing

* Unit (no network): `pnpm --filter @davrabox/scripts test` (validation, mapper construction, flow shape, idempotent diffing).
* End to end against the dev stack (needs the shared Keycloak, Docker, Edge): `source scripts/devenv.sh` then
  `node apps/e2e/sso.e2e.mjs`. It starts the OpenLDAP test container `davra-ldap` from
  `deploy/compose/docker-compose.sso.yml` when absent (removes it afterwards unless `E2E_KEEP_LDAP` is set), creates the
  throw-away realms `sso-test-ldap`, `sso-test-idp`, `sso-test-sp` (all deleted at the end) and verifies, through real
  browser logins, claims, tenant override, role mapping, account-takeover refusal and idempotency. The produced tokens
  are checked with the API's own `identityFromClaims` and `createVerifier`.
* Manual: `kc_idp_hint=<alias>` on `/realms/<realm>/protocol/openid-connect/auth`, decode the access token, check `org_slug` and roles.

## 6. Operations

* Deprovisioning: there is no SCIM yet (later phase). A user removed or disabled at the customer is blocked at the next
  authentication that reaches the customer system: LDAP password checks happen live by bind (verified: a suspended account that
  the `userFilter` excludes cannot sign in; an account suspended after it was already imported is removed by the next full
  sync, immediate refusal in between is not verified);
  an already issued access token stays valid until it expires and an existing refresh/SSO session stays valid until its
  lifetime ends (set short SSO session lifetimes for SSO-only realms); OIDC/SAML users keep an existing Keycloak session until
  it expires; they are re-checked at the next login. Group/claim changes (admin removal) apply at the next login (LDAP: within
  `cacheMaxLifespanSeconds`, or at the next full sync). Full LDAP sync removes users that no longer exist or match the filter.
* Rotating a secret: change the env var and rerun with `--force-secrets`.
* Offboarding a customer: `remove <alias|federation>` (LDAP removal deletes the imported users and the tenant group;
  existing brokered users stay as local accounts and should be disabled).
* The compose override `deploy/compose/docker-compose.sso.yml` is for tests only (long-lived container `davra-ldap`,
  128 MB, 127.0.0.1:53389). Never run `docker compose ... --remove-orphans` with it: the main dev stack shares the project name `davra`.

## 7. Known limits and what is not verified

* Verified end to end against Keycloak 26.0 and OpenLDAP 2.4 (see section 5). **Not verified**: a real Active Directory
  (AD defaults, `msad` account-controls mapper, `sAMAccountName`/`userPrincipalName`, nested groups), `ldaps://`/StartTLS with a
  private CA, `importUsers=false`, Microsoft Entra ID, Google Workspace and Okta tenants, ADFS, signed AuthnRequests, SAML
  encryption, single logout with an external IdP, and very large directories (paging is on, never load-tested).
* SCIM provisioning is a later phase; there is no push deprovisioning.
* Brokered (OIDC/SAML) logins do not get DavraBox's TOTP step: the customer's IdP is expected to enforce MFA. The
  `browser-admin-2fa` flow applies to local and LDAP password logins only.
* Without an `adminRule`/`adminGroups`, nobody from that provider is `org_admin`; grant it in Keycloak manually
  (a manual grant is not removed by the tool).
* LDAP group nesting (groups inside groups) is not expanded for `adminGroups`; list the groups whose members are direct.
* `trustEmail=true` should only be used when the customer IdP is the authority for its users' email addresses. The
  tenant guard stops cross-tenant takeover but a same-tenant account can be linked by email.
* IdP users need `email` (and ideally first/last name) in the token/assertion; otherwise Keycloak may ask for profile completion.
