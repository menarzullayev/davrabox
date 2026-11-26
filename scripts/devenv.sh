#!/usr/bin/env bash
# Source this file: it exports the variables the API and its tests need, built from the
# git-ignored deploy/compose/dev.env. It prints nothing and never echoes secrets.
_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
set -a
. "$_root/deploy/compose/dev.env"
set +a
# Public name of this machine through its Cloudflare tunnel (staging since production moved to its own host on 2026-11-26).
export DAVRA_TUNNEL_HOST="${DAVRA_TUNNEL_HOST:-davrabox-staging.bugvector.uz}"
export MIGRATE_DATABASE_URL="postgres://davra_admin:${POSTGRES_PASSWORD}@127.0.0.1:55432/davra"
export DATABASE_URL="postgres://davra_app:${APP_DB_PASSWORD}@127.0.0.1:55432/davra"
export KEYCLOAK_ISSUER="https://${LAN_IP}:8443/auth/realms/davrabox,https://localhost:8443/auth/realms/davrabox,https://${DAVRA_TUNNEL_HOST}/auth/realms/davrabox"
export KEYCLOAK_JWKS_URL="http://${LAN_IP}:8180/auth/realms/davrabox/protocol/openid-connect/certs"
export LIVEKIT_URL="wss://${LAN_IP}:8443/livekit"
export LIVEKIT_API_URL="http://${LAN_IP}:7880"
# Optional hosted media server (LiveKit Cloud): set LIVEKIT_CLOUD_URL (wss://<project>.livekit.cloud), LIVEKIT_CLOUD_KEY and
# LIVEKIT_CLOUD_SECRET in dev.env. Remove them (or comment them out) to go back to the local LiveKit. Never printed.
# Set DAVRA_LOCAL_LIVEKIT=1 to force the local LiveKit even when the cloud values are present (e2e that needs local TURN or Egress).
if [ -z "${DAVRA_LOCAL_LIVEKIT:-}" ] && [ -n "${LIVEKIT_CLOUD_URL:-}" ] && [ -n "${LIVEKIT_CLOUD_KEY:-}" ] && [ -n "${LIVEKIT_CLOUD_SECRET:-}" ]; then
  export LIVEKIT_URL="$LIVEKIT_CLOUD_URL"
  export LIVEKIT_API_URL="https://${LIVEKIT_CLOUD_URL#wss://}"
  export LIVEKIT_API_KEY="$LIVEKIT_CLOUD_KEY"
  export LIVEKIT_API_SECRET="$LIVEKIT_CLOUD_SECRET"
  export LIVEKIT_URL_FIXED=1
fi
# Local dev and e2e sign up many throw-away organisations from one address: lift the per-IP hourly limit here only (default 5).
export SIGNUP_IP_PER_HOUR="${SIGNUP_IP_PER_HOUR:-1000}"
export SIGNUP_DAILY_CAP="${SIGNUP_DAILY_CAP:-100000}" # the API test suite also creates many trial organisations in the dev database
export CORS_ORIGINS="https://${LAN_IP}:8443,https://localhost:8443,https://${DAVRA_TUNNEL_HOST}"
export KEYCLOAK_ADMIN_URL="http://${LAN_IP}:8180/auth"
export KEYCLOAK_ADMIN_CLIENT_SECRET="${ADMIN_API_CLIENT_SECRET:-}"
[ -n "$KEYCLOAK_ADMIN_CLIENT_SECRET" ] || unset KEYCLOAK_ADMIN_URL KEYCLOAK_ADMIN_CLIENT_SECRET
export S3_ENDPOINT="http://127.0.0.1:${MINIO_HOST_PORT:-59000}"
# Recording needs the local LiveKit + Egress (a hosted LiveKit cannot reach the local MinIO), so it is off in LiveKit Cloud mode.
if [ -n "${DAVRA_LOCAL_LIVEKIT:-}" ] || [ -z "${LIVEKIT_CLOUD_URL:-}" ]; then
  export RECORDING_ENABLED=1
  export RECORDING_S3_ENDPOINT="http://minio:9000"
fi
export CLAMAV_HOST="127.0.0.1"
export CLAMAV_PORT="53310"
unset _root
