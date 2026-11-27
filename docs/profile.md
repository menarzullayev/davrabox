# Profile page (`/app/profile`)

Owner decisions of 2026-11-27 (`davrabox-builds/decisions/2026-11-27-profile-vs-zoom.md`, decisions 1-3, 5, 6).

## What a person can do
- **Picture**: pick a JPEG/PNG/WebP, crop it to a square in the browser (drag, +/-, arrow keys); the browser re-encodes it
  to a 512 px JPEG (no EXIF/location leaves the device). The API checks the type and size from the bytes (square,
  64-1024 px, at most 2 MB), scans it with ClamAV (fail closed), envelope-encrypts it into the file bucket under
  `avatars/<org>/<user>/<random id>` and serves it at `GET /v1/avatars/<random id>` (no sign-in: the 128-bit id is the
  capability; a new upload gets a new id and deletes the old object). 10 uploads per hour per person.
- **Job title, department** (the organization's list), **phone** (optional, never shown to other participants),
  **time zone, date format, time format** (default: the browser's zone, the product's 24-hour clock). The choices apply to
  every time the app shows (meeting list, recent activity, recordings, sessions). Name and email stay in Keycloak.
- **Security** (Keycloak's own flows, no home-made security code): change/set password (`kc_action=UPDATE_PASSWORD`),
  turn on two-step verification (`CONFIGURE_TOTP`), add a passkey (`webauthn-register-passwordless`), remove a TOTP or
  passkey (`delete_credential:<id>`, Keycloak asks to confirm). "Where you're signed in": Keycloak's live sessions joined
  with what the API saw of each session (browser/device from the user agent, a /24 or /48 network prefix, the city and
  country Cloudflare reports); end one session or all. Linked accounts: Google/Microsoft links can be added (Keycloak
  client-initiated account linking) and removed, but never the last way to sign in. Organization-wide 2FA stays off.
- **Calendar**: connect Google Calendar or Outlook. The calendar scope is requested only when the person presses
  "Connect" (incremental consent); sign-in asks for `openid email profile` only.

## Who sees what (decision 5)
| Viewer | Sees |
| --- | --- |
| everyone in a meeting with the person, guests included | name, picture (join-token attribute `avatar`) |
| members of the same organization | + job title, department (`GET /v1/people/:id`, roster in the call) |
| organization admins | + email, phone |

The notice is on the profile page and in `/privacy` ("Your profile and who sees it").

## API
```
GET    /v1/me/profile                      PUT /v1/me/profile {jobTitle, departmentId, phone, timeZone, dateFormat, timeFormat}
PUT    /v1/me/avatar   (raw image bytes)   DELETE /v1/me/avatar
GET    /v1/me/security                     POST /v1/me/security/sessions/:sid/end   POST /v1/me/security/sessions/end-all
DELETE /v1/me/security/links/:provider     GET /v1/people/:id                        GET /v1/avatars/:id
```
Audit: `profile.update`, `profile.avatar.set`, `profile.avatar.delete`, `security.session.end`, `security.session.end_all`,
`security.link.remove`. Tables: `user_profiles`, `user_session_devices` (see `docs/privacy-data-inventory.md`).

## Operator notes
- Sign-in asks for the second factor only of people who set one up on their profile: realm flow `browser-personal-2fa`
  (a copy of the built-in browser flow; built-in flows cannot be changed) with "Conditional OTP" (authenticator-app code)
  and "Conditional passkey". `scripts/keycloak-onboarding.mjs --env-file .env` creates and binds it (idempotent; `--check`
  reports differences). It leaves a realm alone that runs the enforced organization flow (`scripts/keycloak-admin-2fa.mjs`).
- City in "Where you're signed in" needs Cloudflare's managed transform **Add visitor location headers** (zone
  bugvector.uz, Rules > Transform Rules > Managed Transforms); without it only the country (`CF-IPCountry`) is shown.
- The admin client (`KEYCLOAK_ADMIN_CLIENT_SECRET`) must be able to read users' credentials, sessions and federated
  identities (realm-management `view-users`, `manage-users`), which it already has for the admin console.
