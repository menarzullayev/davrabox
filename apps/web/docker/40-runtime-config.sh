#!/bin/sh
# Writes /tmp/runtime-config.json for the browser from the container environment (nginx serves it at /runtime-config.json).
# GLITCHTIP_WEB_DSN empty = browser error tracking off. Values that could break out of the JSON string are dropped, not escaped.
set -eu

clean() {
  case "$1" in
    *'"'* | *'\'* | *'
'* | *' '*) printf '' ;;
    *) printf '%s' "$1" ;;
  esac
}

dsn="$(clean "${GLITCHTIP_WEB_DSN:-}")"
env_name="$(clean "${GLITCHTIP_ENVIRONMENT:-production}")"
release="$(clean "${GLITCHTIP_RELEASE:-}")"

printf '{"glitchtipDsn":"%s","environment":"%s","release":"%s"}\n' "$dsn" "$env_name" "$release" > /tmp/runtime-config.json
