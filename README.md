# DavraBox

Security-first corporate video conferencing platform (web + desktop). Status: early development (phase 1 of 8).
All rights reserved. See `docs/GOAL.md` for scope and rules, `docs/PROGRESS.md` for current state.

## Run the dev stack (Windows + Docker Desktop)
1. `cp deploy/compose/dev.env.example deploy/compose/dev.env` and fill in values (git-ignored).
2. `cd deploy/compose && docker compose --env-file dev.env up -d`
3. `. scripts/devenv.sh` (exports API/test variables), then `pnpm install`, `pnpm --filter @davrabox/api migrate`
4. API: `API_PORT=3000 pnpm --filter @davrabox/api start`; web: `pnpm --filter @davrabox/web dev`
5. Open `https://localhost:8443` (accept the local certificate).
6. Tests: `pnpm --filter @davrabox/api test`, `pnpm --filter @davrabox/web test`, `node apps/e2e/call.e2e.mjs`.
