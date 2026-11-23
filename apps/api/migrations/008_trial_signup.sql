-- Self-serve trial sign-up (workstream A).
--
-- * org_licenses gains the trial fields. A NULL trial_ends_at means "not a trial" (a paid or hand-made organization).
-- * Tables used BEFORE an organization exists (trial_signups, altcha_used, signup_events) have no org context, so the
--   application role has no privilege on them at all; they are reachable only through the SECURITY DEFINER functions
--   below. Row-level security is enabled (not forced) on them as defence in depth: the owner runs the functions.
-- * Every function pins search_path and is executable by the application role only.

ALTER TABLE org_licenses
  ADD COLUMN trial_ends_at        timestamptz,
  ADD COLUMN max_participants     integer CHECK (max_participants IS NULL OR max_participants >= 2),
  ADD COLUMN max_meeting_minutes  integer CHECK (max_meeting_minutes IS NULL OR max_meeting_minutes >= 1);
CREATE INDEX org_licenses_trial_end_idx ON org_licenses (trial_ends_at) WHERE trial_ends_at IS NOT NULL;

-- One trial organization per mailbox. Only a hash of the normalized address is kept, and the row survives the deletion
-- of the organization (org_id becomes NULL) so a deleted trial cannot simply be restarted with the same mailbox.
CREATE TABLE trial_signups (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid REFERENCES organizations(id) ON DELETE SET NULL,
  email_hash text NOT NULL UNIQUE,
  ip_hash    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX trial_signups_org_idx ON trial_signups (org_id);
CREATE INDEX trial_signups_created_idx ON trial_signups (created_at);

-- Single-use proof-of-work solutions (replay protection).
CREATE TABLE altcha_used (
  challenge_hash text PRIMARY KEY,
  used_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX altcha_used_at_idx ON altcha_used (used_at);

-- Platform-level event log of the sign-up endpoint. 'attempt' rows feed the rate limits (kept in the database so they
-- hold across several API instances); 'refusal' and 'success' rows are the audit trail for requests that have no
-- organization to write an audit_log row into. A successful sign-up also writes a normal audit_log row.
CREATE TABLE signup_events (
  id           bigserial PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  kind         text NOT NULL CHECK (kind IN ('attempt', 'refusal', 'success', 'retention')),
  reason       text NOT NULL DEFAULT '',
  ip_hash      text NOT NULL DEFAULT '',
  email_domain text NOT NULL DEFAULT '',
  org_slug     text
);
CREATE INDEX signup_events_ip_idx ON signup_events (ip_hash, at) WHERE kind = 'attempt';
CREATE INDEX signup_events_domain_idx ON signup_events (email_domain, at) WHERE kind = 'attempt';
CREATE INDEX signup_events_at_idx ON signup_events (at);

ALTER TABLE trial_signups ENABLE ROW LEVEL SECURITY;
ALTER TABLE altcha_used   ENABLE ROW LEVEL SECURITY;
ALTER TABLE signup_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON trial_signups, altcha_used, signup_events FROM PUBLIC, davra_app;
REVOKE ALL ON SEQUENCE signup_events_id_seq FROM PUBLIC, davra_app;

-- The functions below run as the table owner. organizations and org_licenses have FORCE row-level security with
-- tenant-only policies, so (like audit_owner_* in 007) the owner role gets explicit policies; they never apply to davra_app.
DO $$
BEGIN
  EXECUTE format('CREATE POLICY signup_owner_insert_orgs ON organizations FOR INSERT TO %I WITH CHECK (true)', current_user);
  EXECUTE format('CREATE POLICY signup_owner_delete_orgs ON organizations FOR DELETE TO %I USING (true)', current_user);
  EXECUTE format('CREATE POLICY signup_owner_licenses ON org_licenses FOR ALL TO %I USING (true) WITH CHECK (true)', current_user);
END $$;

-- Marks a solved challenge as used. Returns false when it was used before (replay).
CREATE FUNCTION altcha_consume(p_challenge_hash text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_n integer;
BEGIN
  -- Challenges live 5 minutes; a day of memory is far beyond that and keeps the table small.
  DELETE FROM altcha_used WHERE used_at < now() - interval '1 day';
  INSERT INTO altcha_used (challenge_hash) VALUES (p_challenge_hash) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n = 1;
END $$;

-- Atomically applies the abuse limits and, when they allow it, records the attempt.
-- reason: '' (allowed), 'rate_ip', 'rate_domain', 'daily_cap'. retry_after is in seconds.
CREATE FUNCTION signup_admit(p_ip_hash text, p_domain text, p_ip_per_hour integer, p_domain_per_hour integer, p_daily_cap integer)
RETURNS TABLE (allowed boolean, reason text, retry_after integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_n integer; v_oldest timestamptz;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('davrabox.signup_admit', 0));

  SELECT count(*), min(e.at) INTO v_n, v_oldest FROM signup_events e
   WHERE e.kind = 'attempt' AND e.ip_hash = p_ip_hash AND e.at > now() - interval '1 hour';
  IF v_n >= p_ip_per_hour THEN
    RETURN QUERY SELECT false, 'rate_ip'::text, greatest(1, ceil(extract(epoch FROM (v_oldest + interval '1 hour' - now())))::integer);
    RETURN;
  END IF;

  SELECT count(*), min(e.at) INTO v_n, v_oldest FROM signup_events e
   WHERE e.kind = 'attempt' AND e.email_domain = p_domain AND e.at > now() - interval '1 hour';
  IF v_n >= p_domain_per_hour THEN
    RETURN QUERY SELECT false, 'rate_domain'::text, greatest(1, ceil(extract(epoch FROM (v_oldest + interval '1 hour' - now())))::integer);
    RETURN;
  END IF;

  SELECT count(*), min(s.created_at) INTO v_n, v_oldest FROM trial_signups s WHERE s.created_at > now() - interval '24 hours';
  IF v_n >= p_daily_cap THEN
    RETURN QUERY SELECT false, 'daily_cap'::text, greatest(60, ceil(extract(epoch FROM (v_oldest + interval '24 hours' - now())))::integer);
    RETURN;
  END IF;

  INSERT INTO signup_events (kind, ip_hash, email_domain) VALUES ('attempt', p_ip_hash, p_domain);
  RETURN QUERY SELECT true, ''::text, 0;
END $$;

-- Writes a platform-level audit row (refusal or success) for a request that has no organization audit log to use.
CREATE FUNCTION signup_event_add(p_kind text, p_reason text, p_ip_hash text, p_domain text, p_org_slug text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO signup_events (kind, reason, ip_hash, email_domain, org_slug)
  VALUES (p_kind, left(p_reason, 80), left(p_ip_hash, 64), left(p_domain, 255), left(p_org_slug, 63))
$$;

-- Creates the organization, its trial licence and the one-per-mailbox record. Raises SQLSTATE 23505 (constraint
-- trial_signups_email_hash_key) when the mailbox already has a trial organization. A slug that is taken or reserved
-- gets a numeric suffix; an existing organization is never touched.
CREATE FUNCTION create_trial_org(p_slug text, p_name text, p_email_hash text, p_ip_hash text, p_days integer, p_participants integer, p_minutes integer)
RETURNS TABLE (org_id uuid, slug text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_base text := lower(p_slug);
  v_try text;
  v_id uuid;
  v_i integer := 0;
BEGIN
  IF v_base !~ '^[a-z0-9][a-z0-9-]{1,47}$' THEN RAISE EXCEPTION 'invalid slug' USING ERRCODE = '22023'; END IF;
  IF p_days < 1 OR p_participants < 2 OR p_minutes < 1 THEN RAISE EXCEPTION 'invalid trial limits' USING ERRCODE = '22023'; END IF;

  -- Enforce one trial per mailbox first, so a repeated mailbox never allocates anything. Two concurrent sign-ups of the same
  -- mailbox are separated by the unique index (the second blocks until the first commits, then fails with 23505).
  IF EXISTS (SELECT 1 FROM trial_signups s WHERE s.email_hash = p_email_hash) THEN
    RAISE EXCEPTION 'mailbox already has a trial' USING ERRCODE = '23505', CONSTRAINT = 'trial_signups_email_hash_key';
  END IF;

  LOOP
    v_try := CASE WHEN v_i = 0 THEN v_base ELSE v_base || '-' || (v_i + 1)::text END;
    IF v_try IN ('admin', 'api', 'app', 'www', 'auth', 'demo', 'status') THEN
      v_i := v_i + 1; CONTINUE;
    END IF;
    INSERT INTO organizations (slug, name) VALUES (v_try, left(p_name, 200)) ON CONFLICT (slug) DO NOTHING RETURNING id INTO v_id;
    EXIT WHEN v_id IS NOT NULL;
    v_i := v_i + 1;
    IF v_i > 200 THEN RAISE EXCEPTION 'no free slug' USING ERRCODE = '54000'; END IF;
  END LOOP;

  INSERT INTO org_licenses (org_id, seats_limit, trial_ends_at, max_participants, max_meeting_minutes)
  VALUES (v_id, p_participants, now() + make_interval(days => p_days), p_participants, p_minutes);
  INSERT INTO trial_signups (org_id, email_hash, ip_hash) VALUES (v_id, p_email_hash, p_ip_hash);
  RETURN QUERY SELECT v_id, v_try;
END $$;

-- Retention: removes trial organizations whose trial ended more than p_grace_days ago. A platform-level row is written
-- BEFORE the delete (the organization's own audit rows disappear with it); returns the removed slugs.
CREATE FUNCTION purge_expired_trials(p_grace_days integer, p_limit integer) RETURNS TABLE (org_slug text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r record;
BEGIN
  IF p_grace_days < 1 THEN RAISE EXCEPTION 'grace period must be at least one day' USING ERRCODE = '22023'; END IF;
  FOR r IN
    SELECT o.id, o.slug FROM organizations o JOIN org_licenses l ON l.org_id = o.id
     WHERE l.trial_ends_at IS NOT NULL AND l.trial_ends_at < now() - make_interval(days => p_grace_days)
     ORDER BY l.trial_ends_at LIMIT greatest(1, least(p_limit, 100))
  LOOP
    INSERT INTO signup_events (kind, reason, org_slug) VALUES ('retention', 'trial_purged', r.slug);
    INSERT INTO audit_log (org_id, actor_id, action, target) VALUES (r.id, NULL, 'trial.purge', r.slug);
    DELETE FROM organizations WHERE id = r.id;
    org_slug := r.slug;
    RETURN NEXT;
  END LOOP;
  DELETE FROM signup_events WHERE kind IN ('attempt', 'refusal') AND at < now() - interval '30 days';
END $$;

REVOKE ALL ON FUNCTION altcha_consume(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION signup_admit(text, text, integer, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION signup_event_add(text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION create_trial_org(text, text, text, text, integer, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION purge_expired_trials(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION altcha_consume(text) TO davra_app;
GRANT EXECUTE ON FUNCTION signup_admit(text, text, integer, integer, integer) TO davra_app;
GRANT EXECUTE ON FUNCTION signup_event_add(text, text, text, text, text) TO davra_app;
GRANT EXECUTE ON FUNCTION create_trial_org(text, text, text, text, integer, integer, integer) TO davra_app;
GRANT EXECUTE ON FUNCTION purge_expired_trials(integer, integer) TO davra_app;
