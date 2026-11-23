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

Phase 1 verdict: the software and local-infrastructure items of phase 1 are done and evidenced (including mandatory admin 2FA); the gate itself ("daily auto-deploy to staging") is BLOCKED on external items (remote repo, staging environment).
Next: phase 2 (video core): TURN + TLS 443, waiting room, host controls, chat, noise suppression/blur, desktop app, 50-participant load test.
