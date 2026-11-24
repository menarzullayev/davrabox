# Security and reliability testing

Date of the runs below: 2026-11-24. Everything was run against instances started locally for the purpose (own database, loopback ports). Nothing was run against the public host or any third party.

## 1. What is tested and how to run it

| Check | Command | Needs |
|---|---|---|
| Attack suite (114 integration tests on the real application module) | `pnpm --filter @davrabox/api test security-attacks` | dev database (own copy), MinIO, ClamAV, LiveKit like the other API tests |
| Rate limits, Redis outage and shared counters | `pnpm --filter @davrabox/api test rate-limit` | a throw-away Redis: `docker run -d --rm --name rl-redis -p 127.0.0.1:56391:6379 redis:7-alpine`, `RATE_LIMIT_TEST_REDIS_URL=redis://127.0.0.1:56391` (stop it afterwards) |
| Hung-dependency timeouts | `pnpm --filter @davrabox/api test timeouts` | none beyond the database |
| Readiness and container healthcheck | `pnpm --filter @davrabox/api test readiness healthcheck` | database |
| SIGTERM on the real image | `docker build -f apps/api/Dockerfile -t davra-api:check . && scripts/check-graceful-shutdown.sh davra-api:check` | Docker, a database you own (CI runs it too) |
| OWASP ZAP baseline and API scan | section 3 | Docker |
| nuclei | section 3 | Docker, internet (templates, out-of-band server) |

The attack suite never talks to a real identity provider: a local JWKS signs the test tokens, and the Keycloak admin client is switched off for it (without it the user-creation endpoints answer 503 after validating input). Early in its development one run created a user in the shared dev Keycloak because the admin client was still configured; that user was deleted and the suite now removes the admin settings before it starts.

## 2. Attack suite results (`apps/api/test/security-attacks.test.ts`)
Run through the real `AppModule` with real JWT verification, Postgres row-level security, MinIO, ClamAV, the recording, BYOK and webhook code.

| Area | Cases | Result |
|---|---|---|
| JWT: `alg:none`, HS256 with the public key as secret, foreign key, unknown `kid`, wrong issuer, trailing-slash issuer, wrong `azp`, expired, `nbf` in the future, missing/unknown role, missing/traversal/upper-case/SQL organisation slug, garbage, truncated, query-string token, Basic scheme, self-granted extra claims | about 30 | all refused with 401/403 |
| Every protected route without a token | 24 routes | 401 |
| Cross-tenant IDOR: meetings (join, patch, requests, lock, cohosts, me), files (upload, download), recordings (status, list, start, download), admin users/departments/policies, audit list/verify/export, API keys, webhooks, external API (read, delete, users) | about 40 requests, as admin and as member of the other tenant | 404 **identical to the answer for a code that does not exist** (no existence oracle); cross-tenant writes change nothing; a plain member gets 403 on every admin route |
| Database layer | forged `app.current_org` | other tenant's rows invisible, cross-org insert refused by RLS |
| Mass assignment: `org_id`, `orgId`, `org_slug`, `role`, `host_user_id`, `is_admin`, `id`, `created_at`, `__proto__`/`constructor` on meetings, external meetings, users, departments, policies, API keys, webhooks, KMS | about 30 | 400 (strict schemas); a member cannot raise their own role; created meetings belong to the caller's organisation and host |
| Oversized and malformed bodies: 2 MB JSON, truncated JSON, wrong content type, empty, array/null/string roots, 20 000-deep nesting, 25 MB + 1 byte upload | about 12 | 413/400, no 5xx, server stays up |
| Path traversal in meeting codes, file ids and recording ids, hostile file names (`../`, backslashes, NUL, reserved names, double extensions) | about 30 | 400/404, or the name is flattened to `_.._etc_passwd`; no path separator ever reaches the object key |
| SSRF: 29 webhook URLs (cloud metadata, loopback in every notation, private ranges, IPv6 mapped, decimal/octal/hex IPs, credentials in the URL, other schemes, internal service names) and 13 BYOK Vault addresses | about 40 | all refused with 400 |
| Header spoofing: forged left-hand `X-Forwarded-For` entries against the failed-authentication throttle, the global per-IP ceiling, the sign-up challenge limiter and the passcode limiter | 4 | the proxy-appended entry is the key; rotating forged entries never resets a count |

### Vulnerabilities found by the suite or the scans, each with a failing test first
1. **Passcode brute-force race (real).** The join path checked "is blocked" and recorded the failure afterwards, so any number of parallel guesses passed the check: 40 parallel guesses against a limit of 5 all reached the hash comparison. Fixed: the attempt is counted atomically (`INCR`) before the hash is checked. Test: `parallel passcode guessing cannot beat the attempt limit`.
2. **Unauthenticated Brotli decoder exposure, CVE-2026-111497 "Node2Shell" (critical, reported by nuclei).** The API image ran Node 22.22.0 (bundled Brotli 1.1.0; fixed in Node 22.23.4 per the Node.js October 2026 security release) and body-parser inflated `br`, `gzip` and `deflate` request bodies from anyone. Fixed twice: the runtime binary now comes from `node:22.23.5-slim` (the distroless base still ships 22.22.0; same Debian 12 and glibc), and request bodies are never decompressed (`415`, no client of this API compresses requests). Tests: `request bodies are never decompressed` including a negative control that shows the unhardened app decodes Brotli. Sources: [Node.js Brotli Decoder Out-of-Bounds Write, OX Security](https://www.ox.security/blog/node-js-brotli-decoder-out-of-bounds-write-rce-cve-2026-111497/), [Node.js patches Node2shell, CSO](https://www.csoonline.com/article/4241027/node2shell-puts-microsoft-and-node-js-on-brotli-patch-duty.html). Not verified by me against the Node.js release notes themselves (secondary sources); the version fact comes from the pulled images (22.22.0 vulnerable, 22.23.5 current).
3. **NUL / control characters answered 500.** Titles, passcodes, names, search and cursor values with a NUL byte reached Postgres and failed with 500. They are now rejected with 400.
4. **AWS SDK S3 client had no effective timeout.** `requestTimeout` only logs a warning unless `throwOnRequestTimeout` is set; a silent object store would have hung requests. Fixed and tested with a stalled server.
5. **PID 1 shutdown hang.** Nest re-raises the signal after closing; a re-raised signal cannot terminate PID 1 in a container, so the API container sat until the 25 s watchdog. Found by `scripts/check-graceful-shutdown.sh` (exit code 1 after 25.4 s), fixed by exiting explicitly (exit 0 after 1.4 s in the same check).

## 3. Scanner runs

Target: the production edge as built from this branch, on a private Docker network: Caddy with `deploy/prod/Caddyfile` (plain HTTP on a high loopback port, so TLS is not part of the scan) in front of the web image and the API image (Redis-backed limiter, own database `davra_wsr`). The scan instance ran with raised limiter ceilings (`RATE_LIMIT_IP_PER_MINUTE=100000`, `RATE_LIMIT_AUTH_FAIL_MAX=100000`) so that the findings describe the application and not the throttle; the throttle is covered by the tests in section 2.

```
docker network create scan-net
docker run -d --rm --name scan-api --network scan-net --network-alias api --env-file <scan.env> davra-api:check
docker run -d --rm --name scan-web --network scan-net --network-alias web davra-web:check
docker run -d --rm --name scan-caddy --network scan-net -p 127.0.0.1:13081:80 -e PUBLIC_HOST=localhost -e SITE_ADDRESS=:80 -e ACME_EMAIL=ops@example.invalid -v ./deploy/prod/Caddyfile:/etc/caddy/Caddyfile:ro caddy:2.10-alpine
docker run --rm --network scan-net -v <outdir>:/zap/wrk zaproxy/zap-stable zap-baseline.py -t http://scan-caddy -J zap-web.json -r zap-web.html -I -m 2
docker run --rm --network scan-net -v <outdir>:/zap/wrk zaproxy/zap-stable zap-api-scan.py -t http://scan-api:3000/v1/ext/openapi.json -f openapi -J zap-api.json -r zap-api.html -I
docker run --rm --network scan-net -v <outdir>:/out projectdiscovery/nuclei:latest -u http://<caddy-ip> -u http://<api-ip>:3000 -severity info,low,medium,high,critical -rl 150 -c 25 -jsonl -o /out/nuclei.jsonl
```
(nuclei does not use Docker's DNS, so it is given container IP addresses.)

Versions: ZAP 2.17.0 (`zaproxy/zap-stable`), nuclei v3.11.1 with nuclei-templates v10.5.2 (11 288 templates, 2 targets), Node 22.23.5, Caddy 2.10, nginx-unprivileged 1.27.

### ZAP baseline (web through Caddy, 14 URLs, 64 rules passed, 0 failures)
| Finding | Risk | Decision |
|---|---|---|
| CSP: wildcard directive (`connect-src 'self' wss: https:`) | Medium | **Accepted for now.** The browser must reach the media server (`wss:`) which in the interim set-up is a hosted LiveKit on another domain. Follow-up: render `connect-src` from the deployment's `LIVEKIT_URL` at container start and drop the scheme-only sources once media is self-hosted. |
| CSP: `style-src 'unsafe-inline'` | Medium | **Accepted.** Inline styles only; `script-src` has no `unsafe-inline`, so no inline script runs. Needed by the component library's style attributes; nonces are not possible with a static nginx. |
| Cross-Origin-Embedder-Policy missing | Low | **Accepted.** `require-corp` would break cross-origin media and has no benefit here (no `SharedArrayBuffer` use). |
| Cross-Origin-Opener-Policy | Low | **Partly fixed.** Was missing; now `same-origin-allow-popups` (and `Cross-Origin-Resource-Policy: same-origin`). ZAP still asks for plain `same-origin`; not used because it severs the opener of any popup (sign-in flows). |
| Modern web application, storable/cacheable content | Info | No action: hashed assets are cacheable by design (`expires 1y`), `index.html` is `no-cache`. |

HSTS, `nosniff`, `Referrer-Policy`, frame-ancestors and the admin-path blocks all passed.

### ZAP API scan (OpenAPI of `/v1/ext`, active rules, 121 rules)
Before the fix: `X-Content-Type-Options` missing and `Cross-Origin-Resource-Policy` missing (Low). Fixed in the API itself (`applyApiHardening`). After: only informational items (client errors for the probe paths, non-storable responses). Unauthenticated scan: it exercises routing, input handling and the 401 paths of the external API; the authenticated surface is covered by the attack suite, not by ZAP.

### nuclei
4 minutes, 11 288 templates, 2 targets (the edge and the API directly): **no critical, high, medium or low findings; 13 informational matches** (WAF/technology detection, weak-CSP detection (the accepted `https:`/`wss:` sources above), and `http-missing-security-headers` on the API when it is reached directly: the COEP/COOP/permissions-style headers that the edge adds and a JSON API does not need).
The first run, before the fix in section 2, item 2, reported **CVE-2026-111497 (critical) on the API**: `node2shell: VULNERABLE`. The same run after the fix reports nothing.

Out-of-band (Interactsh) checks were enabled by nuclei's defaults: they detect blind SSRF/RCE by watching for callbacks from the target; no callback was seen.

## 4. Limits of this testing (read before relying on it)
- ZAP and nuclei ran **without authentication** and over plain HTTP; TLS configuration and the real public host were not tested (needs a real DNS name).
- The attack suite is a set of attacks someone thought of, not a penetration test. Open items for a human tester: business-logic abuse of the waiting room and co-host flows, LiveKit-side authorisation (room join with a stolen token), E2EE key handling, the Android and desktop shells, calendar OAuth with real provider apps, Keycloak configuration on the real host.
- Failure classes of the limiter (decided and tested): login-adjacent endpoints, passcode attempts, uploads, BYOK, sign-up and the per-IP ceiling **fail closed to an in-memory limit** when Redis is down (never unlimited); the per-user ceiling **fails open** because those users are authenticated and already bounded by the per-IP ceiling and the route limiters. With more than one API instance and Redis down, each instance counts on its own, so the effective limit is up to N times higher until Redis returns.
- The sign-up limits that live in the database (`signup_admit`) were not changed.
- Rate-limit keys use the client address by one rule (`SIGNUP_TRUSTED_PROXY_HOPS`). If the number of proxies in front of the API is configured too low or too high, a client can pick its own key; the attack suite checks the default of 1 (Caddy alone). Changing the hosting chain (for example adding a CDN) means changing this value.
- Accepted: a webhook URL may use any TCP port on a public address; internal ranges are blocked regardless of port.
