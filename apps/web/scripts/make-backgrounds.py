"""Generates the built-in virtual backgrounds (apps/web/public/backgrounds/*.webp and their thumbnails).

Every image is drawn here from code (gradients, shapes, blur): no photos, no third-party artwork, no licence questions.
Run: python apps/web/scripts/make-backgrounds.py  (Pillow with WebP support). The output is committed.
"""
import math
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

W, H = 1280, 720
OUT = Path(__file__).resolve().parent.parent / "public" / "backgrounds"


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def vgrad(top, bottom, w=W, h=H):
    img = Image.new("RGB", (w, h))
    d = ImageDraw.Draw(img)
    for y in range(h):
        d.line([(0, y), (w, y)], fill=lerp(top, bottom, y / (h - 1)))
    return img


def glow(img, cx, cy, r, color, alpha=160, blur=None):
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=color + (alpha,))
    layer = layer.filter(ImageFilter.GaussianBlur(blur if blur is not None else r * 0.6))
    return Image.alpha_composite(img.convert("RGBA"), layer)


def davra():
    img = vgrad((14, 30, 64), (6, 14, 34)).convert("RGBA")
    img = glow(img, 980, 200, 260, (60, 120, 230), 120)
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    for i, r in enumerate(range(120, 900, 70)):
        d.ellipse([980 - r, 260 - r, 980 + r, 260 + r], outline=(140, 180, 255, max(24, 120 - i * 8)), width=3)
    return Image.alpha_composite(img, layer.filter(ImageFilter.GaussianBlur(1.2)))


def aurora():
    img = vgrad((8, 18, 38), (16, 10, 40)).convert("RGBA")
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    for k, (col, off) in enumerate([((40, 220, 170), 0), ((90, 120, 255), 90), ((170, 80, 220), 180)]):
        pts = []
        for x in range(0, W + 20, 20):
            y = 260 + off * 0.6 + 70 * math.sin(x / 210 + k) + 30 * math.sin(x / 80 + k * 2)
            pts.append((x, y))
        for w_, a in [(90, 70), (40, 110)]:
            d.line(pts, fill=col + (a,), width=w_)
    return Image.alpha_composite(img, layer.filter(ImageFilter.GaussianBlur(38)))


def sunset():
    img = vgrad((255, 170, 120), (110, 60, 120)).convert("RGBA")
    img = glow(img, 640, 520, 170, (255, 230, 170), 220, blur=60)
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.rectangle([0, 560, W, H], fill=(70, 40, 90, 235))
    return Image.alpha_composite(img, layer.filter(ImageFilter.GaussianBlur(14)))


def mountains():
    img = vgrad((182, 208, 236), (246, 222, 206)).convert("RGBA")
    img = glow(img, 900, 300, 90, (255, 246, 226), 230, blur=40)
    rnd = random.Random(7)
    for i, col in enumerate([(150, 170, 200), (112, 134, 170), (78, 98, 134), (52, 66, 96)]):
        layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        base = 380 + i * 80
        pts = [(0, H)]
        x = 0
        y = base
        while x <= W:
            pts.append((x, y))
            x += rnd.randint(60, 140)
            y = base + rnd.randint(-90 + i * 10, 40)
        pts += [(W, base), (W, H)]
        d.polygon(pts, fill=col + (255,))
        img = Image.alpha_composite(img, layer.filter(ImageFilter.GaussianBlur(max(0.5, 3 - i * 0.6))))
    return img


def bokeh():
    img = vgrad((18, 16, 30), (8, 8, 14)).convert("RGBA")
    rnd = random.Random(11)
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    palette = [(255, 190, 90), (255, 140, 80), (120, 170, 255), (255, 230, 170), (200, 120, 255)]
    for _ in range(70):
        r = rnd.randint(14, 70)
        x, y = rnd.randint(0, W), rnd.randint(80, H - 40)
        c = rnd.choice(palette)
        d.ellipse([x - r, y - r, x + r, y + r], fill=c + (rnd.randint(40, 120),))
    return Image.alpha_composite(img, layer.filter(ImageFilter.GaussianBlur(9)))


def studio():
    img = vgrad((168, 172, 178), (92, 96, 104)).convert("RGBA")
    img = glow(img, 640, 120, 420, (230, 232, 236), 150, blur=200)
    vig = Image.new("L", img.size, 0)
    d = ImageDraw.Draw(vig)
    d.ellipse([-200, -250, W + 200, H + 250], fill=255)
    vig = vig.filter(ImageFilter.GaussianBlur(160))
    dark = Image.new("RGBA", img.size, (30, 32, 38, 255))
    return Image.composite(img, dark, vig)


def office():
    img = vgrad((232, 220, 202), (196, 180, 160)).convert("RGBA")
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    # Window light falling on the wall: slanted bright slats.
    for i in range(7):
        x = 160 + i * 64
        d.polygon([(x, 60), (x + 34, 60), (x + 230, 560), (x + 196, 560)], fill=(255, 248, 230, 70))
    # A shelf with a few objects.
    d.rectangle([800, 430, 1180, 446], fill=(120, 92, 70, 255))
    d.rectangle([830, 330, 870, 430], fill=(70, 110, 120, 255))
    d.rectangle([880, 360, 905, 430], fill=(190, 120, 90, 255))
    d.ellipse([1040, 300, 1150, 430], fill=(84, 130, 92, 255))
    d.rectangle([1080, 400, 1110, 430], fill=(150, 110, 80, 255))
    return Image.alpha_composite(img, layer.filter(ImageFilter.GaussianBlur(6)))


def green():
    img = vgrad((120, 170, 130), (40, 84, 64)).convert("RGBA")
    rnd = random.Random(5)
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    for _ in range(46):
        cx, cy = rnd.randint(-40, W + 40), rnd.randint(-40, H + 40)
        rx, ry = rnd.randint(30, 90), rnd.randint(12, 34)
        ang = rnd.random() * math.pi
        pts = []
        for i in range(16):
            t = i / 16 * 2 * math.pi
            pts.append((cx + rx * math.cos(t) * math.cos(ang) - ry * math.sin(t) * math.sin(ang),
                        cy + rx * math.cos(t) * math.sin(ang) + ry * math.sin(t) * math.cos(ang)))
        shade = rnd.randint(-30, 30)
        d.polygon(pts, fill=(60 + shade, 120 + shade, 70 + shade, rnd.randint(70, 150)))
    return Image.alpha_composite(img, layer.filter(ImageFilter.GaussianBlur(10)))


def girih():
    """Eight-point star lattice in the spirit of Central Asian tilework, kept soft so it never competes with the face."""
    img = vgrad((16, 52, 96), (10, 30, 62)).convert("RGBA")
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    s = 120
    for gy in range(-1, H // s + 2):
        for gx in range(-1, W // s + 2):
            cx, cy = gx * s + (s // 2 if gy % 2 else 0), gy * s
            pts = []
            for k in range(16):
                r = 46 if k % 2 == 0 else 20
                a = k * math.pi / 8
                pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
            d.polygon(pts, outline=(120, 190, 230, 150), width=3)
            d.ellipse([cx - 6, cy - 6, cx + 6, cy + 6], fill=(230, 196, 110, 90))
    img = Image.alpha_composite(img, layer.filter(ImageFilter.GaussianBlur(1.5)))
    return glow(img, 300, 360, 380, (8, 20, 40), 140, blur=180)


ITEMS = [("davra", davra), ("aurora", aurora), ("mountains", mountains), ("office", office), ("studio", studio),
         ("sunset", sunset), ("bokeh", bokeh), ("green", green), ("girih", girih)]

if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for name, fn in ITEMS:
        im = fn().convert("RGB")
        im.save(OUT / f"{name}.webp", "WEBP", quality=80, method=6)
        im.resize((192, 108), Image.LANCZOS).save(OUT / f"{name}.thumb.webp", "WEBP", quality=78, method=6)
        print(name, (OUT / f"{name}.webp").stat().st_size)
