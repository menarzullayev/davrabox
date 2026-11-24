# Personal data inventory

Status: draft of 2026-11-24, written against migrations 001-013 and the code on `feat/privacy`. It is an engineering document, not legal advice. The legal wording (controller, legal basis, cross-border transfer) is for an Uzbekistan IT and data-protection lawyer to confirm (see "Open questions" at the end).

How this was checked: the table list below was compared with `information_schema` of a freshly migrated database, and `apps/api/test/privacy-inventory.test.ts` fails when a table exists in the schema but is missing from this file. Behaviour statements (retention, deletion) are covered by `privacy.test.ts` and `privacy-retention.test.ts`.

Vocabulary: **erasure** = the anonymisation in `privacy.service.ts` (`DELETE /v1/me`, `DELETE /v1/admin/users/:id`): the `users` row stays as a tombstone, personal fields become constants, the identity-provider account is deleted. **Retention job** = `apps/api/src/privacy/retention.job.ts`, hourly, advisory-lock protected.

## 1. PostgreSQL tables

Every tenant table has `FORCE ROW LEVEL SECURITY` keyed on `app.current_org`; the application role (`davra_app`) cannot bypass it. "Org admin" means a user with the `org_admin` role of the same organization.

| Table | Personal data | Purpose | Retention | Who can read | How it is deleted |
|---|---|---|---|---|---|
| `users` | email, display name, department, role, identity-provider subject (`external_sub`, a random provider id), created time | account, seat licensing, host/participant names | until erasure; trial organizations are deleted 30 days after the trial ends | the person, org admins of the same organization | erasure writes a tombstone (constant email `erased@erased.invalid`, name "Erased user", role member, disabled, department cleared); `external_sub` is kept on purpose (a random id that no longer resolves to anybody; it makes sign-in with a still valid token fail with 403 instead of creating a new account). Whole organization: `purge_expired_trials` |
| `organizations` | name and slug (organization data; for a one-person trial it may be a person's name) | tenant key | until the organization is deleted | members of the organization | trial retention (30 days after trial end); the slug is then recorded in `retired_slugs` |
| `departments` | department names (organization data) | admin console grouping | until deleted by an org admin | org admins, members through the user list | admin console |
| `org_policies`, `org_licenses` | none (settings, seat and trial limits) | admin console, licensing | with the organization | org admins (licence: read only) | with the organization |
| `org_kms` | none about a person; an encrypted customer Vault address and token | customer-held keys | until removed by an org admin | nobody in clear (envelope-encrypted) | admin console, or with the organization |
| `meetings` | title (free text, may name a person), code, host user id, schedule, flags; no passcode in clear (hash only) | the meeting itself | metadata is deleted by the retention job when `max(created_at, scheduled_at)` is older than `RETENTION_MEETINGS_DAYS` (365) and no file or recording row is left. There is no "ended" column, so age is the proxy | members who know the code and org admins | retention job; a hosted meeting survives the host's erasure (organization record), its host id then points to the tombstone |
| `meeting_access` | user id, first entry time per meeting (who really joined) | file access control, participant record | with the meeting | org admins, the meeting host | cascade with the meeting; retention; the person's export lists them |
| `join_requests` | user id, status, times, decided-by id (waiting room) | waiting room | with the meeting | host, co-hosts, org admins | cascade with the meeting |
| `guest_sessions` | display name the guest typed (free text, 1-60 characters), status, times, decided-by user id, a KEYED HASH of the network address (not the address) | guest mode: waiting room, admission, ban | with the meeting | host, co-hosts, org admins | cascade with the meeting |
| `meeting_guest_bans` | keyed hash of a removed guest's network address for one meeting, who banned, time | stop a removed guest from coming back to that meeting | with the meeting | host, co-hosts, org admins | cascade with the meeting |
| `meeting_bans`, `meeting_cohosts` | user ids, who granted/banned | host controls | with the meeting | host, co-hosts, org admins | cascade with the meeting |
| `meeting_files` | file name (free text), size, SHA-256, uploader id; the content is in S3 (section 2) | files shared in a meeting | `RETENTION_FILES_DAYS` (90) after upload | participants who entered the meeting, host, org admins | retention job (object first, then row); erasure deletes the files the person uploaded |
| `recordings` | who started it, times, size; content in S3 (section 2) | meeting recording (host-initiated, consent flag in the room) | `RETENTION_RECORDINGS_DAYS` (90) after the end, only for `ready`/`failed` rows | host, co-hosts, org admins | retention job; erasure deletes recordings the person started (refused with 409 while one is still running) |
| `calendar_connections` | refresh token of Google/Microsoft, encrypted (AES-256-GCM envelope), scope, times | create calendar events | until the person disconnects | nobody in clear; export shows provider/scope only, never the token | `DELETE /v1/calendar/:provider`; erasure revokes at the provider where one exists, then deletes |
| `calendar_oauth_states` | user id, PKCE verifier (encrypted), 10-minute lifetime | OAuth state | 10 minutes, single use | no policy for the application role (functions only) | consumed on use, expired rows dropped on creation; erasure calls `privacy_purge_user_oauth_states` |
| `api_keys` | key name (free text), prefix, SHA-256 of the secret (never the secret), creator id, last use | external REST API | until revoked | org admins | erasure revokes keys the person created (the row stays; the application role cannot delete) |
| `ext_idempotency` | stored API response of a meeting creation (host, title) | idempotent retries | 24 hours (`ext_api_prune`) | nobody (internal) | pruned |
| `ext_rate_limits` | none | per-key rate limit | 2 hours | internal | pruned |
| `webhook_endpoints` | target URL (the path may carry a secret), creator id, encrypted signing secret | event delivery to the customer's system | until deleted | org admins | admin console; erasure deletes endpoints the person created. The export shows the host name only |
| `webhook_deliveries` | event payloads (meeting code/title, participant identity and display name) | delivery outbox | finished deliveries 30 days (`ext_api_prune`) | internal | pruned; cascade with the endpoint |
| `audit_log` | actor user id, action, target text (codes, ids, host names, filter text of exports), time, hash chain | security and accountability trail | kept; the retention job never deletes it and the application role has no UPDATE/DELETE | org admins (admin console, export, SIEM forwarder) | NOT deleted on erasure: actor ids resolve to the tombstone, so no name or address remains in the trail |
| `audit_chain_head` | none | detects removal of the newest audit rows | with the audit log | org admins (verify) | with the organization |
| `audit_forward_state` | none (cursor) | SIEM forwarding position | permanent | internal | n/a |
| `signup_events` | keyed hash of the network address, e-mail domain, outcome, organization slug | abuse limits and audit of sign-up attempts | `RETENTION_SIGNUP_EVENTS_DAYS` (90) | operators only (no application grant) | retention job (`privacy_purge_signup_events`) |
| `trial_signups` | keyed hash of the normalized e-mail, keyed hash of the network address | one trial per mailbox | the e-mail hash is kept so a trial cannot be restarted; the network hash is blanked after `RETENTION_SIGNUP_EVENTS_DAYS` | operators only | blanked by the retention job; the row keeps `org_id = NULL` after the organization is deleted |
| `altcha_used` | hash of a solved proof-of-work challenge | replay protection | 1 day | operators only | pruned on use |
| `retired_slugs` | slug of a purged trial organization | never reuse a tenant key | permanent | operators only | not deleted (it is an identifier of a deleted organization, not a person) |
| `schema_migrations` | none | migration bookkeeping | permanent | operators | n/a |

## 2. Object storage (S3 compatible, MinIO)

| Store | Content | Retention | Who can read | How it is deleted |
|---|---|---|---|---|
| files bucket (`S3_BUCKET`) | files shared in a meeting, envelope-encrypted per object (platform master key or the customer's Vault key) | 90 days (`RETENTION_FILES_DAYS`) | the API only, after an authorization check on every download | retention job deletes the object, then the row; erasure does the same for the person's uploads |
| recordings bucket (`RECORDING_BUCKET`) | meeting recordings (MP4, encrypted) and, briefly, the plaintext staging object written by the media server | 90 days after the end | the API only (host, co-hosts, org admins) | retention job and erasure delete the final and the staging object |

Chat messages are not stored by DavraBox (they travel over the media server's data channel; in E2EE meetings they are encrypted end to end). Only files are stored.

## 3. Other systems that hold personal data

| System | Data | Purpose | Retention | Who can read | Deletion |
|---|---|---|---|---|---|
| Keycloak (identity provider, self-hosted) | e-mail, name, password hash, TOTP/passkey credentials, `org_slug`, sessions, login events and admin events | sign-in | account until erased; events 90 days (`eventsExpiration` in the production realm) | operators with Keycloak admin access | erasure ends all sessions and deletes the account (`KeycloakAdmin.eraseUser`); trial purge deletes the organization's users |
| LiveKit media server | during a call: participant identity (the user id), display name, audio/video/screen streams, in-call data messages. Nothing is stored unless a recording is started | real-time media | for the call | participants of the room; operators | ends with the call |
| LiveKit Cloud (hosted LiveKit, pilot) | the same as above, processed by a third party outside Uzbekistan for the pilot | media transport while self-hosted media is not available | per LiveKit's own terms; DavraBox stores nothing there | LiveKit staff per their terms | not controllable by DavraBox. This changes when media is self-hosted |
| API process logs (container stdout, `json-file` driver, 20 MB x 5 files) | error and warning lines; the code avoids writing request bodies or addresses | operations | rotation by size, about a few days | operators | rotation. The OBS workstream (structured logging) may change this; re-check this row when it merges |
| Reverse proxy (Caddy) | no access log is configured in `deploy/prod/Caddyfile` at the time of writing | n/a | n/a | n/a | n/a |
| Browser storage | language, theme, `relayMode`, call preferences, pending meeting code, the sign-in session and the E2EE key of an open meeting (`sessionStorage`, gone when the tab closes); no cookies set by DavraBox, no third-party scripts | usability | until the browser clears it | the person | the person |
| SIEM forwarder (optional, `AUDIT_WEBHOOK_URL`) | audit rows including the actor's e-mail at the time of sending | customer's security monitoring | decided by the customer's system | the customer | NOT reachable from DavraBox: already forwarded rows keep the old e-mail. Tell the customer when an erasure is requested |
| ClamAV | scans uploads in memory | malware check | none stored | n/a | n/a |
| Google / Microsoft (only if a person connects a calendar) | the calendar event DavraBox creates, the OAuth grant | calendar integration | their terms | the person | revoked at erasure and on disconnect |

## 4. Residual personal data after an erasure (honest list)

1. `audit_log.target` is free text written when the action happened. Targets hold meeting codes, ids, webhook host names and, for `audit.export`, the filter text typed by the admin (which could be an e-mail address). They cannot be rewritten without breaking the hash chain; nobody is named by the actor column any more.
2. Meeting titles and file names are organization content and can contain a name; they follow the meeting/file retention, not the person's erasure (files the person uploaded are deleted; meeting titles are not).
3. Rows already forwarded to a customer's SIEM, already downloaded exports and recordings downloaded by others are outside DavraBox.
4. `users.external_sub` of the tombstone (random id, see above) and the ids in `meeting_access`, `join_requests` and similar tables, which now point to the tombstone.
5. Backups: disabled by the owner's decision (2026-11-24), so no copy outlives an erasure. When backups are enabled this row needs a rule (erased users must be re-erased after a restore).

## 5. What a person can obtain and do

- Export: `GET /v1/me/export` (any signed-in person) and `GET /v1/admin/users/:id/export` (org admin). JSON; profile, hosted and joined meetings, join requests, co-host roles, uploaded file metadata, recordings started, calendar connection status (never tokens), API keys (never hashes), webhook host names, the person's own audit rows (up to 10 000). Rate limited (5 per hour per caller), audited as `privacy.export`.
- Erasure: `DELETE /v1/me` and `DELETE /v1/admin/users/:id`, body `{"confirm":"<the account e-mail>"}`. The last organization admin gets 409. Audited as `privacy.erasure.requested` and `privacy.erasure.completed`.
- Correction: through the identity provider and the admin console (no separate endpoint yet).

## 6. Open questions for the lawyer

1. Which legal entity is the controller/operator, and what is the legal basis wording for each purpose.
2. Whether Uzbekistan's personal data law requires data of Uzbek citizens to be stored on servers in Uzbekistan, and how that applies to the LiveKit Cloud pilot (media transit) and to the hosting that is still to be chosen.
3. The retention periods above are engineering defaults (configurable by environment), not legal findings.
4. Whether registration with the data-protection authority is required.
