"""
Builds assets/banner.svg: the wordmark on midnight, with real stills of the
WebPV labs drifting up in faded lanes on the right, the way the site's hero
does it.

Run by hand when the look changes; the daily Action does not touch the banner.

    python scripts/build-banner.py --stills ../WebPV/web/public/home/cards

Why it is built rather than drawn: an SVG shown through <img> on GitHub cannot
load a web font, so every word here is Google Sans turned into outlines, and
the stills are embedded because the image cannot fetch them either. The
palette is WebPV's midnight zone: #0D1734 ground, #F7F6F1 pearl, #AAB6CD
muted, #E3BD70 champagne gold as the one accent.

Needs fontTools, brotli and Pillow, and the network once to fetch the font.
"""

from __future__ import annotations

import argparse
import base64
import io
import re
import tempfile
import urllib.request
from pathlib import Path

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "assets" / "banner.svg"

FONT_CSS = "https://fonts.googleapis.com/css2?family=Google+Sans:wght@400..700"
# Google Fonts picks the file format from the user agent; this one gets woff2.
BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/150.0 Safari/537.36"
)

WIDTH, HEIGHT = 1200, 320
MIDNIGHT = "#0D1734"
PEARL = "#F7F6F1"
MUTED = "#AAB6CD"
GOLD = "#E3BD70"

WORDMARK = "Yim"
TAGLINE = "Websites you can try before you hire"
SITE = "webpv.yimwired.workers.dev"
LABEL = "Yim: websites you can try before you hire"

# Three lanes, the last one cut by the right edge. Each lists the labs whose
# upright stills it carries; durations differ so the lanes never move as one.
# The pale pages ride in the first lane, which the left fade already dims, and
# the lane on the edge carries dark ones: an edge full of pale pages became a
# second bright shape competing with the wordmark.
CARD_WIDTH = 132
CARD_GAP = 18
CARD_OPACITY = 0.42  # the site's resting value for its drifting cards
LANES = [
    {"x": 812, "slugs": ["counter", "meeple", "trine"], "seconds": 54, "offset": 0},
    {"x": 962, "slugs": ["thock", "ember", "clash"], "seconds": 66, "offset": 21},
    {"x": 1112, "slugs": ["gaze", "trellis", "longtail"], "seconds": 60, "offset": 38},
]


# ---------------------------------------------------------------- font ----


def fetch_font(cache: Path) -> Path:
    """The Latin file of Google Sans, downloaded once next to the cache path."""
    if cache.exists():
        return cache
    request = urllib.request.Request(FONT_CSS, headers={"User-Agent": BROWSER_UA})
    css = urllib.request.urlopen(request).read().decode("utf-8")
    block = css.split("/* latin */", 1)[1]
    url = re.search(r"url\((https://[^)]+\.woff2)\)", block).group(1)
    cache.write_bytes(urllib.request.urlopen(url).read())
    return cache


class Face:
    """One weight of the variable font, able to set a line as path data."""

    def __init__(self, font_path: Path, weight: int):
        font = instantiateVariableFont(TTFont(font_path), {"wght": weight})
        self.glyphs = font.getGlyphSet()
        self.cmap = font.getBestCmap()
        self.advances = font["hmtx"].metrics
        self.units = font["head"].unitsPerEm

    def path(self, text: str, size: float, x: float, baseline: float, tracking: float = 0) -> tuple[str, float]:
        """Path data for `text` set at `size`, and the x where the line ends."""
        scale = size / self.units
        parts = []
        cursor = x
        for character in text:
            name = self.cmap[ord(character)]
            pen = SVGPathPen(self.glyphs)
            # Font units point up; SVG points down, hence the flipped y scale.
            self.glyphs[name].draw(TransformPen(pen, (scale, 0, 0, -scale, cursor, baseline)))
            parts.append(pen.getCommands())
            cursor += self.advances[name][0] * scale + tracking
        return " ".join(part for part in parts if part), cursor - tracking


def rounded(path: str) -> str:
    """Trims coordinates to two decimals; the outlines do not need more."""
    return re.sub(r"-?\d+\.\d+", lambda match: f"{float(match.group()):.2f}".rstrip("0").rstrip("."), path)


# -------------------------------------------------------------- stills ----


def still(stills: Path, slug: str) -> tuple[str, int]:
    """A lab's upright still as a small WebP data URI, and its height at CARD_WIDTH."""
    image = Image.open(stills / f"{slug}.webp").convert("RGB")
    height = round(CARD_WIDTH * image.height / image.width)
    # Twice the drawn width, so a retina screen at full column width stays sharp.
    image = image.resize((CARD_WIDTH * 2, height * 2), Image.LANCZOS)
    buffer = io.BytesIO()
    image.save(buffer, "WEBP", quality=64, method=6)
    return "data:image/webp;base64," + base64.b64encode(buffer.getvalue()).decode("ascii"), height


def card_defs(stills: Path) -> tuple[str, dict[str, int]]:
    """Each lab's card drawn once at the origin, for the lanes to place with <use>."""
    defs = []
    heights = {}
    for slug in sorted({slug for lane in LANES for slug in lane["slugs"]}):
        uri, height = still(stills, slug)
        heights[slug] = height
        defs.append(
            f'<clipPath id="clip-{slug}"><rect width="{CARD_WIDTH}" height="{height}" rx="12"/></clipPath>'
            f'<g id="card-{slug}"><image href="{uri}" width="{CARD_WIDTH}" height="{height}" '
            f'clip-path="url(#clip-{slug})" preserveAspectRatio="xMidYMid slice"/>'
            f'<rect x="0.5" y="0.5" width="{CARD_WIDTH - 1}" height="{height - 1}" rx="12" '
            f'fill="none" stroke="{PEARL}" stroke-opacity="0.14"/></g>'
        )
    return "".join(defs), heights


def lane_markup(index: int, lane: dict, heights: dict[str, int]) -> tuple[str, str]:
    """The lane's cards twice over, so sliding by one set loops without a seam."""
    cards = []
    y = 0
    for _ in range(2):
        for slug in lane["slugs"]:
            cards.append(f'<use href="#card-{slug}" x="{lane["x"]}" y="{y}"/>')
            y += heights[slug] + CARD_GAP
    set_height = y // 2
    group = (
        f'<g class="lane lane-{index}" style="animation-duration:{lane["seconds"]}s;'
        f'animation-delay:-{lane["offset"]}s">{"".join(cards)}</g>'
    )
    rule = f"@keyframes drift-{index}{{to{{transform:translateY(-{set_height}px)}}}}.lane-{index}{{animation-name:drift-{index}}}"
    return group, rule


# ---------------------------------------------------------------- main ----


def build(stills: Path, font_path: Path) -> str:
    medium = Face(font_path, 500)
    regular = Face(font_path, 400)

    wordmark, _ = medium.path(WORDMARK, 156, 70, 196, tracking=-3)
    tagline, _ = regular.path(TAGLINE, 30, 74, 248)
    site, _ = regular.path(SITE, 18, 96, 288, tracking=0.4)

    cards, heights = card_defs(stills)
    lanes = [lane_markup(index, lane, heights) for index, lane in enumerate(LANES)]
    lane_groups = "".join(group for group, _ in lanes)
    lane_rules = "".join(rule for _, rule in lanes)

    # The reduced-motion rule is !important because each lane's own rule and its
    # inline timing come later or weigh more, and would keep it moving.
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="{WIDTH}" height="{HEIGHT}" viewBox="0 0 {WIDTH} {HEIGHT}" role="img" aria-label="{LABEL}">
<title>{LABEL}</title>
<style>
.lane{{animation-timing-function:linear;animation-iteration-count:infinite}}
{lane_rules}
@media (prefers-reduced-motion: reduce){{.lane{{animation:none!important}}}}
</style>
<defs>
<clipPath id="frame"><rect width="{WIDTH}" height="{HEIGHT}" rx="24"/></clipPath>
<linearGradient id="fade-y" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="#000"/><stop offset="0.2" stop-color="#fff"/>
<stop offset="0.8" stop-color="#fff"/><stop offset="1" stop-color="#000"/>
</linearGradient>
<linearGradient id="fade-x" x1="0" y1="0" x2="1" y2="0">
<stop offset="0.62" stop-color="#000"/><stop offset="0.74" stop-color="#fff"/>
</linearGradient>
<mask id="lanes-y" maskUnits="userSpaceOnUse" x="0" y="0" width="{WIDTH}" height="{HEIGHT}"><rect width="{WIDTH}" height="{HEIGHT}" fill="url(#fade-y)"/></mask>
<mask id="lanes-x" maskUnits="userSpaceOnUse" x="0" y="0" width="{WIDTH}" height="{HEIGHT}"><rect width="{WIDTH}" height="{HEIGHT}" fill="url(#fade-x)"/></mask>
{cards}
</defs>
<g clip-path="url(#frame)">
<rect width="{WIDTH}" height="{HEIGHT}" fill="{MIDNIGHT}"/>
<g mask="url(#lanes-x)"><g mask="url(#lanes-y)"><g opacity="{CARD_OPACITY}">{lane_groups}</g></g></g>
<path fill="{PEARL}" d="{rounded(wordmark)}"/>
<path fill="{MUTED}" d="{rounded(tagline)}"/>
<rect x="74" y="277.5" width="10" height="10" rx="1.5" fill="{GOLD}"/>
<path fill="{MUTED}" d="{rounded(site)}"/>
</g>
</svg>
"""


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--stills", type=Path, default=ROOT.parent / "WebPV" / "web" / "public" / "home" / "cards")
    # Kept out of the repo: the font is fetched, never committed.
    parser.add_argument("--font-cache", type=Path, default=Path(tempfile.gettempdir()) / "google-sans-latin.woff2")
    args = parser.parse_args()

    svg = build(args.stills, fetch_font(args.font_cache))
    OUTPUT.write_text(svg, encoding="utf-8")
    print(f"wrote {OUTPUT.relative_to(ROOT)} ({len(svg.encode('utf-8')) // 1024} KB)")


if __name__ == "__main__":
    main()
