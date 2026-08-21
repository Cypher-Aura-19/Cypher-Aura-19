#!/usr/bin/env python3
"""Post-process the arcade contribution-graph SVGs.

Two jobs:

1. Inline remote sprite images as data URIs. GitHub's camo proxy will not
   fetch nested remote images inside an SVG, so ghost/player icons render
   as broken boxes unless they are embedded.

2. Repaint the GitHub-green contribution palette to the Dexter red ramp.
   `abozanona/pacman-contribution-graph` hardcodes its themes (see
   src/shared/constants.ts) and exposes no colour inputs, so remapping the
   emitted hex values is the only way to theme it.

The snake SVGs are skipped: they are already red (the palette is passed to
Platane/snk directly), they embed no remote images, and they are written by
a Docker action running as root, so rewriting them fails on permissions.
"""

import base64
import glob
import re
import sys
import urllib.request

# ── Dexter palette ───────────────────────────────────────────────────────
# Index order matches the action's `intensityColors`: 0 = no contributions
# … 4 = fourth quartile.
DARK_HEAT = ["#141417", "#4a0a0e", "#8e1219", "#d01822", "#ff5a5a"]
LIGHT_HEAT = ["#f0e4e4", "#f5b5b5", "#e8737b", "#d62d38", "#a80d16"]

GITHUB_DARK = ["#161b22", "#0e4429", "#006d32", "#26a641", "#39d353"]
GITHUB_LIGHT = ["#ebedf0", "#9be9a8", "#40c463", "#30a14e", "#216e39"]

# Any of these surviving in the output means a green graph shipped.
GREENS = set(GITHUB_DARK[1:]) | set(GITHUB_LIGHT[1:])


def inline_images(svg: str, path: str) -> str:
    """Replace remote href/xlink:href image URLs with base64 data URIs."""

    def repl(match: "re.Match[str]") -> str:
        attr, url = match.group(1), match.group(2)
        if url.startswith("data:"):
            return match.group(0)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            data = urllib.request.urlopen(req, timeout=15).read()
            low = url.lower()
            if low.endswith(".gif"):
                mime = "image/gif"
            elif low.endswith((".jpg", ".jpeg")):
                mime = "image/jpeg"
            elif low.endswith(".svg"):
                mime = "image/svg+xml"
            else:
                mime = "image/png"
            b64 = base64.b64encode(data).decode()
            return f'{attr}="data:{mime};base64,{b64}"'
        except Exception as exc:  # noqa: BLE001 - keep the original URL on failure
            print(f"WARN: could not inline {url}: {exc}")
            return match.group(0)

    return re.sub(r'(xlink:href|href)="(https?://[^"]+)"', repl, svg)


def recolour(svg: str, path: str) -> "tuple[str, int]":
    """Swap the GitHub palette for the Dexter one.

    Galaga renders on a black backdrop in both variants, so its cells always
    take the dark ramp. Both the light and dark GitHub greens are mapped in
    every case: the "-dark" filename does not guarantee which ramp the action
    actually emitted, and an unmapped green would ship a green graph.
    """
    name = path.replace("\\", "/").rsplit("/", 1)[-1]
    prefers_dark = "-dark" in name or "galaga" in name
    ramp = DARK_HEAT if prefers_dark else LIGHT_HEAT

    mapping = {
        # Contribution cells: both source ramps land on the chosen output ramp.
        **dict(zip(GITHUB_DARK, ramp)),
        **dict(zip(GITHUB_LIGHT, ramp)),
        # Chrome: backdrop, labels, maze walls.
        "#0d1117": "#0a0a0b",
        "#8b949e": "#7d8590",
        "#aaaaaa": "#7d8590",
        "#57606a": "#7d8590" if prefers_dark else "#6b5050",
        "#ffffff": "#c1161f",
        "#ebedf0": ramp[0],
    }
    if not prefers_dark:
        # Light variants draw walls in black; dark ones in white.
        mapping["#000000"] = "#a80d16"

    swaps = 0

    def repl(match: "re.Match[str]") -> str:
        nonlocal swaps
        found = match.group(0).lower()
        if found in mapping:
            swaps += 1
            return mapping[found]
        return match.group(0)

    svg = re.sub(r"#[0-9a-fA-F]{6}", repl, svg)
    return svg, swaps


def main() -> int:
    paths = sorted(p for p in glob.glob("dist/*.svg") if "snake" not in p)
    if not paths:
        print("ERROR: no arcade SVGs found in dist/", file=sys.stderr)
        return 1

    for path in paths:
        with open(path, "r", encoding="utf-8") as fh:
            svg = fh.read()

        svg = inline_images(svg, path)
        svg, swaps = recolour(svg, path)

        if swaps == 0:
            # The upstream action changed its palette; the red theme is gone.
            # Fail loudly rather than silently shipping green graphs.
            print(f"ERROR: no colours remapped in {path}", file=sys.stderr)
            return 1

        leftover = sorted(GREENS & set(re.findall(r"#[0-9a-fA-F]{6}", svg.lower())))
        if leftover:
            print(f"ERROR: GitHub green survived in {path}: {leftover}", file=sys.stderr)
            return 1

        with open(path, "w", encoding="utf-8") as fh:
            fh.write(svg)
        print(f"themed {path} ({swaps} colours remapped, {len(svg)} bytes)")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
