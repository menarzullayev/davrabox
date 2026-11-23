-- Organization admin console: departments, user disable flag, org policies, seat licences.
-- Same tenant isolation pattern as every other table: FORCE row-level security keyed on app.current_org.

CREATE TABLE departments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name       text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id) -- target of the composite FK below: a user can only point at a department of its own organization
);
CREATE UNIQUE INDEX departments_org_name_uq ON departments (org_id, lower(name));

ALTER TABLE users ADD COLUMN department_id uuid;
ALTER TABLE users ADD COLUMN disabled boolean NOT NULL DEFAULT false;
-- Same-org is enforced by the database. SET NULL lists only department_id: org_id is NOT NULL and must stay.
ALTER TABLE users ADD CONSTRAINT users_department_fk
  FOREIGN KEY (department_id, org_id) REFERENCES departments (id, org_id) ON DELETE SET NULL (department_id);
CREATE INDEX users_department_idx ON users (department_id) WHERE department_id IS NOT NULL;
CREATE INDEX users_org_created_idx ON users (org_id, created_at DESC, id DESC);

CREATE TABLE org_policies (
  org_id               uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  require_passcode     boolean NOT NULL DEFAULT false,
  waiting_room_default boolean NOT NULL DEFAULT true,
  max_participants     integer NOT NULL DEFAULT 300 CHECK (max_participants BETWEEN 2 AND 300),
  require_totp         boolean NOT NULL DEFAULT false,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- The seat limit is a commercial setting: the application role may read it but never change it.
CREATE TABLE org_licenses (
  org_id      uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  seats_limit integer CHECK (seats_limit IS NULL OR seats_limit >= 1),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE departments  ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_licenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE departments  FORCE ROW LEVEL SECURITY;
ALTER TABLE org_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE org_licenses FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_departments ON departments
  USING      (org_id = nullif(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.current_org', true), '')::uuid);
CREATE POLICY tenant_org_policies ON org_policies
  USING      (org_id = nullif(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.current_org', true), '')::uuid);
CREATE POLICY tenant_org_licenses ON org_licenses FOR SELECT
  USING (org_id = nullif(current_setting('app.current_org', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON departments TO davra_app;
GRANT SELECT, INSERT, UPDATE ON org_policies TO davra_app;
GRANT SELECT ON org_licenses TO davra_app;

-- provision_user v3 (replaces 002): additionally
--  * returns `disabled`; a disabled user is returned untouched (no role/email overwrite) and the API answers 403;
--  * refuses to create a NEW user beyond org_licenses.seats_limit (SQLSTATE 53400; disabled users do not use a seat).
-- The return type changes, so the function is dropped and recreated. #variable_conflict use_column is kept (see 002).
DROP FUNCTION provision_user(text, text, text, text, text, text);
CREATE FUNCTION provision_user(p_org_slug text, p_org_name text, p_sub text, p_email text, p_name text, p_role text)
RETURNS TABLE (org_id uuid, user_id uuid, role text, disabled boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE v_org uuid; v_user uuid; v_role text; v_disabled boolean; v_limit integer; v_used integer;
BEGIN
  IF p_role NOT IN ('org_admin', 'member') THEN RAISE EXCEPTION 'invalid role'; END IF;
  INSERT INTO organizations (slug, name) VALUES (p_org_slug, p_org_name)
    ON CONFLICT (slug) DO NOTHING;
  SELECT o.id INTO v_org FROM organizations o WHERE o.slug = p_org_slug;

  SELECT u.id, u.role, u.disabled INTO v_user, v_role, v_disabled
    FROM users u WHERE u.org_id = v_org AND u.external_sub = p_sub;

  IF v_user IS NULL THEN
    -- New user: serialize concurrent first logins of one organization on its row, then enforce the seat limit.
    PERFORM 1 FROM organizations o WHERE o.id = v_org FOR UPDATE;
    SELECT l.seats_limit INTO v_limit FROM org_licenses l WHERE l.org_id = v_org;
    IF v_limit IS NOT NULL THEN
      SELECT count(*) INTO v_used FROM users u WHERE u.org_id = v_org AND NOT u.disabled;
      IF v_used >= v_limit THEN
        RAISE EXCEPTION 'seat limit reached' USING ERRCODE = '53400';
      END IF;
    END IF;
    INSERT INTO users (org_id, external_sub, email, display_name, role)
      VALUES (v_org, p_sub, p_email, p_name, p_role)
      ON CONFLICT (org_id, external_sub)
      DO UPDATE SET email = EXCLUDED.email, display_name = EXCLUDED.display_name, role = EXCLUDED.role;
  ELSIF NOT v_disabled THEN
    UPDATE users u SET email = p_email, display_name = p_name, role = p_role WHERE u.id = v_user;
  END IF;

  SELECT u.id, u.role, u.disabled INTO v_user, v_role, v_disabled
    FROM users u WHERE u.org_id = v_org AND u.external_sub = p_sub;
  RETURN QUERY SELECT v_org, v_user, v_role, v_disabled;
END $$;
REVOKE ALL ON FUNCTION provision_user(text, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION provision_user(text, text, text, text, text, text) TO davra_app;
