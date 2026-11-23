-- Meeting recording (LiveKit Egress). Also adds the per-meeting E2EE mode flag: recording is refused when it is set.
ALTER TABLE meetings ADD COLUMN e2ee boolean NOT NULL DEFAULT false;

CREATE TABLE recordings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  meeting_id  uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  egress_id   text,
  -- starting: row reserved, Egress not yet confirmed; active: Egress is recording; stopping: stop requested, waiting for
  -- the file; processing: encrypting the finished file; ready: encrypted object stored; failed: nothing usable.
  status      text NOT NULL CHECK (status IN ('starting', 'active', 'stopping', 'processing', 'ready', 'failed')),
  staging_key text NOT NULL,           -- plaintext object written by Egress; deleted once the encrypted copy exists
  object_key  text NOT NULL,           -- envelope-encrypted object, the only copy that may be downloaded
  wrapped_key text,                    -- per-recording data key wrapped by the master key (set when ready)
  started_by  uuid NOT NULL REFERENCES users(id),
  started_at  timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz,
  size_bytes  bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recordings_meeting_idx ON recordings (meeting_id, started_at DESC);
-- At most one recording in flight per meeting: a concurrent second start fails on this index, not on a race.
CREATE UNIQUE INDEX recordings_one_inflight_idx ON recordings (meeting_id) WHERE status IN ('starting', 'active', 'stopping');

ALTER TABLE recordings ENABLE ROW LEVEL SECURITY;
ALTER TABLE recordings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_recordings ON recordings
  USING      (org_id = nullif(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.current_org', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON recordings TO davra_app;
