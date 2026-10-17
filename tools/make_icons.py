"""Draws the app icons (a knight on a board corner) with Pillow."""
from PIL import Image, ImageDraw
import sys

def icon(size):
    img = Image.new("RGB", (size, size), "#161512")
    d = ImageDraw.Draw(img)
    s = size / 4
    for r in range(4):
        for f in range(4):
            if (r + f) % 2 == 0:
                d.rectangle([f * s, r * s, (f + 1) * s, (r + 1) * s], fill="#b58863")
            else:
                d.rectangle([f * s, r * s, (f + 1) * s, (r + 1) * s], fill="#f0d9b5")
    # green "best move" arrow from bottom-left towards top-right
    w = size * 0.07
    a, b = (size * 0.22, size * 0.78), (size * 0.70, size * 0.30)
    d.line([a, b], fill="#15781b", width=int(w))
    h = size * 0.16
    d.polygon([(size * 0.80, size * 0.20), (b[0] - h * 0.9, b[1] - h * 0.1), (b[0] + h * 0.1, b[1] + h * 0.9)], fill="#15781b")
    d.ellipse([a[0] - w, a[1] - w, a[0] + w, a[1] + w], fill="#15781b")
    return img

out = sys.argv[1]
for name, size in [("icon-192.png", 192), ("icon-512.png", 512), ("apple-touch-icon.png", 180)]:
    icon(size).save(f"{out}/{name}")
