# Calendar integration (Google Calendar and Microsoft Outlook)

A meeting host can add a meeting to their own Google or Outlook calendar. The event carries the title, the time and
the join link and code. If the host lists attendees, the calendar provider sends the invitations; DavraBox never
sends email itself.

Status: implemented and tested against mocked provider HTTP. The real end-to-end check (a real consent screen, a real
event in a real calendar) is BLOCKED until the OAuth apps below are registered and their client ids and secrets are
configured. Nothing in this repository contains credentials.

**Enabled (owner decision 6 of the profile package, 2026-11-27).** Production uses the sign-in OAuth clients
(`IDP_GOOGLE_*`, `IDP_MICROSOFT_*`) for the calendar too unless `GOOGLE_CLIENT_*` / `MS_CLIENT_*` are set, so one app per
provider is enough: it gets a second redirect URI and the calendar scope. Consent is incremental: signing in asks for
`openid email profile` only; the calendar scope is asked for only when a person presses "Connect calendar" (profile page
or a meeting row). Until Google verifies the app, people who connect see Google's "unverified app" warning and at most
100 users can connect (Google's cap for unverified apps with a sensitive scope).

### Owner checklist (production `https://davrabox.bugvector.uz`)
- Google (the same OAuth client as sign-in): add the authorised redirect URI
  `https://davrabox.bugvector.uz/api/v1/calendar/google/callback`; enable the "Google Calendar API" in the project; on the
  consent screen ("Data access") add the scope `https://www.googleapis.com/auth/calendar.events.owned`; then "Verification
  centre" -> submit for verification (needs the privacy policy URL `https://davrabox.bugvector.uz/privacy`, the home page
  `https://davrabox.bugvector.uz/`, the authorised domain `bugvector.uz` verified in Google Search Console, a short video of
  the "Connect calendar" flow and a justification: "creates events for meetings the user hosts in the user's own calendar").
- Microsoft (the same app registration as sign-in): add the Web redirect URI
  `https://davrabox.bugvector.uz/api/v1/calendar/microsoft/callback`; API permissions -> Microsoft Graph, Delegated:
  `Calendars.ReadWrite` (and `offline_access`, `User.Read` which are present by default). No admin consent is needed for
  personal accounts; some work tenants require their admin to approve.

## What the user must do once

The redirect URI is the same host the web app is served from, plus `/api/v1/calendar/<provider>/callback`
(the reverse proxy strips `/api`). For `https://meet.example.com`:

- Google: `https://meet.example.com/api/v1/calendar/google/callback`
- Microsoft: `https://meet.example.com/api/v1/calendar/microsoft/callback`

### Google

1. Google Cloud console: create (or pick) a project; enable the "Google Calendar API".
2. "Google Auth Platform" (OAuth consent screen): set the app name, support email and the domain; add the scope
   `https://www.googleapis.com/auth/calendar.events.owned`. While the app is in "Testing", only listed test users can
   connect. To let anybody connect, publish the app; Google then asks for verification of the sensitive scope (not
   verified here, check the current requirements before launch).
3. Credentials, "Create credentials", "OAuth client ID", type "Web application". Add the authorized redirect URI
   above. Copy the client id and secret.
4. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

### Microsoft

1. Microsoft Entra admin center, "App registrations", "New registration". Supported account types: "Accounts in any
   organizational directory and personal Microsoft accounts" (the endpoint used is `/common`). Redirect URI: platform
   "Web", the URI above.
2. "API permissions": Microsoft Graph, Delegated: `Calendars.ReadWrite` (`offline_access` is requested in the
   authorization request; it is not an admin-consent permission). Some tenants require an admin to approve user
   consent; that is the tenant's choice, not ours.
3. "Certificates and secrets": create a client secret and copy the VALUE once. Secrets expire; note the date.
4. Set `MS_CLIENT_ID` (Application (client) ID) and `MS_CLIENT_SECRET`.

### Server configuration

| Variable | Meaning |
| --- | --- |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google OAuth web client. Both or the provider answers 503. |
| `MS_CLIENT_ID`, `MS_CLIENT_SECRET` | Microsoft app registration. Both or the provider answers 503. |
| `CALENDAR_PUBLIC_URL` | https origin users reach the product on (no path). Used to build the redirect URI and the join link. `deploy/prod/docker-compose.yml` sets it from `PUBLIC_HOST`. http is accepted for localhost only. |
| `FILE_MASTER_KEY` | Already required for file sharing; it also wraps the stored refresh tokens. Without it calendar answers 503. |

Empty values count as "not set". After the user supplies the values, run the manual check at the end of this file and
record the result in `docs/PROGRESS.md`.

## HTTP API

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `GET /v1/calendar` | bearer | `[{provider, configured, connected}]` |
| `GET /v1/calendar/:provider/start` | bearer | 302 to the provider's consent page. With `Accept: application/json` answers `{url}` instead (the web app uses this, a fetch cannot follow a redirect with a bearer token and a plain navigation cannot send one). |
| `GET /v1/calendar/:provider/callback` | none (state) | Provider redirect target. Answers 302 to `<CALENDAR_PUBLIC_URL>/app?calendar=connected\|denied\|error&provider=...`, or 400 for an invalid, expired, reused or foreign-provider state. |
| `DELETE /v1/calendar/:provider` | bearer | Deletes the stored token (and revokes it at Google). `{disconnected}`. |
| `POST /v1/meetings/:code/calendar-event` | bearer, host | Body `{provider, start, end, attendees?}` (ISO 8601 with offset, end after start, at most 12 hours, at most 50 valid emails, unknown fields rejected). Answers 201 `{eventUrl}`. 403 not the host, 404 unknown meeting, 409 not connected or connection expired (reconnect), 502 provider failure, 503 not configured. |

`:provider` is `google` or `microsoft`; anything else is 404.

## Security design

- State and PKCE: `state` (256 bits) and the PKCE verifier are generated server side. The table
  `calendar_oauth_states` keeps only SHA-256(state), the verifier encrypted, the provider, user and organization, and
  an expiry of 10 minutes. The callback is anonymous (the provider redirects the browser without our bearer token), so
  the state row is what identifies the user. It is consumed by a `SECURITY DEFINER` function that deletes and returns
  the row in one statement: single use, and an expired row is deleted but not returned. The table has FORCE row-level
  security and no policy, so the application role cannot read it directly. A state minted for one provider is refused
  on the other provider's callback. At most 5 pending states per user.
- Tokens: only the refresh token is stored, encrypted with the envelope helpers of `apps/api/src/files/crypto.ts`
  (per-record data key wrapped by the master key, AAD = `calendar:<user>:<provider>`, so a blob copied to another row
  fails to decrypt). Access tokens are kept in process memory until shortly before they expire and are never written to
  the database. Microsoft rotates refresh tokens; the new one replaces the stored one. Refreshes of one connection are
  de-duplicated in flight.
- Dead grants: when the provider answers `invalid_grant` or `interaction_required` to a refresh, the stored token is
  deleted, an audit row `calendar.expired` is written and the caller gets 409 "reconnect". Network or 5xx errors keep
  the connection and answer 502.
- Scopes: Google `calendar.events.owned` (create, change, delete events on calendars the user owns; Google lists it
  as accepted for `events.insert` and narrower than `calendar.events`). Microsoft `Calendars.ReadWrite` delegated
  plus `offline_access`; the Graph reference lists `Calendars.ReadWrite` as the least privileged permission for
  `POST /me/events` (there is no events-only Graph permission). If Google's consent screen returns without the
  calendar scope (granular consent), the connection is refused. Tests pin the exact scope strings.
- The client secret is only ever sent to the provider's token (and Google revoke) endpoint over https. The browser is
  redirected only to the configured `CALENDAR_PUBLIC_URL`; nothing from the request is reflected into a redirect.
  The callback sends `Cache-Control: no-store` and `Referrer-Policy: no-referrer` (the URL carries the code).
- Event content: titles are sent as plain text (Microsoft body type `text`), so a meeting title cannot inject markup.
  The passcode is never sent anywhere; an event for a protected meeting says only that a passcode is needed. The event
  link returned to the browser must be https on a provider host, otherwise 502.
- Limits: 20 `start` calls and 30 event creations per user per minute (in memory per API instance).
- Audit rows: `calendar.connect`, `calendar.disconnect`, `calendar.expired`, `calendar.event.create`.
- Disconnect deletes the stored token. Google revocation is best effort. Microsoft has no token revocation endpoint;
  the user removes the app at account.microsoft.com or in their tenant if they want the grant gone there too.

## Provider documentation used (read 2026-11-24)

- Google OAuth 2.0 for web server apps: https://developers.google.com/identity/protocols/oauth2/web-server
  (endpoints `https://accounts.google.com/o/oauth2/v2/auth`, `https://oauth2.googleapis.com/token`,
  `https://oauth2.googleapis.com/revoke`; `access_type=offline`, `prompt`, `state`; `invalid_grant`). The page does
  not describe PKCE for web server apps; PKCE parameters (S256 challenge, `code_verifier`) follow the Google
  desktop-app page https://developers.google.com/identity/protocols/oauth2/native-app , and we also send the client
  secret, which is allowed for a web client. Not confirmed against live Google: that a web client accepts PKCE
  together with a secret (RFC 7636 allows it). Covered only by the manual check below.
- Google Calendar scopes: https://developers.google.com/workspace/calendar/api/auth
- Google `events.insert` (URL, `sendUpdates`, attendees, accepted scopes):
  https://developers.google.com/workspace/calendar/api/v3/reference/events/insert
- Microsoft identity platform authorization code flow (endpoints under `/common/oauth2/v2.0`, PKCE, `client_secret`
  for web apps, refresh requests and rotation, token error codes):
  https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow
- Microsoft Graph create event (`POST /me/events`, `Calendars.ReadWrite`, `webLink`, invitations sent automatically
  when attendees are present): https://learn.microsoft.com/en-us/graph/api/user-post-events?view=graph-rest-1.0

Things that were not read in the docs and are therefore unverified here: Google's verification requirements for
publishing an app with this scope, the lifetime of refresh tokens for a Google app left in "Testing" status, and the
exact consent-screen behaviour in tenants with restricted user consent.

## Manual end-to-end check (after the apps are registered)

1. Sign in as a normal user, create a meeting, press the calendar button on its row, connect Google, grant access.
   Expect to land on `/app` with the toast "Calendar connected".
2. Create the event with one attendee. Expect the event in the Google calendar with the join link and code, and the
   invitation sent by Google to the attendee.
3. Repeat for Microsoft (personal account and a work account).
4. Revoke the app in the provider's account settings, create another event: expect the "reconnect" message and the
   connect button.
5. Disconnect and confirm `calendar_connections` has no row for the user.
