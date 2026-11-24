export type GuestMode = 'off' | 'waiting_room' | 'open';
const ORDER: Record<GuestMode, number> = { off: 0, waiting_room: 1, open: 2 };

/** The stricter of two modes: what a guest is really allowed is the minimum of the meeting's choice and the organization's maximum. */
export function effectiveGuestMode(meeting: GuestMode, policy: GuestMode): GuestMode {
  return ORDER[meeting] <= ORDER[policy] ? meeting : policy;
}

/** LiveKit identity of a guest: `guest:<guest session id>`. Members use their user id (a bare uuid). */
export const GUEST_IDENTITY_PREFIX = 'guest:';
