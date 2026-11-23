"""Rebuild the self-hosted Onest WOFF2 subsets in apps/web/public/fonts/.

Usage:  python build-fonts.py <path to Onest[wght].ttf from onest-2.001.zip> <output dir>
Needs:  pip install fonttools brotli
Source: https://github.com/simpals/onest/releases/download/2.001/onest-2.001.zip (SIL OFL 1.1, see NOTICE).

The variable font is limited to wght 400-700 (UI never uses other weights), then split by script so a Latin-only
session (uz, en) never downloads the Cyrillic file. unicode-range in fonts.css selects the right file.
"""
import sys
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools import subset

LATIN = (
    list(range(0x20, 0x7F)) + list(range(0xA0, 0x100))
    + [0x131, 0x11E, 0x11F, 0x15E, 0x15F, 0x130, 0x152, 0x153, 0x178]            # Turkish-style Latin extras, oe
    + [0x2BB, 0x2BC, 0x2C6, 0x2DC]                                                # Uzbek modifier apostrophes
    + list(range(0x2000, 0x2070)) + [0x20AC, 0x20B8, 0x20BD, 0x2116, 0x2122]      # punctuation, currency, numero
    + [0x2190, 0x2191, 0x2192, 0x2193, 0x2212, 0x2215, 0x2260, 0x2264, 0x2265]    # arrows and maths used in UI
)
CYRILLIC = (
    list(range(0x400, 0x460)) + [0x490, 0x491, 0x492, 0x493, 0x49A, 0x49B, 0x4B2, 0x4B3, 0x4B6, 0x4B7]
    + [0x2BB, 0x2BC, 0x301]                                                       # apostrophes + stress mark
    + list(range(0x2010, 0x2016)) + [0x2018, 0x2019, 0x201C, 0x201D, 0x2026, 0x2116]
)
FEATURES = ['tnum', 'pnum', 'case', 'ccmp', 'locl', 'calt', 'ss01', 'ss02', 'kern', 'liga']


def build(src: str, unicodes: list, out: str) -> None:
    font = TTFont(src)
    font = instancer.instantiateVariableFont(font, {'wght': (400, 700)})
    opts = subset.Options()
    opts.flavor = 'woff2'
    opts.layout_features = FEATURES
    opts.name_IDs = [0, 1, 2, 3, 4, 5, 6, 13, 14]
    opts.notdef_outline = True
    opts.hinting = False
    opts.desubroutinize = True
    sub = subset.Subsetter(opts)
    sub.populate(unicodes=sorted(set(unicodes)))
    sub.subset(font)
    font.flavor = 'woff2'
    font.save(out)
    print(out)


if __name__ == '__main__':
    src, outdir = sys.argv[1], sys.argv[2]
    build(src, LATIN, outdir + '/onest-latin.woff2')
    build(src, CYRILLIC, outdir + '/onest-cyrillic.woff2')
