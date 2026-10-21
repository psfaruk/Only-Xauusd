#!/usr/bin/env python3
"""Task 39 (UI-03) — migrate hard-coded zinc/amber/emerald/red/orange classes
to the theme-aware semantic design tokens defined in globals.css.

Rules:
  - Variant prefixes (hover:, focus:, data-[state=active]:, disabled:,
    placeholder:, supports-[...]:) are preserved untouched.
  - Opacity suffixes (/NN) are preserved, except where the target token is
    a solid theme-resolved surface (bg-muted, bg-panel, bg-surface).
  - Elevation thresholds: bg-zinc-900|800 with /NN opacity < 70 collapse to
    the solid `muted` inset surface; >= 70 map to panel/surface with opacity.
  - Status colors map to semantic tokens: amber→sun, emerald→up, red→down,
    orange→warn, sky→brand.
"""
import re
import sys
from pathlib import Path

FILES = [
    "src/app/page.tsx",
    "src/lib/dashboard/i18n.ts",
    *sorted(str(p) for p in Path("src/components/terminal").glob("*.tsx")),
]

TOKEN_RE = re.compile(
    r"(?P<prefix>(?:[a-z-]+:|data-\[[^\]]+\]:|supports-\[[^\]]+\]:)*)"
    r"(?P<core>(?:bg|text|border|ring|divide|from|to|via|outline|fill|stroke)"
    r"-(?:zinc|amber|emerald|red|orange|sky|green|slate)-\d{2,3})"
    r"(?P<op>/\d{1,3})?"
)

CORE_MAP = {
    # zinc → surfaces / text / borders
    "bg-zinc-950": "bg-terminal",
    "bg-zinc-900": "bg-panel",
    "bg-zinc-800": "bg-surface",
    "bg-zinc-700": "bg-muted",
    "bg-zinc-600": "bg-muted",
    "bg-zinc-500": "bg-muted-foreground",
    "text-zinc-50": "text-foreground",
    "text-zinc-100": "text-foreground",
    "text-zinc-200": "text-foreground/90",
    "text-zinc-300": "text-content",
    "text-zinc-400": "text-content",
    "text-zinc-500": "text-muted-foreground",
    "text-zinc-600": "text-muted-foreground",
    "text-zinc-700": "text-muted-foreground",
    "text-zinc-950": "text-on-sun",
    "border-zinc-800": "border-border",
    "border-zinc-700": "border-border-strong",
    "border-zinc-600": "border-border-strong",
    "border-zinc-500": "border-border-strong",
    "divide-zinc-800": "divide-border",
    "divide-zinc-700": "divide-border-strong",
    "ring-zinc-800": "ring-border",
    "ring-zinc-700": "ring-border-strong",
    "ring-zinc-600": "ring-border-strong",
    "ring-zinc-500": "ring-muted-foreground",
    # amber → sunlight accent
    "text-amber-100": "text-sun",
    "text-amber-200": "text-sun",
    "text-amber-300": "text-sun",
    "text-amber-400": "text-sun",
    "text-amber-500": "text-sun",
    "bg-amber-100": "bg-sun/20",
    "bg-amber-200": "bg-sun/30",
    "bg-amber-300": "bg-sun/50",
    "bg-amber-400": "bg-sun",
    "bg-amber-500": "bg-sun",
    "border-amber-300": "border-sun/70",
    "border-amber-400": "border-sun",
    "border-amber-500": "border-sun",
    "ring-amber-400": "ring-sun",
    "ring-amber-500": "ring-sun",
    "from-amber-400": "from-sun",
    "from-amber-500": "from-sun",
    "to-amber-400": "to-sun",
    "to-amber-500": "to-sun",
    # emerald → market-up / success
    "text-emerald-200": "text-up",
    "text-emerald-300": "text-up",
    "text-emerald-400": "text-up",
    "text-emerald-500": "text-up",
    "bg-emerald-300": "bg-up/60",
    "bg-emerald-400": "bg-up",
    "bg-emerald-500": "bg-up",
    "bg-emerald-600": "bg-up",
    "border-emerald-400": "border-up",
    "border-emerald-500": "border-up",
    "ring-emerald-400": "ring-up",
    "ring-emerald-500": "ring-up",
    # red → market-down / error
    "text-red-200": "text-down",
    "text-red-300": "text-down",
    "text-red-400": "text-down",
    "text-red-500": "text-down",
    "bg-red-300": "bg-down/60",
    "bg-red-400": "bg-down",
    "bg-red-500": "bg-down",
    "border-red-400": "border-down",
    "border-red-500": "border-down",
    "ring-red-400": "ring-down",
    "ring-red-500": "ring-down",
    # orange → warn (degraded)
    "text-orange-300": "text-warn",
    "text-orange-400": "text-warn",
    "text-orange-500": "text-warn",
    "bg-orange-400": "bg-warn",
    "bg-orange-500": "bg-warn",
    "border-orange-400": "border-warn",
    "border-orange-500": "border-warn",
    "ring-orange-400": "ring-warn",
    "ring-orange-500": "ring-warn",
    # sky → brand (if any appear)
    "text-sky-300": "text-brand",
    "text-sky-400": "text-brand",
    "text-sky-500": "text-brand",
    "bg-sky-400": "bg-primary",
    "bg-sky-500": "bg-primary",
    "border-sky-400": "border-primary",
    "border-sky-500": "border-primary",
}

# Targets that must stay SOLID (no appended opacity) — theme-resolved surfaces.
SOLID_TARGETS = {"bg-muted", "bg-panel", "bg-surface", "bg-terminal"}


def convert(match: re.Match) -> str:
    prefix = match.group("prefix")
    core = match.group("core")
    op = match.group("op")
    target = CORE_MAP.get(core)
    if target is None:
        # unmapped — keep as-is, flagged later
        return match.group(0)
    base = target.split("/")[0]
    baked_op = "/" + target.split("/")[1] if "/" in target else ""
    if op and base not in SOLID_TARGETS and not baked_op:
        return f"{prefix}{target}{op}"
    if op and base not in SOLID_TARGETS and baked_op:
        return f"{prefix}{base}{op}"  # original opacity wins over baked
    return f"{prefix}{target}"


def main() -> int:
    root = Path("/home/z/my-project")
    total = 0
    for rel in FILES:
        path = root / rel
        src = path.read_text(encoding="utf-8")
        out, n = TOKEN_RE.subn(convert, src)
        if n:
            path.write_text(out, encoding="utf-8")
        # count leftovers
        leftover = re.findall(
            r"(?:zinc|amber|emerald|red|orange|sky|green|slate)-\d{2,3}(?:/\d+)?", out
        )
        print(f"{rel}: migrated={n} leftovers={len(leftover)}")
        if leftover:
            from collections import Counter

            for token, cnt in Counter(leftover).most_common():
                print(f"    LEFTOVER {token} x{cnt}")
        total += n
    print(f"TOTAL migrated: {total}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
