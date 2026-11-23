#!/usr/bin/env bash
# Source this file: it exports the variables the API and its tests need, built from the
# git-ignored deploy/compose/dev.env. It prints nothing and never echoes secrets.
_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
set -a
. "$_root/deploy/compose/dev.env"
set +a
export MIGRATE_DATABASE_URL="postgres://davra_admin:${POSTGRES_PASSWORD}@127.0.0.1:55432/davra"
export DATABASE_URL="postgres://davra_app:${APP_DB_PASSWORD}@127.0.0.1:55432/davra"
export KEYCLOAK_ISSUER="https://${LAN_IP}:8443/auth/realms/davrabox"
export KEYCLOAK_JWKS_URL="http://${LAN_IP}:8180/auth/realms/davrabox/protocol/openid-connect/certs"
export LIVEKIT_URL="wss://${LAN_IP}:8443/livekit"
export LIVEKIT_API_URL="http://${LAN_IP}:7880"
export CORS_ORIGINS="https://${LAN_IP}:8443,https://localhost:8443"
unset _root
