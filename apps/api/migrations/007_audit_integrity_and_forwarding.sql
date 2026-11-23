-- Audit log: per-organization hash chain, query indexes, and a cross-tenant read path for SIEM forwarding.
--
-- Hash chain: every audit row stores chain_seq (1,2,3,... per organization), prev_hash (row_hash of the previous
-- row, 32 zero bytes for the first) and row_hash = sha256(prev_hash || canonical(row)). A BEFORE INSERT trigger fills
-- them, serialised per organization with a transaction-level advisory lock, so existing inserts that only supply
-- (org_id, actor_id, action, target) keep working and parallel inserts cannot fork the chain.
-- audit_chain_head keeps the latest (seq, hash) per organization so that deleting the newest rows is detectable too.
-- Limit: someone with full database rights who rewrites a COMPLETE consistent chain (rows and head) is not caught by the
-- chain alone; the SIEM forwarder ships row_hash to an external system as the independent anchor.

ALTER TABLE audit_log
  ADD COLUMN chain_seq bigint,
  ADD COLUMN prev_hash bytea,
  ADD COLUMN row_hash  bytea,
  ADD COLUMN txid      bigint NOT NULL DEFAULT 0;

CREATE TABLE audit_chain_head (
  org_id    uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  last_seq  bigint NOT NULL,
  last_hash bytea  NOT NULL
);
ALTER TABLE audit_chain_head ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_audit_head ON audit_chain_head FOR SELECT
  USING (org_id = nullif(current_setting('app.current_org', true), '')::uuid);
GRANT SELECT ON audit_chain_head TO davra_app;

-- The table owner (the migration role) must keep working on a FORCE-RLS table even when it is not a superuser:
-- these policies apply to that role only and never to davra_app.
DO $$
BEGIN
  EXECUTE format('CREATE POLICY audit_owner_all ON audit_log FOR ALL TO %I USING (true) WITH CHECK (true)', current_user);
  EXECUTE format('CREATE POLICY audit_owner_read_orgs ON organizations FOR SELECT TO %I USING (true)', current_user);
  EXECUTE format('CREATE POLICY audit_owner_read_users ON users FOR SELECT TO %I USING (true)', current_user);
END $$;

CREATE FUNCTION audit_row_hash(p_prev bytea, p_seq bigint, p_id bigint, p_org uuid, p_actor uuid, p_action text, p_target text, p_at timestamptz)
RETURNS bytea LANGUAGE sql AS $$
  SELECT sha256(p_prev || convert_to(concat_ws('|',
    p_seq::text,
    p_id::text,
    p_org::text,
    CASE WHEN p_actor IS NULL THEN 'N' ELSE 'U:' || p_actor::text END,
    length(p_action)::text || ':' || p_action,
    CASE WHEN p_target IS NULL THEN 'N' ELSE length(p_target)::text || ':' || p_target END,
    to_char(p_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')
  ), 'UTF8'))
$$;

-- Chain the existing rows in id order, per organization.
DO $$
DECLARE r record; v_org uuid; v_seq bigint := 0; v_prev bytea; v_hash bytea;
BEGIN
  FOR r IN SELECT id, org_id, actor_id, action, target, created_at FROM audit_log ORDER BY org_id, id LOOP
    IF v_org IS DISTINCT FROM r.org_id THEN
      IF v_org IS NOT NULL THEN
        INSERT INTO audit_chain_head (org_id, last_seq, last_hash) VALUES (v_org, v_seq, v_prev);
      END IF;
      v_org := r.org_id; v_seq := 0; v_prev := decode(repeat('00', 32), 'hex');
    END IF;
    v_seq := v_seq + 1;
    v_hash := audit_row_hash(v_prev, v_seq, r.id, r.org_id, r.actor_id, r.action, r.target, r.created_at);
    UPDATE audit_log SET chain_seq = v_seq, prev_hash = v_prev, row_hash = v_hash WHERE id = r.id;
    v_prev := v_hash;
  END LOOP;
  IF v_org IS NOT NULL THEN
    INSERT INTO audit_chain_head (org_id, last_seq, last_hash) VALUES (v_org, v_seq, v_prev);
  END IF;
END $$;

ALTER TABLE audit_log
  ALTER COLUMN chain_seq SET NOT NULL,
  ALTER COLUMN prev_hash SET NOT NULL,
  ALTER COLUMN row_hash  SET NOT NULL;
CREATE UNIQUE INDEX audit_log_chain_idx ON audit_log (org_id, chain_seq);
CREATE INDEX audit_log_org_time_idx ON audit_log (org_id, created_at DESC, id DESC);
CREATE INDEX audit_log_forward_idx ON audit_log (txid, id);

CREATE FUNCTION audit_chain_before_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_seq bigint; v_prev bytea;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('davrabox.audit_chain:' || NEW.org_id::text, 0));
  SELECT h.last_seq, h.last_hash INTO v_seq, v_prev FROM audit_chain_head h WHERE h.org_id = NEW.org_id;
  IF NOT FOUND THEN v_seq := 0; v_prev := decode(repeat('00', 32), 'hex'); END IF;
  NEW.created_at := coalesce(NEW.created_at, now());
  NEW.txid       := txid_current();
  NEW.chain_seq  := v_seq + 1;
  NEW.prev_hash  := v_prev;
  NEW.row_hash   := audit_row_hash(v_prev, NEW.chain_seq, NEW.id, NEW.org_id, NEW.actor_id, NEW.action, NEW.target, NEW.created_at);
  INSERT INTO audit_chain_head (org_id, last_seq, last_hash) VALUES (NEW.org_id, NEW.chain_seq, NEW.row_hash)
    ON CONFLICT (org_id) DO UPDATE SET last_seq = EXCLUDED.last_seq, last_hash = EXCLUDED.last_hash;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION audit_chain_before_insert() FROM PUBLIC;
CREATE TRIGGER audit_chain BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_chain_before_insert();

-- Verification of the current tenant's chain (SECURITY INVOKER: row-level security confines it to that tenant).
CREATE FUNCTION audit_verify_chain(p_org uuid)
RETURNS TABLE (ok boolean, checked bigint, first_broken_id bigint)
LANGUAGE plpgsql STABLE AS $$
DECLARE r record; v_seq bigint := 0; v_prev bytea := decode(repeat('00', 32), 'hex'); v_n bigint := 0; h record;
BEGIN
  FOR r IN SELECT a.* FROM audit_log a WHERE a.org_id = p_org ORDER BY a.chain_seq LOOP
    v_n := v_n + 1;
    IF r.chain_seq <> v_seq + 1 OR r.prev_hash <> v_prev
       OR r.row_hash <> audit_row_hash(r.prev_hash, r.chain_seq, r.id, r.org_id, r.actor_id, r.action, r.target, r.created_at) THEN
      RETURN QUERY SELECT false, v_n, r.id;
      RETURN;
    END IF;
    v_seq := r.chain_seq;
    v_prev := r.row_hash;
  END LOOP;
  SELECT * INTO h FROM audit_chain_head WHERE audit_chain_head.org_id = p_org;
  IF FOUND THEN
    IF h.last_seq <> v_seq OR h.last_hash <> v_prev THEN
      RETURN QUERY SELECT false, v_n, NULL::bigint;  -- newest rows were removed or the head was altered
      RETURN;
    END IF;
  ELSIF v_n > 0 THEN
    RETURN QUERY SELECT false, v_n, NULL::bigint;
    RETURN;
  END IF;
  RETURN QUERY SELECT true, v_n, NULL::bigint;
END $$;
GRANT EXECUTE ON FUNCTION audit_verify_chain(uuid) TO davra_app;

-- SIEM forwarding. The cursor is (txid, id): all rows of one transaction become visible together and only
-- transactions older than the oldest running one are handed out, so a slow transaction can never commit a row
-- "behind" the cursor. State and the cross-tenant read are reachable only through these SECURITY DEFINER
-- functions; davra_app does not get BYPASSRLS and has no grant on the state table.
CREATE TABLE audit_forward_state (
  singleton  boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  last_txid  bigint NOT NULL DEFAULT 0,
  last_id    bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO audit_forward_state DEFAULT VALUES;
REVOKE ALL ON audit_forward_state FROM PUBLIC, davra_app;

CREATE FUNCTION audit_forward_state_get() RETURNS TABLE (last_txid bigint, last_id bigint)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.last_txid, s.last_id FROM audit_forward_state s
$$;

CREATE FUNCTION audit_forward_state_advance(p_txid bigint, p_id bigint) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE audit_forward_state SET last_txid = p_txid, last_id = p_id, updated_at = now()
   WHERE (p_txid, p_id) > (last_txid, last_id)
$$;

CREATE FUNCTION audit_forward_batch(p_after_txid bigint, p_after_id bigint, p_limit integer)
RETURNS TABLE (id bigint, txid bigint, org_slug text, created_at timestamptz, actor_email text, action text, target text, row_hash text)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT a.id, a.txid, o.slug, a.created_at, u.email, a.action, a.target, encode(a.row_hash, 'hex')
    FROM audit_log a
    JOIN organizations o ON o.id = a.org_id
    LEFT JOIN users u ON u.id = a.actor_id
   WHERE (a.txid, a.id) > (p_after_txid, p_after_id)
     AND a.txid < txid_snapshot_xmin(txid_current_snapshot())
   ORDER BY a.txid, a.id
   LIMIT greatest(1, least(p_limit, 1000))
$$;

REVOKE ALL ON FUNCTION audit_forward_state_get() FROM PUBLIC;
REVOKE ALL ON FUNCTION audit_forward_state_advance(bigint, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION audit_forward_batch(bigint, bigint, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_forward_state_get() TO davra_app;
GRANT EXECUTE ON FUNCTION audit_forward_state_advance(bigint, bigint) TO davra_app;
GRANT EXECUTE ON FUNCTION audit_forward_batch(bigint, bigint, integer) TO davra_app;
