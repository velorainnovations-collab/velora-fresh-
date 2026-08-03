#!/usr/bin/env python3
"""
Build index.html from src/template.html + data/*.txt

    python3 src/build.py

The template carries two placeholders, @@PRODUCTS@@ and @@GROUPS@@.
This script substitutes the data files into them and writes index.html.
Never edit index.html by hand — edit src/template.html and rebuild.
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
TEMPLATE = ROOT / "src" / "template.html"
PRODUCTS = ROOT / "data" / "products.txt"
GROUPS = ROOT / "data" / "groups.txt"
SYNC = ROOT / "src" / "sync.js"
CONFIG = ROOT / "src" / "config.js"
OUTPUT = ROOT / "index.html"


def build_id(parts: list) -> str:
    """A short fingerprint of everything the page is made of.

    Not a timestamp and not a commit id: it must come out the same for
    the same sources, or scripts/check.sh could never tell a stale
    index.html from a freshly built one. It changes when the app
    changes, which is exactly what is wanted on screen — "is the thing I
    am looking at the thing that was just pushed?" has been asked twice
    now, and guessing from the page is no way to answer it.
    """
    import hashlib

    h = hashlib.sha256()
    for text in parts:
        h.update(text.encode("utf-8"))
    return h.hexdigest()[:7]


def main() -> int:
    html = TEMPLATE.read_text(encoding="utf-8")
    html = html.replace("@@PRODUCTS@@", PRODUCTS.read_text(encoding="utf-8").strip())
    html = html.replace("@@GROUPS@@", GROUPS.read_text(encoding="utf-8").strip())
    # Optional: the app runs unchanged with no sync layer at all.
    if "@@CONFIG@@" in html:
        html = html.replace("@@CONFIG@@", CONFIG.read_text(encoding="utf-8"))
    if "@@SYNC@@" in html:
        html = html.replace("@@SYNC@@", SYNC.read_text(encoding="utf-8"))
    # after the substitutions, so it fingerprints the page that ships
    html = html.replace("@@BUILD@@", build_id([html]))
    if "@@" in html:
        print("ERROR: a placeholder was left unsubstituted", file=sys.stderr)
        return 1
    OUTPUT.write_text(html, encoding="utf-8")
    print(f"wrote {OUTPUT.relative_to(ROOT)}  ({len(html):,} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
