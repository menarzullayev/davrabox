// A ratchet, not a wall: the places that still use a literal colour, an off-list breakpoint, a literal px or a raw control are
// recorded in baseline.json. A file may only get better. New code uses tokens, named breakpoints and the ui/ components.
// After a clean-up run `pnpm --filter @davrabox/web design-lint:update` to lock the improvement in.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { breakpoints } from '@davrabox/design-tokens';
import { countFile, scanAll, type FileCounts } from './scan';

const here = dirname(fileURLToPath(import.meta.url));
const allowed = Object.values(breakpoints);
const now = scanAll(join(here, '..'), allowed);
if (process.env['UPDATE_DESIGN_LINT']) writeFileSync(join(here, 'baseline.json'), JSON.stringify(now, null, 1) + '\n');
const baseline = JSON.parse(readFileSync(join(here, 'baseline.json'), 'utf8')) as Record<string, FileCounts>;
const KINDS: Array<keyof FileCounts> = ['colours', 'offBreakpoints', 'literalPx', 'rawControls'];

describe('design lint (ratchet)', () => {
  for (const kind of KINDS) {
    it(`no file adds ${kind} beyond its recorded baseline`, () => {
      const worse = Object.entries(now)
        .filter(([f, c]) => c[kind] > (baseline[f]?.[kind] ?? 0))
        .map(([f, c]) => `${f}: ${c[kind]} (allowed ${baseline[f]?.[kind] ?? 0})`);
      expect(worse, `Use design tokens, named breakpoints and ui components instead (${kind})`).toEqual([]);
    });
  }

  it('the scanner counts what it claims to', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dlint-'));
    try {
      const css = join(dir, 'a.css');
      writeFileSync(css, '/* #fff */ .a { color: #fff; background: rgba(0,0,0,.5); margin: 12px; }\n@media (min-width: 960px) { .a { padding: 8px; } }\n@media (max-width: 479px) { .a { top: 1px; } }\n@media (min-width: 777px) { .a { top: 2px; } }\n');
      expect(countFile(css, allowed)).toEqual({ colours: 2, offBreakpoints: 1, literalPx: 4, rawControls: 0 });
      const tsx = join(dir, 'b.tsx');
      writeFileSync(tsx, "const c = '#aabbcc'; export const x = <><button>a</button><select/><input/><Button/></>;");
      expect(countFile(tsx, allowed)).toEqual({ colours: 1, offBreakpoints: 0, literalPx: 0, rawControls: 3 });
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
