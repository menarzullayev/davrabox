-- meeting_access: who actually passed passcode, lock and waiting room (a join token was issued). File access depends on it.
-- meeting_files: metadata of files shared in a meeting; the bytes live encrypted in object storage.
CREATE TABLE meeting_access (
  meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  first_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (meeting_id, user_id)
);

CREATE TABLE meeting_files (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  meeting_id  uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  uploader_id uuid NOT NULL REFERENCES users(id),
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  size_bytes  bigint NOT NULL CHECK (size_bytes > 0),
  mime        text NOT NULL,
  sha256      text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  object_key  text NOT NULL,
  wrapped_key text NOT NULL, -- per-file data key wrapped by the master key (envelope encryption)
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX meeting_files_meeting_idx ON meeting_files (meeting_id, created_at);

ALTER TABLE meeting_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_files  ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_access FORCE ROW LEVEL SECURITY;
ALTER TABLE meeting_files  FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_meeting_access ON meeting_access
  USING      (org_id = nullif(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.current_org', true), '')::uuid);
CREATE POLICY tenant_meeting_files ON meeting_files
  USING      (org_id = nullif(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.current_org', true), '')::uuid);
GRANT SELECT, INSERT ON meeting_access TO davra_app;
GRANT SELECT, INSERT ON meeting_files TO davra_app;
