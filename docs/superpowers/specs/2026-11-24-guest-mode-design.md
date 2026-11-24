# Guest mode (join with a meeting code and a name, no account)

Status: approved decisions of 2026-11-24, implementation in progress. Source of the idea: comparison with Zoom's `zoom.us/join` (meeting ID + name).

## Decisions (product owner)
1. Guests can join without an account; first priority.
2. Every combination is configurable: guests off, always through the waiting room, or direct; the meeting passcode and lock still apply.
3. Two levels: the organisation admin sets the **maximum** (`off` | `waiting_room` | `open`, default `off`); the host picks inside that limit per meeting.
4. Guest rights: video, audio, chat, raise hand, reactions. No files, no recording control, no host controls. Screen share is not granted by default.

## Model
- Order `off < waiting_room < open`. Effective mode at join time = `min(meeting.guest_mode, org.guest_policy)`, evaluated on every join and every poll, so lowering the policy takes effect immediately.
- `off`: refused. `waiting_room`: the guest always waits for the host or a co-host. `open`: the guest gets a token directly (after the passcode, if the meeting has one).
- A new meeting's `guest_mode` is the host's choice, capped by the policy; the default is `off`.
- Unknown code, guests off, banned and locked meetings all answer the same way where an answer would reveal that a code exists (`404 meeting not found`); a wrong passcode is `403`, as for members.

## Identity and token
- A guest has no `users` row. Each join creates a `guest_sessions` row (id, org, meeting, display name, created_at) and a LiveKit identity `guest:<uuid>`; the participant metadata is `{"guest":true}` so every client can label the person.
- The LiveKit grant: join, subscribe, publish, publish data; **not** `roomAdmin`, and no recorder rights. The token lives at most as long as a member token (`MEETING_TOKEN_TTL_SECONDS`) and never longer than the trial limit.
- A signed guest session token (HMAC-SHA256, 12 h at most, bound to meeting and session) authorises only the guest polling endpoint; it is not a member token and the member endpoints reject it (`AuthGuard` needs the Keycloak JWT).

## Threats and controls
| Threat | Control |
|---|---|
| Guessing meeting codes (10^10 space) | 10 attempts per address and 5 per address and code in 15 minutes, counted before the work (shared Redis limiter); identical answers for unknown and guest-disabled codes |
| Passcode guessing | Same atomic counter as members, keyed on address + code (guests have no stable user id) |
| Flooding the waiting room | At most 50 pending requests per meeting; one pending request per guest session; display name 1-60 characters, control characters refused |
| Spoofed names ("Host", "Admin") | Guests are labelled in every client; reserved look-alikes of the host's name are not blocked, the label is the control |
| A removed guest coming back | The ban stores a keyed hash of the address for that meeting; honest limit: a changed address defeats it, which the admin documentation states |
| Guests reading files or recordings | The file and recording endpoints require a member token; guests have none |
| Guests becoming hosts | No `roomAdmin`; the member-only `/me` is skipped by the client, the role is `guest` |
| Tenant leakage | The code lookup is a narrow `SECURITY DEFINER` function that returns only what a join needs; every later query runs inside `withTenant` of the meeting's organisation |
| Trial abuse | Guests count towards the room's participant cap and the trial's time limit |
| Webhooks and audit | Guests are audited (`guest.join`, `guest.admit`, `guest.deny`) with the session id; participant webhooks ignore non-members as before |

## API
- `POST /v1/guest/meetings/:code/join` `{ name, passcode? }` -> `{ status: 'joined', token, url, meetingId, title, e2ee, guest: true, guestToken }` or `{ status: 'waiting', requestId, guestToken }`.
- `GET /v1/guest/requests/:id` (Bearer guest token) -> `{ status: 'waiting' }` or the joined result, `403` when denied.
- Host side: `GET /v1/meetings/:code/requests` lists guests too (`guest: true`); admit and deny work on both kinds.
- `PUT /v1/admin/policies` gains `guestPolicy`; `POST /v1/meetings` gains `guests` (capped by the policy); the meeting list reports `guests`.
- Muting and removing a guest use the same participant endpoints with the `guest:<uuid>` identity.

## Client
- Landing, sign-in screen and the `?join=` deep link offer "Join as a guest": code, name (and passcode when needed), then the call or the waiting screen.
- In a guest call the screen hides files, recording and host controls and does not call member-only endpoints.

## Verification
Unit and integration tests for every row of the threat table (negative cases first), a real-browser run where a host admits a guest and a guest chats, and a guest refused when the policy is `off`.
