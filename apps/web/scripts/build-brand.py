"""Generate the DavraBox brand SVGs (mark, wordmark, lockup, favicon, app icon) and src/brand/wordmarkPaths.ts.

Usage:  python build-brand.py <Onest[wght].ttf> <public/brand dir> <wordmarkPaths.ts path>
Needs:  pip install fonttools uharfbuzz
The mark is hand-authored geometry (below). The wordmark is Onest 700 ("Davra") + 500 ("Box") converted to outlines
(HarfBuzz shaping incl. kerning) so it renders identically where webfonts are unavailable (img tags, favicons, Electron).
Rasterising to PNG/ICO is done by build-brand.mjs (Playwright).
"""
import io
import math
import sys

import uharfbuzz as hb
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

INK_DARK = '#eef0fc'   # text colour for use on dark backgrounds
INK_LIGHT = '#12163a'  # text colour for use on light backgrounds
TURQ_DARK, TURQ_LIGHT = '#3dd6c8', '#087069'
GOLD_DARK, GOLD_LIGHT = '#f4c24f', '#e5a000'
NIGHT = '#0a0d21'


def n(v: float) -> str:
    s = ('%.2f' % v).rstrip('0').rstrip('.')
    return '0' if s in ('-0', '') else s


# ---- mark -------------------------------------------------------------------------------------------------------
def mark_inner(ring: str, box: str, dot: str, uid: str, r: float = 24, sw: float = 6, bx: float = 14, dot_r: float = 6.5,
               cut_r: float = 10, angle: float = -40) -> str:
    """Ring (the davra), a rounded square in the middle (the box) and one amber dot on the ring (a participant). The box is a square turned 45 degrees (a rhomb, as in ikat borders)."""
    a = math.radians(angle)
    dx, dy = 32 + r * math.cos(a), 32 + r * math.sin(a)
    half = bx / 2
    return (
        f'<defs><mask id="{uid}"><rect width="64" height="64" fill="#fff"/>'
        f'<circle cx="{n(dx)}" cy="{n(dy)}" r="{n(cut_r)}" fill="#000"/></mask></defs>'
        f'<circle cx="32" cy="32" r="{n(r)}" fill="none" stroke="{ring}" stroke-width="{n(sw)}" mask="url(#{uid})"/>'
        f'<rect x="{n(32 - half)}" y="{n(32 - half)}" width="{n(bx)}" height="{n(bx)}" rx="{n(bx * 0.24)}" fill="{box}" transform="rotate(45 32 32)"/>'
        f'<circle cx="{n(dx)}" cy="{n(dy)}" r="{n(dot_r)}" fill="{dot}"/>'
    )


def svg(w: float, h: float, body: str, label: str = 'DavraBox', view: str | None = None) -> str:
    vb = view or f'0 0 {n(w)} {n(h)}'
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}" width="{n(w)}" height="{n(h)}" role="img" '
        f'aria-label="{label}"><title>{label}</title>{body}</svg>\n'
    )


# ---- wordmark ---------------------------------------------------------------------------------------------------
class Face:
    def __init__(self, path: str, wght: int):
        font = instancer.instantiateVariableFont(TTFont(path), {'wght': wght})
        buf = io.BytesIO()
        font.save(buf)
        self.font = font
        self.glyphs = font.getGlyphSet()
        self.order = font.getGlyphOrder()
        self.upem = font['head'].unitsPerEm
        self.hbfont = hb.Font(hb.Face(buf.getvalue()))

    def text(self, s: str, size: float, x: float, y: float, tracking: float = 0.0):
        """Returns (svg path data, advance width) for a line of text with baseline at (x, y)."""
        buf = hb.Buffer()
        buf.add_str(s)
        buf.guess_segment_properties()
        hb.shape(self.hbfont, buf, {'kern': True, 'liga': False})
        scale = size / self.upem
        pen = SVGPathPen(self.glyphs, ntos=n)
        cx = 0.0
        for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
            name = self.order[info.codepoint]
            tp = TransformPen(pen, (scale, 0, 0, -scale, x + (cx + pos.x_offset) * scale, y - pos.y_offset * scale))
            self.glyphs[name].draw(tp)
            cx += pos.x_advance + tracking * self.upem
        return pen.getCommands(), cx * scale


def main(src: str, out: str, ts_out: str) -> None:
    bold, medium = Face(src, 700), Face(src, 500)
    size, base = 40.0, 34.0
    d1, a1 = bold.text('Davra', size, 1, base, tracking=-0.01)
    d2, a2 = medium.text('Box', size, 1 + a1 + 1, base, tracking=-0.005)
    ww, wh = round(1 + a1 + 1 + a2 + 1, 2), 46

    def wordmark(ink: str) -> str:
        return svg(ww, wh, f'<path fill="{ink}" d="{d1}"/><path fill="{ink}" d="{d2}"/>', 'DavraBox')

    def lockup(ring: str, box: str, dot: str, ink: str, uid: str) -> str:
        mark = f'<g transform="scale(0.875)">{mark_inner(ring, box, dot, uid)}</g>'
        # Cap height of Onest is ~0.7 em: centre it on the mark's centre line (y = 28).
        ty = 28 + 0.35 * size - base
        word = f'<g transform="translate(66 {n(ty)})"><path fill="{ink}" d="{d1}"/><path fill="{ink}" d="{d2}"/></g>'
        return svg(66 + ww, 56, mark + word, 'DavraBox')

    files = {
        'mark.svg': svg(64, 64, mark_inner(TURQ_DARK, INK_DARK, GOLD_DARK, 'a')),
        'mark-light.svg': svg(64, 64, mark_inner(TURQ_LIGHT, INK_LIGHT, GOLD_LIGHT, 'a')),
        'wordmark.svg': wordmark(INK_DARK),
        'wordmark-light.svg': wordmark(INK_LIGHT),
        'logo.svg': lockup(TURQ_DARK, INK_DARK, GOLD_DARK, INK_DARK, 'a'),
        'logo-light.svg': lockup(TURQ_LIGHT, INK_LIGHT, GOLD_LIGHT, INK_LIGHT, 'a'),
    }
    # Favicon: tile + a heavier mark so it holds at 16 px. Same file serves every browser theme.
    fav_mark = mark_inner(TURQ_DARK, INK_DARK, GOLD_DARK, 'f', r=21, sw=8, bx=14, dot_r=7, cut_r=11)
    files['favicon.svg'] = svg(64, 64, f'<rect width="64" height="64" rx="14" fill="{NIGHT}"/>{fav_mark}')
    # App icon: rounded tile with a soft radial glow; maskable variant is full-bleed with the mark in the safe zone.
    glow = ('<defs><radialGradient id="g" cx="50%" cy="38%" r="75%"><stop offset="0" stop-color="#1b2150"/>'
            f'<stop offset="1" stop-color="{NIGHT}"/></radialGradient></defs>')
    icon_mark = mark_inner(TURQ_DARK, INK_DARK, GOLD_DARK, 'i', r=22, sw=7, bx=14, dot_r=6.8, cut_r=10.5)
    files['app-icon.svg'] = svg(
        64, 64, f'{glow}<rect width="64" height="64" rx="14" fill="url(#g)"/><g transform="translate(6.4 6.4) scale(0.8)">{icon_mark}</g>')
    files['app-icon-maskable.svg'] = svg(
        64, 64, f'{glow}<rect width="64" height="64" fill="url(#g)"/><g transform="translate(12.8 12.8) scale(0.6)">{icon_mark}</g>')
    for name, body in files.items():
        with open(f'{out}/{name}', 'w', encoding='utf-8', newline='\n') as f:
            f.write(body)
        print(name, len(body.encode()), 'bytes')

    ts = (
        '// Generated by apps/web/scripts/build-brand.py from Onest 2.001 (SIL OFL 1.1). Do not edit.\n'
        '// Outlines of "Davra" (700) and "Box" (500), baseline y=34 in a 0 0 W 46 box.\n'
        f'export const WORDMARK = {{ width: {n(ww)}, height: {wh}, davra: "{d1}", box: "{d2}" }} as const;\n'
    )
    with open(ts_out, 'w', encoding='utf-8', newline='\n') as f:
        f.write(ts)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2], sys.argv[3])
