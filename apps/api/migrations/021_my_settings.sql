-- "My settings" and organization defaults with locks (owner decisions 1-3 of 2026-11-27).
--
-- * org_setting_defaults: what an organization admin chose for a setting of src/settings/catalog.ts, and whether it is
--   locked (a locked value applies to everybody and people cannot change it). Organization-only rules (join disclaimer,
--   country allow/block list) live here too.
-- * user_settings: a person's own values for settings that are not locked. Unknown keys and bad values are refused by the
--   API; the value is JSON so booleans, choices and lists share one column.
-- * meetings.cancelled_at: a scheduled meeting the host cancelled (it can no longer be joined; people are told by email
--   when they asked for that).

CREATE TABLE org_setting_defaults (
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key        text NOT NULL CHECK (key ~ '^[a-zA-Z][a-zA-Z0-9]{1,39}$'),
  value      jsonb NOT NULL,
  locked     boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (org_id, key)
);

CREATE TABLE user_settings (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key        text NOT NULL CHECK (key ~ '^[a-zA-Z][a-zA-Z0-9]{1,39}$'),
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

ALTER TABLE meetings ADD COLUMN cancelled_at timestamptz;

ALTER TABLE org_setting_defaults ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_settings        ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_setting_defaults FORCE ROW LEVEL SECURITY;
ALTER TABLE user_settings        FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_org_setting_defaults ON org_setting_defaults
  USING      (org_id = nullif(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.current_org', true), '')::uuid);
CREATE POLICY tenant_user_settings ON user_settings
  USING      (org_id = nullif(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.current_org', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON org_setting_defaults TO davra_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON user_settings TO davra_app;
