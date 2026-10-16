"""Draw the app icons into icons/ (dev-time only; needs Pillow).

    python3 tools/make_icons.py

A gold bathroom scale, its dial in a window at the top, on the app's dark gradient: learnthai's look
(one bold gold shape; its gradient, sampled from its icon). Full-bleed squares, as iOS rounds the
corners itself, with the scale inside the middle 80% so it survives a maskable icon's crop. Drawn
at 4x in a 512 grid and scaled down for smooth edges.
"""
import math
from pathlib import Path

from PIL import Image, ImageDraw

GOLD = (247, 183, 51)                       # --accent
TOP, BOTTOM = (36, 43, 61), (15, 17, 21)    # the gradient: learnthai's, ending at --bg
OUT = Path(__file__).resolve().parent.parent / 'icons'
SIZES = {'icon-512.png': 512, 'icon-192.png': 192, 'apple-touch-icon.png': 180, 'favicon-32.png': 32}
SS = 4
N = 512 * SS


def u(v):  # 512 grid → drawing pixels
    return v * SS


def gradient():
    col = Image.new('RGB', (1, N))
    for y in range(N):
        t = y / (N - 1)
        col.putpixel((0, y), tuple(round(a + (b - a) * t) for a, b in zip(TOP, BOTTOM)))
    return col.resize((N, N))


def scale_mask():
    """Where the gold goes: the platform, less the dial's window, plus the needle and its hub."""
    m = Image.new('L', (N, N), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([u(136), u(146), u(376), u(370)], radius=u(52), fill=255)
    cx, cy, r = 256, 250, 76
    d.pieslice([u(cx - r), u(cy - r), u(cx + r), u(cy + r)], 180, 360, fill=0)
    d.rectangle([u(cx - r), u(cy - 1), u(cx + r), u(cy + 10)], fill=0)
    a = math.radians(-55)
    end = (cx + 56 * math.cos(a), cy + 56 * math.sin(a))
    w = 18
    d.line([(u(cx), u(cy)), (u(end[0]), u(end[1]))], fill=255, width=u(w))
    d.ellipse([u(end[0] - w / 2), u(end[1] - w / 2), u(end[0] + w / 2), u(end[1] + w / 2)], fill=255)
    d.ellipse([u(cx - 16), u(cy - 16), u(cx + 16), u(cy + 16)], fill=255)
    return m


def main():
    img = gradient()
    img.paste(Image.new('RGB', (N, N), GOLD), mask=scale_mask())
    OUT.mkdir(exist_ok=True)
    for name, size in SIZES.items():
        img.resize((size, size), Image.LANCZOS).save(OUT / name)
        print(f'wrote icons/{name} ({size}x{size})')


if __name__ == '__main__':
    main()
