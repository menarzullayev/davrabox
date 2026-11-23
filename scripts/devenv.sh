#!/usr/bin/env bash
# Source this file: it exports the variables the API and its tests need, built from the
# git-ignored deploy/compose/dev.env. It prints nothing and never echoes secrets.
_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
set -a
. "$_root/deploy/compose/dev.env"
set +a
export MIGRATE_DATABASE_URL="postgres://davra_admin:${POSTGRES_PASSWORD}@127.0.0.1:55432/davra"
export DATABASE_URL="postgres://davra_app:${APP_DB_PASSWORD}@127.0.0.1:55432/davra"
export KEYCLOAK_ISSUER="https://${LAN_IP}:8443/auth/realms/davrabox,https://localhost:8443/auth/realms/davrabox,https://davrabox.bugvector.uz/auth/realms/davrabox"
export KEYCLOAK_JWKS_URL="http://${LAN_IP}:8180/auth/realms/davrabox/protocol/openid-connect/certs"
export LIVEKIT_URL="wss://${LAN_IP}:8443/livekit"
export LIVEKIT_API_URL="http://${LAN_IP}:7880"
# Optional hosted media server (LiveKit Cloud): set LIVEKIT_CLOUD_URL (wss://<project>.livekit.cloud), LIVEKIT_CLOUD_KEY and
# LIVEKIT_CLOUD_SECRET in dev.env. Remove them (or comment them out) to go back to the local LiveKit. Never printed.
if [ -n "${LIVEKIT_CLOUD_URL:-}" ] && [ -n "${LIVEKIT_CLOUD_KEY:-}" ] && [ -n "${LIVEKIT_CLOUD_SECRET:-}" ]; then
  export LIVEKIT_URL="$LIVEKIT_CLOUD_URL"
  export LIVEKIT_API_URL="https://${LIVEKIT_CLOUD_URL#wss://}"
  export LIVEKIT_API_KEY="$LIVEKIT_CLOUD_KEY"
  export LIVEKIT_API_SECRET="$LIVEKIT_CLOUD_SECRET"
  export LIVEKIT_URL_FIXED=1
fi
export CORS_ORIGINS="https://${LAN_IP}:8443,https://localhost:8443,https://davrabox.bugvector.uz"
export KEYCLOAK_ADMIN_URL="http://${LAN_IP}:8180/auth"
export KEYCLOAK_ADMIN_CLIENT_SECRET="${ADMIN_API_CLIENT_SECRET:-}"
[ -n "$KEYCLOAK_ADMIN_CLIENT_SECRET" ] || unset KEYCLOAK_ADMIN_URL KEYCLOAK_ADMIN_CLIENT_SECRET
export S3_ENDPOINT="http://127.0.0.1:59000"
# Recording needs the local LiveKit + Egress (a hosted LiveKit cannot reach the local MinIO), so it is off in LiveKit Cloud mode.
if [ -z "${LIVEKIT_CLOUD_URL:-}" ]; then
  export RECORDING_ENABLED=1
  export RECORDING_S3_ENDPOINT="http://minio:9000"
fi
export CLAMAV_HOST="127.0.0.1"
export CLAMAV_PORT="53310"
unset _root
