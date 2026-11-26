# Liquid Glass style

The 13th style (`liquid-glass`), selectable like the others and allowed/defaulted by org admins the same way. Owner
decisions: `davrabox-builds/decisions/2026-11-26-liquid-glass-and-features.md` (1-5, 12). It is not the default style; the
switch is a separate change once the gate in decision 12 is met.

## Where it lives

| Part | Place |
|---|---|
| Tokens (glass materials, springs, radii, own chrome colour) | `packages/design-tokens/src/style-defs.ts` (`'liquid-glass'`), `tokens.ts` (`GlassMaterial`, `glassFailures`, `chromeColour`) |
| Platform copies (`pnpm --filter @davrabox/design-tokens sync`) | web `theme-colors.generated.ts` + boot colours in `index.html`, Android `ThemeBarsPlugin` table, desktop `STYLE_WINDOW_BG`, Keycloak `davrabox.css` glass block |
| Runtime (refraction + degradation) | `apps/web/src/glass/runtime.ts`, `governor.ts`, `map.ts`, `capability.ts` |
| Material, shapes, motion | `apps/web/src/glass/liquid-glass.css` |
| iOS layouts (owner-approved per screen) | `apps/web/src/glass/lg-{call,prejoin,home,landing,signin,admin}.css` |
| Keycloak refraction | `deploy/helm/davrabox/files/keycloak-theme/login/resources/js/glass.js` |
| Android battery saver | `apps/mobile/android/.../PowerSavePlugin.java` |

Every rule is scoped to `:root[data-style='liquid-glass']`; markup and `data-testid`s are shared by all styles. The one
extra element is the home phone tab bar (`.hm-tabbar`, ids `tab-*`), hidden in every other style.

## Refraction

Each floating glass surface (the selectors in `REFRACT_SELECTORS`) gets its own SVG filter: a displacement map generated for
its size and corner radius (`feImage` + `feDisplacementMap`), referenced from `backdrop-filter` through `--lg-refract`.
Chromium engines only (Chrome, Edge, Android WebView, Electron); Safari, Firefox and all iOS browsers get the same look as
CSS glass (blur + vibrancy), `html[data-glass="css"]`.

Content (cards, rows) uses the regular glass tint without a backdrop filter: cheap while scrolling, and Apple's own split
between the navigation layer and content. Tile name labels on video are tinted capsules for the same reason.

## Automatic degradation

`html[data-glass]` is `refract` or `css`, `data-glass-reason` says why:

| Reason | Trigger | Back to refraction |
|---|---|---|
| `unsupported` | not a Chromium engine | never |
| `reduced-transparency` | `prefers-reduced-transparency`, `prefers-contrast: more`, forced colours (also solid surfaces) | when the setting is lifted |
| `battery-saver` | Android battery saver (PowerSave plugin), or Battery API: discharging and <= 20 % | when it ends / charging |
| `low-fps` | during a call, 3 one-second samples in a row below 40 fps | retried after 20 s, doubling up to 5 min while it keeps failing; 10 good seconds reset the back-off |

`prefers-reduced-motion` turns off the springs and morphs (and ui.css shortens every animation).

Status for measurements: `window.__davraGlass.status()` -> `{ mode, reason, fps, fallbacks, surfaces, ... }`.
Force a mode for an A/B measurement: `localStorage['davra.glass'] = 'refract' | 'css'` (remove it for automatic).

## Legibility

Text on glass must stay AA over anything behind it (live video, a white shared screen). `tokens.test.ts` composites the glass
tint over pure black and pure white and checks: clear glass (bars) primary text 4.5:1 and focus/accent 3:1; regular glass
(panels) every text level 4.5:1 and every control colour 3:1.

## Tests

- Unit: `packages/design-tokens` (glass legibility, chrome), `apps/web/src/glass/*.test.ts`, home tab bar in `home.test.tsx`.
- e2e in both styles: `bash apps/e2e/run-suite.sh` and `E2E_STYLE=liquid-glass bash apps/e2e/run-suite.sh`
  (`style-hook.mjs` starts every browser context with the style saved).
- `apps/e2e/glass.e2e.mjs`: refraction in a real call and each degradation path.
