"""Draw the app icons into icons/ (dev-time only; needs Pillow).

    python3 tools/make_icons.py

A falling amber trend line with grey weigh-in dots on the app's dark background, inside the middle
80% so it survives a maskable icon's crop. Drawn at 4x and scaled down for smooth edges.
"""
from pathlib import Path

from PIL import Image, ImageDraw

BG = (15, 17, 21)          # --bg
TREND = (247, 183, 51)     # --accent
DOT = (124, 135, 154)      # --dot
OUT = Path(__file__).resolve().parent.parent / 'icons'
SIZES = {'icon-512.png': 512, 'icon-192.png': 192, 'apple-touch-icon.png': 180, 'favicon-32.png': 32}

# In a 100-unit square: the weigh-ins scatter around the trend as it falls.
DOTS = [(22, 34), (32, 42), (42, 40), (52, 54), (62, 52), (72, 64), (80, 62)]
TREND_LINE = [(20, 36), (34, 40), (48, 47), (62, 54), (80, 63)]


def draw(size):
    big = size * 4
    s = big / 100
    img = Image.new('RGB', (big, big), BG)
    d = ImageDraw.Draw(img)
    small = size <= 32
    if not small:  # a favicon is too small for the dots
        r = 3.2 * s
        for x, y in DOTS:
            d.ellipse([x * s - r, y * s - r, x * s + r, y * s + r], fill=DOT)
    width = round((9 if small else 5) * s)
    d.line([(x * s, y * s) for x, y in TREND_LINE], fill=TREND, width=width, joint='curve')
    for x, y in (TREND_LINE[0], TREND_LINE[-1]):  # round ends
        d.ellipse([x * s - width / 2, y * s - width / 2, x * s + width / 2, y * s + width / 2], fill=TREND)
    return img.resize((size, size), Image.LANCZOS)


def main():
    OUT.mkdir(exist_ok=True)
    for name, size in SIZES.items():
        draw(size).save(OUT / name)
        print(f'wrote icons/{name} ({size}x{size})')


if __name__ == '__main__':
    main()
