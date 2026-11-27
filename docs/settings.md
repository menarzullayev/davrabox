# My settings and organization locks

Owner decisions 1-3 of 2026-11-27 (`davrabox-builds/decisions/2026-11-27-settings-vs-zoom.md`).

## The list (`apps/api/src/settings/catalog.ts`)
| Group | Settings | Enforced by |
| --- | --- | --- |
| Security (6) | waiting room by default, require a passcode, guests by default, passcode in the link, removed participants may rejoin, E2EE by default | `POST /v1/meetings` fills the creator's defaults and refuses a meeting without passcode (400 `passcode_required`); removal bans only when rejoin is off; the passcode-in-link is a browser convenience (the server keeps only a hash) |
| Scheduling (5) | host video, participant video, mute on entry, join before host, instant meetings in the personal room | join refuses with 409 `host_absent` while no host/co-host is connected (members and guests; the app waits and retries); the API mutes newcomers' audio/video at its first sight of them (poll + webhook) and clients start the same way |
| In meeting (9) | chat (off / host only / everyone), private chat, file sending, screen sharing (host / all), no sharing when guests may join, reactions, polls+Q&A+whiteboard, participants may rename, join/leave sound | screen sharing: LiveKit `canPublishSources` (camera+microphone only); file sending: upload API 403 `files_off`; rename: only through `POST /v1/meetings/:code/rename` (nobody may update their own LiveKit name/attributes); chat, private chat, reactions, activities, sound: the server writes the policy into the room metadata (participants cannot change it) and every receiving client drops what the policy does not allow |
| Notifications (3) | email when someone waits in the lobby, when a meeting is cancelled, on a sign-in from a new device | the API sends them (SMTP relay `SMTP_*`, in production the Keycloak relay `KC_SMTP_*`); without a relay nothing is sent and the page says so |
| Appearance (3) | style, mode, density | `/v1/me/prefs` refuses a locked value (403) and returns the locked one |
| Organization only (2) | join notice, country allow/block list | join (members and guests) returns 428 `disclaimer` with the text until accepted; a blocked country (Cloudflare `CF-IPCountry`, unknown = `XX`, Tor = `T1`) is 403 `country_blocked` and audited (`join.country.blocked`); organization admins are exempt from the country rule so they can never lock themselves out; VPN users count as the VPN's country |
| Recording (only while `RECORDING_ENABLED=1`) | record automatically, confirm before recording, who may record, retention days | auto-start when the host joins; `recording/start` returns 428 `confirm_recording` until confirmed; a co-host is refused when only the host may record; the retention job keeps an organization's recordings at most its own number of days |

Values: the person's own value unless the organization locked the setting; the organization's default otherwise; else the
built-in default. The existing policy "require a passcode" counts as a locked `requirePasscode`; the policy's waiting-room
default is the organization default; a single allowed style is a locked style.

## API
```
GET /v1/me/settings        -> { items: [{ key, group, type, options?, value, orgValue, locked }], recordingEnabled, mailEnabled }
PUT /v1/me/settings        { key: value | null }      403 locked, 400 unknown or invalid
GET /v1/admin/settings     (org admins)  -> items incl. organization-only rules
PUT /v1/admin/settings     { key: { value, locked } | null }
DELETE /v1/meetings/:code  cancel (host or org admin): 410 afterwards, out of the list, room closed, email to the host side
POST /v1/meetings/:code/rename { name }
```
Audit: `settings.update`, `admin.settings.update`, `meeting.cancel`, `meeting.rename`, `join.country.blocked`.
Tables: `user_settings`, `org_setting_defaults`, `meetings.cancelled_at` (migration 021).
