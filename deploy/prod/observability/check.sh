#!/usr/bin/env bash
# Validates the observability configuration with the official tools, run from their own images (nothing is installed on the host):
#   promtool check config / check rules / test rules, amtool check-config, blackbox_exporter --config.check, Compose config, dashboard JSON.
# Usage: deploy/prod/observability/check.sh      (needs Docker; exits non-zero on the first failure)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
obs="$(pwd)"
prod="$(cd .. && pwd)"
export MSYS_NO_PATHCONV=1 # Git Bash on Windows: keep container paths as written
win() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }

PROM=prom/prometheus:v3.15.1
AM=prom/alertmanager:v0.34.2
BB=prom/blackbox-exporter:v0.29.1

echo "== promtool check config"
docker run --rm --entrypoint promtool -v "$(win "$obs/prometheus.yml"):/etc/prometheus/prometheus.yml:ro" -v "$(win "$obs/rules"):/etc/prometheus/rules:ro" "$PROM" check config /etc/prometheus/prometheus.yml
echo "== promtool check rules"
docker run --rm --entrypoint promtool -v "$(win "$obs"):/obs:ro" "$PROM" check rules /obs/rules/davrabox.yml
echo "== promtool test rules"
docker run --rm --entrypoint promtool -v "$(win "$obs"):/obs:ro" "$PROM" test rules /obs/tests/rules.test.yml
echo "== amtool check-config"
docker run --rm --entrypoint amtool -v "$(win "$obs/alertmanager.yml"):/etc/alertmanager/alertmanager.yml:ro" "$AM" check-config /etc/alertmanager/alertmanager.yml
echo "== blackbox_exporter --config.check"
docker run --rm -v "$(win "$obs/blackbox.yml"):/etc/blackbox/blackbox.yml:ro" "$BB" --config.check --config.file=/etc/blackbox/blackbox.yml
echo "== Compose config (main stack and observability overlay)"
docker compose --env-file "$(win "$prod/.env.example")" -f "$(win "$prod/docker-compose.yml")" config -q
GRAFANA_ADMIN_PASSWORD=x GLITCHTIP_SECRET_KEY=x GLITCHTIP_DB_PASSWORD=x docker compose --env-file "$(win "$prod/.env.example")" -f "$(win "$prod/docker-compose.observability.yml")" config -q
echo "== Caddyfile"
docker run --rm -e PUBLIC_HOST=davrabox.example.org -e SITE_ADDRESS=davrabox.example.org -e ACME_EMAIL=ops@example.org -v "$(win "$prod/Caddyfile"):/etc/caddy/Caddyfile:ro" caddy:2.10-alpine caddy validate --config /etc/caddy/Caddyfile >/dev/null
echo "== Grafana dashboard JSON"
node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(!d.uid||!d.panels.length) throw new Error("empty dashboard"); console.log(d.panels.length+" panels")' "$(win "$obs/grafana/dashboards/davrabox-overview.json")"
echo "all observability checks passed"
