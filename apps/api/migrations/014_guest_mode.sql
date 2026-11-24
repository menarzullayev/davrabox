-- Guest mode: joining a meeting with a code and a name, without an account (docs/superpowers/specs/2026-11-24-guest-mode-design.md).
--
-- * org_policies.guest_policy: the MAXIMUM an organization allows ('off' < 'waiting_room' < 'open'); default 'off'.
-- * meetings.guest_mode: the host's choice, capped by the policy at creation and again at every join.
-- * guest_sessions: one row per guest join (no users row exists for a guest); tenant-scoped like every other table.
-- * meeting_guest_bans: a removed guest is banned by a KEYED HASH of the network address for that meeting only.
-- * guest_meeting_lookup: the only cross-tenant read a guest join needs (code -> organization and meeting id); everything
--   after it runs inside the meeting's tenant under row-level security.

ALTER TABLE org_policies
  ADD COLUMN guest_policy text NOT NULL DEFAULT 'off' CHECK (guest_policy IN ('off', 'waiting_room', 'open'));

ALTER TABLE meetings
  ADD COLUMN guest_mode text NOT NULL DEFAULT 'off' CHECK (guest_mode IN ('off', 'waiting_room', 'open'));

CREATE TABLE guest_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  meeting_id   uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 60),
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'admitted', 'denied', 'joined')),
  ip_hash      text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  decided_at   timestamptz,
  decided_by   uuid REFERENCES users(id)
);
CREATE INDEX guest_sessions_meeting_idx ON guest_sessions (meeting_id, status);

CREATE TABLE meeting_guest_bans (
  meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  ip_hash    text NOT NULL,
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  banned_by  uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (meeting_id, ip_hash)
);

ALTER TABLE guest_sessions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_guest_bans ENABLE ROW LEVEL SECURITY;
ALTER TABLE guest_sessions     FORCE ROW LEVEL SECURITY;
ALTER TABLE meeting_guest_bans FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_guest_sessions ON guest_sessions
  USING      (org_id = nullif(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.current_org', true), '')::uuid);
CREATE POLICY tenant_meeting_guest_bans ON meeting_guest_bans
  USING      (org_id = nullif(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.current_org', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON guest_sessions TO davra_app;
GRANT SELECT, INSERT ON meeting_guest_bans TO davra_app;

-- Code -> (organization, meeting). Returns nothing for an unknown code; reveals nothing else.
CREATE FUNCTION guest_meeting_lookup(p_code text) RETURNS TABLE (org_id uuid, meeting_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT m.org_id, m.id FROM meetings m WHERE m.code = p_code AND p_code ~ '^[0-9]{11,12}$'
$$;
REVOKE ALL ON FUNCTION guest_meeting_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION guest_meeting_lookup(text) TO davra_app;
