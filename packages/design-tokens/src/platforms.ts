// Keeps every place that must repeat a design colour in step with tokens.ts: the web boot screen and theme-color, the Android
// colour resources and plugin, the Electron window and the style guide swatches. `syncPlatforms(root, false)` only reports
// drift (the test uses it, so CI fails when a copy goes stale); `pnpm sync` rewrites the files.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromeColour, chromeOverrides, resolveColours, styles, themes, type StyleId, type ThemeName } from './tokens.js';

const dark = chromeColour('dark');
const light = chromeColour('light');
const argb = (hex: string) => `0xFF${hex.slice(1).toUpperCase()}`;
/** Styles with their own chrome colour: `{ 'liquid-glass': { dark: '#..', light: '#..' } }` as a TypeScript literal. */
const overrideLiteral = () => `{ ${chromeOverrides().map((o) => `'${o.style}': { dark: '${o.dark}', light: '${o.light}' }`).join(', ')} }`;

interface Target {
  file: string;
  /** Returns the file's new content; a regex that no longer matches is reported as an error, never skipped. */
  apply: (current: string) => string;
}

function replaceOnce(src: string, re: RegExp, to: string, what: string): string {
  if (!re.test(src)) throw new Error(`design-token sync: pattern not found (${what})`);
  return src.replace(re, to);
}


/** The sign-in page (Keycloak, PatternFly 5) dressed in the app's colours for both modes; its script picks the mode from the app's choice. */
function keycloakCss(): string {
  const block = (mode: ThemeName, selector: string) => {
    const c = themes[mode];
    return `${selector} {
  --pf-v5-global--primary-color--100: ${c.accent};
  --pf-v5-global--primary-color--200: ${c.accentHover};
  --pf-v5-global--link--Color: ${mode === 'dark' ? c.accent : c.accentActive};
  --pf-v5-global--link--Color--hover: ${c.accentHover};
  --pf-v5-global--BackgroundColor--100: ${c.surface1};
  --pf-v5-global--BackgroundColor--200: ${c.bg};
  --pf-v5-global--Color--100: ${c.text};
  --pf-v5-global--Color--200: ${c.textMuted};
  --pf-v5-global--BorderColor--100: ${c.borderStrong};
  --pf-v5-global--danger-color--100: ${c.danger};
}
${selector} body, ${selector} .pf-v5-c-login { background: ${c.bg}; color: ${c.text}; }
${selector} .pf-v5-c-login__main { background: ${c.surface1}; color: ${c.text}; border: 1px solid ${c.border}; border-radius: 14px; }
${selector} .pf-v5-c-login__main-header h1, ${selector} .pf-v5-c-title, ${selector} .pf-v5-c-form__label-text { color: ${c.text}; }
${selector} .pf-v5-c-form-control { background: ${c.surface3}; color: ${c.text}; border: 1px solid ${c.borderStrong}; border-radius: 10px; }
${selector} .pf-v5-c-button.pf-m-primary { background: ${c.accent}; color: ${c.textOnAccent}; border-radius: 10px; }
${selector} .pf-v5-c-button.pf-m-primary:hover { background: ${c.accentHover}; }
${selector} #kc-header-wrapper, ${selector} #kc-header, ${selector} .kc-logo-text { color: ${c.text} !important; }
${selector} select, ${selector} .pf-v5-c-button.pf-m-control { background-color: ${c.surface3}; color: ${c.text}; border: 1px solid ${c.borderStrong}; }
${selector} a { color: ${mode === 'dark' ? c.accent : c.accentActive}; }
${selector} :focus-visible { outline: 2px solid ${c.focusRing}; outline-offset: 2px; }
${selector} #kc-header-wrapper { font-size: 0; height: 36px; background: url(${mode === 'dark' ? '/brand/logo.svg' : '/brand/logo-light.svg'}) center / contain no-repeat; }
${selector} .dx-kc-langs a { border: 1px solid ${c.borderStrong}; color: ${c.text}; }
${selector} .dx-kc-langs a[aria-current='true'] { background: ${c.accentSoft}; border-color: ${c.accent}; }
${selector} .pf-v5-c-form-control:focus-within { border-color: ${c.focusRing}; outline: 2px solid ${c.focusRing}; outline-offset: 2px; }
${selector} .pf-v5-c-form-control input:focus-visible { outline: none; }
${selector} .pf-v5-c-input-group .pf-v5-c-form-control { border-radius: 10px 0 0 10px; border-inline-end-width: 0; }
${selector} .pf-v5-c-input-group .pf-v5-c-button.pf-m-control { border-radius: 0 10px 10px 0; }
${selector} .pf-v5-c-input-group:focus-within { border-radius: 10px; outline: 2px solid ${c.focusRing}; outline-offset: 2px; }
${selector} .pf-v5-c-input-group .pf-v5-c-form-control:focus-within { outline: none; }
${selector} .pf-v5-c-input-group .pf-v5-c-button.pf-m-control:focus-visible { outline-offset: -4px; }
`;
  };
  const shared = `/* Layout shared by both modes: card margins, one border per field, the eye button joined to its field, tighter action spacing, language pills. */
.pf-v5-c-login__container { max-width: 30rem; margin-inline: auto; padding-inline: 1rem; }
.pf-v5-c-login__main { width: 100%; }
.pf-v5-c-form-control::before, .pf-v5-c-form-control::after { display: none; }
.pf-v5-c-form-control { min-height: 2.75rem; }
.pf-v5-c-form-control input { background: transparent; border: 0; box-shadow: none; outline: none; height: 100%; min-height: inherit; }
.pf-v5-c-button.pf-m-control::before, .pf-v5-c-button.pf-m-control::after { display: none; }
.pf-v5-c-input-group { gap: 0; }
.pf-v5-c-button.pf-m-primary { min-height: 2.75rem; }
.pf-v5-c-check { align-items: center; min-height: 2.75rem; }
.pf-v5-c-check__input { width: 1.25rem; height: 1.25rem; }
.pf-v5-c-input-group .pf-v5-c-form-control { border-start-end-radius: 0; border-end-end-radius: 0; }
.pf-v5-c-input-group .pf-v5-c-button.pf-m-control { min-width: 2.75rem; min-height: 2.75rem; border-start-start-radius: 0; border-end-start-radius: 0; border-inline-start: 0; border-radius: 0 10px 10px 0; }
.pf-v5-c-form__group.pf-m-action { margin-block-start: 0.5rem; }
.pf-v5-c-login__main-header-utilities .pf-v5-c-form-control { display: none; }
.dx-kc-langs { display: flex; gap: 0.5rem; flex-wrap: nowrap; }
.pf-v5-c-login__main-header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.75rem 1rem; }
.dx-kc-langs a { display: inline-flex; align-items: center; justify-content: center; min-width: 2.75rem; min-height: 2.75rem; padding-inline: 0.875rem; border-radius: 999px; font-weight: 600; text-decoration: none; }
`;
  return `/* Generated from packages/design-tokens (pnpm sync). Do not edit. */
${shared}${block('light', ':root')}${block('dark', ':root.pf-v5-theme-dark')}${keycloakGlassCss()}`;
}

/**
 * The glass look of the sign-in page for styles that have glass (liquid-glass). davrabox.js copies the app's style choice
 * into data-style; glass.js adds the refraction (--dx-refract) where the browser supports it, otherwise the frosted glass
 * below is what shows. Reduced transparency gets the opaque card back; reduced motion, no spring.
 */
function keycloakGlassCss(): string {
  const out: string[] = [];
  for (const id of Object.keys(styles) as StyleId[]) {
    const def = styles[id];
    if (!def.glass) continue;
    const v = def.vars ?? {};
    const r = (k: string, d: string) => v[k] ?? d;
    const frost = `blur(${r('glassBlur', '14px')}) saturate(${r('glassSat', '1.8')})`;
    for (const mode of ['light', 'dark'] as const) {
      const g = def.glass[mode];
      if (!g) continue;
      const c = resolveColours(id, mode);
      const mv = def.modeVars?.[mode] ?? {};
      const n = parseInt(g.tint.slice(1), 16);
      const tint = (a: number) => `rgb(${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255} / ${a})`;
      const rim = mv['glassRim'] ?? 'none';
      const sel = mode === 'dark' ? `:root.pf-v5-theme-dark[data-style='${id}']` : `:root[data-style='${id}']:not(.pf-v5-theme-dark)`;
      out.push(`${sel} body, ${sel} .pf-v5-c-login { background: ${mv['bgImage'] ? `${mv['bgImage']}, ` : ''}${c.bg}; background-attachment: fixed; }
${sel} body { font-family: ${r('fontSans', 'inherit')}; }
${sel} .pf-v5-c-login__main { background: ${tint(g.regular)}; border: 0; border-radius: ${r('radiusXl', '28px')}; box-shadow: ${rim}, ${mv['glassShadow'] ?? 'none'}; -webkit-backdrop-filter: ${frost}; backdrop-filter: var(--dx-refract, ${frost}); }
${sel} .pf-v5-c-login__main-header h1, ${sel} .pf-v5-c-title { font-family: ${r('fontHeading', 'inherit')}; font-weight: 700; letter-spacing: -0.02em; }
${sel} .pf-v5-c-form-control { border-radius: ${r('radiusMd', '14px')}; }
${sel} .pf-v5-c-input-group .pf-v5-c-form-control { border-radius: ${r('radiusMd', '14px')} 0 0 ${r('radiusMd', '14px')}; }
${sel} .pf-v5-c-input-group .pf-v5-c-button.pf-m-control { border-radius: 0 ${r('radiusMd', '14px')} ${r('radiusMd', '14px')} 0; }
${sel} .pf-v5-c-input-group:focus-within { border-radius: ${r('radiusMd', '14px')}; }
${sel} .pf-v5-c-button.pf-m-primary { border-radius: 999px; min-height: 3rem; font-weight: 600; box-shadow: ${rim}; transition: transform ${r('durSpring', '400ms')} ${r('easeSpring', 'ease-out')}; }
${sel} .pf-v5-c-button.pf-m-primary:active { transform: scale(0.97); }
${sel} .dx-kc-langs a { background: ${tint(g.clear)}; box-shadow: ${rim}; }
`);
    }
    out.push(`@media (prefers-reduced-transparency: reduce) { :root[data-style='${id}'] .pf-v5-c-login__main { -webkit-backdrop-filter: none; backdrop-filter: none; background: var(--pf-v5-global--BackgroundColor--100); } }
@media (prefers-reduced-motion: reduce) { :root[data-style='${id}'] .pf-v5-c-button.pf-m-primary { transition: none; } }
`);
  }
  return out.join('');
}

export const targets: Target[] = [
  {
    file: 'apps/web/src/prefs/theme-colors.generated.ts',
    apply: () =>
      `// Generated from packages/design-tokens by \`pnpm --filter @davrabox/design-tokens sync\`. Do not edit.\nexport const THEME_COLOR = { dark: '${dark}', light: '${light}' } as const;\n/** Styles whose page background (and so the browser and system bar colour) differs from the base. */\nexport const STYLE_THEME_COLOR: Readonly<Record<string, { dark: string; light: string }>> = ${overrideLiteral()};\n`,
  },
  {
    file: 'apps/web/index.html',
    apply: (s) => {
      let t = replaceOnce(s, /(<meta name="theme-color" content=")#[0-9a-fA-F]{6}(")/, `$1${dark}$2`, 'theme-color meta');
      t = replaceOnce(t, /(html \{ background: )#[0-9a-fA-F]{6}(; \})/, `$1${dark}$2`, 'boot dark background');
      t = replaceOnce(t, /(html\[data-theme='light'\] \{ background: )#[0-9a-fA-F]{6}(; \})/, `$1${light}$2`, 'boot light background');
      const boot = chromeOverrides()
        .map((o) => `      html[data-style='${o.style}'] { background: ${o.dark}; }\n      html[data-style='${o.style}'][data-theme='light'] { background: ${o.light}; }\n`)
        .join('');
      t = replaceOnce(t, /( *\/\* <style-boot> \*\/\n)[\s\S]*?( *\/\* <\/style-boot> \*\/)/, `$1${boot}$2`, 'boot style backgrounds');
      return t;
    },
  },
  {
    file: 'apps/mobile/android/app/src/main/res/values/colors_davra.xml',
    apply: () =>
      `<?xml version="1.0" encoding="utf-8"?>\n<!-- Generated from packages/design-tokens (pnpm sync). Do not edit. -->\n<resources>\n    <color name="davra_bg">${dark.toUpperCase()}</color>\n    <color name="davra_bg_light">${light.toUpperCase()}</color>\n</resources>\n`,
  },
  {
    file: 'apps/mobile/android/app/src/main/res/values/ic_launcher_background.xml',
    apply: (s) => replaceOnce(s, /(<color name="ic_launcher_background">)#[0-9a-fA-F]{6}(<\/color>)/, `$1${dark.toUpperCase()}$2`, 'launcher background'),
  },
  {
    file: 'apps/mobile/android/app/src/main/java/uz/davrabox/app/ThemeBarsPlugin.java',
    apply: (s) => {
      let t = replaceOnce(s, /(DARK_BG = )0x[0-9A-Fa-f]{8}(;)/, `$1${argb(dark)}$2`, 'DARK_BG');
      t = replaceOnce(t, /(LIGHT_BG = )0x[0-9A-Fa-f]{8}(;)/, `$1${argb(light)}$2`, 'LIGHT_BG');
      const rows = chromeOverrides()
        .map((o) => `        if ("${o.style}".equals(style)) return new int[] { ${argb(o.dark)}, ${argb(o.light)} };\n`)
        .join('');
      t = replaceOnce(t, /( *\/\/ <generated-style-chrome>[^\n]*\n[^\n]*\n)[\s\S]*?( *return null;\n)/, `$1${rows}$2`, 'style chrome table');
      return t;
    },
  },
  {
    file: 'deploy/helm/davrabox/files/keycloak-theme/login/resources/css/davrabox.css',
    apply: () => keycloakCss(),
  },
  {
    file: 'apps/desktop/src/window.ts',
    apply: (s) => {
      let t = replaceOnce(s, /(WINDOW_BG = \{ dark: ')#[0-9a-fA-F]{6}(')/, `$1${dark}$2`, 'desktop dark window');
      t = replaceOnce(t, /(WINDOW_BG = \{ dark: '#[0-9a-fA-F]{6}', light: ')#[0-9a-fA-F]{6}(')/, `$1${light}$2`, 'desktop light window');
      t = replaceOnce(t, /(export const STYLE_WINDOW_BG: [^=]+= ).*?(;\n)/, `$1${overrideLiteral()}$2`, 'desktop style windows');
      return t;
    },
  },
  {
    file: 'apps/web/src/styleguide/styleguide.css',
    apply: (s) => {
      let t = replaceOnce(s, /(\.sg-tile--dark \{ background: )#[0-9a-fA-F]{6}/, `$1${dark}`, 'sg dark tile');
      t = replaceOnce(t, /(\.sg-tile--light \{ background: )#[0-9a-fA-F]{6}/, `$1${light}`, 'sg light tile');
      return t;
    },
  },
];

/** Files whose content differs from what the tokens say. With `write` true they are rewritten (line endings kept). */
export function syncPlatforms(root: string, write: boolean): string[] {
  const drift: string[] = [];
  for (const { file, apply } of targets) {
    const path = join(root, file);
    let raw = '';
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      /* a generated file that does not exist yet is created below */
    }
    const crlf = raw.includes('\r\n');
    const current = raw.replace(/\r\n/g, '\n');
    const next = apply(current);
    if (next !== current) {
      drift.push(file);
      if (write) writeFileSync(path, crlf ? next.replace(/\n/g, '\r\n') : next);
    }
  }
  return drift;
}
