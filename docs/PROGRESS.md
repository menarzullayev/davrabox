# DavraBox progress log

Update after every milestone. Format per entry: date, phase, done, evidence (command + result), failures, next step, open decisions.

## 2026-11-23: Phase 0 preparation (planning, no product code yet)
- Done: requirements study (plan docx/pdf), name chosen (davrabox), GOAL.md approved.
- Spike (throwaway, not in git): LiveKit 1.13.11 dev container `davra-livekit` reachable on :7880; Jitsi spike stopped.
- Not verified: real multi-device call, Cloudflare Tunnel media path, external reachability of the PC.
- Next: Phase 1 foundation per plan section 9 (monorepo, CI, backend skeleton, Keycloak, 2-party LiveKit call).

## 2026-11-23: Phase 1 foundation (software part)
Done, with evidence (all run locally on this PC):
- Monorepo (pnpm workspaces): apps/api (NestJS), apps/web (React+Vite+livekit-client), apps/e2e (Playwright), deploy/compose, deploy/keycloak.
- Dev stack in Docker, all `davra-*`, resource-limited: Postgres 17, Redis, Keycloak 26 (realm import with org_slug claim mapper, org_slug editable by admins only, brute-force protection, password policy), LiveKit 1.13.11, Caddy (single HTTPS origin: /, /api, /auth, /livekit).
- API: multi-tenant schema with FORCE row-level security, unprivileged app role, SECURITY DEFINER provisioning, append-only audit log, JWT verification (RS256, issuer, azp), meetings (11-digit code, Argon2id passcode, lock, failure limiter), 10-minute room-scoped LiveKit tokens.
- Web: sign-in (OIDC code+PKCE), create/list/join meetings, call view (camera, mic, screen share, speaker highlight), uz/ru/en dictionaries with a key-parity test.
- `pnpm --filter @davrabox/api test`: 32 PASSED (RLS isolation incl. WITH CHECK, no-tenant sees nothing, hostile ids, append-only audit, meetings vs real LiveKit).
- `pnpm --filter @davrabox/web test`: 5 PASSED. Typecheck of api/web: PASSED.
- E2E `node apps/e2e/call.e2e.mjs` (system Edge, fake media devices): 8/8 PASSED: two users sign in through Keycloak, wrong passcode refused, member joins, both see two participants with playing video, only host badge.
- `pnpm audit --audit-level moderate`: no known vulnerabilities after upgrading vitest 4.1.12, vite 6.4.4, zod 4.6.6.
- Tracked files and history contain none of the generated dev secrets (grep check). CI/CodeQL/Dependabot files written and YAML-validated.

Not done / not verified (honest list):
- CI workflows have NOT run (nothing pushed; first GitHub push needs the user's approval). Gitleaks/Trivy/SBOM steps are untested.
- Real-device call (phone, real camera/mic) and the LAN from another device not tested; Chromium fake devices only. The Caddy root CA is not trusted by browsers, so other devices must accept the certificate warning.
- Cloudflare Tunnel (davrabox.bugvector.uz) not set up; media over UDP will not pass the tunnel.
- 2FA: Keycloak TOTP policy exists but is not enforced for any role; passkeys (WebAuthn) not configured; no self-registration (invite-only by design for now).
- Kubernetes/Terraform/Vault/ArgoCD/Wazuh from phase 1 not started (need a local kind cluster; planned next).
- Design system (Figma) not started; no waiting room yet (flag exists, behaviour is phase 2).
- Known dev-only choices: Keycloak runs start-dev; Caddy uses its internal CA; LiveKit TURN not configured (phase 2).
- Gate "code goes to staging every day" cannot be met until there is a staging environment and a remote repo.

## 2026-11-23 (later): Phase 1 infrastructure part
Done, with evidence:
- Docker images: `davra/api:dev` (distroless nonroot, compiled), `davra/web:dev` (nginx-unprivileged). Both built.
- Helm chart `deploy/helm/davrabox` (api, web, livekit, optional dev postgres+keycloak, network policies, ingress, migration hook Job). `helm lint`: 0 failed.
- Validated on a real local cluster (kind v0.33.0, cluster `davra-kind`, now deleted): helm install/upgrade succeeded; all 5 pods Running; migration hook applied 001+002; app DB role is not superuser/BYPASSRLS; API /healthz 200 and /v1/meetings 401 unauthenticated; web 200; LiveKit 200; Keycloak realm discovery 200. Real faults found and fixed by the cluster: LiveKit image runs as root (set numeric UID 65532), Kubernetes service-link env `LIVEKIT_PORT` crashed LiveKit (`enableServiceLinks: false` on all pods), nginx location-level `add_header` silently dropped the security headers (fixed; CSP, X-Frame-Options, nosniff, Referrer/Permissions-Policy verified on `/` and SPA routes).
- Terraform `deploy/terraform/environments/dev` (namespace with pod-security labels, secret from variable, resource quota, helm_release): `terraform init -backend=false`, `validate`, `fmt -check` PASSED. NOT planned or applied against a cluster.
- ArgoCD Application manifest written (`deploy/argocd/application.yaml`); NOT applied (ArgoCD not installed, repo URL placeholder).
- Observability add-on (`docker-compose.observability.yml`): Prometheus scrapes the API metrics endpoint (target `davra-api` up, separate internal port 9100, not routed by the edge), Grafana with Prometheus+Loki datasources provisioned, Loki ready, Vault dev mode (kv put/get round trip verified).
- API: `/healthz`, Prometheus metrics (default + meetings/join counters). API tests 32 PASSED.
- 2FA: `node apps/e2e/totp.e2e.mjs` 5/5 PASSED: new user forced to enrol TOTP, valid code signs in, second login asks for a code, wrong code refused, correct code signs in.
- Design tokens package (`packages/design-tokens`): dark + light themes, generated CSS, 14 PASSED tests incl. WCAG 2.1 AA contrast (4.5:1) for every text pair in both themes; web app now uses the tokens. Call e2e re-run after the change: 8/8 PASSED.
- CI now also lints/renders the Helm chart and validates Terraform (not yet executed on GitHub).
- Local checks at the end: api 32, web 5, design-tokens 14 tests PASSED; `pnpm audit --audit-level moderate`: no known vulnerabilities; no generated dev secret in any tracked file.

Not done / not verified (honest list, supersedes the earlier list where it overlaps):
- GitHub: nothing pushed, so CI/CodeQL/Dependabot and the gitleaks/Trivy/SBOM steps have never run; the plan gate "code reaches staging every day" needs a remote repo, a staging cluster and ArgoCD, none of which exist.
- Production web image (nginx CSP) has not been exercised by the browser e2e; the e2e runs against the Vite dev server. CSP `worker-src blob:` was added without a browser test.
- Keycloak login inside the kind cluster was not tested (only realm discovery); full login is tested in the compose stack.
- 2FA is available and tested but not enforced for admins (needs a custom authentication flow; planned with the admin console in phase 3); passkeys (WebAuthn) not configured.
- Vault is dev-mode only, nothing reads secrets from it yet; no HSM. Wazuh SIEM not deployed (needs ~4 GB; held for a dedicated host). Loki has no log shipper yet.
- Figma design system cannot be produced here; tokens are the code-side source of truth (listed in HELD.md).
- Real phone/camera/LAN-device call and the Cloudflare Tunnel (davrabox.bugvector.uz) are still untested; TURN not configured (phase 2).
- Three third-party images could not be preloaded into kind (kind load failed); the cluster pulled them from the registries instead.
- The local cluster was deleted after validation to free resources; Terraform/Helm paths need a cluster to be exercised again.

## 2026-11-23 (latest): mandatory 2FA for org_admin
- `scripts/keycloak-admin-2fa.mjs` (idempotent) builds Keycloak flow `browser-admin-2fa`: sub-flow A forces the OTP form for role org_admin (enrols an authenticator if none); built-in sub-flow B still challenges non-admin members who enrolled their own TOTP. Two real faults found by the tests and fixed: first version disabled the wrong "user configured" condition (organization sub-flow) and dropped OTP for self-enrolled members; an existing execution config was not updated on rerun (now read/compared/PUT).
- `pnpm --filter @davrabox/e2e test` (system Edge, fake media): call suite 8/8, TOTP suite 5/5, admin-2FA suite 3/3 PASSED (16 checks). The call suite now uses two plain members because `admin.demo` must pass 2FA.
- Caveats: the script must be run after Keycloak first starts (it is not part of the realm import and not yet a Helm hook); demo admin `admin.demo` now has to enrol an authenticator at first login; passkeys (WebAuthn) still not configured.

The earlier "2FA not enforced for admins" item is therefore closed. Remaining open items are the ones listed above, all external (remote repo, staging, ArgoCD install, Figma, real devices, Cloudflare Tunnel, SIEM host).

## 2026-11-23 (evening): public repository and Cloudflare Tunnel (user approved both)
- Repository: https://github.com/menarzullayev/davrabox (PUBLIC), branch main. Before pushing, local history was rewritten (filter-branch) to remove the internal business plan (docx/pdf: budget and strategy, now git-ignored and kept only locally) and the private LAN IP (realm redirect URIs now use the `${PUBLIC_HOST}` placeholder, filled from the environment). Verified on every commit of the pushed history: no plan files, no private IP, no generated dev secret.
- Tunnel: new named tunnel `davrabox` (own credentials and `~/.cloudflared/davrabox.yml`), connector started by this session, DNS `davrabox.bugvector.uz` -> this tunnel, origin `http://127.0.0.1:58081` (Caddy plain-HTTP site, TLS ends at Cloudflare). Evidence: web 200, Keycloak discovery issuer `https://davrabox.bugvector.uz/auth/realms/davrabox`, API unauthenticated 401, and `E2E_BASE_URL=https://davrabox.bugvector.uz node apps/e2e/call.e2e.mjs`: 8/8 PASSED (login via Keycloak at the public host, API, LiveKit WSS through the tunnel, two participants with live video).
- Faults found on the way: (1) the first `cloudflared tunnel route dns davrabox ...` resolved the default tunnel from `~/.cloudflared/config.yml` and pointed the new CNAME at ANOTHER existing tunnel (the host then answered 404); fixed by re-routing my own record with the explicit tunnel UUID (`--overwrite-dns`); no other record or tunnel config was edited. (2) For a few minutes the public host proxied the Keycloak admin console and master realm; now blocked at the edge (`/auth/admin*`, `/auth/realms/master*` return 404 on the public site) and the e2e helpers use the internal admin port.
- API now accepts several token issuers (`KEYCLOAK_ISSUER` comma list) and returns the LiveKit WSS URL for the host the browser used, honouring only allowed origins (10 new unit tests; API tests 42 PASSED). Keycloak no longer pins one hostname (`start-dev`, host from forwarded headers).
- IMPORTANT limit: only signalling and the web app pass through the tunnel. The media path is UDP/TCP straight to this PC (ICE, `node-ip` = LAN IP). The e2e media check runs on this PC, so it proves nothing about a participant on another network. External participants need a reachable address or a TURN relay (phase 2 task, may need a public IP/VPS: see HELD.md).

## 2026-11-23 (night): GitHub CI green, passkeys
- GitHub Actions on https://github.com/menarzullayev/davrabox, latest push: CI `verify` success (typecheck, web build, web/design-token tests, Helm lint+render, Terraform fmt/validate, API tests against real Postgres RLS and real LiveKit) and CI `security` success (pnpm audit high, gitleaks, Trivy fs vuln+misconfig, SBOM artifact), CodeQL success. Four real CI faults found by the first runs and fixed: duplicate pnpm version, non-existent trivy-action tag, Dockerfiles without an explicit non-root USER (now 65532 / 101, images re-run), cdxgen cannot parse the pnpm 12 lockfile (now `pnpm sbom`).
- Passkeys (WebAuthn): members who enrolled a passkey or an authenticator app are challenged with whichever they have (direct ALTERNATIVEs next to the REQUIRED conditions, Keycloak's own conditional-2FA shape). `apps/e2e/passkey.e2e.mjs` (Chromium virtual authenticator) PASSED: registration via required action, second login asks for the passkey (not a TOTP code), passkey signs in. Faults found while building it: a nested REQUIRED/ALTERNATIVE sub-flow makes the "user configured" check vacuous and breaks login for every user without a factor (script now builds and migrates to the working shape, idempotent: second run no-op).
- LIMIT: this Keycloak (26.0.8) has no condition for "has a passkey", so org_admin keeps a mandatory authenticator-app (TOTP) factor; passkey-or-TOTP for admins needs a custom authenticator (SPI). Recorded as a limitation, not claimed.
- Full local e2e (`pnpm --filter @davrabox/e2e test`): call 8/8, TOTP 5/5, admin-2FA 3/3, passkey 3/3 PASSED.
- ArgoCD manifest now points at the real repository and passes the realm file via fileParameters; still not applied (no ArgoCD, staging cluster, or published images: `davra/*:dev` exist only locally; publishing images to GHCR is the next step toward the staging gate).

## 2026-11-23 (late night): staging gate with evidence
- `.github/workflows/publish.yml`: after a green CI on main it builds the api and web images, pushes `ghcr.io/menarzullayev/davrabox-{api,web}:sha-<commit>` (packages are public: anonymous pull works), then a bot commit (`[skip ci]`) rewrites the tags in `deploy/helm/davrabox/values-staging.yaml`.
- Staging cluster: local kind cluster `davra-kind` with ArgoCD v3.6.2 and Application `davrabox-staging` (automated sync, prune, self-heal) watching `main`; secrets are created in-cluster by hand (never in git). Result: Synced/Healthy, all pods Running from the GHCR images, migrations 001+002 applied, API `/healthz` 200 and unauthenticated `/v1/meetings` 401.
- GATE PROOF ("code reaches staging automatically"): commit `a5fd782` pushed -> CI success -> publish workflow success (images for sha-a5fd782, bump commit) -> ArgoCD (no manual action) changed the running api Deployment from `davrabox-api:sha-1dda5e0` to `davrabox-api:sha-a5fd782`.
- Caveats: this "staging" is a kind cluster on the developer PC, not an independent environment; ArgoCD polls (about 3 minutes); the staging host name `staging.davrabox.local` is not resolvable from outside and Keycloak login inside staging was not exercised (only discovery earlier); TURN/UDP media to outsiders still untested.

## 2026-11-23 (final): production web image CSP verified in a browser
- The production image `davra/web:dev` (nginx-unprivileged, strict CSP incl. `worker-src blob:`) was served on the app port behind Caddy and `node apps/e2e/call.e2e.mjs` run against it with console capture: 8/8 PASSED (Keycloak login, API, LiveKit WSS, two participants with live video) and 0 Content-Security-Policy violation lines in the browser console. The previously open "CSP not browser-tested" item is closed. (The Vite dev server was stopped for the test and restarted afterwards.)

Open items, each with its precise blocker (all recorded in HELD.md):
- Figma design system: needs a designer or Figma access; code-side tokens (WCAG-tested) exist.
- Wazuh SIEM: needs a host with ~4 GB RAM beyond the 10 GB Docker budget that already runs other projects.
- Real phone/camera and an external-network participant: need the user's devices and a reachable address or TURN relay (public IP or small VPS; paid, needs approval).
- Passkey-or-TOTP for org_admin: Keycloak 26.0.8 has no "has passkey" condition; needs a custom Java authenticator (SPI) or a Keycloak upgrade; admins keep mandatory TOTP meanwhile.
- Independent staging environment: current staging is a local kind cluster.

## 2026-11-23: user decision closing phase 1
The user decided that phase 1 is closed with these items left open because none of them stops the system from working: Figma design system, Wazuh SIEM (production monitoring, not needed for function), admin passkey-or-TOTP (admins keep mandatory TOTP), independent staging environment, real-device and external-network testing. The only one with product impact is external reachability (public IP / VPS / TURN): it is NOT needed for LAN development and demos, but is required before real customers outside the LAN can see video. It stays in HELD.md and is revisited in phase 2 (TURN) and before any customer pilot.

## 2026-11-23 (phase 2, slice 1): waiting room and host controls
- Migration 003: `join_requests` and `meeting_bans` with FORCE RLS (same tenant pattern). Applied locally.
- API: waiting room (on by default; hosts and org admins skip it), admit/deny with polling by the waiting participant, lock/unlock (also stops an already admitted participant from collecting a token), mute a participant (all published mic tracks), remove = ban from the meeting; everything host-only, audited (`meeting.admit/deny/lock/unlock/mute/remove`), UUID/code validation. Decisions (mine, to be confirmed): an org_admin of the same organization can manage any meeting of that organization (needed for admin control, also means they bypass passcode/lock/waiting room); a denied request is final for that meeting.
- Web: waiting screen (auto-polls, returns to the list with a clear error on deny/ban/lock), host panel (pending requests with Admit/Deny, lock toggle, per-participant Mute/Remove), "Waiting room" checkbox when creating a meeting, uz/ru/en strings (parity test passes).
- Evidence: API tests 60 PASSED (18 new: waiting room defaults, admit/deny, request ids belong to their owner, host-only controls refused for members, cross-organization 404, lock/ban semantics, host cannot be removed, hostile ids, audit rows). Web 5 PASSED, typecheck PASSED, `pnpm audit` clean. E2E (real browser, fake media): call 9/9 (now includes waiting + admit), TOTP 5/5, admin-2FA 3/3, passkey 3/3, host-controls 5/5 (mute really turns the tile muted, lock refuses with visible error, deny, remove drops the participant and the ban blocks a rejoin).
- Pipeline proof for this slice: CI success (verify + security) -> publish -> bump -> ArgoCD rolled staging to `sha-a334efa`, migration 003 applied by the hook, Application Synced/Healthy (kind staging).
- Not done in phase 2 yet: TURN + TLS 443 (needs an externally reachable address for a real test), chat and file sharing, noise suppression, background blur, raise hand/reactions, co-host assignment, speaker/gallery layouts, desktop (Electron) app, 50-participant load test, i18n of the Keycloak login page.

## 2026-11-23 (phase 2, slice 2): chat, raised hand, reactions
- Web only (no server state, nothing stored): signals travel over the LiveKit data channel. `signals.ts` validates everything received (shape, 8 KB cap, 1000-char chat cap, control characters stripped, reactions limited to a fixed set) and never trusts a sender field: the sender is the SFU-verified participant. Chat renders as plain text (no markup, no links). Private messages use `destinationIdentities`, so the SFU delivers them only to the recipient.
- UI: chat panel with unread counter, everyone/private target selector, raise/lower hand (shown on the tile), 6 reactions that pop on the sender's tile; uz/ru/en strings; reduced-motion respected.
- Evidence: web tests 32 PASSED (27 new: codec round trip, 12 malformed/forged/oversized payloads rejected, markup stays literal, forged sender ignored); typecheck and production build PASSED. New e2e `chat.e2e.mjs` 8/8 PASSED with three real browsers: public message with `<b>` and `<img onerror>` shown literally, unread counter, whitespace-only sends nothing, private message reaches only the host (third participant verified not to receive it), raised hand appears and disappears, reaction visible to others. Full e2e suite: call, TOTP, admin 2FA, passkey, host controls, chat all ALL PASSED.
- Pipeline: CI (verify + security) success -> publish -> ArgoCD rolled staging to `sha-9f79861`, Application Synced/Healthy.
- Limits: chat history is not kept (late joiners see nothing earlier, by design: plan says no chat text in logs); a malicious client can label a public message "private" (label only, delivery still follows `destinationIdentities`); chat is not end-to-end encrypted yet (phase 4).
- Still open in phase 2: TURN + TLS 443, file sharing in chat, noise suppression, background blur, co-host, speaker/gallery layouts, Electron desktop app, 50-participant load test, Keycloak login page i18n.

## 2026-11-23 (phase 2, slice 3): noise suppression
- The microphone is captured with browser noise suppression, echo cancellation and auto gain on by default (`audioCaptureDefaults`); a toggle restarts the live track with the chosen setting and shows the state read back from the browser's `MediaStreamTrack.getSettings()`. `apps/e2e/noise.e2e.mjs` 3/3 PASSED (default on, toggled off, back on, verified on the real track). uz/ru/en strings; web tests 32 PASSED, typecheck PASSED.
- Pipeline: CI success -> publish -> ArgoCD rolled staging web to `sha-c0fa260`, Synced/Healthy.
- Honest scope: this is the browser's built-in DSP, not an AI denoiser (Krisp-class). It satisfies the "noise suppression" item at baseline quality; an AI model would be a later upgrade (licensing/size to be decided).
- Still open in phase 2: background blur (needs a self-hosted segmentation model to satisfy the CSP and privacy rules), TURN + TLS 443, file sharing in chat, co-host, speaker/gallery layouts, Electron app, 50-participant load test, Keycloak login page i18n.

## 2026-11-23 (phase 2, slice 4): gallery and speaker views
- Toggle between gallery (yourself first) and speaker view (features a screen sharer, else the last active speaker, else the first remote participant; one featured tile, others in a strip). uz/ru/en strings. `apps/e2e/layout.e2e.mjs` 4/4 PASSED (default gallery, speaker view features someone else, exactly one featured tile first, switching back restores order). Web tests 32 PASSED, typecheck PASSED.
- Pipeline: CI success -> publish -> ArgoCD rolled staging web to `sha-aa957e5`, Synced/Healthy.
- Not verified: featuring a real screen sharer (the fake devices cannot share a screen), and behaviour with 20+ tiles (no pagination yet: planned with the 50-participant load test).
- Still open in phase 2: background blur, TURN + TLS 443, file sharing in chat, co-host, Electron app, 50-participant load test, Keycloak login page i18n.

## 2026-11-23 (phase 2, slice 5): background blur
- `@livekit/track-processors` 0.8.3 + MediaPipe selfie segmentation, fully self-hosted: its defaults fetch from cdn.jsdelivr.net and storage.googleapis.com (blocked by our CSP and against the no-third-party rule), so the model (249 KB, Apache-2.0, sha256 pinned and verified by `scripts/prepare-assets.mjs`, committed with a NOTICE) and the WASM runtime (copied from node_modules at build time) are served from our own origin. CSP gained only `'wasm-unsafe-eval'` for script-src. Toggle in the call controls, disabled while the camera is off, reset when the camera restarts; uz/ru/en strings.
- Evidence: `apps/e2e/blur.e2e.mjs` 6/6 PASSED on the dev server AND against the production nginx image with its strict CSP: toggle loads, camera stays live, hard-edge share of the outgoing picture drops 5.7 -> 0.3 per mille and returns to 6.0 when switched off, zero requests to any other origin, zero CSP violations. Web tests 32 PASSED, typecheck and build PASSED, `pnpm audit` clean.
- Pipeline: CI success -> publish -> ArgoCD rolled staging web to `sha-32ead18`, Synced/Healthy; the staging web image serves the model and the WASM (HTTP 200).
- Limits: tested with Chromium's fake camera (no person in frame, so the whole frame counts as background); segmentation quality on real faces, CPU cost on weak laptops and Safari/Firefox support are not measured (the UI shows an error when `supportsBackgroundProcessors()` is false). The processed video is not yet usable together with the planned E2EE insertable-streams mode (phase 4 design question).
- Still open in phase 2: TURN + TLS 443, file sharing in chat, co-host, Electron app, 50-participant load test, Keycloak login page i18n.

## 2026-11-23 (phase 2, slice 6): Keycloak login page in uz/ru/en
- Custom login theme `davrabox` (parent keycloak.v2) with Uzbek (Latin) messages for the login, authenticator-app, passkey, error and password-reset screens (single source: `deploy/helm/davrabox/files/keycloak-theme`, mounted by compose and rendered into a ConfigMap by the Helm chart); realm `loginTheme=davrabox`. Russian and English come from Keycloak itself. Keys missing from `messages_uz.properties` fall back to English (not every rarely used screen is translated).
- Evidence: `apps/e2e/logini18n.e2e.mjs` 5/5 PASSED (Uzbek page without leftover English, Russian, English, and a wrong password reported in Uzbek). Helm lint and template PASSED (theme ConfigMap rendered).
- Not verified: the theme inside the kind staging cluster (will roll out with this commit; check after); screens such as account console and admin console are not themed.

## 2026-11-23 (phase 2, slice 7): co-host
- Migration 004 `meeting_cohosts` (FORCE RLS). Host or org admin appoints/dismisses a co-host per meeting; a co-host gets the host controls (skips waiting room/passcode/lock, admits, locks, mutes, removes) but cannot appoint co-hosts, cannot remove the host or another co-host, and the rights are per meeting and revoked at once. `GET /me` lets clients follow promotions live; managers also get the co-host list. All audited.
- Web: role polled every 2 s (no rejoin needed), role badge, "Make/Remove co-host" on tiles (real host only), lock/admit/mute/remove for co-hosts; uz/ru/en strings.
- Evidence: API tests 68 PASSED (8 new: role transitions, co-host powers, co-host limits, immediate revocation, per-meeting scope, cross-organization 404, hostile ids, audit rows). `apps/e2e/cohost.e2e.mjs` 6/6 PASSED (promotion reaches the co-host live, no co-host button for non-hosts, co-host locks, dismissal removes the controls live). Web tests and typecheck PASSED.
- Limits: LiveKit token `roomAdmin` is not used for anything (all controls go through our API), so promotion does not need a new token; the 2 s polling is simple, not push.

## 2026-11-23 (phase 2, slice 8): file sharing in the chat
- Dev stack gained `davra-minio` (S3 API, same chainguard image the other project already uses, pinned by digest) and `davra-clamav` (clamav 1.4.7). Migration 005: `meeting_access` (who really passed passcode, lock and waiting room: recorded when a join token is issued) and `meeting_files` (metadata only), both FORCE RLS.
- Upload: `PUT /v1/meetings/:code/files?name=` raw body, capped at 25 MB while reading. Order of checks: authorisation (must have entered the meeting, not banned) -> per-user rate limit (20/min) -> name sanitising (no paths/control chars/hidden names) -> blocked types (exe, scripts, html, svg, ... checked on every dot-suffix, so `report.pdf.exe` fails) -> ClamAV INSTREAM scan, fail closed (antivirus down = nothing stored) -> envelope encryption (random AES-256 data key per file, wrapped by a master key, both AES-256-GCM with the file id as AAD) -> S3 -> audit. Download streams through the API (authorised on every request), always `attachment`, `nosniff`, `CSP: sandbox`, `no-store`; a tampered stored object fails its GCM check and is refused (500).
- Web: attach button, file chip in the chat for the recipients (the `file` signal is validated like the others: uuid id, name <= 200, size <= 25 MB), download via fetch + blob with the original file name; uz/ru/en error messages.
- Evidence: API tests 102 PASSED (34 new, against the real MinIO and ClamAV): crypto round trip, per-file keys, tamper/wrong key/moved blob rejected, policy cases, fake-clamd protocol cases, EICAR rejected (422) and nothing stored, size/type/empty/name rules, stranger who knows the code gets 403, other organisation 404, waiting-room user 403 until admitted, banned user loses access, file id of another meeting 404, tampered object 500, antivirus unreachable 503, not configured 503, rate limit 20/min, audit rows. Web tests 42 PASSED. `apps/e2e/files.e2e.mjs` 6/6 PASSED in real browsers (upload, chip at the recipient, sha-256 identical download with original name, EICAR rejected with a clear message and not announced, .exe refused, outsider upload 403). CI now starts MinIO and ClamAV for the API tests.
- A bug the e2e exposed and fixed: in development (React StrictMode) the aborted first connection attempt of a discarded room raised a stray "Something went wrong" banner; aborted attempts of discarded rooms are now ignored.
- Helm: `files.enabled` (default false) wires S3/ClamAV/master key into the API when an environment provides them; staging keeps it off, so file endpoints answer 503 there (nothing stores files without antivirus and encryption). Honest gaps: master key comes from an environment variable (Vault/HSM integration is a later step, HSM is held); no content-type sniffing beyond the extension blocklist (ClamAV is the content check); downloads are buffered in memory (fine at 25 MB, would need streaming for larger limits); no file expiry/retention job yet (retention is a phase 4 item).

Phase 1 verdict: the software and local-infrastructure items of phase 1 are done and evidenced (including mandatory admin 2FA); the gate ("code reaches staging automatically") is PASSED on a local kind staging with ArgoCD and GHCR images (evidence above); an independent staging environment is still a held item.
Next: phase 2 (video core): TURN + TLS 443, waiting room, host controls, chat, noise suppression/blur, desktop app, 50-participant load test.
