# Secret rotation and incident runbook

Scope: the single-host production bundle in `deploy/prod` (Docker Compose). Verified against `deploy/prod/.env.example`, `docker-compose.yml`, `deploy/keycloak/davrabox-realm.prod.json` and the API source on 2026-11-24. The short version of the rotation notes also lives in `deploy/prod/README.md` ("Rotate a secret"); this document is the full one.

Conventions: `cd deploy/prod` first; `.env` is the file next to `docker-compose.yml`; "recreate" means `docker compose --env-file .env up -d <service>` (Compose recreates a container when its environment changed). Generate values with `openssl rand -base64 36` (or `-base64 32` where a key is stated). **Never paste a secret into a command line that is logged or into chat, a ticket or a commit**; edit `.env` in an editor and pass database passwords through `psql`'s interactive `\password`.

Backups are OFF (accepted risk, decision 2026-11-24). Consequence for every step below: a rotation that goes wrong cannot be undone from a backup. Before touching `pgdata`, `minio-data` or `FILE_MASTER_KEY`, take a copy by hand (`docker compose stop` the writers, then archive the volume) and keep it until the change is verified.

## 1. Inventory: what is a secret, who uses it, what breaks

| Secret (`.env`) | Used by | Rotation effect | Section |
|---|---|---|---|
| `POSTGRES_PASSWORD` | role `davra_admin` (migrations, Keycloak's own database user `KC_DB_PASSWORD`, the API's `MIGRATE_DATABASE_URL`) | brief API and Keycloak restart | 2.1 |
| `APP_DB_PASSWORD` | role `davra_app` (everything the API does at run time; row-level security applies to it) | API restart (a few seconds of 5xx) | 2.2 |
| `KEYCLOAK_ADMIN_PASSWORD` | Keycloak master realm bootstrap admin (operator console over an SSH tunnel) | none for users | 2.3 |
| `ADMIN_API_CLIENT_SECRET` | confidential client `davrabox-admin-api` in the realm; the API uses it to create and manage users | admin console user management and trial sign-up fail until both sides match | 2.4 |
| `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | LiveKit server, Egress, the API (tokens, room control, webhook signature). The API also derives two things from the secret, see 2.5 | every running meeting ends | 2.5 |
| `S3_ACCESS_KEY`, `S3_SECRET_KEY` | MinIO root credentials and the API's storage credentials (the API passes them to Egress per recording) | file and recording access fails while they differ | 2.6 |
| `FILE_MASTER_KEY` | AES-256-GCM key that wraps every per-file, per-recording and per-secret data key | **cannot be rotated today without a re-wrap tool**; see 2.7 | 2.7 |
| `GOOGLE_CLIENT_SECRET`, `MS_CLIENT_SECRET` (+ client ids) | calendar OAuth code exchange and token refresh | calendar connect fails until updated; stored refresh tokens keep working | 2.8 |
| `SIGNUP_TRUSTED_PROXY_HOPS` | not a secret; one rule for every rate limit | wrong value lets a client choose its own rate-limit key | `docs/security-testing.md` |
| TLS certificates and the ACME account key (`caddy-data` volume) | Caddy | issuance only; nothing to configure | 2.9 |

Secrets that are **not** in `.env` but exist, and how they are replaced:

| Secret | Where it lives | How it is replaced |
|---|---|---|
| Customer API keys `dbx_...` | database, only an HMAC of the secret part | the owner's admin revokes (`DELETE /v1/admin/api-keys/:id`) and creates a new one; the old key stops at once |
| Webhook signing secrets (`whsec_...`) | database, encrypted under `FILE_MASTER_KEY` | delete the endpoint and create it again (the new secret is shown once); there is no in-place rotate |
| Customer BYOK Vault token | database (`org_kms.config_enc`), encrypted under `FILE_MASTER_KEY` | the org admin sends the new token with `PUT /v1/admin/kms` (audited as `kms.rotate`) |
| Calendar refresh tokens | database, encrypted under `FILE_MASTER_KEY` | user disconnects (`DELETE /v1/calendar/:provider`) and reconnects |
| `SIGNUP_CAPTCHA_SECRET` (optional) | environment | not set by the bundle: the key is derived from `LIVEKIT_API_SECRET` (2.5) |
| `AUDIT_WEBHOOK_SECRET` (optional, SIEM forwarding) | environment | set a new value on both ends, recreate `api`; rows already forwarded are not re-sent |
| Keycloak realm signing keys | Keycloak database | Realm settings > Keys > Providers: add a new RSA provider with a higher priority, keep the old one passive until tokens signed with it expire (access tokens are short-lived), then delete it. The API reads the JWKS dynamically; no API change or restart |
| SSH keys, GitHub tokens, GHCR credentials | operator machines, GitHub | outside this repository; rotate in GitHub settings |

## 2. Rotation steps

### 2.1 `POSTGRES_PASSWORD` (role `davra_admin`)
The initdb script runs only on an empty data directory, so changing `.env` alone does not change the role.
1. `docker compose exec postgres psql -U davra_admin -d davra` then `\password davra_admin` (type the new value twice; it is hashed client-side).
2. Put the same value in `.env` as `POSTGRES_PASSWORD`.
3. `docker compose --env-file .env up -d keycloak api` (Keycloak's `KC_DB_PASSWORD` and the API's `MIGRATE_DATABASE_URL` change). The `migrate` job reads it on the next release.
4. Verify: `docker compose ps` (keycloak healthy, api healthy), `curl -sf https://$PUBLIC_HOST/api/readyz`.
What breaks if you only do step 2: Keycloak and `migrate` fail to log in after the next restart. If you only do step 1: the same, until `.env` matches.

### 2.2 `APP_DB_PASSWORD` (role `davra_app`)
1. `docker compose exec postgres psql -U davra_admin -d davra`, then `\password davra_app`.
2. Same value in `.env`.
3. `docker compose --env-file .env up -d api` (about 5 s of errors while it restarts; the API drains in-flight requests on SIGTERM, see `scripts/check-graceful-shutdown.sh`).
4. Verify `/api/readyz` reports `"postgres":true`.
Between steps 1 and 3 the running API keeps its open connections until they are recycled; new connections fail. Do step 3 immediately.

### 2.3 `KEYCLOAK_ADMIN_PASSWORD`
`KC_BOOTSTRAP_ADMIN_PASSWORD` is read only when the master realm is first created, so editing `.env` later does nothing to the live account.
1. Open the console through the tunnel (`ssh -L 8180:127.0.0.1:8180 <host>`, `http://127.0.0.1:8180/auth`), sign in, Users > admin > Credentials > Reset password (not temporary).
2. Update `.env` so the file does not mislead the next person; no restart is needed.
3. Consider a named personal admin with its own password and disabling the bootstrap account; the console is reachable only through the tunnel, which is the real protection.

### 2.4 `ADMIN_API_CLIENT_SECRET`
The realm is imported once (`--import-realm` skips an existing realm), so the value in the realm file only seeds a fresh installation.
1. Console (tunnel): realm `davrabox` > Clients > `davrabox-admin-api` > Credentials > Regenerate. Copy the new value.
2. Put it in `.env`, then `docker compose --env-file .env up -d api`.
3. Verify: in the admin console (the web app), open Users; or `docker compose logs api | grep -i "identity provider"` shows no 502 lines. Trial sign-up uses the same client: a refused sign-up with `signup_unavailable` or 502 means the values differ.
If the secret was leaked, also check Clients > `davrabox-admin-api` > Sessions and the user list for accounts you did not create (the client may only manage users: roles `org_admin`/`member` are the dangerous part).

### 2.5 `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET`
Key and secret are a pair used by three services. Rotate both values, then restart all three together.
1. Pick a quiet time: **all running meetings end** (LiveKit restarts and previously issued tokens stop verifying).
2. Edit both values in `.env`. The secret must be at least 32 characters.
3. `docker compose --env-file .env up -d livekit egress api`.
4. Verify: start a meeting from the web app and join from a second browser; start a 20-second recording (Egress authenticates with the same pair); `/api/readyz` shows `"livekit":true`.
What else changes (derived from the secret in the API, `apps/api/src/app.module.ts` and `signup/limits.ts`): the cursors of the audit log pages (MAC key) become invalid, so an admin who has an audit page open reloads it; the sign-up captcha key and the per-address hash key (used by the database sign-up limits) change, so captcha challenges issued before the change fail (the browser fetches a new one) and the per-IP sign-up history starts from zero once, which gives an attacker one fresh budget of `SIGNUP_IP_PER_HOUR` attempts. Do the rotation off-peak and watch `signup_events` for a burst afterwards.
If a hosted LiveKit (LiveKit Cloud, `LIVEKIT_URL_FIXED=1`) is used instead: create a new key pair in its console, switch the API (`LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET`), recreate `api`, then delete the old key in the console. Egress is not used in that mode.

### 2.6 `S3_ACCESS_KEY` / `S3_SECRET_KEY`
These are the MinIO root credentials and the application's credentials at once (a least-privilege service account for the API is an open improvement).
1. Stop the writers: `docker compose stop api egress`.
2. Edit `.env`; `docker compose --env-file .env up -d minio` (MinIO takes the new root user from its environment on start).
3. `docker compose --env-file .env up -d api egress`.
4. Verify: upload a small file in a meeting and download it again; start and stop a short recording.
Data stays readable: object encryption is done by the API (`FILE_MASTER_KEY`), not by MinIO. Stored credentials exist nowhere else (Egress receives them per recording).

### 2.7 `FILE_MASTER_KEY` (does not rotate today)
It wraps the per-object data keys of files and recordings, every webhook signing secret, every stored calendar refresh token and every customer Vault configuration. Changing the value in `.env` makes all of them unreadable: downloads answer errors, webhook deliveries cannot be signed, calendar connections fail and BYOK configurations cannot be opened. **Do not change it unless it is compromised, and then only with the procedure below.**

There is no re-wrap tool in the repository (open item). The data to re-wrap, so that the tool can be written and tested on a copy:
- `meeting_files.wrapped_key` and `recordings.wrapped_key` where `kek_id IS NULL` (platform-wrapped; rows with a `kek_id` are wrapped by the customer's key and are unaffected). Unwrap with the old key, wrap with the new one, additional authenticated data is the object id. The encrypted objects in MinIO are not touched.
- `webhook_endpoints.secret_wrapped_key` (additional data = the endpoint id).
- `calendar_connections.wrapped_key` (additional data = the connection AAD of user and provider); `calendar_oauth_states` rows live 10 minutes: delete them.
- `org_kms.config_enc`: this column is encrypted directly with the master key (AES-256-GCM, additional data `kms:<org id>`), so the whole blob is decrypted and encrypted again.
Procedure once the tool exists: stop `api`; hand-copy `pgdata`; run the tool with the old and the new key (all rows in one transaction per table, verify by decrypting a sample with the new key); change `FILE_MASTER_KEY`; start `api`; download a file, a recording and verify a webhook endpoint and the calendar status. Keep the old key offline until the copy is deleted.
If the key leaks and the tool does not exist yet: the exposure is real only for someone who also has the stored ciphertext (the `minio-data` and `pgdata` volumes). Treat it as a data breach (section 4) if both could have been taken; otherwise tighten access to the host and plan the tool.

### 2.8 Calendar OAuth client secrets
- Google: Cloud console > Credentials > the OAuth client > add a new secret, put it in `.env`, `up -d api`, then disable the old one.
- Microsoft: App registrations > Certificates & secrets > New client secret (they expire; diary the expiry date), update `.env`, `up -d api`, delete the old one.
Existing refresh tokens belong to the client id, not to the secret: connected users stay connected. If the secret leaked and you also want to cut off all grants, remove the connections: `DELETE FROM calendar_connections` as `davra_admin` (users reconnect), and revoke the app's grants in the provider console.

### 2.9 TLS
Caddy obtains and renews certificates itself (`caddy-data`). To force a new key pair after a suspected private-key leak: `docker compose stop caddy`, remove the certificate directory of the host under the `caddy-data` volume (named volume `davrabox_caddy-data`, path `caddy/certificates/...`), `docker compose --env-file .env up -d caddy`. Let's Encrypt rate limits apply (5 duplicate certificates per week).

## 3. Rotation schedule (suggested)
| Secret | When |
|---|---|
| Database passwords, `ADMIN_API_CLIENT_SECRET`, LiveKit pair, S3 pair | every 12 months, and when an operator who knew them leaves |
| `KEYCLOAK_ADMIN_PASSWORD` | on operator change |
| Calendar secrets | before the provider's expiry date (Microsoft: at most 24 months) |
| `FILE_MASTER_KEY` | only on compromise, after the re-wrap tool exists |
| Keycloak realm keys | yearly, or per Keycloak's guidance |
Record every rotation (date, secret name, who) in the operations log. Never record values.

## 4. Incident checklist

### 4.1 Suspected key or secret leak (committed to git, pasted in chat, seen in a log, laptop lost)
1. **Contain first, investigate second.** Assume the value is known to an attacker from the moment it was exposed. Do not wait for proof.
2. Identify which secret and where it was exposed (section 1 table gives the blast radius). For a value that reached a public repository: removing the commit does not help (forks, caches, CI logs); rotate.
3. Rotate it with the section 2 step for that secret. Order for several: `FILE_MASTER_KEY` last (it needs the tool), the rest in this order: `ADMIN_API_CLIENT_SECRET`, database passwords, LiveKit pair, S3 pair, calendar secrets.
4. Revoke what the secret protected beyond itself: customer API keys and webhook endpoints created by a compromised admin account; Keycloak sessions (Sessions > Sign out all); calendar grants.
5. Look for use: `docker compose logs api caddy` around the exposure window (unknown `Authorization` attempts: 401/403 bursts, 429 from the limiter), `SELECT * FROM audit_log ORDER BY ts DESC` for the affected org (`/v1/admin/audit/verify` confirms the hash chain was not edited), Keycloak events, MinIO access logs, `signup_events` for bursts.
6. Remove the exposure: delete the pasted message where possible, scrub logs that contain the value, add the pattern to the secret scanner if it was not caught (CI runs gitleaks).
7. Write down what happened, what was rotated, and what was not (and why).

### 4.2 Suspected data breach (someone read or copied customer data)
1. Declare it, name an incident lead, start a timeline (UTC) in a private document. Keep evidence: do not rebuild or wipe the host before copying logs and the database state you need.
2. Stop the bleeding: isolate the access path (firewall the host except from the operator address, disable the compromised account, rotate every secret in section 1 that the attacker could have reached; assume the host's environment is readable if the host itself was accessed).
3. Scope: which organisations (`org_id`), which data classes (accounts and emails, meeting titles and times, chat/files and recordings (encrypted but the master key sits in the same environment), audit rows), which time window. The audit log records admin actions; ordinary reads of meetings are not audited, so absence of evidence is not evidence of absence. State that limit when you report.
4. Per-tenant isolation (row-level security) means a bug normally exposes one organisation; check whether the access came through the application (then reproduce and fix with a failing test first) or through the host or database (then it is not limited by RLS).
5. Notify: customers' organisation admins first, with facts and the actions they should take. Regulators and data subjects: check the obligations that apply to you and to each affected customer (Uzbek personal-data law; GDPR's 72-hour rule if any EU data subject is involved) with a lawyer; this runbook does not replace that advice. Outward messages need the owner's approval before they are sent.
6. Recover: fix, rotate, redeploy from clean images (`DAVRA_TAG` of a verified release), re-check with `scripts/check-graceful-shutdown.sh` and the attack suite (`pnpm --filter @davrabox/api test security-attacks`).
7. After: blameless write-up, new tests for the hole, and update this runbook.

### 4.3 Contacts and tools to have ready
Owner of the deployment, hosting provider support, DNS control (to point traffic away), a clean workstation with the repository and an SSH key, this runbook printed or offline (it is useless if it only exists on the host that is down).
