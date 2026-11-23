# DavraBox landing, self-serve trial and the launch feature program (design)

Date: 2026-11-24. Status: DRAFT for approval. Decisions below come from the user in the brainstorming session; "(my call)" marks what I filled in.

## 1. Intent
DavraBox is going to an open paid launch. Today `/` is only a sign-in screen. The user wants a real landing page that turns two kinds of visitors into users: an organisation decision maker (security, local control) and an individual who just wants to join a meeting. The main action on the page is a free trial that anyone can start alone, without talking to us. The user also wants the whole planned feature set built and the page to present it as one equal set of capabilities.

## 2. Decisions taken (user)
- Audience: both. Top of page speaks to the organisation; a "join a meeting" code field sits beside it.
- Main action: free trial, self-service sign-up. No email verification; protected by a captcha and limits.
- Captcha: ALTCHA (proof of work, self-hosted, no third party).
- Trial limits: 7 days, up to 10 participants, meetings up to 30 minutes.
- Location: landing at `/`, the application moves to `/app`.
- Languages: Uzbek (primary), Russian, English.
- Hero: mandala plus a real call screenshot (Davra mode).
- Claims: planned features are shown in the main block with no status badges, all alike. **Rule I add (my call, not negotiable for me):** the page does not go public until every capability it names is working and verified; until then it is built and reviewed on a non-public path. Items that need purchases by the user (code-signing certificates, store accounts) block publication until the user supplies them.
- Programs (all required before launch): E2EE, recording, calendar integration, REST API plus webhooks, BYOK, mobile app (Android first, iOS later), signed desktop app.
- E2EE is an optional per-meeting mode; recording works only for meetings created without E2EE, with a clear warning in the UI.
- Execution: parallel agents in separate worktrees, merged and verified by me. Expected cost stated and accepted: about 200-300k tokens per agent, about 1M tokens for four.

## 3. Goals, non-goals, anti-goals
Goals: a landing that is fast, accessible (WCAG AA), in three languages, on the existing design system, that gets a visitor from "what is this" to a running trial organisation in under two minutes; a sign-up that cannot be used to flood the system; every named capability real.
Non-goals: pricing pages and payments (no payment provider yet), blog, SEO campaigns, email verification and email delivery of any kind.
Anti-goals (would make this a failure even if it technically works): a feature claim that is not true on the day of publication; a free trial that costs us unbounded media spend; sign-up that lets one person create thousands of organisations; third-party scripts on the page.

## 4. Constraints
- Public repository: no secrets, no server details in commits.
- Existing system: Keycloak realm `davrabox`, tenant = `org_slug` claim, Postgres RLS, users provisioned on first login (`provision_user`), admin API client (`davrabox-admin-api`) can create users in Keycloak. Second factor is currently OFF by user decision.
- Media currently via LiveKit Cloud free tier (hard cap 5,000 participant minutes per month); trial limits protect that cap.
- Production edge is `deploy/prod` (Caddy); the Vite dev server serves the pilot host.

## 5. Approaches considered for the landing and sign-up
1. **Landing inside the web app (React, route `/`), sign-up through a new API endpoint (chosen).** One build, shares tokens, components, i18n and tests; the app moves to `/app`. Trade-off: marketing and app share a bundle; mitigated by a lazy-loaded landing route.
2. Separate static site. Faster to load and independent deploy, but a second codebase, duplicated tokens and two hosts to keep in sync.
3. Enrich the current sign-in screen. Least work, but marketing and login stay tangled and the page cannot grow.

## 6. Landing (project A) design
Sections, in order: header (logo, language switch, theme, Sign in, Start free); hero (headline, one sentence, "Start free" button, "Have a meeting code?" field, mandala beside a real Davra call screenshot); proof strip (facts we can show: local control, audit chain, SSO, no third-party scripts); capabilities grid (one equal tile per capability, including the program features); how it works in three steps; security and local control section; for-organisations block (SSO, audit, admin console, data location); join-a-meeting block; final call to action; footer (privacy, terms placeholders, contact). Copy in uz, ru, en kept in one dictionary like the app. No statistics we cannot prove (the competitor's "50K+ meetings" pattern is excluded).

Routing (my call): `/` landing, `/app` application (sign-in, home, call), `/admin` stays, `/j/<code>` and the current `?code=` links keep working and redirect into `/app`. Keycloak redirect URIs, the e2e suite and the prod realm generator are updated for `/app`.

## 7. Self-serve trial (project A) design (my calls unless noted)
- Form: organisation name, your name, email, password, ALTCHA. Endpoint `POST /v1/public/signup`, unauthenticated, strictly validated (zod).
- Creates in one transaction: organisation (slug derived from name, unique, reserved words blocked), trial licence (7 days; 10 participants; 30 minutes), Keycloak user with `org_slug`, role `org_admin`, password set, then returns a sign-in redirect. Keycloak failure rolls the organisation back.
- Abuse controls: ALTCHA challenge signed by the server and single-use; per-IP and per-email-domain rate limits kept in the database so they survive more than one API instance; disposable-email domain list; one trial organisation per email; global daily cap on new trial organisations (configurable, default 50).
- Limits enforced server-side: participant cap per room and meeting duration at token issue (token TTL and `maxParticipants`); trial expiry blocks creating and joining meetings with a clear message; data of expired trials is kept 30 days then deleted by a retention job.
- Audit: every sign-up and every refusal is written to the audit log.
- No email is sent (user decision); a lost password cannot be recovered by email in the trial (documented; operator reset only).

## 8. The feature program (projects B-H)
Each project gets its own short design note and tests before code. Waves avoid conflicts on shared files (call screen, `app.module.ts`, migrations).

Wave 1, parallel agents in worktrees (each owns the listed paths; I merge by hand):
- **A** landing, routing, sign-up: `apps/web/src/landing/**`, `apps/web/src/main.tsx`, `apps/api/src/signup/**`, migration 008, Caddy/nginx routes, i18n landing dictionary.
- **D** REST API and webhooks: `apps/api/src/public-api/**`, migration 009 (API keys hashed at rest, scopes, revocation; webhook endpoints, signed deliveries with retry and backoff, idempotency keys), OpenAPI document, admin UI hooks kept minimal.
- **C** recording: `apps/api/src/recording/**`, LiveKit Egress service in `deploy/prod` and dev compose, MinIO storage with envelope encryption, consent banner and host controls in the call UI (small, additive), migration 010; unavailable when the meeting is E2EE.
- **Cal** calendar integration (Outlook and Google): `apps/api/src/calendar/**`, OAuth, event creation with join link, migration 011; needs OAuth client registrations from the user (blocker for real end-to-end tests).

Wave 2 (after wave 1 merges, because they touch the call screen and the encryption paths):
- **B** E2EE as an optional meeting mode (Insertable Streams with SFrame, key exchange design to be decided; interaction with background blur must be resolved or the blur disabled in E2EE meetings).
- **BYOK** customer-held keys (KMS/Vault integration; applies to files and recordings).
- **Mobile**: Android app first (Capacitor or React Native around the web client; decision in its own note), iOS later.
- **Desktop signing**: needs the user's Windows EV certificate; the pipeline is prepared, signing is the user's action.

## 9. Blockers that are not mine to remove
- Windows EV code-signing certificate (and Apple Developer account for iOS).
- Google Play developer account for the Android store release.
- OAuth app registrations at Microsoft and Google for the calendar.
- A production host with open media ports (media currently via LiveKit Cloud, interim).
- Native-language review of the Uzbek, Russian and English copy.

## 10. Verification before the page goes public
Per capability: a real-browser (or real-client) end-to-end check recorded in docs/PROGRESS.md; landing audit (axe, keyboard, 360/768/1280/1920, three languages, dark and light, performance budget, no third-party requests); sign-up abuse tests (rate limit, replayed captcha, disposable email, duplicate email, Keycloak failure rollback); full CI green; a second independent critic pass.

## 11. Left to the builders
Copy wording within the agreed structure, exact component composition on the design system, ALTCHA library version and difficulty, slug rules, table layouts for the new modules, OpenAPI details, Egress layout, OAuth scopes.
