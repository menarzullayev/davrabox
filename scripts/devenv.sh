#!/usr/bin/env bash
# Source this file: it exports the variables the API and its tests need, built from the
# git-ignored deploy/compose/dev.env. It prints nothing and never echoes secrets.
_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
set -a
. "$_root/deploy/compose/dev.env"
set +a
export MIGRATE_DATABASE_URL="postgres://davra_admin:${POSTGRES_PASSWORD}@127.0.0.1:55432/davra"
export DATABASE_URL="postgres://davra_app:${APP_DB_PASSWORD}@127.0.0.1:55432/davra"
export KEYCLOAK_ISSUER="http://${LAN_IP}:8180/realms/davrabox"
export LIVEKIT_URL="ws://${LAN_IP}:7880"
export LIVEKIT_API_URL="http://${LAN_IP}:7880"
export CORS_ORIGINS="http://localhost:5173,http://${LAN_IP}:5173"
unset _root
