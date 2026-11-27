-- "Get started" checklist on the home screen (owner decision 5, 2026-11-27). Most steps are derived from real data
-- (another person in the organization, a meeting the person hosted, a saved organization policy, a verified email);
-- this table keeps only what the server cannot see by itself, plus the person's "hide this card" choice.
--  * devices_tested_at: the person finished the camera/microphone check;
--  * meeting_joined_at: the person was in a meeting (joining someone else's counts as "first meeting");
--  * dismissed_at: the card was closed; it never comes back for this person.

CREATE TABLE user_onboarding (
  user_id           uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  org_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  devices_tested_at timestamptz,
  meeting_joined_at timestamptz,
  dismissed_at      timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE user_onboarding ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_onboarding FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_user_onboarding ON user_onboarding
  USING      (org_id = nullif(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.current_org', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON user_onboarding TO davra_app;
