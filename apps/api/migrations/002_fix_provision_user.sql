-- 001 declared RETURNS TABLE (org_id, user_id, role); inside plpgsql those OUT names collide with the
-- column names used in ON CONFLICT and SELECT ("column reference org_id is ambiguous").
-- #variable_conflict use_column makes column names win; the OUT values are only set via RETURN QUERY.
CREATE OR REPLACE FUNCTION provision_user(p_org_slug text, p_org_name text, p_sub text, p_email text, p_name text, p_role text)
RETURNS TABLE (org_id uuid, user_id uuid, role text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
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
