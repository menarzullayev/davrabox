-- Profile package (owner decisions 2, 3 and 5 of 2026-11-27, docs/privacy-data-inventory.md).
--
-- * user_profiles: what a person adds about themselves in /app/profile. Name and email stay in the identity provider.
--   The avatar bytes live envelope-encrypted in object storage; `avatar_id` is a random 128-bit id that is the only way to
--   fetch them (it is handed to the people in a meeting with the person through the join token), and it changes on every
--   upload, so an old link stops working.
-- * user_session_devices: what the API saw of each sign-in session (keyed by the identity provider's session id): the
--   browser's user agent, a shortened address (/24 or /48) and the city/country Cloudflare reported. "Where you're signed in"
--   joins it with the provider's live session list. Rows go with the person and age out after 90 days.
-- * avatar_lookup: the only cross-tenant read the public avatar endpoint needs (random id -> where the bytes are).

CREATE TABLE user_profiles (
  user_id            uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  org_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  job_title          text CHECK (job_title IS NULL OR char_length(job_title) BETWEEN 1 AND 100),
  phone              text CHECK (phone IS NULL OR phone ~ '^\+?[0-9 ()-]{5,24}$'),
  time_zone          text CHECK (time_zone IS NULL OR time_zone ~ '^[A-Za-z_+-]+(/[A-Za-z0-9_+-]+){0,2}$'),
  date_format        text CHECK (date_format IS NULL OR date_format IN ('dmy', 'mdy', 'ymd')),
  time_format        text CHECK (time_format IS NULL OR time_format IN ('24h', '12h')),
  avatar_id          text UNIQUE CHECK (avatar_id IS NULL OR avatar_id ~ '^[0-9a-f]{32}$'),
  avatar_object      text,
  avatar_wrapped_key text,
  avatar_mime        text CHECK (avatar_mime IS NULL OR avatar_mime IN ('image/jpeg', 'image/png', 'image/webp')),
  avatar_updated_at  timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK ((avatar_id IS NULL) = (avatar_object IS NULL))
);

CREATE TABLE user_session_devices (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  sid        text NOT NULL CHECK (char_length(sid) BETWEEN 1 AND 100),
  user_agent text CHECK (user_agent IS NULL OR char_length(user_agent) <= 300),
  ip_prefix  text CHECK (ip_prefix IS NULL OR char_length(ip_prefix) <= 50),
  country    text CHECK (country IS NULL OR country ~ '^[A-Z]{2}$'),
  city       text CHECK (city IS NULL OR char_length(city) <= 80),
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, sid)
);
CREATE INDEX user_session_devices_seen_idx ON user_session_devices (last_seen);

ALTER TABLE user_profiles        ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_session_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_profiles        FORCE ROW LEVEL SECURITY;
ALTER TABLE user_session_devices FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_user_profiles ON user_profiles
  USING      (org_id = nullif(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.current_org', true), '')::uuid);
CREATE POLICY tenant_user_session_devices ON user_session_devices
  USING      (org_id = nullif(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.current_org', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON user_profiles TO davra_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON user_session_devices TO davra_app;

CREATE FUNCTION avatar_lookup(p_id text) RETURNS TABLE (org_id uuid, user_id uuid, avatar_object text, avatar_wrapped_key text, avatar_mime text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p.org_id, p.user_id, p.avatar_object, p.avatar_wrapped_key, p.avatar_mime
    FROM user_profiles p JOIN users u ON u.id = p.user_id
   WHERE p.avatar_id = p_id AND p_id ~ '^[0-9a-f]{32}$' AND NOT u.disabled AND u.erased_at IS NULL
$$;
REVOKE ALL ON FUNCTION avatar_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION avatar_lookup(text) TO davra_app;
