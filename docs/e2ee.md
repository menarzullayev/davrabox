# End-to-end encrypted meetings

An organisation member can create a meeting in **end-to-end encrypted (E2EE) mode**. In that mode video, audio, screen
share and in-call chat are encrypted in the participants' browsers with a key the server never sees. This page says
what that protects, what it does not, and how it works.

## How it works

1. **Key.** When the host creates an E2EE meeting, the browser makes a random 256-bit key (`crypto.getRandomValues`,
   32 bytes, base64url, 43 characters). The server is told only `e2ee: true`.
2. **Link.** The key travels in the fragment of the share link: `https://<host>/app?join=<code>#k=<key>`. Browsers never
   send the fragment to a server (not in the request line, not in `Referer`; the production web server also sets `Referrer-Policy:
   no-referrer`). The reverse proxy, the API, the media server and our logs therefore cannot see it.
3. **Keeping it.** As soon as the app loads, it moves the key into `sessionStorage` (per tab, gone when the tab closes)
   and replaces the history entry with the address without the fragment. A reload keeps working; a sign-in redirect keeps
   working (the key is stored before the browser leaves for Keycloak). Old-style links (`/j/<code>#k=...`) keep the key
   through the redirect to `/app`.
4. **Joining.** A participant with the key derives an AES-GCM media key from it (HKDF) and turns encryption on **before**
   connecting and before any track is published. LiveKit encrypts every audio and video frame in a worker through
   insertable streams (frame-level, SFrame-style), and encrypts data-channel messages (chat, reactions, raised hands).
   If any step fails, nothing connects: there is no plaintext fallback.
5. **No key, no call.** A participant who joins by code without the key sees a page that explains why and offers a field to
   paste the full link. No room is created, no connection is opened and no camera or microphone is requested until a valid
   key is present. A browser that cannot encrypt media gets a clear message instead of an unencrypted call.

### What the installed SDK supports (livekit-client 2.25.0, checked in `node_modules`)

- `ExternalE2EEKeyProvider` with a shared key; the worker `livekit-client/e2ee-worker`; `Room.setE2EEEnabled(true)`.
- Data-channel encryption is **on** with the `encryption` room option and **off** with the deprecated `e2ee` option
  (`dcEncryptionEnabled = !room.options.e2ee` in the SDK). We use `encryption`. A unit test builds a real `Room` with
  both options and asserts the difference, so an SDK change that breaks this is noticed.
- `Room` throws on a browser without insertable streams or `RTCRtpScriptTransform`; the call screen turns that into
  the "your browser does not support encrypted meetings" message.
- The worker is bundled by Vite from the installed package as a same-origin classic worker (`/assets/livekit-client.e2ee.worker-*.js`), which the
  existing CSP (`worker-src 'self' blob:`) already allows. No CSP change was needed.

## Rules the product enforces

- E2EE is chosen at creation and **cannot be changed**. The UI has no switch for a running meeting and the API answers `PATCH
  /v1/meetings/:code` with `e2ee` in the body with **409** (audited as `meeting.e2ee.change.denied`).
- **Server-side recording is refused** (409): the server would need the plaintext. The record control stays visible,
  focusable and says why it does nothing.
- **File sharing is refused** (409 on upload, and the attach button is replaced by an explanation): files pass through the
  server and are encrypted there with a server key, which would contradict the promise.
- The meeting key never goes into a request. The browser API client checks every request (URL, headers, string body)
  against the keys the tab holds and against the `k=<key>` shape, and throws before sending; the API rejects unknown
  fields on meeting creation (400), so a client that ever sent a key by mistake fails loudly instead of the server
  silently dropping it.
- A visible **E2EE badge** with a polite `aria-live` announcement shows when encryption is confirmed active on this
  browser.

## Threat model (what you get, what you do not)

**Protected against**
- The DavraBox server, the reverse proxy, the database and its backups, the media server (SFU/TURN), a hosting provider and an
  organisation administrator: none of them can decrypt media or chat, because none of them has the key.
- A passive network attacker (already blocked by TLS; E2EE adds a layer if TLS is terminated or inspected).
- A participant who is removed from the meeting and did not copy the key cannot rejoin (the server bans them); see the
  limits below for one who did.

**Not protected against / honest limits**
- **The link is the trust root.** Anyone who has the full link has the key. If the link leaks (chat, mail archive,
  browser history sync, a screenshot of the address bar, a calendar invite), the meeting is readable by whoever can also
  join it. Joining still passes the server's checks (organisation membership, passcode, lock, waiting room), which is a
  second barrier but not a cryptographic one. Treat the link like a password and send it over a channel you trust.
- **No forward secrecy and no key change when members change.** One shared key lasts for the whole meeting. A member who is
  removed still holds the key; they can no longer connect, but if they were recorded off-line by someone else (or the
  SFU were compromised and replayed traffic) they could decrypt what they captured. To get a fresh key, create a new meeting.
- **No authentication of participants by the key.** The key proves "has the link", not "is Alice". Identities come from
  the server (SSO); a compromised server could show a wrong name, and a malicious server could also admit an extra
  participant who then still needs the key to see anything.
- **Metadata is visible to the server:** who joined which meeting and when, how long, from which IP, the meeting title,
  passcode hash, waiting-room events, room metadata, track counts and sizes, bitrate and the approximate size and timing
  of chat messages. Meeting titles are not encrypted.
- **A malicious or compromised web server could serve a modified web app** that steals the key (the usual limit of
  browser-based E2EE). The desktop and Android apps load the same hosted client. Signed desktop builds reduce but do not
  remove this.
- **Key at rest on the endpoint:** the key lives in `sessionStorage` while the tab is open and in the address bar until
  the app replaces it; browser extensions, a compromised endpoint or screen sharing of the browser window can expose it.
- **Wrong key.** A participant with a wrong or outdated key is not blocked by the server; they see decryption failures.
  The app shows a message ("some participants' video and audio could not be decrypted") instead of leaving the tiles
  unexplained. The key is not verified before connecting.
- **No transcripts, recording, or server-side features** (recording, file sharing, anything that needs plaintext) in an
  E2EE meeting.
- **Screen sharing** is encrypted like camera video. Shared **audio** is part of the screen-share track.
- The audio and video that a participant *publishes* before encryption is enabled does not exist: encryption is on before
  the first track is published. A participant who opens the meeting in two tabs needs the key in each tab.

## Background blur

Background blur (MediaPipe) processes the camera track before it reaches the encoder, and E2EE encrypts the encoded
frames afterwards, so they do not interfere by design. This is verified by the real-browser script `apps/e2e/e2ee.e2e.mjs`
(host enables blur in an E2EE meeting; a second browser must still receive live video and see a measurably softer
picture). Unit tests cannot prove it: it needs real WebRTC, which only the integrator's stack run provides.

## Verification map

| Claim | Where it is checked |
|---|---|
| key format, parsing, link building, no key in the query, sessionStorage only | `apps/web/src/e2ee/keys.test.ts` |
| SDK options: `encryption` (data channel on), HKDF raw key, fail on invalid key, unsupported browser throws | `apps/web/src/e2ee/provider.test.ts` (real livekit-client, fake worker) |
| key never in any request; guard refuses a key in URL/header/body | `apps/web/src/e2ee/guard.test.ts` |
| gate without key, no `Room` built, order install-key / enable / connect / publish, fail closed, badge, no console leak | `apps/web/src/Call.e2ee.test.tsx` |
| create dialog, full link shown once, copy link with key, paste link into join field | `apps/web/src/e2ee/home.e2ee.test.tsx` |
| `e2ee` persisted, returned on create/list/join, 409 on change, strict body, 409 file upload and recording | `apps/api/test/e2ee.test.ts` |
| two real browsers, pixel check of decrypted video, third context without the key, no key on the wire, blur, chat | `apps/e2e/e2ee.e2e.mjs` (real stack; written and syntax-checked here, run by the integrator) |
