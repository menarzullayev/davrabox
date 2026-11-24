-- Data-subject rights (export, erasure) and retention.
--
-- Erasure is done by ANONYMISATION: the users row stays (audit_log.actor_id, meetings.host_user_id and similar columns
-- keep pointing at it, and the audit hash chain covers actor_id, so the id must not change) but every personal field is
-- replaced by a constant tombstone and the account is disabled for good. audit_log is never touched by erasure or by
-- retention: the application role has no UPDATE or DELETE on it.
--
-- * users.erasure_requested_at: the request is recorded first, so a half-finished erasure (identity provider or object
--   storage failure) is retried by the same call or by the hourly job. erased_at: the tombstone has been written.
-- * external_sub of a tombstone is KEPT on purpose: it is a random identity-provider id that no longer resolves to anybody
--   (the identity-provider user is deleted), and keeping it makes provision_user find the disabled row instead of creating
--   a fresh account for a token that is still valid for a few minutes.

ALTER TABLE users
  ADD COLUMN erasure_requested_at timestamptz,
  ADD COLUMN erased_at            timestamptz;
CREATE INDEX users_erasure_pending_idx ON users (erasure_requested_at)
  WHERE erasure_requested_at IS NOT NULL AND erased_at IS NULL;

-- Erasing a person removes the files they uploaded and the recordings they started; retention removes expired ones.
-- Both stay tenant-scoped through row-level security (the policies already exist).
GRANT DELETE ON meeting_files TO davra_app;
GRANT DELETE ON recordings TO davra_app;

-- ---------------------------------------------------------------------------------------------------------------------
-- Cross-tenant helpers for the retention job (no tenant context exists there). Narrow SECURITY DEFINER functions, like the
-- ones of 008/009; davra_app gets no BYPASSRLS.

-- Organization ids, so that the job can then work tenant by tenant under row-level security.
CREATE FUNCTION privacy_list_orgs() RETURNS TABLE (org_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT o.id FROM organizations o ORDER BY o.id
$$;

-- Erasure requests that were not finished (a crash or an identity-provider outage in the middle of the request).
CREATE FUNCTION privacy_pending_erasures(p_before timestamptz, p_limit integer) RETURNS TABLE (org_id uuid, user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.org_id, u.id FROM users u
   WHERE u.erasure_requested_at IS NOT NULL AND u.erased_at IS NULL AND u.erasure_requested_at < p_before
   ORDER BY u.erasure_requested_at
   LIMIT greatest(1, least(p_limit, 100))
$$;

-- Pending OAuth authorizations of the erased user (the table has no policy for the application role by design).
CREATE FUNCTION privacy_purge_user_oauth_states(p_org uuid, p_user uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_n integer;
BEGIN
  DELETE FROM calendar_oauth_states WHERE org_id = p_org AND user_id = p_user;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

-- Sign-up events older than the cutoff are deleted (they hold a keyed hash of the address and the mail domain); the keyed
-- address hash of trial_signups stays (it is what makes "one trial per mailbox" hold) but its network-address hash goes.
-- The cutoff is a parameter so that the job decides what "now" is.
CREATE FUNCTION privacy_purge_signup_events(p_cutoff timestamptz) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_n integer;
BEGIN
  DELETE FROM signup_events WHERE at < p_cutoff;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  UPDATE trial_signups SET ip_hash = '' WHERE created_at < p_cutoff AND ip_hash <> '';
  RETURN v_n;
END $$;

REVOKE ALL ON FUNCTION privacy_list_orgs() FROM PUBLIC;
REVOKE ALL ON FUNCTION privacy_pending_erasures(timestamptz, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION privacy_purge_user_oauth_states(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION privacy_purge_signup_events(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION privacy_list_orgs() TO davra_app;
GRANT EXECUTE ON FUNCTION privacy_pending_erasures(timestamptz, integer) TO davra_app;
GRANT EXECUTE ON FUNCTION privacy_purge_user_oauth_states(uuid, uuid) TO davra_app;
GRANT EXECUTE ON FUNCTION privacy_purge_signup_events(timestamptz) TO davra_app;
