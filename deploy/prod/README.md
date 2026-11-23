# DavraBox production bundle (one Linux host, Docker Compose)

Verified on 2026-11-24 by starting every service from the published GHCR images on a clean machine: migrations applied,
Keycloak imported the production realm in production mode (`start`, not `start-dev`), the API answered `/healthz` through Caddy,
the web app carried the strict CSP and HSTS, and the Keycloak admin console, master realm, metrics and health paths returned 404 on the public site.
Not verified in that run: real TLS issuance (needs a public DNS name), LiveKit media from outside the host, ClamAV scans and MinIO uploads with real files.

## Host requirements
- Linux with Docker Engine 24+ and Compose v2, root or docker group, 4 vCPU / 8 GB RAM / 40 GB disk minimum (ClamAV 2 GB, Keycloak 1.5 GB, LiveKit 2 GB limits).
- Public IPv4, DNS `A` record for `PUBLIC_HOST` pointing at it.
- Firewall: allow **80/tcp, 443/tcp, 443/udp, 7881/tcp, 7882/udp, 3478/udp, 52000-52019/udp**. Nothing else is published (Keycloak's operator console binds to 127.0.0.1:8180).
- Without all of those ports WebRTC video does not reach participants outside the host's network (measured on a firewalled shared server: only 80/443 were open and media failed).

## First start
```
cd deploy/prod
cp .env.example .env              # fill every value; generate secrets with: openssl rand -base64 36
docker compose --env-file .env pull
docker compose --env-file .env up -d
```
`migrate` runs once and must finish with exit 0 before `api` starts. Check: `docker compose ps`, then `curl -sf https://$PUBLIC_HOST/api/healthz`.

### Enforce the admin second factor (once, after Keycloak is up)
```
ssh -L 8180:127.0.0.1:8180 <host>          # in another terminal
KEYCLOAK_URL=http://127.0.0.1:8180/auth KEYCLOAK_ADMIN_PASSWORD=... node scripts/keycloak-admin-2fa.mjs
```
Create the first organization admin in the Keycloak console (same tunnel, realm `davrabox`): attribute `org_slug`, realm role `org_admin`. The admin must enrol an authenticator at the first login.

## Update
Pick a tag from the Publish workflow (`sha-<commit>` or `vX.Y.Z`), set `DAVRA_TAG` in `.env`, then:
```
docker compose --env-file .env pull api web
docker compose --env-file .env up -d      # re-runs migrate, then recreates api/web
```
Migrations only move forward. To roll back the code, set the previous tag; a migration that already ran is NOT undone (there are no down migrations).

## Rotate a secret
Change the value in `.env`, then `docker compose --env-file .env up -d` (containers using it are recreated). Special cases:
- `LIVEKIT_API_KEY/SECRET`: update both, restart `livekit` and `api` together; running meetings end.
- `POSTGRES_PASSWORD`/`APP_DB_PASSWORD`: also run `ALTER ROLE ... PASSWORD` inside Postgres (the init script only runs on an empty data directory).
- `FILE_MASTER_KEY`: files already stored are encrypted under the old key; do not change it without re-encrypting them.
- `ADMIN_API_CLIENT_SECRET`: also update the `davrabox-admin-api` client secret in Keycloak.

## Known limits (accepted or open)
- **No backups** (decision 2026-11-24, to be reviewed after 12 months): losing the volumes loses all data. Volumes: `pgdata`, `minio-data`, `clamav-db`, `caddy-data`.
- Single host, single instance of each service: no failover.
- Postgres, MinIO and ClamAV traffic is unencrypted on the internal Docker network.
- No alerting yet (planned: Prometheus, Grafana, Alertmanager, GlitchTip with Telegram notifications).
- The MinIO image comes from `cgr.dev`; when that registry fails (it did on 2026-11-24, HTTP 500) pulls fail until it recovers.
