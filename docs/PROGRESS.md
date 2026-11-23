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

Next: kind cluster + Helm chart skeleton, TURN (coturn/LiveKit TURN) and TLS 443, enforce 2FA for admins, waiting room, host controls (phase 2).
