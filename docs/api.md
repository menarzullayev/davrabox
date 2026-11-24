# DavraBox external API and webhooks

This document describes the integration surface of DavraBox for organization administrators and developers: the REST API under `/v1/ext`, API keys, and signed webhooks. The machine-readable description of the REST API is served at `GET /v1/ext/openapi.json` (OpenAPI 3.1, public, generated from the same schemas the server validates with).

Behind the standard deployment the API is reachable under the `/api` prefix of the public host (for example `https://<host>/api/v1/ext/meetings`).

## 1. API keys

An organization admin creates keys in the admin console (Integrations) or with the admin API.

```
POST   /v1/admin/api-keys          { "name": "ci", "scopes": ["meetings:read", "users:read"] }   -> 201
GET    /v1/admin/api-keys                                                                       -> 200 (list, never contains secrets)
DELETE /v1/admin/api-keys/:id                                                                   -> 204 (revoke)
```

- The key looks like `dbx_<8 hex>_<43 base64url>` and is returned **once**, in the creation response. The server stores only the SHA-256 of the secret part and the 8-character prefix; it cannot show the key again. Lost key: revoke it and create a new one.
- Scopes: `meetings:read`, `meetings:write`, `users:read`. A request to a route whose scope the key lacks gets `403`.
- At most 20 active keys per organization.
- A key acts for the organization it was created in. Meetings created through a key are hosted by the user who created the key. A key stops working when it is revoked or when its owner is disabled.
- Send the key as `Authorization: Bearer dbx_...` (a header only; keys in URLs are never accepted). Wrong, unknown and revoked keys all answer the same `401`.
- Never log keys or put them in source control. Keys are compared in constant time and never written to server logs.
- Besides the per-key limit, every request counts against a global per-IP ceiling (default 1200 per minute, `RATE_LIMIT_IP_PER_MINUTE`) and, once authenticated, a per-user ceiling (300 per minute); crossing either answers `429` with `Retry-After`. Request bodies must not use `Content-Encoding` (`415`).
- Rate limit: 120 requests per minute per key by default (`EXT_API_RATE_PER_MINUTE`), counted in the database. Over the limit the answer is `429` with a `Retry-After` header (seconds).

## 2. REST API

| Method and path | Scope | Purpose |
|---|---|---|
| `GET /v1/ext/meetings?limit=&cursor=` | `meetings:read` | List meetings, newest first |
| `POST /v1/ext/meetings` | `meetings:write` | Create a meeting |
| `GET /v1/ext/meetings/{id}` | `meetings:read` | Get a meeting (`id` is the uuid or the 11-digit join code) |
| `DELETE /v1/ext/meetings/{id}` | `meetings:write` | Delete a meeting and close its room |
| `GET /v1/ext/users?limit=&cursor=` | `users:read` | List the organization's users |
| `GET /v1/ext/openapi.json` | none | The OpenAPI document |

Create a meeting:

```sh
curl -X POST https://<host>/api/v1/ext/meetings \
  -H "Authorization: Bearer $DAVRA_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"title":"Weekly sync","waitingRoom":true}'
```

```json
{ "id": "…uuid…", "code": "12345678901", "title": "Weekly sync", "hostUserId": "…uuid…",
  "waitingRoom": true, "locked": false, "hasPasscode": false, "scheduledAt": null, "createdAt": "2026-11-24T10:00:00.000Z" }
```

Request bodies are strict: unknown fields are rejected with `400`. The meeting passcode (optional, 6-64 characters) is accepted on creation and never returned.

**Idempotency.** Send an `Idempotency-Key` header (1-200 printable ASCII characters) on `POST /v1/ext/meetings` to make retries safe. The same key with the same body returns the first response (status `201`, header `Idempotent-Replay: true`) and creates nothing. The same key with a different body is `422`. A duplicate that arrives while the first request is still running is `409`: retry shortly. A request that failed is not remembered, so you can correct the body and reuse the key. Keys are scoped per API key and remembered for 24 hours.

**Pagination.** List endpoints return `{ "items": [...], "next": "<cursor>" | null }`. Pass `next` as `cursor` to read the following page. The cursor is stable: meetings created while you are paging do not shift or duplicate pages. `limit` is 1-100 (default 25).

**Deleting meetings.** A meeting that has shared files cannot be deleted through the API (`409`), because the stored encrypted files would be orphaned; remove it in the app.

**Errors.** `{ "statusCode": 400, "message": "..." }`. Codes used: `400` invalid input, `401` bad key, `403` missing scope, `404` not found (including other organizations' objects), `409` conflict, `422` idempotency mismatch, `429` rate limit.

## 3. Webhooks

An organization admin registers endpoints in the admin console or with the admin API.

```
POST   /v1/admin/webhooks     { "url": "https://hooks.example.com/davra", "events": ["meeting.created"] }   -> 201 (secret returned once)
GET    /v1/admin/webhooks                                                                                   -> 200
DELETE /v1/admin/webhooks/:id                                                                               -> 204
GET    /v1/admin/webhooks/:id/deliveries?status=dead&limit=&cursor=                                         -> 200 (delivery log, dead letters)
```

Events: `meeting.created`, `meeting.ended`, `participant.joined`, `participant.left`. At most 10 endpoints per organization.

**URL rules (security).** The URL must be `https`, must not contain credentials, and its host must resolve only to public internet addresses. Private, loopback, link-local, carrier-grade NAT, multicast, documentation and cloud metadata ranges are refused in IPv4 and IPv6, including IPv4-mapped IPv6 addresses and alternative spellings such as `https://2130706433/`. Names like `localhost`, `*.local`, `*.internal` are refused. The check runs when you register the endpoint **and again before every delivery**, and the delivery connects to the vetted address, so changing DNS afterwards (rebinding) cannot reach an internal host. Redirects are never followed: a `3xx` answer counts as a failed attempt.

**Payload.**

```json
{ "id": "7a3d…uuid", "type": "meeting.created", "createdAt": "2026-11-24T10:00:00.123Z",
  "data": { "meetingId": "…", "code": "12345678901", "title": "Weekly sync", "hostUserId": "…", "scheduledAt": null, "waitingRoom": true } }
```

`participant.joined` / `participant.left` carry `data.meetingId`, `data.meetingCode`, `data.occurredAt` and `data.participant` (`identity` = the user id, `name`). `meeting.ended` carries `meetingId`, `meetingCode`, `occurredAt`. The meeting passcode is never sent. The `id` is the same on every retry of an event: use it to deduplicate.

**Headers.** `Content-Type: application/json`, `User-Agent: DavraBox-Webhooks/1`, `X-Davra-Event`, `X-Davra-Event-Id`, `X-Davra-Delivery`, `X-Davra-Signature`.

**Signature.** `X-Davra-Signature: t=<unix seconds>,v1=<hex>` where `v1 = HMAC-SHA256(secret, t + "." + body)` over the exact raw request body, with the endpoint secret (`whsec_...`, shown once at creation). Verify the HMAC with a constant-time comparison **and reject a timestamp more than 5 minutes (300 s) away from your clock** to prevent replays. Several `v1` values may appear in one header (secret rotation): accept the request if any matches.

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verify(secret, header, rawBody, toleranceSeconds = 300) {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=', 2)));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  const given = Buffer.from(parts.v1 ?? '', 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
```

```python
import hmac, hashlib, time

def verify(secret: str, header: str, raw_body: bytes, tolerance: int = 300) -> bool:
    parts = dict(p.split("=", 1) for p in header.split(","))
    t = int(parts["t"])
    if abs(time.time() - t) > tolerance:
        return False
    expected = hmac.new(secret.encode(), f"{t}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, parts.get("v1", ""))
```

**Delivery and retries.** Answer with any `2xx` within 10 seconds to acknowledge. Otherwise the delivery is retried with exponential backoff and jitter: 30 s, 1 min, 2 min, 4 min, 8 min, 16 min, 32 min (each +-25 %, capped at 6 h) for up to 8 attempts in total, then it is marked `dead`. Dead letters stay visible in the admin console and in `GET /v1/admin/webhooks/:id/deliveries?status=dead` (finished deliveries are kept 30 days). Deliveries are stored in the database before they are sent, so they survive an API restart, and several API instances can run the worker without sending an event twice. Delivery is at least once: design the receiver to be idempotent.

**Signing secret storage.** The endpoint secret is encrypted at rest with the envelope helpers also used for shared files (`FILE_MASTER_KEY`). Without that key the webhook endpoints answer `503` and no delivery is attempted.

## 4. Media-server events (operator setup)

`participant.*` and `meeting.ended` come from the media server. Point LiveKit at the receiver endpoint, with the same API key and secret DavraBox uses:

```yaml
# livekit.yaml
webhook:
  api_key: <LIVEKIT_API_KEY>
  urls:
    - http://<api-host>:3000/v1/livekit/webhook   # internal address of the API; LiveKit Cloud: set the URL in its project settings
```

The receiver accepts only `Content-Type: application/webhook+json` requests whose `Authorization` token is signed with the LiveKit API secret and carries the SHA-256 of the exact body; anything else is `401` (or `415` / `413`). Rooms that are not DavraBox meetings, participants that are not DavraBox users (for example a recording bot) and events we do not forward are acknowledged and ignored. A retried event produces one delivery.

## 5. Configuration

| Variable | Default | Meaning |
|---|---|---|
| `EXT_API_RATE_PER_MINUTE` | `120` | Requests per minute per API key |
| `WEBHOOK_DELIVERY_INTERVAL_MS` | `5000` | Poll interval of the delivery worker; `0` turns it off on this instance |
| `WEBHOOK_REQUEST_TIMEOUT_MS` | `10000` | Timeout of one delivery request |
| `FILE_MASTER_KEY` | none | Required for webhooks (encrypts signing secrets) |


## 6. Guests (people without an account)

A meeting can let people in with only its code and a display name. Three levels decide:
- **Organisation policy** (admin console, Policies, or `PUT /v1/admin/policies` with `guestPolicy`): the most an organisation allows: `off` (default), `waiting_room` or `open`.
- **Meeting setting**: `POST /v1/meetings` accepts `guests` (`off` | `waiting_room` | `open`); a value above the policy is `400`. `GET /v1/meetings/settings` tells a member the policy. The meeting list reports `guest_mode`.
- **Effective mode** = the stricter of the two, checked on every join and every poll: lowering the policy ends guest access at once. `off`: refused. `waiting_room`: the host or a co-host admits each guest. `open`: a token directly (after the passcode, if any). A locked meeting refuses guests.

```
POST /v1/guest/meetings/:code/join   { "name": "Ali Valiyev", "passcode": "…" }   -> 200 joined | waiting
GET  /v1/guest/requests/:id          Authorization: Bearer <guestToken>            -> 200 waiting | joined, 403 denied
```

- No sign-in. `name` is 1-60 characters, no control characters. Unknown fields are `400`.
- An unknown code and a meeting that takes no guests give the same `404`.
- Limits per client address (counted before the work): 60 attempts and 10 unknown-code misses per 15 minutes, 5 wrong passcodes per address and code, 50 waiting guests per meeting (`429`).
- The result carries a LiveKit token with identity `guest:<id>` and metadata `{"guest":true}`, **without** room admin rights, and a `guestToken` (HMAC-signed, 2 hours) that only the polling endpoint accepts; every member endpoint refuses it (`401`).
- Guests can use video, audio, chat, raised hand and reactions. They cannot share files, control recording or manage participants. Participant webhooks ignore guests (they are not users of the organisation).
- The host side lists waiting guests in `GET /v1/meetings/:code/requests` (`guest: true`, `user_id: null`) and admits or denies them with the same endpoints. Muting or removing a guest uses the identity `guest:<id>`; removal ends the session and bans a keyed hash of the guest's address for that meeting only. Honest limit: a guest who changes address gets in again if the policy allows, so lock the meeting when that matters.
- Audit: `guest.join`, `guest.admit`, `guest.deny`, `guest.remove` (no actor id for the join).
