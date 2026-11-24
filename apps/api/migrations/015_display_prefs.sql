-- Display preferences kept on the server so they follow the person to every device, and the organization's guard rails:
--  * user_prefs: language, mode, style and density the person chose (NULL = never chose; the client then uses the organization default);
--  * org_policies.default_style / default_density: what a person who never chose gets;
--  * org_policies.allowed_styles: NULL = every style, otherwise the only styles people may pick (a corporate look).
-- Style ids are checked by shape here and against the real list in the API (the list lives in the design tokens).

CREATE TABLE user_prefs (
  user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lang       text CHECK (lang IN ('uz', 'ru', 'en')),
  theme      text CHECK (theme IN ('dark', 'light')),
  style      text CHECK (style ~ '^[a-z]{3,24}$'),
  density    text CHECK (density IN ('compact', 'comfortable', 'spacious')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE user_prefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_prefs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_user_prefs ON user_prefs
  USING      (org_id = nullif(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.current_org', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON user_prefs TO davra_app;

ALTER TABLE org_policies
  ADD COLUMN default_style   text NOT NULL DEFAULT 'dashboard' CHECK (default_style ~ '^[a-z]{3,24}$'),
  ADD COLUMN default_density text NOT NULL DEFAULT 'comfortable' CHECK (default_density IN ('compact', 'comfortable', 'spacious')),
  ADD COLUMN allowed_styles  text[] CHECK (allowed_styles IS NULL OR cardinality(allowed_styles) BETWEEN 1 AND 20);
