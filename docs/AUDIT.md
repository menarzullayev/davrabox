# Audit log: API, export, integrity and SIEM forwarding

All routes need an authenticated organization administrator (`org_admin`); members get 403, anonymous callers 401.
Every query runs inside `withTenant`, so row-level security confines it to the caller's organization.

## API

| Route | Purpose |
|---|---|
| `GET /v1/admin/audit?from&to&action&actor&target&limit&cursor` | `{items:[{id,at,actorId,actorEmail,action,target}], next}`, newest first, keyset pagination on `(created_at, id)`. `limit` 1..200 (default 50). `action` is exact or a prefix with a trailing `*` (`meeting.*`). `actor` is a uuid or an email substring. `target` is a substring. LIKE wildcards in filters are matched literally. `from`/`to` are inclusive ISO 8601 instants with a zone (or a plain date, taken as UTC midnight). The cursor is opaque and HMAC-protected (key derived from `LIVEKIT_API_SECRET`, bound to the organization); any change returns 400. |
| `GET /v1/admin/audit/export?format=csv\|json\|cef&from&to&action` | Streamed download (`attachment`, `nosniff`, `no-store`). Read in keyset chunks of 1000 rows, one short transaction each. More than 1,000,000 matching rows: 413 before anything is sent. 5 exports per user per minute (in memory, per API process): 429 with `Retry-After`. The export writes an `audit.export` row whose target holds the format and filters, never data. |
| `GET /v1/admin/audit/verify` | `{ok, checked, firstBrokenId}` for the caller's organization chain. |

Formats: `csv` is RFC 4180 with a header row and CRLF; a cell starting with `=`, `+`, `-`, `@`, tab or CR gets a leading apostrophe (formula injection). `json` is JSON Lines. `cef` is `CEF:0|DavraBox|Platform|1.0|<action>|<action>|3|rt=<ms> externalId=<id> suser=<email> msg=<target>` with CEF escaping (`\\`, `\|` in the header; `\\`, `\=`, `\n`, `\r` in the extension).

## Integrity (hash chain)

Migration `007` adds `chain_seq`, `prev_hash`, `row_hash` to `audit_log`. A `BEFORE INSERT` trigger serialises inserts per organization with `pg_advisory_xact_lock` and sets `row_hash = sha256(prev_hash || canonical(seq, id, org, actor, action, target, created_at))`. `audit_chain_head` stores the newest `(seq, hash)` per organization. Existing rows were chained in id order by the migration. Other services keep inserting `(org_id, actor_id, action, target)` only.

`verify` detects: a changed row, a changed row with a recomputed own hash (the next link breaks), a deleted row in the middle, and deletion of the newest rows (head mismatch; then `firstBrokenId` is `null`). It does NOT detect someone with full database rights who rewrites a complete consistent chain together with `audit_chain_head`. The independent anchor against that is the SIEM stream: every forwarded event carries `hash` (the row hash), kept outside the database.

## SIEM forwarding (deployment level, off by default)

| Env | Meaning |
|---|---|
| `AUDIT_WEBHOOK_URL` | Receiver URL. `https` only; `http` is accepted for `localhost`, `127.0.0.1`, `[::1]` (tests). Unset = forwarding off. |
| `AUDIT_WEBHOOK_SECRET` | HMAC secret, at least 16 characters, required with the URL. |
| `AUDIT_FORWARD_INTERVAL_MS` | Poll interval, default 5000. |

The forwarder starts after the API is listening and never blocks startup. It sends batches of at most 500 events of all organizations:

```json
{"events":[{"id":"123","orgSlug":"acme","at":"2026-11-23T10:00:00.123Z","actorEmail":"a@acme.test","action":"meeting.create","target":"12345678901","hash":"<hex>"}]}
```

Headers: `X-DavraBox-Signature: sha256=<hex hmac-sha256 of the raw body>` and `X-DavraBox-Delivery: <uuid>` (the same uuid when the same batch is retried). Delivery is at least once: the position is stored in `audit_forward_state` only after a 2xx answer, so receivers must de-duplicate on `id`. Failures back off exponentially (interval x 2^n, cap 5 minutes), the same batch is re-sent, order is kept. Multiple API replicas coordinate with a session advisory lock; only one forwards at a time.

Ordering and loss safety: the cursor is `(txid, id)` and only transactions older than the oldest running one are handed out, so a slow transaction that commits late cannot appear behind the cursor. A long-running open transaction anywhere in the database delays forwarding until it ends.

Cross-tenant read without BYPASSRLS: `davra_app` stays a plain role. It can only call the `SECURITY DEFINER` functions `audit_forward_batch`, `audit_forward_state_get`, `audit_forward_state_advance` (owned by the migration role, which bypasses RLS); it has no grant on `audit_forward_state` and no direct cross-tenant table access. Note that a compromised API process can call these functions and so read audit rows of all organizations; that is inherent to a forwarder living in the API process (a separate forwarder process with its own role would remove it).

### Verifying a delivery (Node)

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

// rawBody: the request body bytes exactly as received (do not re-serialise parsed JSON)
export function verify(rawBody: Buffer | string, header: string | undefined, secret: string): boolean {
  if (!header || !/^sha256=[0-9a-f]{64}$/.test(header)) return false;
  const expected = Buffer.from('sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex'));
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
```

The same helper ships as `verifySignature` in `apps/api/src/audit/signature.ts`. Python equivalent: `hmac.compare_digest("sha256=" + hmac.new(secret, raw, hashlib.sha256).hexdigest(), header)`.
