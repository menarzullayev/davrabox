// Proves glyph coverage of the SHIPPED font files: parses the WOFF2 container, decompresses the table stream and
// reads the cmap. The required Uzbek Latin and Cyrillic code points must be present in the right file.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliDecompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const TAGS = ['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill'];

function cmapOf(file: string): Set<number> {
  const b = readFileSync(join(here, '..', 'public', 'fonts', file));
  expect(b.toString('latin1', 0, 4)).toBe('wOF2');
  const n = b.readUInt16BE(12);
  const compressed = b.readUInt32BE(20);
  let p = 48;
  const base128 = () => {
    let v = 0;
    for (let i = 0; i < 5; i++) {
      const c = b[p++]!;
      v = v * 128 + (c & 0x7f);
      if (!(c & 0x80)) break;
    }
    return v;
  };
  const dir: Array<{ tag: string; len: number }> = [];
  for (let i = 0; i < n; i++) {
    const flags = b[p++]!;
    let tag = TAGS[flags & 0x3f] ?? '';
    if ((flags & 0x3f) === 63) {
      tag = b.toString('latin1', p, p + 4);
      p += 4;
    }
    const version = flags >> 6;
    const orig = base128();
    const transformed = tag === 'glyf' || tag === 'loca' ? version !== 3 : tag === 'hmtx' ? version === 1 : false;
    dir.push({ tag, len: transformed ? base128() : orig });
  }
  const data = brotliDecompressSync(b.subarray(p, p + compressed));
  let off = 0;
  let cmap: Buffer | undefined;
  for (const d of dir) {
    if (d.tag === 'cmap') cmap = data.subarray(off, off + d.len);
    off += d.len;
  }
  expect(cmap, 'cmap table').toBeDefined();
  const c = cmap!;
  const cps = new Set<number>();
  const count = c.readUInt16BE(2);
  for (let i = 0; i < count; i++) {
    const sub = c.readUInt32BE(4 + i * 8 + 4);
    const fmt = c.readUInt16BE(sub);
    if (fmt === 4) {
      const segX2 = c.readUInt16BE(sub + 6);
      const ends = sub + 14;
      const starts = ends + segX2 + 2;
      for (let s = 0; s < segX2 / 2; s++) {
        const e = c.readUInt16BE(ends + s * 2);
        for (let cp = c.readUInt16BE(starts + s * 2); cp <= e && cp < 0xffff; cp++) cps.add(cp);
      }
    } else if (fmt === 12) {
      const groups = c.readUInt32BE(sub + 12);
      for (let g = 0; g < groups; g++) {
        const at = sub + 16 + g * 12;
        for (let cp = c.readUInt32BE(at); cp <= c.readUInt32BE(at + 4); cp++) cps.add(cp);
      }
    }
  }
  return cps;
}
const missing = (have: Set<number>, want: number[]) => want.filter((c) => !have.has(c)).map((c) => `U+${c.toString(16).toUpperCase().padStart(4, '0')}`);
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

describe('Onest subsets cover Uzbek Latin and Cyrillic', () => {
  const latin = cmapOf('onest-latin.woff2');
  const cyr = cmapOf('onest-cyrillic.woff2');
  it('latin file: ASCII, o‘ g‘ apostrophes (U+2018 U+2019 U+02BB U+02BC), numerals, punctuation', () => {
    const need = [...range(0x20, 0x7e), 0x2018, 0x2019, 0x2bb, 0x2bc, 0x2013, 0x2014, 0x2026, 0xab, 0xbb, 0x201c, 0x201d, 0x2116, 0x11f, 0x15f, 0x131];
    expect(missing(latin, need)).toEqual([]);
  });
  it('cyrillic file: Russian alphabet and the Uzbek Cyrillic letters', () => {
    const need = [...range(0x410, 0x44f), 0x401, 0x451, 0x40e, 0x45e, 0x49a, 0x49b, 0x492, 0x493, 0x4b2, 0x4b3];
    expect(missing(cyr, need)).toEqual([]);
  });
  it('negative: the check can fail (Cyrillic is not in the latin file, Latin not in the cyrillic file)', () => {
    expect(missing(latin, [0x416]).length).toBe(1);
    expect(missing(cyr, [0x41]).length).toBe(1);
  });
});
