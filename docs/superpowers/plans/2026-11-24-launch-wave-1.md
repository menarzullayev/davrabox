# Launch wave 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the landing page with a self-serve trial, the external REST API with webhooks, meeting recording, and calendar integration, as four independent workstreams that merge cleanly.

**Architecture:** Each workstream is a new NestJS module under `apps/api/src/<name>/` with its own migration and tests, plus additive web UI in its own folder. Shared files (`app.module.ts`, `i18n.ts`, `main.tsx`, `deploy/prod/*`) are touched only by adding lines; the integrator (me) merges them by hand.

**Tech Stack:** NestJS 11, zod, pg with row-level security (`withTenant`), React 18 + Vite, vitest, Playwright e2e (system Edge), Keycloak admin API, LiveKit server SDK, MinIO (S3), Docker Compose.

**Spec:** `docs/superpowers/specs/2026-11-24-landing-and-launch-program-design.md` (read it first; sections 6-8 are the requirements).

## Global Constraints
- Trial: 7 days, up to 10 participants, meetings up to 30 minutes.
- Captcha: ALTCHA, self-hosted proof of work; no third-party script, font or request on the landing page.
- Languages: Uzbek (primary), Russian, English, one dictionary per workstream merged into `apps/web/src/i18n.ts` by spreading it at the end (same pattern as `...homeUz`).
- Routing: landing at `/`, application at `/app`, `/admin` unchanged; old `?code=` and `/j/<code>` links must still reach the app.
- No email is sent by the product; no email verification.
- E2EE is a per-meeting mode (`meetings.e2ee boolean not null default false`, added by migration 010); recording must refuse E2EE meetings.
- Migration numbers are reserved: 008 (A), 009 (D), 010 (C), 011 (Cal). One migration per workstream, forward only, applied by `apps/api/src/db/migrate-cli.ts`.
- Every table has `org_id` and FORCE row-level security keyed on `app.current_org`, like migrations 001-007, except tables used before an organisation exists (signup), which must be reachable only through a SECURITY DEFINER function.
- Secrets never in git; secrets at rest hashed (API keys) or encrypted with the existing envelope helpers in `apps/api/src/files/crypto.ts`.
- Every new endpoint: zod validation, correct status codes, audit rows via the existing audit insert, no stack traces in responses.
- Tests: write the negative test first; never weaken or delete existing tests; run `pnpm --filter @davrabox/api test`, `pnpm --filter @davrabox/web test`, `pnpm --filter @davrabox/web typecheck` before each commit.
- Git: work on your own branch from `origin/main`; open a PR; main is protected (required checks `verify` and `security`). Never commit anything under `deploy/compose/*.cred.txt`, `dev.env`, or any file with a secret; stage files by name, never `git add -A`.

## Review Focus
- A signup solution replayed a second time (ALTCHA payload reuse) is refused with 400; the challenge expires after 5 minutes.
- The same mailbox signs up twice with different case, dots in the local part, or a `+tag`: exactly one trial organisation exists.
- Keycloak is unreachable or returns 409 during signup: no organisation row and no licence row remain, and the caller gets a retryable error.
- A webhook endpoint URL that resolves to a private, loopback, link-local or metadata address (including via redirect or DNS rebinding) is refused at registration and at delivery.
- A host starts recording in an E2EE meeting, or a non-host starts recording in any meeting: refused with 409 / 403 and an audit row; nothing is started in LiveKit.

---

## Workstream A: landing, routing and self-serve trial (branch `feat/landing-trial`, migration 008)

### Task A1: Move the app to `/app`
**Files:** Modify `apps/web/src/main.tsx`, `apps/web/src/auth.ts`, `apps/web/src/App.tsx` (links), `apps/e2e/*.e2e.mjs` and `apps/e2e/kc.mjs` (BASE paths), `deploy/prod/Caddyfile` (no change expected, confirm SPA fallback), `apps/web/nginx.conf` (confirm `try_files`).
**Interfaces:** Produces `isAppPath(pathname: string): boolean` and `appUrl(path = ''): string` in `apps/web/src/routes.ts`.
- [ ] Write failing tests in `apps/web/src/routes.test.ts`: `isAppPath('/app')`, `isAppPath('/app/')`, `isAppPath('/')` is false, `isAppPath('/admin')` is false, `/j/12345678901` and `/?code=12345678901` are mapped to `/app?code=12345678901` by `legacyJoinRedirect(location): string | null`.
- [ ] Implement `routes.ts`, route `/` to the (placeholder) landing and `/app*` to the existing App; redirect legacy join links; sign-in return URL becomes `/app`.
- [ ] Update every e2e helper that does `page.goto(BASE + '/')` followed by sign-in to use `BASE + '/app'`; run `pnpm --filter @davrabox/e2e test` (needs the dev stack, `. scripts/devenv.sh`). Expected: all suites that passed before still pass.
- [ ] Commit.

### Task A2: Landing page
**Files:** Create `apps/web/src/landing/{Landing.tsx,sections/*.tsx,landing.css,i18n-landing.ts,landing.test.tsx}`; modify `apps/web/src/i18n.ts` (spread `...landingUz/Ru/En`), `apps/web/src/main.tsx` (lazy route).
**Interfaces:** Consumes `Logo`, `Davra`, `Button`, `Badge`, `Card` from `apps/web/src/ui`, `parseJoinInput` from `apps/web/src/home/logic.ts`, `t(lang, key)`. Produces `Landing(): JSX.Element` default export (lazy) and keys prefixed `ln`.
- [ ] Failing tests: all `ln*` keys exist in uz, ru and en; the page renders one `h1`; the "Start free" button links to `/app/signup`; the join field accepts an 11-digit code and navigates to `/app?code=...`; no element has an external `src`/`href` except `mailto:`.
- [ ] Build sections in this order: header, hero (headline, one sentence, Start free, join field, mandala beside a Davra call screenshot saved under `apps/web/public/landing/`), proof strip, capabilities grid (equal tiles: meetings, waiting room and host control, chat and files, SSO and admin console, audit trail, E2EE, recording, calendar, REST API and webhooks, BYOK, mobile, desktop), how it works (3 steps), security and local control, for organisations, join a meeting, final call to action, footer. Copy in uz, ru, en; no statistics that cannot be proven.
- [ ] Verify: axe 0 violations in dark and light at 360, 768, 1280, 1920 for uz, ru, en (reuse the pattern of `apps/e2e/home.axe.mjs`); no horizontal overflow; production build contains no request to another origin; Lighthouse performance recorded in PROGRESS.md.
- [ ] Commit.

### Task A3: Signup API with ALTCHA and abuse limits
**Files:** Create `apps/api/migrations/008_trial_signup.sql`, `apps/api/src/signup/{signup.module.ts,signup.controller.ts,signup.service.ts,altcha.ts,disposable-domains.ts,email-normalize.ts,limits.ts}`, `apps/api/test/signup.test.ts`; modify `apps/api/src/app.module.ts` (add module only).
**Interfaces:** Produces `POST /v1/public/challenge -> { algorithm, challenge, salt, signature, maxnumber }` and `POST /v1/public/signup { orgName, name, email, password, altcha } -> 201 { slug, signInUrl }`; `createChallenge(secret: string, now?: number): AltchaChallenge`, `verifySolution(payload: string, secret: string, now?: number): Promise<boolean>` (single use via table `altcha_used(challenge_hash, used_at)`); `normalizeEmail(email: string): string` (lower-case, strip dots and `+tag` for gmail-style domains only); `isDisposable(email: string): boolean`; `slugify(name: string): string` with a reserved list (`admin`, `api`, `app`, `www`, `auth`, `demo`, `status`).
- [ ] Failing tests (each a separate `it`): replayed solution 400; expired challenge 400; wrong signature 400; disposable domain 422; same normalized email twice 409; slug collision gets a numeric suffix and never overwrites; Keycloak 409 or timeout leaves zero rows in `organizations`, `org_licenses`, `users` (use a fake Keycloak client injected through the module); more than the configured signups per IP per hour returns 429 with `Retry-After`; global daily cap returns 503 with a clear code; password shorter than 12 characters 400; an audit row exists for success and for each refusal class.
- [ ] Migration 008: `trial_signups(id, email_norm unique, ip_hash, created_at)`, `altcha_used`, `org_licenses` gains `trial_ends_at timestamptz`, `max_participants int`, `max_meeting_minutes int`; function `create_trial_org(slug, name, ...)` SECURITY DEFINER; table access only through it.
- [ ] Implement the service: one DB transaction creates organisation, licence (7 days, 10, 30) and the pending user row, then calls the Keycloak admin client (`apps/api/src/admin/identity-admin.ts`, extend with `createOrgAdmin({email, name, orgSlug, password})`); on any failure roll back and best-effort delete the Keycloak user.
- [ ] Commit.

### Task A4: Trial enforcement and retention
**Files:** Modify `apps/api/src/meetings/meetings.service.ts` (token issue), create `apps/api/src/signup/trial.guard.ts`, `apps/api/src/signup/retention.job.ts`, tests `apps/api/test/trial.test.ts`.
**Interfaces:** Consumes `org_licenses` from A3. Produces `assertTrialActive(orgId: string): Promise<void>` throwing `MeetingError(402, 'trial expired')`, and `effectiveLimits(orgId): Promise<{ maxParticipants: number; maxMinutes: number }>`.
- [ ] Failing tests: after `trial_ends_at` creating or joining a meeting returns 402 with a stable error code; the 11th participant is refused; the access token TTL and the room close are bounded by `max_meeting_minutes` (room is deleted through the LiveKit API when the limit is reached); a paid organisation (no trial fields) is unaffected.
- [ ] Implement the guard in the create and join paths and a retention job (advisory-lock protected, runs hourly) that deletes organisations 30 days after trial end, writing an audit row first.
- [ ] Add a banner key `lnTrialEnds` shown in `/app` home when fewer than 3 days remain (small, additive in `apps/web/src/home/`).
- [ ] Commit.

### Task A5: Signup page and end-to-end
**Files:** Create `apps/web/src/landing/Signup.tsx`, `apps/web/src/landing/altcha.ts` (client solver in a Web Worker, no dependency fetched at runtime), `apps/e2e/signup.e2e.mjs`.
- [ ] Failing e2e: a new visitor completes the form, lands signed in at `/app` as organisation admin of a new organisation, creates a meeting; a second signup with the same email shows the friendly "already registered" message; cleanup deletes the Keycloak user and organisation.
- [ ] Implement the page (4 fields, progress while solving, error states in 3 languages, keyboard accessible); the solver runs off the main thread and gives up after 30 s with a retry.
- [ ] Add `signup` to `apps/e2e/package.json` test script; run axe on the page.
- [ ] Commit; open the PR.

---

## Workstream D: external REST API and webhooks (branch `feat/ext-api`, migration 009)

### Task D1: API keys
**Files:** Create `apps/api/migrations/009_ext_api.sql`, `apps/api/src/ext-api/{ext-api.module.ts,api-keys.service.ts,api-key.guard.ts,keys.controller.ts}`, `apps/api/test/ext-api.test.ts`.
**Interfaces:** Produces `POST/GET/DELETE /v1/admin/api-keys` (org admin only; the secret is returned once), key format `dbx_<8 hex prefix>_<43 base64url>`, stored as SHA-256 of the secret plus the prefix; scopes `meetings:read`, `meetings:write`, `users:read`; `ApiKeyGuard` sets `req.apiOrg` and checks `@Scope('meetings:read')`.
- [ ] Failing tests: secret never appears in list responses or logs; revoked key 401; missing scope 403; key of org A cannot read org B; `last_used_at` updates; constant-time hash comparison; creating more than 20 keys per org refused.
- [ ] Implement; audit rows for create and revoke. Commit.

### Task D2: External endpoints under `/v1/ext`
**Files:** Create `apps/api/src/ext-api/{meetings.ext.controller.ts,users.ext.controller.ts,openapi.ts}`.
**Interfaces:** `GET /v1/ext/meetings`, `POST /v1/ext/meetings` (header `Idempotency-Key`, same key and body returns the first response), `GET /v1/ext/meetings/:id`, `DELETE /v1/ext/meetings/:id`, `GET /v1/ext/users`; `GET /v1/ext/openapi.json` generated from the zod schemas and tested against the real route list.
- [ ] Failing tests: idempotent POST creates one meeting; unknown fields rejected; pagination cursor stable; per-key rate limit stored in the database returns 429 with `Retry-After`; the OpenAPI document lists every `/v1/ext` route and no other.
- [ ] Implement by reusing `MeetingsService`; commit.

### Task D3: Webhooks
**Files:** Create `apps/api/src/ext-api/{webhooks.service.ts,webhooks.controller.ts,webhook-delivery.job.ts,url-guard.ts}`.
**Interfaces:** `POST/GET/DELETE /v1/admin/webhooks` (URL https only, events from `meeting.created`, `meeting.ended`, `participant.joined`, `participant.left`); `assertPublicHttpsUrl(url: string): Promise<void>` resolving DNS and rejecting private, loopback, link-local and metadata ranges (re-checked at delivery, redirects not followed); deliveries signed `X-Davra-Signature: t=<unix>,v1=<hex hmac-sha256(secret, t + '.' + body)>`, retried with exponential backoff and jitter, 8 attempts, then marked dead; endpoint secret encrypted at rest.
- [ ] Failing tests: private-address and redirect and DNS-rebinding URLs refused; signature verifies with the documented algorithm and a 5-minute replay window is documented; failure then success after backoff delivers once; dead letters visible in `GET /v1/admin/webhooks/:id/deliveries`; deliveries survive an API restart.
- [ ] Implement with LiveKit webhook ingestion for participant events (add the LiveKit webhook receiver endpoint, signature verified with the LiveKit key). Commit.

### Task D4: Admin UI hook and docs
- [ ] Add an "Integrations" section to `apps/web/src/admin/` (keys and webhooks tables, create dialog showing the secret once, copy button) using the admin kit pieces; extend `apps/e2e/admin.e2e.mjs`; write `docs/api.md`. Commit; open the PR.

---

## Workstream C: recording (branch `feat/recording`, migration 010)

### Task C1: Egress service and storage
**Files:** Modify `deploy/compose/docker-compose.yml`, `deploy/compose/livekit.yaml`, `deploy/prod/docker-compose.yml`, `deploy/prod/livekit.yaml`; create `deploy/compose/egress.yaml`, `deploy/prod/egress.yaml`.
- [ ] Add the `livekit/egress` service (needs Redis shared with LiveKit; add `redis:` to `livekit.yaml`), bucket `davra-recordings` in MinIO, resource limits; verify with a manual 20-second room composite recording written to the bucket (record the command and result in PROGRESS.md). Commit.

### Task C2: Recording API
**Files:** Create `apps/api/migrations/010_recording.sql` (also `meetings.e2ee`), `apps/api/src/recording/{recording.module.ts,recording.controller.ts,recording.service.ts,recording-crypto.ts}`, `apps/api/test/recording.test.ts`.
**Interfaces:** `POST /v1/meetings/:code/recording/start`, `POST .../stop`, `GET /v1/meetings/:code/recordings`, `GET /v1/recordings/:id/download` (host, co-host or org admin only); table `recordings(id, org_id, meeting_id, egress_id, object_key, status, started_by, started_at, ended_at, size_bytes)`; finished objects are envelope-encrypted with `files/crypto.ts` helpers before download is allowed; download streams and decrypts.
- [ ] Failing tests (egress client faked): member 403; E2EE meeting 409; double start 409; stop without start 404; download of another org's recording 404; audit rows for start, stop, download; object in the bucket is not plaintext after processing.
- [ ] Implement; commit.

### Task C3: Consent and host controls
**Files:** Modify (additively) `apps/web/src/call/ControlBar.tsx`, `apps/web/src/call/CallView.tsx`, `apps/web/src/call/i18n-call.ts`, `apps/web/src/signals.ts`; create `apps/web/src/call/RecordingBadge.tsx`.
- [ ] Failing tests: the recording badge and an announcement (`aria-live`) appear for every participant when recording starts and disappear on stop; the start button exists only for host and co-host; it is disabled with an explanation in E2EE meetings.
- [ ] Implement with a `recording` data signal plus room metadata so late joiners see the badge; add `apps/e2e/recording.e2e.mjs` (two browsers, start, 10 s, stop, recording listed and downloadable). Commit; open the PR.

---

## Workstream Cal: calendar integration (branch `feat/calendar`, migration 011)

### Task K1: OAuth connections
**Files:** Create `apps/api/migrations/011_calendar.sql`, `apps/api/src/calendar/{calendar.module.ts,oauth.service.ts,providers/google.ts,providers/microsoft.ts,calendar.controller.ts}`, `apps/api/test/calendar.test.ts`.
**Interfaces:** `GET /v1/calendar/:provider/start -> 302` (state and PKCE stored server side, 10 minutes), `GET /v1/calendar/:provider/callback`, `DELETE /v1/calendar/:provider`; table `calendar_connections(user_id, provider, refresh_token_enc, scope, created_at)`; config keys `GOOGLE_CLIENT_ID/SECRET`, `MS_CLIENT_ID/SECRET` optional (endpoints answer 503 when unset, like files).
- [ ] Failing tests (provider HTTP mocked): tampered or reused `state` rejected; refresh token stored only encrypted; disconnect deletes it; scopes limited to calendar events create/read.
- [ ] Implement; commit.

### Task K2: Create events with a join link
**Files:** Create `apps/api/src/calendar/events.service.ts`; modify `apps/web/src/home/` (additive "Add to calendar" action on a meeting row and in the create dialog).
**Interfaces:** `POST /v1/meetings/:code/calendar-event { provider, start, end, attendees? } -> { eventUrl }` (host only; the join link and code in the event body; attendees optional emails passed to the provider, never sent by us).
- [ ] Failing tests: non-host 403; provider 401 triggers one refresh then succeeds; refresh failure returns a reconnect message; times validated (end after start, at most 12 hours).
- [ ] Implement; document the one-time OAuth app registration steps in `docs/calendar.md` (the real end-to-end check is blocked until the user supplies client IDs; say so in the PR). Commit; open the PR.

---

## Integration (me, after all four PRs)
- [ ] Merge PRs one at a time in the order A, D, C, Cal, resolving `app.module.ts`, `i18n.ts`, `main.tsx` conflicts by keeping every addition; run the full CI and the full e2e suite after each merge; update `docs/PROGRESS.md` and the local readiness ledger.
- [ ] Do not publish the landing page publicly until every capability on it is verified (spec section 10); wave 2 (E2EE, BYOK, Android app, signed desktop) is brainstormed after this merge.

## Self-review notes
Spec coverage: sections 6-7 map to A1-A5; section 8 wave 1 maps to D, C, Cal; section 9 blockers are called out in Cal and the integration task; section 10 verification is in A2, A5 and Integration. Types used across tasks: `org_licenses` fields are defined in A3 and consumed in A4; `meetings.e2ee` is defined in C2 (migration 010) and consumed by C3 and wave 2.
