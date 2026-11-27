-- Signed-in home package (owner decisions 3 and 7 of 2026-11-27).
--
-- * meetings.personal_owner: a member's personal room. It is an ordinary meeting row (join, waiting room, passcode and the
--   organization's guest policy all apply unchanged) with a fixed code that only "regenerate" changes. One per person.
--   Personal rooms are left out of the meeting list and of the meeting-metadata retention (they never "end").
-- * meeting_sessions: one row per real run of a meeting on the media server (a LiveKit room instance, keyed by its sid).
--   Filled by the API itself from the media server (polling, plus the signed webhook when it is configured), so "Recent
--   activity" shows only what really happened: start, last moment someone was connected, end, peak head count.
-- * meeting_session_participants: who was connected in that run (members by user id, guests only as a count: their
--   identity is the guest session id, never a name). It lets a person see the meetings they attended.
-- * activity_room_lookup: the only cross-tenant read the tracker needs (room name -> organization); everything after it
--   runs inside the meeting's tenant under row-level security.

ALTER TABLE meetings ADD COLUMN personal_owner uuid REFERENCES users(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX meetings_personal_owner_uq ON meetings (personal_owner) WHERE personal_owner IS NOT NULL;

CREATE TABLE meeting_sessions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  meeting_id        uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  room_sid          text NOT NULL UNIQUE CHECK (char_length(room_sid) BETWEEN 1 AND 100),
  started_at        timestamptz NOT NULL,
  last_active_at    timestamptz,
  ended_at          timestamptz,
  peak_participants integer NOT NULL DEFAULT 0 CHECK (peak_participants >= 0)
);
CREATE INDEX meeting_sessions_meeting_idx ON meeting_sessions (meeting_id, started_at DESC);
CREATE INDEX meeting_sessions_open_idx ON meeting_sessions (meeting_id) WHERE ended_at IS NULL;

CREATE TABLE meeting_session_participants (
  session_id    uuid NOT NULL REFERENCES meeting_sessions(id) ON DELETE CASCADE,
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  identity      text NOT NULL CHECK (char_length(identity) BETWEEN 1 AND 64),
  user_id       uuid REFERENCES users(id) ON DELETE CASCADE,
  guest         boolean NOT NULL DEFAULT false,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, identity)
);
CREATE INDEX meeting_session_participants_user_idx ON meeting_session_participants (user_id) WHERE user_id IS NOT NULL;

ALTER TABLE meeting_sessions             ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_session_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_sessions             FORCE ROW LEVEL SECURITY;
ALTER TABLE meeting_session_participants FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_meeting_sessions ON meeting_sessions
  USING      (org_id = nullif(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.current_org', true), '')::uuid);
CREATE POLICY tenant_meeting_session_participants ON meeting_session_participants
  USING      (org_id = nullif(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.current_org', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON meeting_sessions TO davra_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON meeting_session_participants TO davra_app;

-- Room names are meeting ids. Returns (meeting, organization) for the ones that exist; reveals nothing else.
CREATE FUNCTION activity_room_lookup(p_meeting_ids uuid[]) RETURNS TABLE (meeting_id uuid, org_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT m.id, m.org_id FROM meetings m WHERE m.id = ANY (p_meeting_ids)
$$;
-- The tracker also has to close runs whose room is gone; it needs their organization without a tenant context.
CREATE FUNCTION activity_open_sessions() RETURNS TABLE (session_id uuid, org_id uuid, meeting_id uuid, room_sid text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.id, s.org_id, s.meeting_id, s.room_sid FROM meeting_sessions s WHERE s.ended_at IS NULL
$$;
REVOKE ALL ON FUNCTION activity_room_lookup(uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION activity_open_sessions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION activity_room_lookup(uuid[]) TO davra_app;
GRANT EXECUTE ON FUNCTION activity_open_sessions() TO davra_app;

-- "Regenerate link" voids the waiting requests made through the old link (a member must be able to ask again through the
-- new one; a denied row would refuse them for good).
GRANT DELETE ON join_requests TO davra_app;
