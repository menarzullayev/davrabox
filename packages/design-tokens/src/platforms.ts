// Keeps every place that must repeat a design colour in step with tokens.ts: the web boot screen and theme-color, the Android
// colour resources and plugin, the Electron window and the style guide swatches. `syncPlatforms(root, false)` only reports
// drift (the test uses it, so CI fails when a copy goes stale); `pnpm sync` rewrites the files.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromeColour } from './tokens.js';

const dark = chromeColour('dark');
const light = chromeColour('light');
const argb = (hex: string) => `0xFF${hex.slice(1).toUpperCase()}`;

interface Target {
  file: string;
  /** Returns the file's new content; a regex that no longer matches is reported as an error, never skipped. */
  apply: (current: string) => string;
}

function replaceOnce(src: string, re: RegExp, to: string, what: string): string {
  if (!re.test(src)) throw new Error(`design-token sync: pattern not found (${what})`);
  return src.replace(re, to);
}

export const targets: Target[] = [
  {
    file: 'apps/web/src/prefs/theme-colors.generated.ts',
    apply: () =>
      `// Generated from packages/design-tokens by \`pnpm --filter @davrabox/design-tokens sync\`. Do not edit.\nexport const THEME_COLOR = { dark: '${dark}', light: '${light}' } as const;\n`,
  },
  {
    file: 'apps/web/index.html',
    apply: (s) => {
      let t = replaceOnce(s, /(<meta name="theme-color" content=")#[0-9a-fA-F]{6}(")/, `$1${dark}$2`, 'theme-color meta');
      t = replaceOnce(t, /(html \{ background: )#[0-9a-fA-F]{6}(; \})/, `$1${dark}$2`, 'boot dark background');
      t = replaceOnce(t, /(html\[data-theme='light'\] \{ background: )#[0-9a-fA-F]{6}(; \})/, `$1${light}$2`, 'boot light background');
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
      return t;
    },
  },
  {
    file: 'apps/desktop/src/main.ts',
    apply: (s) => replaceOnce(s, /(backgroundColor: ')#[0-9a-fA-F]{6}(')/, `$1${dark}$2`, 'window backgroundColor'),
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
