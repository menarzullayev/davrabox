-- BYOK: customer-held key-encryption keys (HashiCorp Vault Transit first; the provider column leaves room for other KMS).
--
-- org_kms: one row per organization. config_enc holds the provider address, token and mount as JSON, encrypted with the
-- platform master key through the envelope helpers (AES-256-GCM, additional data = "kms:<org id>"); the token is never
-- stored in clear and never returned by the API. kek_id names the customer key ("vault-transit:<mount>/<key>"); every
-- object remembers the kek_id that wrapped its data key, so a rotation or a revocation can be decided per object.
-- NULL kek_id on an object means "wrapped by the platform master key" (everything written before BYOK was switched on).
CREATE TABLE org_kms (
  org_id     uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  provider   text NOT NULL CHECK (provider IN ('vault-transit')),
  config_enc bytea NOT NULL,
  key_name   text NOT NULL CHECK (key_name ~ '^[A-Za-z0-9_-]{1,64}$'),
  kek_id     text NOT NULL CHECK (char_length(kek_id) BETWEEN 3 AND 200),
  status     text NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown', 'ok', 'denied', 'unreachable')),
  checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  rotated_at timestamptz
);

ALTER TABLE org_kms ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_kms FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_org_kms ON org_kms
  USING      (org_id = nullif(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.current_org', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON org_kms TO davra_app;

-- Which key wrapped each object's data key. NULL = platform master key.
ALTER TABLE meeting_files ADD COLUMN kek_id text;
ALTER TABLE recordings    ADD COLUMN kek_id text;
CREATE INDEX meeting_files_kek_idx ON meeting_files (org_id, id) WHERE kek_id IS NOT NULL;
CREATE INDEX recordings_kek_idx    ON recordings    (org_id, id) WHERE kek_id IS NOT NULL;

-- A re-wrap replaces only the wrapped data key and its kek_id; the object bytes stay untouched.
GRANT UPDATE (wrapped_key, kek_id) ON meeting_files TO davra_app;
