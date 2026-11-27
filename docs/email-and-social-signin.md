# Email, password reset and Google / Microsoft sign-in

Owner decisions of 2026-11-27 (`davrabox-builds/decisions/2026-11-27-signup-onboarding.md`, decisions 1, 2 and 4).

## What it does

- **Email** goes out through a DavraBox-only Brevo account (SMTP relay), sender `no-reply@mail.davrabox.bugvector.uz`.
  Keycloak sends it: the "confirm your email" link and the "reset your password" link, in the account's language
  (uz / ru / en, branded theme in `deploy/helm/davrabox/files/keycloak-theme/email`).
- **Verification never blocks** (decision 2): the organisation opens at once; the email is sent right after sign-up, the
  home screen shows a "Verify your email" step and, once the "Get started" card is closed, a reminder with "Send the link".
- **Forgot password?** is on the sign-in page once the realm has a mail server (the script switches it on only then).
- **Google and Microsoft** are Keycloak identity providers. A first sign-in creates the account; the app then asks for the
  organisation name once (`POST /api/v1/onboarding/organization`) and opens a 7-day trial with the person as administrator.
  Someone who was invited (an account with that email already exists) is linked to that account instead and joins their
  organisation.
  - Google: `trustEmail` on (Google only returns verified addresses), so the address counts as verified.
  - Microsoft: `trustEmail` **off**. A Microsoft (Entra) directory administrator can type any address into an account
    ("nOAuth"); trusting it would let such an account take over an existing DavraBox account. Linking a Microsoft account
    to an existing DavraBox account therefore always needs that account's password or a link sent to its mailbox. A new
    Microsoft person gets the organisation at once and verifies the address like a form sign-up.
- The sign-up page shows only the buttons the realm really has (`GET /api/v1/public/signin-options`, cached 60 s).

## Owner steps (never paste keys into chats or prompts)

### 1. Brevo account and SMTP key

1. Create a new Brevo account for DavraBox only (free plan; check the current daily limit on Brevo's pricing page; it is
   shared by verification, reset and invitation emails).
2. Senders, Domains: add the domain `mail.davrabox.bugvector.uz` and open "Authenticate". Brevo shows the DNS records
   (a `brevo-code` TXT, DKIM records, DMARC). Copy them into a file `brevo-records.json` (format in
   `scripts/cloudflare-mail-dns.mjs`) and hand the FILE path over, or add them yourself in Cloudflare. They are public DNS
   values, not secrets.
3. Senders: add the sender `no-reply@mail.davrabox.bugvector.uz`, name `DavraBox`.
4. SMTP & API, SMTP tab: create an SMTP key. Put the login and the key into the production server's
   `/opt/davrabox/repo/deploy/prod/.env` yourself:

   ```
   KC_SMTP_HOST=smtp-relay.brevo.com
   KC_SMTP_PORT=587
   KC_SMTP_USER=<SMTP login>
   KC_SMTP_PASSWORD=<SMTP key>
   KC_SMTP_FROM=no-reply@mail.davrabox.bugvector.uz
   KC_SMTP_FROM_NAME=DavraBox
   ```

### 2. DNS (Cloudflare zone bugvector.uz)

```
node scripts/cloudflare-mail-dns.mjs --records brevo-records.json --dry-run
node scripts/cloudflare-mail-dns.mjs --records brevo-records.json
```

It uses the cloudflared `cert.pem` token that already manages the zone, adds SPF (`v=spf1 include:spf.brevo.com ~all`)
and DMARC at `p=none` if Brevo's list has none, and is idempotent. Then press "Verify" in Brevo. Tighten DMARC to
`p=quarantine` after a few weeks of clean reports (deliverability warm-up).

### 3. Google OAuth app

Google Cloud console, a project for DavraBox:
1. OAuth consent screen: External; app name DavraBox; support email; authorised domain `bugvector.uz`; scopes
   `openid`, `email`, `profile` only (no verification review is needed for these); publish the app ("In production").
2. Credentials, Create credentials, OAuth client ID, type **Web application**. Authorised redirect URI:
   - `https://davrabox.bugvector.uz/auth/realms/davrabox/broker/google/endpoint`
   - (staging, optional) `https://davrabox-staging.bugvector.uz/auth/realms/davrabox/broker/google/endpoint`
3. Put the client ID and secret into the server `.env`: `IDP_GOOGLE_CLIENT_ID=`, `IDP_GOOGLE_CLIENT_SECRET=`.

### 4. Microsoft app

Microsoft Entra admin center, App registrations, New registration:
1. Name DavraBox; supported account types: **Accounts in any organizational directory and personal Microsoft accounts**.
2. Redirect URI, platform **Web**:
   - `https://davrabox.bugvector.uz/auth/realms/davrabox/broker/microsoft/endpoint`
   - (staging, optional) `https://davrabox-staging.bugvector.uz/auth/realms/davrabox/broker/microsoft/endpoint`
3. Certificates & secrets, New client secret (note the expiry date: the button stops working when it expires).
4. API permissions: Microsoft Graph `User.Read` (delegated; present by default).
5. Put the Application (client) ID and the secret VALUE into the server `.env`: `IDP_MICROSOFT_CLIENT_ID=`,
   `IDP_MICROSOFT_CLIENT_SECRET=`.

## Apply on the server (operator)

After the release with this change is deployed and `.env` has the values (nothing is typed on the command line; the
script reads `.env`; it never prints a secret):

```
cd /opt/davrabox/repo/deploy/prod
docker compose --env-file .env -f docker-compose.yml -f docker-compose.shared-host.yml restart keycloak   # loads the email theme (login down ~20-60 s)
cd /opt/davrabox/repo && git pull --ff-only && cd deploy/prod      # the sparse checkout includes scripts/
KEYCLOAK_URL=http://127.0.0.1:8180/auth node ../../scripts/keycloak-onboarding.mjs --env-file .env --check
KEYCLOAK_URL=http://127.0.0.1:8180/auth node ../../scripts/keycloak-onboarding.mjs --env-file .env
```

`--env-file` reads only the variables the script needs (the production `.env` has CRLF line ends, which a shell `source`
would turn into wrong passwords). The script is idempotent. After a key rotation run it with `--force-secrets` (Keycloak never shows a stored secret, so a
change cannot be detected). Without `KC_SMTP_HOST` it leaves mail alone; without both `IDP_*` values of a provider it does
not create that provider (no half-configured button).

Check: sign up with a real mailbox (the verification email arrives), "Forgot password?" (the reset email arrives), and the
Google / Microsoft buttons on `/app/signup` once the apps exist.

## Staging and tests

- The dev stack has a Mailpit catcher (`davra-mailpit`, inbox and API on `http://127.0.0.1:58025`, loopback only).
  `deploy/compose/dev.env` sets `KC_SMTP_HOST=mailpit`, `KC_SMTP_PORT=1025`. Run `scripts/keycloak-onboarding.mjs` once
  after the realm is imported.
- In the dev stack Keycloak builds links from the address it was called on: emails triggered by the API (verification)
  point to `http://127.0.0.1:8180/auth/...`, emails triggered from the browser (reset) to the browser's host.
  Production sets `--hostname`, so every link uses the public host.
- `apps/api/test/onboarding-keycloak.test.ts` sends a real email through Keycloak into Mailpit and follows the link;
  `apps/e2e/onboarding.e2e.mjs` covers sign-up, the checklist, the verification link, password reset and a first
  external sign-in (simulated by an account linked to a throw-away identity provider).

## Rollback

- Emails: remove `KC_SMTP_*` from `.env` does NOT remove the realm setting; to stop sending, clear the SMTP host in the
  Keycloak admin console (Realm settings, Email) or set `resetPasswordAllowed` off there.
- A provider: Identity providers, disable or delete `google` / `microsoft`; the sign-up page drops the button within a minute.
