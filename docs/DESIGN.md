# DavraBox design brief (approved decisions, 2026-11-23)

Goal: replace the functional-but-generic UI with a distinctive, professional product identity. Decisions below were taken
with the product owner step by step; agents must follow them and not reopen them. Anything not decided here is the
agent's call, stated in its report.

## 1. Character
"Local trust + modern". Calm, premium, corporate-grade, with restrained Uzbek craft references (suzani/ikat geometry,
the word *davra* = circle). Must feel credible to a bank and welcoming to a training centre. Brand line (from the plan):
"Xavfsiz. Oddiy. Sizning nazoratingizda." (until 2026-11-27: "Mahalliy"; it returns only if hosting moves to Uzbekistan) Not a festival card: ornament is an accent, never decoration everywhere.

## 2. Signature idea: Davra mode (call screen)
- Participants sit on a circle (up to 12), the centre shows the active speaker or the shared screen; when the speaker
  changes, that person glides to the centre (150-400 ms ease), the previous one returns to the ring.
- A raised hand gets an amber glow ring; reactions bloom near the tile; host/co-host badges stay subtle.
- More than 12 participants: automatic switch to the grid (with pagination, a later task); the user can always choose
  Davra / Grid / Speaker manually. Existing gallery and speaker views stay available.
- Layout is computed (not hard-coded sizes), responsive down to 360 px width (on phones the ring becomes a compact ring
  or the speaker view), keyboard operable, announces speaker/hand changes to screen readers (aria-live, polite).
- Performance: CSS transforms/opacity only for motion, no layout thrash, 60 fps with 12 video tiles on a mid laptop,
  `prefers-reduced-motion` removes the gliding (instant swaps) but keeps all information.

## 3. Visual language
- Palette: deep night-indigo base, Samarkand turquoise (firuza) as the main accent, warm amber/gold only for emphasis
  (raised hand, active speaker ring, primary call-to-action highlight). Dark theme is the default, a light theme
  exists; both must pass WCAG 2.1 AA (the repo's `packages/design-tokens` contrast test must stay green and be extended
  to the new tokens). Success/danger/warning colours defined as tokens as well.
- Typography: one modern grotesk with full Latin (including the Uzbek letters o‘ g‘ and the modifier apostrophes) and
  Cyrillic support, self-hosted (no Google Fonts or CDN: the CSP is strict and the privacy rule forbids third parties).
  Candidates: Onest, Manrope, Geologica; the design-system agent verifies glyph coverage and picks one (SIL OFL fonts
  only, licence file committed), WOFF2 subsets, `font-display: swap`, a defined type scale and numeric tabular figures
  for meeting codes and timers.
- Ornament: a geometric "davra" motif (SVG, generated from simple rules so it stays crisp and tiny) used ONLY on the
  sign-in screen, empty states and loading/connecting animation. Working screens stay clean.
- Iconography: one consistent stroke icon set drawn as inline SVG components (no icon font, no CDN).
- Logo: wordmark "DavraBox" plus a compact mark built from the circle motif; delivered as SVG (light/dark), favicon set,
  app icons (Electron uses them), social preview.
- Motion: meaningful and calm, 150-400 ms, easing tokens, never decorative loops; all motion respects reduced motion.
- Voice (UI copy): short, direct, polite, uz (Latin) first, ru and en equal quality; no jargon, no exclamation marks.

## 4. Home screen concept
One large primary area: "Davraga qo'shil" (join by code or link) with instant validation, next to a prominent "Yangi davra"
action. Below, today's meetings as a day timeline (now / later / earlier), each row with time, title, host, lock/passcode
icons and a one-click join. Empty state uses the davra motif. Recent meetings and a calm greeting; the language and theme
switchers and the firewall mode live in a compact settings menu, not in the header clutter.

## 5. Scope and sequence
Wave 1 (now): design system + home + call screen (Davra mode). Wave 2: admin console and remaining screens move onto the
same system (an admin console already exists on a separate branch and will be restyled, not rewritten).
Process: (1) a design-system agent delivers tokens, fonts, logo, icons, base components and a live "styleguide" page;
(2) after the product owner approves screenshots, two agents work in parallel on the home screen and on the Davra call
screen; (3) an independent critic agent audits with Playwright screenshots (dark/light, 360/768/1280/1920 px, uz/ru/en),
axe-style accessibility checks, contrast, keyboard paths, bundle size and runtime performance, and returns a defect
list that is fixed before anything ships.

## 6. Non-negotiables (engineering)
- Keep every existing behaviour and `data-testid` used by `apps/e2e` (the e2e suite must keep passing; new test ids may
  be added). Do not change API contracts.
- Strict CSP stays: no inline scripts, no third-party hosts, fonts and assets self-hosted. Bundle growth justified
  (report the numbers). No heavy UI kits or animation libraries unless the agent shows a clear need and size cost.
- Accessibility: WCAG 2.1 AA, visible focus, 44 px touch targets on touch devices, semantic landmarks, labels, live
  regions for speaker/hand/chat/waiting-room events, forms with clear errors.
- i18n: all strings in the dictionaries (uz, ru, en), no hard-coded text; layouts must survive 40% longer strings.
- Responsive from 360 px to 4K; works in Edge/Chrome/Firefox/Safari and in the Electron shell.
- Evidence rule: screenshots and measurements are part of every report; nothing is called done without them.

## Build-time settings (web)
- `VITE_PUBLIC_URL` (optional): public origin used for absolute URLs that crawlers read from `apps/web/index.html`
  (`og:image`), for example `https://meet.example.com`. Empty (the default) keeps them relative to the host that serves
  the page. It must be a plain http(s) URL without query or fragment, otherwise the build fails. The Docker build takes it
  as `--build-arg VITE_PUBLIC_URL=...`.
