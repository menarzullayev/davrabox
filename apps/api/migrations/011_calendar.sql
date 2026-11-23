-- Calendar integration (Google Calendar, Microsoft Outlook).
-- calendar_connections: one OAuth connection per (user, provider). Only the refresh token is kept, and only
--   encrypted (envelope encryption, apps/api/src/files/crypto.ts); access tokens are never stored.
-- calendar_oauth_states: server-side state + PKCE verifier of a pending authorization (10 minutes, single use).
--   The provider redirects the browser back without our bearer token, so the callback is anonymous: the state row is
--   the only thing that proves which user started the flow. The table has FORCE row-level security and NO policy for
--   the application role; it is reachable only through the two SECURITY DEFINER functions below.

CREATE TABLE calendar_connections (
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider          text NOT NULL CHECK (provider IN ('google', 'microsoft')),
  org_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  refresh_token_enc text NOT NULL,  -- base64 of nonce || ciphertext || tag (AES-256-GCM, per-record data key)
  wrapped_key       text NOT NULL,  -- the data key wrapped by the master key
  scope             text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider)
);
CREATE INDEX calendar_connections_org_idx ON calendar_connections (org_id);

ALTER TABLE calendar_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_calendar_connections ON calendar_connections
  USING      (org_id = nullif(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.current_org', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON calendar_connections TO davra_app;

CREATE TABLE calendar_oauth_states (
  state_hash   text PRIMARY KEY CHECK (state_hash ~ '^[0-9a-f]{64}$'), -- SHA-256 of the state; the state itself is never stored
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider     text NOT NULL CHECK (provider IN ('google', 'microsoft')),
  verifier_enc text NOT NULL,       -- PKCE code_verifier, encrypted like the refresh token
  wrapped_key  text NOT NULL,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX calendar_oauth_states_expiry_idx ON calendar_oauth_states (expires_at);
ALTER TABLE calendar_oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_oauth_states FORCE ROW LEVEL SECURITY;
-- Deliberately no policy and no grant: only the functions (owner = migration role) can touch the table.

-- Stores a pending authorization and drops expired ones. At most 5 pending states per user (older ones are removed).
CREATE FUNCTION calendar_state_create(p_state_hash text, p_org uuid, p_user uuid, p_provider text, p_verifier_enc text, p_wrapped_key text, p_ttl_seconds int)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_ttl_seconds < 1 OR p_ttl_seconds > 900 THEN RAISE EXCEPTION 'invalid ttl'; END IF;
  -- the caller must be the user it claims to be acting for: the user row must belong to the organization
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = p_user AND org_id = p_org) THEN RAISE EXCEPTION 'unknown user'; END IF;
  DELETE FROM calendar_oauth_states WHERE expires_at < now();
  DELETE FROM calendar_oauth_states WHERE state_hash IN (
    SELECT state_hash FROM calendar_oauth_states WHERE user_id = p_user ORDER BY created_at DESC OFFSET 4);
  INSERT INTO calendar_oauth_states (state_hash, org_id, user_id, provider, verifier_enc, wrapped_key, expires_at)
    VALUES (p_state_hash, p_org, p_user, p_provider, p_verifier_enc, p_wrapped_key, now() + make_interval(secs => p_ttl_seconds));
END $$;
REVOKE ALL ON FUNCTION calendar_state_create(text, uuid, uuid, text, text, text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION calendar_state_create(text, uuid, uuid, text, text, text, int) TO davra_app;

-- Single use: the row is deleted by the same statement that returns it, so a replayed state finds nothing.
-- Expired rows are deleted as well but not returned.
CREATE FUNCTION calendar_state_consume(p_state_hash text)
RETURNS TABLE (org_id uuid, user_id uuid, provider text, verifier_enc text, wrapped_key text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  RETURN QUERY
    WITH gone AS (DELETE FROM calendar_oauth_states s WHERE s.state_hash = p_state_hash RETURNING s.*)
    SELECT g.org_id, g.user_id, g.provider, g.verifier_enc, g.wrapped_key FROM gone g WHERE g.expires_at > now();
END $$;
REVOKE ALL ON FUNCTION calendar_state_consume(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION calendar_state_consume(text) TO davra_app;
