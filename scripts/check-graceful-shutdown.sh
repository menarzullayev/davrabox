#!/usr/bin/env bash
# Scripted proof that the real API image (distroless) handles SIGTERM correctly and that its healthcheck works.
#
#   docker build -f apps/api/Dockerfile -t davra-api:check .
#   . scripts/devenv.sh            # DATABASE_URL, KEYCLOAK_ISSUER, LIVEKIT_* (a database you own; never a shared one)
#   scripts/check-graceful-shutdown.sh davra-api:check
#
# It runs the container on a high loopback port (--rm, no volumes), then checks:
#   1. the container healthcheck command (`node dist/healthcheck.js /readyz`, as in deploy/prod/docker-compose.yml) passes;
#   2. a request that is in flight when SIGTERM arrives still completes (a slow /readyz: the media server stub never answers);
#   3. the container exits on its own within the grace limit with a signal-style code (143) or 0, not killed after 10 s;
#   4. Postgres no longer lists connections of the container (application_name) afterwards;
#   0. the start-up log carries the single "REDIS_URL is not set" warning (checked first, before the container is gone).
# Secrets are passed through a temporary env file (mode 600, deleted on exit) and are never printed.
set -euo pipefail
export MSYS_NO_PATHCONV=1 # Git Bash on Windows must not rewrite /nodejs/bin/node into a Windows path

IMAGE="${1:?usage: check-graceful-shutdown.sh <image>}"
NAME="davra-shutdown-check-$$"
PORT="${CHECK_PORT:-13090}"
STALL_PORT="${CHECK_STALL_PORT:-13091}"
APPNAME="shutdown-check-$$"
ENVFILE="$(mktemp)"
chmod 600 "$ENVFILE"
STALL_PID=""
cleanup() {
  [ -n "$STALL_PID" ] && kill "$STALL_PID" 2>/dev/null || true
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -f "$ENVFILE"
}
trap cleanup EXIT

: "${DATABASE_URL:?source scripts/devenv.sh first}"
: "${KEYCLOAK_ISSUER:?}" "${LIVEKIT_API_KEY:?}" "${LIVEKIT_API_SECRET:?}"

# A "media server" that accepts connections and never answers: /readyz then takes its full 1.5 s timeout.
node -e "require('net').createServer(s=>{s.on('error',()=>{})}).listen(${STALL_PORT},'0.0.0.0')" &
STALL_PID=$!

{
  echo "DATABASE_URL=${DATABASE_URL//127.0.0.1/host.docker.internal}"
  echo "KEYCLOAK_ISSUER=${KEYCLOAK_ISSUER}"
  echo "LIVEKIT_URL=ws://host.docker.internal:${STALL_PORT}"
  echo "LIVEKIT_API_URL=http://host.docker.internal:${STALL_PORT}"
  echo "LIVEKIT_API_KEY=${LIVEKIT_API_KEY}"
  echo "LIVEKIT_API_SECRET=${LIVEKIT_API_SECRET}"
  echo "PGAPPNAME=${APPNAME}"
  echo "SIGNUP_BACKGROUND_JOBS=0"
  echo "METRICS_PORT=9100"
} > "$ENVFILE"

docker run -d --rm --name "$NAME" --add-host host.docker.internal:host-gateway --env-file "$(cygpath -w "$ENVFILE" 2>/dev/null || echo "$ENVFILE")" -p "127.0.0.1:${PORT}:3000" "$IMAGE" >/dev/null

echo "waiting for the API to listen..."
for i in $(seq 1 60); do
  curl -s -o /dev/null "http://127.0.0.1:${PORT}/healthz" && break
  sleep 1
done
curl -sf "http://127.0.0.1:${PORT}/healthz" >/dev/null || { echo "FAILED: the API never answered /healthz"; docker logs "$NAME" | tail -20; exit 1; }

echo "0. start-up log carries the single REDIS_URL warning (no Redis configured in this run)"
W="$(docker logs "$NAME" 2>&1 | grep -c 'REDIS_URL is not set' || true)"
[ "$W" = "1" ] && echo "   (PASSED: exactly one warning)" || { echo "FAILED: expected one REDIS_URL warning, saw $W"; exit 1; }

echo "1. healthcheck command inside the distroless image"
docker exec "$NAME" /nodejs/bin/node dist/healthcheck.js /healthz || { echo "FAILED: healthcheck of /healthz did not exit 0"; exit 1; }
echo "   /healthz: exit 0 (PASSED)"
RC=0
docker exec "$NAME" /nodejs/bin/node dist/healthcheck.js /readyz || RC=$?
[ "$RC" = "1" ] && echo "   /readyz: exit 1 while the media server is down (PASSED)" || { echo "FAILED: /readyz healthcheck exit code was $RC, expected 1 (media server stub is silent)"; exit 1; }

echo "2. SIGTERM while a request is in flight"
sleep 2.5 # /readyz answers are cached for 2 s: wait so the next request really runs (about 1.5 s) instead of hitting the cache
OUT="$(mktemp)"
( curl -s -w '
%{http_code}' "http://127.0.0.1:${PORT}/readyz" > "$OUT" ) &
CURL_PID=$!
sleep 0.4
WAITOUT="$(mktemp)"
docker wait "$NAME" > "$WAITOUT" & # started before the signal so a --rm removal cannot race it
WAIT_PID=$!
SENT=$(date +%s%3N)
docker kill --signal=SIGTERM "$NAME" >/dev/null
wait "$CURL_PID" || true
ANSWERED=$(date +%s%3N)
CODE="$(tail -n 1 "$OUT")"
BODY="$(head -n 1 "$OUT")"
echo "   in-flight /readyz answered HTTP $CODE with body: $BODY"
[ "$CODE" = "503" ] && printf '%s' "$BODY" | grep -q '"postgres":true' || { echo "FAILED: the in-flight request was cut off or answered unexpectedly"; exit 1; }
[ $((ANSWERED - SENT)) -ge 500 ] || { echo "FAILED: the request finished only $((ANSWERED - SENT)) ms after SIGTERM: it was not in flight, the check proves nothing"; exit 1; }
echo "   (PASSED: the request was still running ${SENT:+$((ANSWERED - SENT))} ms after SIGTERM and was drained, not dropped)"

echo "3. the container exits by itself"
wait "$WAIT_PID"
DONE=$(date +%s%3N)
EXIT_CODE="$(tr -d '[:space:]' < "$WAITOUT")"
echo "   exit code ${EXIT_CODE} after $((DONE - SENT)) ms"
{ [ "$EXIT_CODE" = "143" ] || [ "$EXIT_CODE" = "0" ]; } && [ $((DONE - SENT)) -lt 9000 ] && echo "   (PASSED: clean, well inside Docker's 10 s default grace)" || { echo "FAILED: unexpected exit code or too slow"; exit 1; }

echo "4. Postgres connections of the container are gone"
sleep 1
N="$(cd apps/api && node -e "
const {Pool}=require('pg');
const p=new Pool({connectionString:process.env.MIGRATE_DATABASE_URL});
p.query('SELECT count(*) n FROM pg_stat_activity WHERE application_name=\$1',['${APPNAME}']).then(r=>{console.log(r.rows[0].n);return p.end()});
")"
echo "   connections with application_name ${APPNAME}: ${N}"
[ "$N" = "0" ] && echo "   (PASSED)" || { echo "FAILED: connections survived the shutdown"; exit 1; }
echo "ALL CHECKS PASSED"
