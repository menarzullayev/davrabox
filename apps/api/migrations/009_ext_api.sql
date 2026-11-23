-- External REST API (API keys, idempotency, per-key rate limit) and signed webhooks (endpoints, delivery outbox).
-- Same isolation pattern as every tenant table: FORCE row-level security keyed on app.current_org. The few places that
-- must work before a tenant is known (API key lookup by prefix, the delivery worker, the media-server webhook) are narrow
-- SECURITY DEFINER functions; davra_app gets no BYPASSRLS and no direct grant on what they read across tenants.

-- ---------------------------------------------------------------------------------------------------------------------
-- API keys. The secret is shown once and never stored: only SHA-256(secret) and the public prefix are kept.
-- Key format: dbx_<8 hex prefix>_<43 base64url secret>.
CREATE TABLE api_keys (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  prefix      text NOT NULL UNIQUE CHECK (prefix ~ '^[0-9a-f]{8}$'),
  secret_hash bytea NOT NULL CHECK (octet_length(secret_hash) = 32),
  scopes      text[] NOT NULL CHECK (cardinality(scopes) >= 1 AND scopes <@ ARRAY['meetings:read', 'meetings:write', 'users:read']),
  -- meetings created through the key are hosted by this user; the key dies with the user.
  created_by  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at  timestamptz
);
CREATE INDEX api_keys_org_idx ON api_keys (org_id, created_at DESC);

-- Idempotency-Key replay store for POST /v1/ext/meetings (one row per key and client-chosen key string).
CREATE TABLE ext_idempotency (
  key_id       uuid NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  idem_key     text NOT NULL CHECK (char_length(idem_key) BETWEEN 1 AND 200),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  request_hash text NOT NULL,
  response     jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (key_id, idem_key)
);

-- Per-key fixed-window rate limit counters, kept in the database so they hold across API instances.
CREATE TABLE ext_rate_limits (
  key_id       uuid NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  window_start timestamptz NOT NULL,
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  hits         integer NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, window_start)
);

-- ---------------------------------------------------------------------------------------------------------------------
-- Webhooks. The signing secret is envelope-encrypted (files/crypto.ts helpers; the endpoint id is the AAD).
CREATE TABLE webhook_endpoints (
  id                 uuid PRIMARY KEY,
  org_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  url                text NOT NULL CHECK (char_length(url) <= 2048 AND url ~ '^https://'),
  events             text[] NOT NULL CHECK (
    cardinality(events) >= 1 AND events <@ ARRAY['meeting.created', 'meeting.ended', 'participant.joined', 'participant.left']
  ),
  secret_blob        bytea NOT NULL,
  secret_wrapped_key text NOT NULL,
  created_by         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, url)
);

-- Delivery outbox: rows are written in the same transaction as the thing that happened (trigger / tenant context),
-- so nothing is lost on a crash, and they survive an API restart. body is the exact text that gets signed and sent.
CREATE TABLE webhook_deliveries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  endpoint_id     uuid NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event_id        uuid NOT NULL,
  event_type      text NOT NULL,
  body            text NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'dead')),
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_status     integer,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  delivered_at    timestamptz,
  UNIQUE (endpoint_id, event_id) -- a retried media-server event never produces a second delivery
);
CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries (next_attempt_at) WHERE status = 'pending';
CREATE INDEX webhook_deliveries_endpoint_idx ON webhook_deliveries (endpoint_id, created_at DESC);

ALTER TABLE api_keys           ENABLE ROW LEVEL SECURITY;
ALTER TABLE ext_idempotency    ENABLE ROW LEVEL SECURITY;
ALTER TABLE ext_rate_limits    ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_endpoints  ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys           FORCE ROW LEVEL SECURITY;
ALTER TABLE ext_idempotency    FORCE ROW LEVEL SECURITY;
ALTER TABLE ext_rate_limits    FORCE ROW LEVEL SECURITY;
ALTER TABLE webhook_endpoints  FORCE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_api_keys ON api_keys
  USING      (org_id = nullif(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.current_org', true), '')::uuid);
CREATE POLICY tenant_ext_idempotency ON ext_idempotency
  USING      (org_id = nullif(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.current_org', true), '')::uuid);
CREATE POLICY tenant_ext_rate_limits ON ext_rate_limits
  USING      (org_id = nullif(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.current_org', true), '')::uuid);
CREATE POLICY tenant_webhook_endpoints ON webhook_endpoints
  USING      (org_id = nullif(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.current_org', true), '')::uuid);
CREATE POLICY tenant_webhook_deliveries ON webhook_deliveries
  USING      (org_id = nullif(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.current_org', true), '')::uuid);

-- The application can create keys and revoke them; it can never change a stored hash, a scope list or the owner.
GRANT SELECT, INSERT ON api_keys TO davra_app;
GRANT UPDATE (revoked_at) ON api_keys TO davra_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ext_idempotency TO davra_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ext_rate_limits TO davra_app;
GRANT SELECT, INSERT, DELETE ON webhook_endpoints TO davra_app;
GRANT SELECT, INSERT ON webhook_deliveries TO davra_app; -- state changes only through webhook_record_result()

-- ---------------------------------------------------------------------------------------------------------------------
-- API key authentication runs before a tenant is known: look the key up by its public prefix.
CREATE FUNCTION api_key_lookup(p_prefix text)
RETURNS TABLE (key_id uuid, org_id uuid, secret_hash bytea, scopes text[], revoked boolean, created_by uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT k.id, k.org_id, k.secret_hash, k.scopes, k.revoked_at IS NOT NULL, k.created_by
    FROM api_keys k WHERE k.prefix = p_prefix
$$;

-- last_used_at is touched at most once a minute per key, so authentication does not turn into a write per request.
CREATE FUNCTION api_key_touch(p_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE api_keys SET last_used_at = now()
   WHERE id = p_id AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Event outbox. SECURITY INVOKER on purpose: it runs under the caller's tenant and row-level security.
CREATE FUNCTION webhook_enqueue(p_org uuid, p_event_id uuid, p_type text, p_data jsonb) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE v_body text; v_n integer;
BEGIN
  v_body := jsonb_build_object(
    'id', p_event_id,
    'type', p_type,
    'createdAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'data', p_data
  )::text;
  INSERT INTO webhook_deliveries (org_id, endpoint_id, event_id, event_type, body)
    SELECT p_org, e.id, p_event_id, p_type, v_body FROM webhook_endpoints e WHERE e.org_id = p_org AND p_type = ANY (e.events)
    ON CONFLICT (endpoint_id, event_id) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
GRANT EXECUTE ON FUNCTION webhook_enqueue(uuid, uuid, text, jsonb) TO davra_app;

-- meeting.created is emitted by the database for every creation path (web app and external API alike).
CREATE FUNCTION webhook_on_meeting_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM webhook_enqueue(
    NEW.org_id, gen_random_uuid(), 'meeting.created',
    jsonb_build_object('meetingId', NEW.id, 'code', NEW.code, 'title', NEW.title, 'hostUserId', NEW.host_user_id,
                       'scheduledAt', NEW.scheduled_at, 'waitingRoom', NEW.waiting_room)
  );
  RETURN NEW;
END $$;
CREATE TRIGGER webhook_meeting_created AFTER INSERT ON meetings FOR EACH ROW EXECUTE FUNCTION webhook_on_meeting_insert();

-- The media server reports a room (= meeting id) with no tenant context: resolve the owner here.
CREATE FUNCTION webhook_meeting_lookup(p_meeting uuid) RETURNS TABLE (org_id uuid, code text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT m.org_id, m.code FROM meetings m WHERE m.id = p_meeting
$$;

-- Delivery worker (cross-tenant). Claiming bumps attempts and leases the row, so a crashed worker's rows come back
-- after the lease; FOR UPDATE SKIP LOCKED lets several API instances share the queue.
CREATE FUNCTION webhook_claim_due(p_limit integer, p_lease_seconds integer)
RETURNS TABLE (id uuid, org_id uuid, endpoint_id uuid, event_id uuid, event_type text, body text, attempts integer,
               url text, secret_blob bytea, secret_wrapped_key text)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH due AS (
    SELECT d.id FROM webhook_deliveries d
     WHERE d.status = 'pending' AND d.next_attempt_at <= now()
     ORDER BY d.next_attempt_at
     LIMIT greatest(1, least(p_limit, 100))
     FOR UPDATE SKIP LOCKED
  ), upd AS (
    UPDATE webhook_deliveries d
       SET attempts = d.attempts + 1, next_attempt_at = now() + make_interval(secs => greatest(p_lease_seconds, 5))
      FROM due WHERE d.id = due.id
    RETURNING d.id, d.org_id, d.endpoint_id, d.event_id, d.event_type, d.body, d.attempts
  )
  SELECT upd.id, upd.org_id, upd.endpoint_id, upd.event_id, upd.event_type, upd.body, upd.attempts,
         e.url, e.secret_blob, e.secret_wrapped_key
    FROM upd JOIN webhook_endpoints e ON e.id = upd.endpoint_id
$$;

CREATE FUNCTION webhook_record_result(p_id uuid, p_outcome text, p_status integer, p_error text, p_retry_in_seconds integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_outcome NOT IN ('delivered', 'retry', 'dead') THEN RAISE EXCEPTION 'invalid outcome'; END IF;
  UPDATE webhook_deliveries d SET
      status          = CASE p_outcome WHEN 'delivered' THEN 'delivered' WHEN 'dead' THEN 'dead' ELSE 'pending' END,
      last_status     = p_status,
      last_error      = left(p_error, 500),
      delivered_at    = CASE WHEN p_outcome = 'delivered' THEN now() END,
      next_attempt_at = CASE WHEN p_outcome = 'retry' THEN now() + make_interval(secs => greatest(p_retry_in_seconds, 1)) ELSE d.next_attempt_at END
    WHERE d.id = p_id AND d.status = 'pending';
END $$;

-- Housekeeping: finished deliveries after 30 days, idempotency records after 24 hours, old rate-limit windows.
CREATE FUNCTION ext_api_prune() RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  DELETE FROM webhook_deliveries WHERE status <> 'pending' AND created_at < now() - interval '30 days';
  DELETE FROM ext_idempotency WHERE created_at < now() - interval '24 hours';
  DELETE FROM ext_rate_limits WHERE window_start < now() - interval '2 hours';
$$;

REVOKE ALL ON FUNCTION api_key_lookup(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION api_key_touch(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION webhook_enqueue(uuid, uuid, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION webhook_on_meeting_insert() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION webhook_on_meeting_insert() TO davra_app;
REVOKE ALL ON FUNCTION webhook_meeting_lookup(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION webhook_claim_due(integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION webhook_record_result(uuid, text, integer, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION ext_api_prune() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api_key_lookup(text) TO davra_app;
GRANT EXECUTE ON FUNCTION api_key_touch(uuid) TO davra_app;
GRANT EXECUTE ON FUNCTION webhook_meeting_lookup(uuid) TO davra_app;
GRANT EXECUTE ON FUNCTION webhook_claim_due(integer, integer) TO davra_app;
GRANT EXECUTE ON FUNCTION webhook_record_result(uuid, text, integer, text, integer) TO davra_app;
GRANT EXECUTE ON FUNCTION ext_api_prune() TO davra_app;
