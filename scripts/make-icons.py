#!/usr/bin/env python3
"""Render the L3 home-screen icons.

Writes public/favicon.svg, public/icon-192.png and public/icon-512.png so the
installed icon cannot drift away from the mark in the header. Both come from
the two colours below, which must match --logo-tile and --logo-ink in
src/styles.css and the <Logo> component.

    pip install pillow && python3 scripts/make-icons.py

Not part of the build: these change about once a year, and the generated PNGs
are committed. Keeping Pillow out of the build means a deploy never depends on
it being installed.
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

TILE = "#1b365d"  # navy
INK = "#ffffff"
TEXT = "L3"

OUT = Path(__file__).resolve().parent.parent / "public"

# A serif face, to match the Georgia the header uses for the wordmark. The
# first one present wins; the list covers a Linux CI box and a Mac.
FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSerif-Bold.ttf",
    "/System/Library/Fonts/Supplemental/Georgia Bold.ttf",
    "/Library/Fonts/Georgia Bold.ttf",
]


def font_path() -> str:
    for candidate in FONT_CANDIDATES:
        if Path(candidate).exists():
            return candidate
    raise SystemExit(
        "No serif bold font found. Add one to FONT_CANDIDATES in this script."
    )


def render(size: int) -> Image.Image:
    # 4x supersampling, then one downscale: rounder corners and cleaner glyph
    # edges than anything the rasteriser does at final size.
    scale = 4
    big = size * scale
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    # 14/64 of the side, the same radius as the SVG tile.
    draw.rounded_rectangle([0, 0, big - 1, big - 1], radius=big * 14 // 64, fill=TILE)

    font = ImageFont.truetype(font_path(), int(big * 0.52))
    # Measure the actual ink, not the font's nominal box: the two glyphs sit
    # noticeably above centre otherwise.
    left, top, right, bottom = draw.textbbox((0, 0), TEXT, font=font)
    draw.text(
        ((big - (right - left)) / 2 - left, (big - (bottom - top)) / 2 - top),
        TEXT,
        font=font,
        fill=INK,
    )
    return img.resize((size, size), Image.LANCZOS)


svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <rect width="64" height="64" rx="14" fill="{TILE}"/>
  <text x="32" y="33" text-anchor="middle" dominant-baseline="central"
        fill="{INK}" font-family="Georgia, 'Times New Roman', serif"
        font-size="38" font-weight="700" letter-spacing="-1">{TEXT}</text>
</svg>
"""

if __name__ == "__main__":
    (OUT / "favicon.svg").write_text(svg)
    print("wrote public/favicon.svg")
    for px in (192, 512):
        render(px).save(OUT / f"icon-{px}.png")
        print(f"wrote public/icon-{px}.png")
