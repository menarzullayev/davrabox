-- Co-hosts: participants the host (or an org admin) trusts with the host controls of one meeting.
CREATE TABLE meeting_cohosts (
  meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  granted_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (meeting_id, user_id)
);
ALTER TABLE meeting_cohosts ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_cohosts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_meeting_cohosts ON meeting_cohosts
  USING      (org_id = nullif(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.current_org', true), '')::uuid);
GRANT SELECT, INSERT, DELETE ON meeting_cohosts TO davra_app;
