import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export interface FileCounts {
  /** Hex or rgb()/rgba() colours written into a stylesheet or component instead of a token. */
  colours: number;
  /** `@media` width conditions that are not one of the named breakpoints. */
  offBreakpoints: number;
  /** Literal px values in stylesheets (spacing and sizes should come from the scale). */
  literalPx: number;
  /** Raw <button>, <select> and <input> in components (use the ui/ components). */
  rawControls: number;
}

const SKIP_DIR = new Set(['node_modules', 'dist', 'prefs']);
const SKIP_FILE = /(\.test\.|\.generated\.|design-lint\/)/;

export function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (!SKIP_DIR.has(name)) walk(p, out);
    } else if (/\.(css|tsx?)$/.test(name) && !SKIP_FILE.test(p.split(sep).join('/'))) out.push(p);
  }
  return out;
}

export function countFile(path: string, allowedBreakpoints: readonly number[]): FileCounts {
  const src = readFileSync(path, 'utf8');
  const css = path.endsWith('.css');
  const counts: FileCounts = { colours: 0, offBreakpoints: 0, literalPx: 0, rawControls: 0 };
  if (css) {
    const noComments = src.replace(/\/\*[\s\S]*?\*\//g, '');
    counts.colours = (noComments.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(/g) ?? []).length;
    counts.literalPx = (noComments.replace(/@media[^{]*/g, '').match(/\b\d+(?:\.\d+)?px\b/g) ?? []).length;
    for (const m of noComments.matchAll(/@media[^{]*/g)) {
      for (const w of m[0].matchAll(/\((?:min|max)-width:\s*(\d+)px\)/g)) {
        const v = Number(w[1]);
        if (!allowedBreakpoints.includes(v) && !allowedBreakpoints.includes(v + 1)) counts.offBreakpoints++;
      }
    }
  } else {
    counts.colours = (src.match(/['"`]#[0-9a-fA-F]{6}['"`]/g) ?? []).length;
    counts.rawControls = (src.match(/<(?:button|select|input)\b/g) ?? []).length;
  }
  return counts;
}

export function scanAll(srcDir: string, allowedBreakpoints: readonly number[]): Record<string, FileCounts> {
  const out: Record<string, FileCounts> = {};
  for (const f of walk(srcDir)) {
    const c = countFile(f, allowedBreakpoints);
    if (c.colours || c.offBreakpoints || c.literalPx || c.rawControls) out[relative(srcDir, f).split(sep).join('/')] = c;
  }
  return out;
}
