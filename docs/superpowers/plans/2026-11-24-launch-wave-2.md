# Launch wave 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build end-to-end encrypted meetings, customer-held keys (BYOK), an Android app, and a code-signing pipeline for the desktop app.

**Architecture:** Four independent workstreams with disjoint paths; each lands as its own PR. E2EE and BYOK change shared encryption paths, so they keep strict interfaces (below). Wave 1 (landing and trial, external API and webhooks, recording, calendar) is already on `main`.

**Tech Stack:** livekit-client E2EE (SFrame via insertable streams, key provider and worker), NestJS 11, HashiCorp Vault Transit, Capacitor (Android), GitHub Actions, electron-builder.

**Spec:** `docs/superpowers/specs/2026-11-24-landing-and-launch-program-design.md` (sections 2, 8, 9, 10) plus the decisions below.

## Decisions taken by the user (2026-11-24)
- E2EE key model: a random per-meeting key created in the host's browser and carried in the link fragment (`#k=<base64url key>`); the fragment is never sent to any server; the key is also kept in `sessionStorage` for reloads. Meetings are created either normal or E2EE (`meetings.e2ee`, column already exists from migration 010). In an E2EE meeting server-side recording is refused (already enforced in wave 1).
- BYOK: HashiCorp Vault Transit first (adapter interface so AWS KMS, Azure Key Vault, Google KMS can follow).
- Android: Capacitor wrapper around the hosted web client; APK built in GitHub Actions; Play Store release needs the user's Google Play account and signing key.
- Desktop: prepare the signing pipeline (Windows certificate or cloud signing, macOS Developer ID and notarisation); unsigned build when secrets are absent; the user supplies the certificates.

## Global Constraints
- Migration numbers: 012 is reserved for BYOK; E2EE, Android and Desktop add none. Forward only; org-scoped tables use FORCE row-level security like migrations 001-011.
- No secret in git; stage files by name, never `git add -A`; no AI attribution lines; work on your own branch from `origin/main`; open a PR, do not merge; main is protected (checks `verify`, `security`, CodeQL must stay green: avoid backtracking regexes on user input, keep keyed hashes for tokens).
- Each workstream uses its own throw-away database and never touches the shared dev stack; real-stack Playwright e2e is run by the integrator, but write the e2e script and `node --check` it.
- Uzbek, Russian, English strings for every new UI text, in a dictionary of your own spread into `apps/web/src/i18n.ts` (additive lines only).
- Tests: failing negative test first; run `pnpm --filter @davrabox/api test`, `pnpm --filter @davrabox/web test`, `pnpm -r typecheck`, `pnpm --filter @davrabox/web build` (build design tokens first with `pnpm --filter @davrabox/design-tokens build`).
- Honest reporting: say what you ran and what you could not verify.

## Review Focus
- A participant who joins an E2EE meeting without the key must never see plaintext media or messages, and must be told why (not a blank screen): test with a second context lacking `#k`.
- The key never reaches the server: assert that no request URL, header, body, log line or room metadata contains it (including `Referer`; the fragment is not sent but reloads and redirects must not copy it into a query string).
- Turning E2EE on mid-meeting is not supported; the UI must not offer it, and the API must refuse changing `meetings.e2ee` after creation.
- BYOK key revoked or unreachable at read time: stored files and recordings fail closed with a clear 503/423 and an audit row, and nothing falls back to the platform key silently.
- Android WebView denies camera or microphone permission: the call screen shows an actionable message, not a hang.

---

## Workstream E: end-to-end encryption (branch `feat/e2ee`)

### Task E1: Key handling and room options
**Files:** Create `apps/web/src/e2ee/{keys.ts,keys.test.ts,provider.ts}`; modify `apps/web/src/Call.tsx` (Room options), `apps/web/nginx.conf` and `deploy/prod/Caddyfile` only if the E2EE worker needs a CSP source (it must stay same-origin).
**Interfaces:** Produces `generateMeetingKey(): string` (32 random bytes, base64url), `parseKeyFromHash(hash: string): string | null`, `buildShareLink(origin: string, code: string, key: string): string` (`/app?join=<code>#k=<key>`), `loadStoredKey(code): string | null` and `storeKey(code, key)` (sessionStorage); `createE2eeRoomOptions(key: string): Pick<RoomOptions, 'e2ee'>` using livekit-client `ExternalE2EEKeyProvider` and its worker bundled from the installed package (verify the API against the installed version's source, do not guess).
- [ ] Failing tests: key is 43 base64url chars and differs per call; `parseKeyFromHash('#k=abc')` accepts only valid base64url of the right length; the key is removed from `location` after being stored (history replaced) so it is not left in the address bar copy buffer longer than needed (document the trade-off); `buildShareLink` puts the key only after `#`.
- [ ] Implement; commit.

### Task E2: Create and join E2EE meetings
**Files:** Modify `apps/api/src/meetings/{meetings.controller.ts,meetings.service.ts}` (accept `e2ee` on create, return it on join/list, refuse updates), `apps/web/src/home/NewMeetingDialog.tsx` (toggle with explanation), `apps/web/src/Call.tsx`, `apps/web/src/call/CallView.tsx` (E2EE badge), `apps/web/src/call/i18n-call.ts`; create `apps/web/src/e2ee/E2eeGate.tsx` (shown when the meeting is E2EE and no key is present: explains and offers a field to paste the full link or key).
**Interfaces:** `POST /v1/meetings { title, passcode?, waitingRoom?, e2ee?: boolean }`, join result gains `e2ee: boolean`; `PATCH`-style changes to `e2ee` return 409.
- [ ] Failing tests (API): `e2ee` defaults to false; true persists; join returns it; recording start returns 409 for it (already) and the list endpoints expose it; no endpoint changes it. (Web): the gate renders when `e2ee` and no key; a participant without a key never calls `room.connect` with media enabled.
- [ ] Implement: host browser generates the key, shows the copyable full link (and QR-free text) after creation; joiners with the fragment key connect with `e2ee` options and `room.setE2EEEnabled(true)` before publishing; show a persistent E2EE badge with an `aria-live` notice on state changes; chat and reactions use the encrypted data channel if the installed SDK supports it, otherwise they are disabled in E2EE meetings with an explanation (verify in the SDK source and state which in the PR).
- [ ] Commit.

### Task E3: Compatibility and proof
**Files:** Create `apps/e2e/e2ee.e2e.mjs`, `docs/e2ee.md`.
- [ ] Failing e2e (written, `node --check`ed): host creates an E2EE meeting; member with the link sees host video (pixel check) ; a third context without the key sees the gate and no video; background blur works with E2EE on (the blur processor runs before encoding) or is disabled with a clear note if it cannot; recording button disabled with the E2EE reason.
- [ ] Document the threat model honestly in `docs/e2ee.md` (what the server can still see: who, when, room metadata, message sizes; link sharing is the trust root; no forward secrecy on member changes). Commit; open the PR.

---

## Workstream B: BYOK with Vault Transit (branch `feat/byok`, migration 012)

### Task B1: Key provider interface and Vault adapter
**Files:** Create `apps/api/migrations/012_byok.sql`, `apps/api/src/byok/{byok.module.ts,key-provider.ts,vault-transit.ts,byok.service.ts,byok.controller.ts}`, `apps/api/test/byok.test.ts`, `deploy/compose/docker-compose.byok.yml` (Vault in dev mode for tests, loopback only, disposable).
**Interfaces:** `interface KeyProvider { wrap(plain: Buffer, ctx: string): Promise<Buffer>; unwrap(wrapped: Buffer, ctx: string): Promise<Buffer>; health(): Promise<'ok' | 'unreachable' | 'denied'> }`; `VaultTransitProvider(opts: { addr: string; token: string; keyName: string; mount?: string; fetch?: typeof fetch })`; table `org_kms(org_id pk, provider text, config_enc bytea, key_name text, status text, created_at, rotated_at)`; admin endpoints `PUT/GET/DELETE /v1/admin/kms` (org admin), `POST /v1/admin/kms/test`.
- [ ] Failing tests: Vault token and address stored only encrypted with the existing envelope helpers; `wrap`/`unwrap` round-trip against a real Vault dev container; wrong token gives `denied`; unreachable gives `unreachable`; the SSRF guard from `ext-api/url-guard.ts` rejects private Vault addresses unless `BYOK_ALLOW_PRIVATE_VAULT=1` (self-hosted customers; default off, documented).
- [ ] Implement; audit rows for configure, test, rotate, remove. Commit.

### Task B2: Use the customer key for files and recordings
**Files:** Modify `apps/api/src/files/crypto.ts` (add a key-wrapping hook; default behaviour unchanged), `apps/api/src/files/files.service.ts`, `apps/api/src/recording/recording-crypto.ts`/`recording.service.ts`; tests extended.
**Interfaces:** Data keys stay per object; their wrapping uses the organisation's `KeyProvider` when configured, else the platform master key; the envelope stores `kek_id` so rotation and revocation are decidable.
- [ ] Failing tests: with BYOK on, a stored file/recording is undecryptable after the customer key is disabled in Vault (read returns 423 with an audit row, never falls back); objects written before BYOK was enabled still read with the platform key; re-wrap job moves old objects to the customer key on request (`POST /v1/admin/kms/rewrap`, resumable, audited).
- [ ] Implement; commit.

### Task B3: Admin UI
- [ ] Add an "Encryption keys" section to `apps/web/src/admin/` (provider form, Test connection, status, rewrap, remove with confirmation) in the admin kit style; extend `apps/e2e/admin.e2e.mjs` (syntax-checked); write `docs/byok.md` including the Vault policy the customer must create (transit encrypt/decrypt only). Commit; open the PR.

---

## Workstream M: Android app (branch `feat/android`)

### Task M1: Capacitor project and CI build
**Files:** Create `apps/mobile/{package.json,capacitor.config.ts,android/**,README.md}`, `.github/workflows/android.yml`, `docs/android.md`; modify `pnpm-workspace.yaml` only if needed.
**Interfaces:** App id `uz.davrabox.app`; `server.url` points to `https://<PUBLIC_HOST>/app` set at build time through `DAVRA_APP_URL` (default the pilot host); cleartext disabled; `allowNavigation` limited to the app origin; deep links `https://<host>/app?join=<code>` open the app (Android App Links file served by the web app at `/.well-known/assetlinks.json`, generated from `ANDROID_SHA256_CERT_FINGERPRINT` when set).
- [ ] Failing checks (scripted, run in CI): `apps/mobile` config test asserts cleartext off, navigation limited, camera/microphone/modify-audio permissions only (no storage or location), minSdk and targetSdk values documented.
- [ ] Workflow builds a debug APK on every push to the branch and a release APK/AAB only when signing secrets exist; uploads the artifact; JDK and Android SDK are installed in the runner, never assumed locally. State plainly that the APK was not run on a device or emulator unless you did.
- [ ] Web side (additive only): detect the Capacitor shell (`window.Capacitor`) to hide "install the desktop app" prompts and to show a permission-denied message when camera/microphone are refused. Commit; open the PR.

---

## Workstream S: desktop code-signing pipeline (branch `feat/desktop-signing`)

### Task S1: Signing and notarisation pipeline
**Files:** Modify `apps/desktop/package.json` (electron-builder `win`, `mac`, `publish` sections), `.github/workflows/desktop.yml`; create `apps/desktop/build/entitlements.mac.plist`, `docs/desktop-signing.md`, `apps/desktop/scripts/verify-signature.mjs`.
**Interfaces:** Secrets read from GitHub Actions secrets only: `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` (PFX) or cloud-signing variables, `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`; when absent the job builds unsigned artifacts and writes "UNSIGNED" in the job summary. `verify-signature.mjs <file>` exits non-zero when a Windows or macOS artifact is unsigned (uses `signtool verify` / `codesign --verify` and `spctl` on the right runner).
- [ ] Failing checks: a unit test of the secret-detection logic (pure function `signingMode(env): 'signed' | 'unsigned'` with cases for missing, partial, and complete secrets: partial must fail the build instead of silently producing unsigned output).
- [ ] Add an auto-update channel using electron-updater against GitHub Releases, disabled by default and enabled only for signed builds; the update URL is fixed in the app and updates are refused when the signature check fails.
- [ ] Write `docs/desktop-signing.md`: what to buy (Windows EV or OV certificate or a cloud signing service, Apple Developer ID), how to add the secrets, how to verify; state that signing itself could not be tested without certificates. Commit; open the PR.

---

## Integration (me, after the four PRs)
- [ ] Merge in the order S, M, B, E on an integration branch, resolving additive conflicts in `app.module.ts`, `i18n.ts`, `Call.tsx`, `NewMeetingDialog.tsx`; run all unit suites, CI, and the real-stack e2e (including the new `e2ee.e2e.mjs`) before opening the integration PR.
- [ ] Update `docs/PROGRESS.md` and the local readiness ledger. The landing page stays private until the spec section 10 checks pass; Google Play and certificate purchases remain the user's actions.
