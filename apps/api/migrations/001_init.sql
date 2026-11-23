-- Core multi-tenant schema. Every tenant table is protected by row-level security keyed on
-- the transaction-local setting app.current_org. The application connects as davra_app,
-- which is NOT a superuser and does NOT bypass RLS; FORCE keeps the owner subject to it as well.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE organizations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  external_sub text NOT NULL,
  email        text NOT NULL,
  display_name text NOT NULL DEFAULT '',
  role         text NOT NULL CHECK (role IN ('org_admin', 'member')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, external_sub)
);

CREATE TABLE meetings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code          text NOT NULL UNIQUE CHECK (code ~ '^[0-9]{11,12}$'),
  title         text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  host_user_id  uuid NOT NULL REFERENCES users(id),
  passcode_hash text,
  waiting_room  boolean NOT NULL DEFAULT true,
  locked        boolean NOT NULL DEFAULT false,
  scheduled_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX meetings_org_idx ON meetings (org_id, created_at DESC);

CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_id   uuid,
  action     text NOT NULL,
  target     text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE users         ENABLE ROW LEVEL SECURITY;
ALTER TABLE meetings      ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log     ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
ALTER TABLE users         FORCE ROW LEVEL SECURITY;
ALTER TABLE meetings      FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_log     FORCE ROW LEVEL SECURITY;

-- current_setting(..., true) returns NULL when unset, so an unset tenant sees nothing.
CREATE POLICY tenant_org   ON organizations USING (id = nullif(current_setting('app.current_org', true), '')::uuid);
CREATE POLICY tenant_users ON users
  USING      (org_id = nullif(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.current_org', true), '')::uuid);
CREATE POLICY tenant_meetings ON meetings
  USING      (org_id = nullif(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.current_org', true), '')::uuid);
CREATE POLICY tenant_audit_select ON audit_log FOR SELECT
  USING (org_id = nullif(current_setting('app.current_org', true), '')::uuid);
CREATE POLICY tenant_audit_insert ON audit_log FOR INSERT
  WITH CHECK (org_id = nullif(current_setting('app.current_org', true), '')::uuid);

GRANT SELECT ON organizations TO davra_app;
GRANT SELECT, INSERT, UPDATE ON users TO davra_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON meetings TO davra_app;
GRANT SELECT, INSERT ON audit_log TO davra_app;       -- append-only for the app
GRANT USAGE ON SEQUENCE audit_log_id_seq TO davra_app;

-- Provisioning runs before a tenant context exists, so it is a narrow SECURITY DEFINER function.
-- It creates the org and user on first login from verified identity claims and returns both ids.
CREATE FUNCTION provision_user(p_org_slug text, p_org_name text, p_sub text, p_email text, p_name text, p_role text)
RETURNS TABLE (org_id uuid, user_id uuid, role text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_org uuid; v_user uuid; v_role text;
BEGIN
  IF p_role NOT IN ('org_admin', 'member') THEN RAISE EXCEPTION 'invalid role'; END IF;
  INSERT INTO organizations (slug, name) VALUES (p_org_slug, p_org_name)
    ON CONFLICT (slug) DO NOTHING;
  SELECT o.id INTO v_org FROM organizations o WHERE o.slug = p_org_slug;
  INSERT INTO users (org_id, external_sub, email, display_name, role)
    VALUES (v_org, p_sub, p_email, p_name, p_role)
    ON CONFLICT (org_id, external_sub)
    DO UPDATE SET email = EXCLUDED.email, display_name = EXCLUDED.display_name, role = EXCLUDED.role;
  SELECT u.id, u.role INTO v_user, v_role FROM users u WHERE u.org_id = v_org AND u.external_sub = p_sub;
  RETURN QUERY SELECT v_org, v_user, v_role;
END $$;
REVOKE ALL ON FUNCTION provision_user(text, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION provision_user(text, text, text, text, text, text) TO davra_app;
