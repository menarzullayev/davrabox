-- Waiting room admissions and per-meeting bans (removed participants cannot rejoin).
-- Same tenant isolation pattern as the other tables: FORCE row-level security keyed on app.current_org.

CREATE TABLE join_requests (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status     text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'admitted', 'denied')),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by uuid REFERENCES users(id),
  UNIQUE (meeting_id, user_id)
);
CREATE INDEX join_requests_meeting_idx ON join_requests (meeting_id, status);

CREATE TABLE meeting_bans (
  meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  banned_by  uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (meeting_id, user_id)
);

ALTER TABLE join_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_bans  ENABLE ROW LEVEL SECURITY;
ALTER TABLE join_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE meeting_bans  FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_join_requests ON join_requests
  USING      (org_id = nullif(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.current_org', true), '')::uuid);
CREATE POLICY tenant_meeting_bans ON meeting_bans
  USING      (org_id = nullif(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.current_org', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON join_requests TO davra_app;
GRANT SELECT, INSERT ON meeting_bans TO davra_app;
