# Customer-held encryption keys (BYOK) with HashiCorp Vault Transit

Files shared in meetings and meeting recordings are encrypted with a random data key per object. By default that data
key is wrapped with the platform master key (`FILE_MASTER_KEY`). With BYOK an organization can have its data keys wrapped
by a key that lives in its own HashiCorp Vault (Transit secrets engine). The platform never sees that key: it sends a
32-byte data key to Vault to be encrypted and sends the result back to decrypt it.

The object bytes are still encrypted locally with the data key, so Vault only handles small requests (one per file
upload, one per file download, one per recording).

## What the customer does

1. Enable the Transit engine (once): `vault secrets enable transit`.
2. Create a key (the default `aes256-gcm96` type, not derived): `vault write -f transit/keys/davrabox`.
3. Create a policy that allows **encrypt and decrypt with this one key and nothing else**:

   ```hcl
   path "transit/encrypt/davrabox" { capabilities = ["update"] }
   path "transit/decrypt/davrabox" { capabilities = ["update"] }
   ```

   Do not grant `create`: with it, Vault would silently create a missing key on `encrypt` ("upsert"), and a deleted
   key would quietly be replaced by a new one. With `update` only, a missing key is an error and the platform fails
   closed.
4. Create a token with that policy (`vault token create -policy=davrabox -period=720h`, or an AppRole/auth method that
   produces such a token). Use a periodic token or renew it yourself: the platform stores the token it was given and
   does **not** renew it. When it expires the key counts as revoked (see below) until an admin saves a new token.
5. In the admin console open **Encryption keys**, press **Connect a Vault key**, and enter the Vault address, the
   token, the key name and (if not `transit`) the mount path. The platform runs a real round trip with the token before
   it saves anything.

## What happens afterwards

- New files and recordings of the organization get data keys wrapped by the customer key. Each object stores a
  `kek_id` (`vault-transit:<mount>/<key>`) next to its wrapped key.
- Objects written before BYOK was switched on have no `kek_id`; they keep opening with the platform key. Press
  **Move existing data to the customer key** (`POST /v1/admin/kms/rewrap`) to re-wrap them. Only the wrapped data key
  changes, never the object. The call is resumable and audited; **Move data back to the platform key** does the reverse.
- Vault's own key rotation (`vault write -f transit/keys/davrabox/rotate`) needs nothing from the platform: the Vault
  ciphertext records its key version. If you later raise `min_decryption_version`, objects wrapped by older versions
  stop opening, which is the intended way to retire them.
- Removing the configuration is refused while any object is still wrapped by the customer key (it would become
  unreadable); move the data back first. Switching to a different key name is refused for the same reason.

## Revocation and failure behaviour (fail closed)

| Situation | Reading a file or recording | Uploading or starting a recording |
|---|---|---|
| Key deleted or disabled, token revoked or expired, policy removed | 423, audit row `file.download.denied` / `recording.download.denied` | 423, audit row `file.upload.denied` / `recording.start.denied` |
| Vault unreachable, sealed or failing | 503 with the same audit rows | 503 |
| Object wrapped by a key that is not the configured one | 423 | n/a |

Nothing falls back to the platform key: not for reading, not for writing. A recording whose customer key disappears
while it is being recorded is marked `failed` and its plaintext staging file is deleted (`recording.encrypt.denied`);
a temporarily unreachable Vault only delays finishing the recording (retried until the normal give-up time).

The admin console shows the last observed key status (ok, denied, unreachable). **Test connection** re-checks it.

## Audit

Every action writes an audit row: `kms.configure`, `kms.rotate` (new credentials for an existing configuration),
`kms.test`, `kms.rewrap`, `kms.remove`, and the refusals `kms.denied` (not an admin), `kms.configure.refused` (address
guard), `kms.configure.failed`, `kms.rewrap.failed`, `kms.remove.refused`. Rows contain the key id and counts, never the token.

## Security properties

- The Vault address, token and mount are stored only encrypted (AES-256-GCM under the platform master key, bound to
  the organization id) in `org_kms.config_enc`. The token is never returned by the API, never logged and never in an
  audit row; the form field is a password field and the dialog drops it after saving.
- The Vault address is called by our servers, so it is held to the same SSRF rules as webhooks: https only, no
  credentials, every resolved address must be public, redirects are never followed, and the address is checked again
  (and the connection pinned to the vetted IP) on every use. Self-hosted installations whose Vault is on a private network
  set `BYOK_ALLOW_PRIVATE_VAULT=1` (default off); then http and private addresses are accepted, credentials, paths and
  queries still are not.
- The wrapped key is bound to its object id (`associated_data`), so a wrapped key moved to another object does not unwrap.

## Limits, stated honestly

- Only Vault Transit is implemented. `KeyProvider` (`apps/api/src/byok/key-provider.ts`) is the interface AWS KMS,
  Azure Key Vault and Google KMS adapters would implement; none exists yet.
- The platform holds a data key in memory while it encrypts or decrypts one object. BYOK protects data at rest and
  gives the customer a kill switch; it is not a guarantee against a compromised running platform.
- A recording is written by LiveKit Egress as a plaintext MP4 to a staging key and encrypted when it is finished; the
  staging file is deleted right after. During that window the file is protected by the object store, not by the customer key.
- Vault tokens are not renewed by the platform (see step 4).
- The tests were run against Vault 2.2.2 in dev mode; other versions and Vault Enterprise namespaces were not tested.

## Running the Vault tests

`apps/api/test/byok.test.ts` needs a real Vault with the transit engine and the root token of a throw-away container:

```bash
export BYOK_TEST_VAULT_TOKEN="root-$(openssl rand -hex 16)"
docker compose -f deploy/compose/docker-compose.byok.yml up -d
curl -s -H "X-Vault-Token: $BYOK_TEST_VAULT_TOKEN" -X POST -d '{"type":"transit"}' http://127.0.0.1:58200/v1/sys/mounts/transit
export BYOK_TEST_VAULT_ADDR=http://127.0.0.1:58200
pnpm --filter @davrabox/api test
docker compose -f deploy/compose/docker-compose.byok.yml down
```

CI starts the same container with a token generated for the run.
