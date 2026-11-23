# DavraBox

Security-first corporate video conferencing platform (web + desktop). Status: early development (phase 1 of 8).
All rights reserved. See `docs/GOAL.md` for scope and rules, `docs/PROGRESS.md` for current state.

## Run the dev stack (Windows + Docker Desktop)
1. `cp deploy/compose/dev.env.example deploy/compose/dev.env` and fill in values (git-ignored).
2. `cd deploy/compose && docker compose --env-file dev.env up -d`
3. After the first Keycloak start: `. scripts/devenv.sh && KEYCLOAK_URL=http://$LAN_IP:8180/auth node scripts/keycloak-admin-2fa.mjs` (makes TOTP mandatory for org_admin; idempotent).
3b. `. scripts/devenv.sh` (exports API/test variables), then `pnpm install`, `pnpm --filter @davrabox/api migrate`
4. API: `API_PORT=3000 pnpm --filter @davrabox/api start`; web: `pnpm --filter @davrabox/web dev`
5. Open `https://localhost:8443` (accept the local certificate).
6. Tests: `pnpm --filter @davrabox/api test`, `pnpm --filter @davrabox/web test`, ``pnpm --filter @davrabox/e2e test` (call, TOTP and admin-2FA suites).

## Staging flow
A green CI run on `main` publishes `ghcr.io/menarzullayev/davrabox-{api,web}:sha-<commit>`, a bot commit rewrites the tags in
`deploy/helm/davrabox/values-staging.yaml`, and ArgoCD (watching `main`, application in `deploy/argocd/application.yaml`) rolls staging forward.
