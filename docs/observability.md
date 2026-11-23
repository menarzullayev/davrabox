# Observability: logs, metrics, alerts, error tracking

Everything is self-hosted on the production host. No log, metric, error report or alert goes to a third-party SaaS. The only outbound
call is Alertmanager to the Telegram Bot API (the alert text itself, to your own bot).

| Concern | Where | Notes |
|---|---|---|
| Request logs | API stdout, JSON, one line per request | `docker compose logs api`; Docker keeps 5 x 20 MB |
| Metrics | Prometheus (30 days or 5 GB) | scrapes api, livekit, caddy, node, blackbox |
| Dashboard | Grafana, provisioned "DavraBox overview" (19 panels) | traffic, errors, latency, meetings, pool, sign-ups, webhooks, disk |
| Alerts | Alertmanager -> Telegram | 12 rules in `deploy/prod/observability/rules/davrabox.yml` |
| Uptime and certificate | blackbox_exporter probes the PUBLIC URL from the host | `/`, `/api/healthz`, the Keycloak discovery document |
| Errors (API and browser) | GlitchTip (Sentry-compatible), 30 days | PII scrubbed before anything leaves the process |

## 1. API logging

`apps/api/src/observability/`. Every request writes exactly one line when the response is done:

```json
{"ts":"2026-11-24T10:15:30.123Z","level":"info","msg":"request","requestId":"7d7c40ec-838f-4c3e-a890-287766a176a1","method":"GET","route":"/v1/meetings/:code/me","status":200,"latencyMs":12.4,"orgId":"...","userId":"..."}
```

- The log is an **allow-list**: `ts, level, msg, requestId, method, route, status, latencyMs` plus `orgId` and `userId` when the caller was authenticated
  (by sign-in or by API key). Headers, the query string, path parameters, bodies, cookies, tokens, passcodes and file names cannot appear because they
  are never read. `route` is the route template (`/v1/meetings/:code/me`), not the URL (meeting codes are in the path).
- `X-Request-Id`: a caller-supplied value is accepted only if it is 8-64 characters of `A-Za-z0-9._-`; otherwise the API generates a UUID. It is returned in the
  `X-Request-Id` response header and in every error body, so a user's "request id" leads straight to the log line (and the GlitchTip event, tagged `request_id`).
- Errors: every response with an error is `{"statusCode":..,"message":..,"requestId":..}` (plus the stable `code` that sign-up already returned). No stack
  traces, framework wording (`Cannot GET /x`), parser details or SQL. For a 5xx the exception is logged as a second line (`"msg":"unhandled_exception"`)
  with the stack on the server; error message and stack go through `redactText` (bearer tokens, JWTs, `user:password@` in URLs, `password=`/`token:` style pairs).
- Boot messages keep Nest's default logger.
- Tests: `apps/api/test/observability.test.ts` feeds hostile headers, bodies and query strings and asserts that none of the secrets appear in the log output,
  and that a thrown error yields the safe body.

Useful queries:
```
docker compose logs --since 15m api | grep '"level":"error"'
docker compose logs api | grep '<request id from the user>'
```

## 2. Metrics

Served by the API on its internal port (METRICS_PORT 9100, never published). Added in this work:

| Metric | Labels | Meaning |
|---|---|---|
| `davra_http_request_duration_seconds` (histogram) | method, route, status | latency and rate; 5xx ratio is derived from it |
| `davra_db_pool_connections` | pool (`main`, `ext_api`, `signup`), state (`total`, `idle`, `waiting`) | database pool use |
| `davra_db_pool_max_connections` | pool | configured pool size |
| `davra_active_rooms`, `davra_active_participants` | none | from the LiveKit room list, cached 10 s so scraping adds no load |
| `davra_signup_success_total`, `davra_signup_refusals_total` | reason (bounded code set) | trial sign-ups |
| `davra_webhook_deliveries_total` | outcome (`delivered`, `retry`, `dead`) | customer webhook outbox |
| existing: `davra_meetings_created_total`, `davra_meeting_join_total`, Node process metrics | | |

## 3. Error tracking (GlitchTip)

- API: `GLITCHTIP_DSN` (empty = off: the SDK is not even loaded). Only error capture is on (no tracing, no breadcrumbs, no default integrations, no
  local variables). 5xx errors and uncaught exceptions/rejections are reported.
- Browser: the web container writes `/runtime-config.json` at start from `GLITCHTIP_WEB_DSN`; the page reads it and only then loads the SDK (a separate
  lazy chunk). With an empty value the page makes no request other than fetching its own `/runtime-config.json`. No replay, no tracing, no breadcrumbs.
- **Scrubbing (beforeSend, API and browser)**: request bodies, headers, cookies, query strings, user data, host name, breadcrumbs, extra data and local
  variables are dropped; the URL is cut at `?` and `#` (the E2EE meeting key travels in the URL fragment and must never leave the browser). Exception
  messages are redacted. Verified against a real GlitchTip: an event carrying a hostile query string, `Authorization` header and `Cookie` arrived with none of them.
- **CSP stays strict.** The browser DSN is `https://<key>@<PUBLIC_HOST>/_obs/<project id>`: reports go to the same origin, so `connect-src 'self'` already covers it
  and the policy in `apps/web/nginx.conf` is unchanged. Caddy forwards only `/_obs/api/<id>/envelope/` and `/_obs/api/<id>/store/` to GlitchTip (body limit 1 MB,
  a project key is required); every other `/_obs/*` path is 404. The GlitchTip UI is never on a public route.
  (The existing policy also lists `wss:` and `https:` in `connect-src` for LiveKit Cloud; tightening that is a separate decision.)

## 4. Deploy the stack

Prerequisite: the main stack (`docker-compose.yml`) is up; the observability file joins its network (`davrabox_default`, or `DAVRA_NETWORK`).

```
cd deploy/prod
# 1) add the observability values to .env (see the end of .env.example): GRAFANA_ADMIN_PASSWORD, GLITCHTIP_SECRET_KEY (openssl rand -hex 32), GLITCHTIP_DB_PASSWORD
# 2) Telegram files (section 5), then:
docker compose --env-file .env -f docker-compose.observability.yml up -d
docker compose --env-file .env up -d caddy        # picks up the new Caddyfile (metrics listener, /_obs ingest)
```
Needs Docker Compose 2.23 or newer (inline `configs` generate the probe target list from `PUBLIC_HOST`).

Nothing is on a public port. Reach the tools through an SSH tunnel:
```
ssh -L 3030:127.0.0.1:3030 -L 8001:127.0.0.1:8001 -L 9090:127.0.0.1:9090 -L 9093:127.0.0.1:9093 <host>
# Grafana http://localhost:3030 (user admin, password GRAFANA_ADMIN_PASSWORD) | GlitchTip http://localhost:8001 | Prometheus :9090 | Alertmanager :9093
```
GlitchTip's links use `GLITCHTIP_DOMAIN` (default `http://localhost:8001`, matching the tunnel above).

### GlitchTip first run
1. Open `http://localhost:8001` and register. The first account can always register; registration is closed afterwards (`GLITCHTIP_ENABLE_REGISTRATION=false`).
2. Create an organization, a team and two projects: `api` (platform Node) and `web` (platform JavaScript).
3. Open each project's Client Keys. GlitchTip shows a DSN such as `http://<key>@localhost:8001/<id>`. Build the two DSNs from the key (dashes removed, the SDK
   rejects a dashed key) and the project id:
   - `GLITCHTIP_DSN=http://<api key>@glitchtip:8000/<api project id>`
   - `GLITCHTIP_WEB_DSN=https://<web key>@<PUBLIC_HOST>/_obs/<web project id>`
4. Put both in `.env`, then `docker compose --env-file .env up -d api web`.
5. Check the API: `docker compose --env-file .env exec api /nodejs/bin/node -e "const S=require('@sentry/node');S.init({dsn:process.env.GLITCHTIP_DSN});S.captureException(new Error('observability check'));S.flush(3000)"`
   (an issue appears in project `api`). Check the browser path from any machine:
   ```
   curl -s -o /dev/null -w '%{http_code}\n' -X POST "https://<PUBLIC_HOST>/_obs/api/<web project id>/envelope/?sentry_key=<web key>&sentry_version=7" --data-binary $'{"event_id":"fc6d8c0c43fc4630ad850ee518f1b9d0"}\n{"type":"event"}\n{"event_id":"fc6d8c0c43fc4630ad850ee518f1b9d0","platform":"javascript","level":"error","exception":{"values":[{"type":"Error","value":"ingest check"}]}}'
   ```
   expected `200` and an issue in project `web`.
6. In GlitchTip set an email or a webhook for new-issue notifications if you want them there (alerts about availability already go to Telegram).

## 5. Telegram alerts (setup the operator must do; not testable without a token)

Alertmanager uses its native `telegram_configs` receiver. The bot token and the chat id are read from two files that are **not in git** (`deploy/prod/secrets/`
is git-ignored): `bot_token_file` and `chat_id_file` (Alertmanager 0.34.2).

1. In Telegram open `@BotFather`, send `/newbot`, choose a name and a username ending in `bot`. BotFather replies with the token. Treat it like a password.
2. Create a group (for example "DavraBox alerts"), add the bot to it, and send one message in the group.
3. Create the files (single line, no trailing newline):
   ```
   mkdir -p deploy/prod/secrets && cd deploy/prod/secrets
   printf '%s' '<token from BotFather>' > telegram_bot_token
   ```
4. Find the chat id: `curl -s "https://api.telegram.org/bot$(cat telegram_bot_token)/getUpdates"` and read `"chat":{"id":<number>}` (a group id is negative, for a
   supergroup it starts with `-100`; if the list is empty, send another message to the group first).
   ```
   printf '%s' '<chat id>' > telegram_chat_id
   sudo chown 65534:65534 telegram_bot_token telegram_chat_id && sudo chmod 400 telegram_bot_token telegram_chat_id   # Alertmanager runs as `nobody`
   ```
5. Start (or restart) Alertmanager and send a test alert:
   ```
   docker compose --env-file .env -f docker-compose.observability.yml up -d alertmanager
   docker compose --env-file .env -f docker-compose.observability.yml exec alertmanager amtool alert add TestAlert severity=critical \
     --annotation=summary="Test alert" --annotation=description="Telegram delivery check" --alertmanager.url=http://localhost:9093
   ```
   The message arrives within about 10 seconds (critical alerts wait 10 s, others 30 s). If it does not: `docker compose ... logs alertmanager` (a wrong token shows
   `401`, a bot that is not in the chat shows `400 chat not found`); the alert `AlertNotificationsFailing` also fires after 10 minutes of failures.
6. To change the token or chat, replace the file contents and `docker compose ... restart alertmanager`.

## 6. Alerts

| Alert | Condition | Severity |
|---|---|---|
| ApiDown | API not scrapeable 2 min | critical |
| LiveKitDown | LiveKit metrics endpoint down 2 min | critical |
| PublicProbeDown | public URL not 2xx over valid TLS 3 min | critical |
| ApiHigh5xxRate | 5xx share > 2 % for 5 min (and at least 20 requests in the window) | critical |
| ApiLatencyP95High | p95 > 1.5 s for 10 min | warning |
| DbPoolSaturated | a pool has waiting requests, or is at its maximum with none idle, for 5 min | warning |
| DiskSpaceLow | any real filesystem under 15 % free for 10 min | warning |
| CertificateExpiringSoon | public certificate expires in under 14 days (1 h) | warning |
| SignupRefusalsSpike | more than 30 sign-up refusals in 15 min | warning |
| WebhookDeliveriesFailing | more than 10 webhook deliveries abandoned in 1 h | warning |
| ScrapeTargetDown | caddy/node/blackbox/alertmanager not scrapeable 5 min | warning |
| AlertNotificationsFailing | Alertmanager cannot deliver (for example a revoked bot token) 10 min | warning |

Thresholds are starting points: tune them in `rules/davrabox.yml` after a week of real traffic and run `observability/check.sh` (each rule has a unit test
in `observability/tests/rules.test.yml`). Reload without restart: `curl -X POST http://localhost:9090/-/reload` through the tunnel.

## 7. Checks

`deploy/prod/observability/check.sh` runs `promtool check config`, `check rules`, `test rules` (14 cases), `amtool check-config`, `blackbox_exporter --config.check`,
Compose config for both files, `caddy validate` and the dashboard JSON, all from the official images.

### What was verified on 2026-11-24 (throwaway Compose project `davra-obs-test`, removed afterwards)
- All images pull and start; Prometheus scraped all 10 targets "up": the real API process (own database), a real LiveKit, a real Caddy with the production Caddyfile,
  node-exporter, blackbox, Alertmanager, itself. The 12 rules loaded healthy; the Grafana datasource and dashboard were provisioned and every dashboard query evaluates.
- A real Alertmanager sent a test alert and a natural one (PublicProbeDown, the placeholder host does not resolve) through `telegram_configs`, reading the token and chat
  id from files, to a local fake Bot API; the request was `POST /bot<token>/sendMessage` with the expected chat id and text.
- A 500 from the API appeared in GlitchTip without the query string, headers, cookie or password; a browser-style envelope sent through Caddy `/_obs` arrived in the
  `web` project; the GlitchTip UI and admin paths through Caddy answered 404; a wrong key was refused (403); a 2 MB body was refused (413).
- **Not verified**: delivery to the real Telegram (no bot token here), a real Docker host on Linux (the test ran on Docker Desktop: node-exporter's disk series are
  the VM's), `DiskSpaceLow`/`CertificateExpiringSoon` against real values (covered by the rule unit tests only), the web image built from the Dockerfile (the entrypoint script
  and nginx location were run in the official nginx image with a read-only root and tmpfs instead), the browser SDK in a real browser against GlitchTip (unit tests plus the curl envelope),
  Grafana panels rendered visually (queries checked through the API), long-term resource use.

## 8. Known limits
- Monitoring data is **not backed up**, like everything else (decision 2026-11-24). Prometheus keeps 30 days or 5 GB, GlitchTip 30 days.
- One host: if the host is down, nothing alerts (the probes run on the same host). An external heartbeat (a free uptime service pinging `https://<PUBLIC_HOST>/api/healthz`)
  would cover that; it sends no user data but is a third party, so it was left out. Decide separately.
- GlitchTip's web UI and Grafana have password logins and no second factor; they are reachable only through SSH.
- Alertmanager has one receiver (one Telegram chat). Add `telegram_configs` entries or a second route for a different on-call chat.
