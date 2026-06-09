#!/usr/bin/env python3
"""Validate local assets used by the static sites homepage."""

from html.parser import HTMLParser
from pathlib import Path
import sys
from typing import Optional


ROOT = Path(__file__).resolve().parents[1]
SITE_DIR = ROOT / "sites"
INDEX = SITE_DIR / "index.html"
REMOVED_ASSET = SITE_DIR / "assets" / "use-case.png"
REQUIRED_SLOGAN = "每一次迭代的涟漪，都是向解的收敛。"


class AssetParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.assets: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, Optional[str]]]) -> None:
        attr_map = {name: value for name, value in attrs}
        if tag in {"img", "script"} and attr_map.get("src"):
            self.assets.append(attr_map["src"] or "")
        if tag == "link" and attr_map.get("href"):
            href = attr_map["href"] or ""
            rel = attr_map.get("rel", "")
            if "icon" in rel or href.endswith(".css"):
                self.assets.append(href)


def is_local_asset(asset: str) -> bool:
    return not (
        asset.startswith("http://")
        or asset.startswith("https://")
        or asset.startswith("mailto:")
        or asset.startswith("#")
    )


def main() -> int:
    html = INDEX.read_text(encoding="utf-8")
    parser = AssetParser()
    parser.feed(html)

    failures: list[str] = []
    if "use-case.png" in html:
        failures.append("index.html still references use-case.png")
    if REQUIRED_SLOGAN not in html:
        failures.append("index.html is missing the Ripple slogan")
    if "assets/iOS/" in html:
        failures.append("index.html still references iOS assets")
    if REMOVED_ASSET.exists():
        failures.append(f"old asset still exists: {REMOVED_ASSET.relative_to(ROOT)}")

    for asset in parser.assets:
        if not is_local_asset(asset):
            continue
        path = (SITE_DIR / asset).resolve()
        try:
            path.relative_to(SITE_DIR)
        except ValueError:
            failures.append(f"asset escapes sites directory: {asset}")
            continue
        if not path.is_file():
            failures.append(f"missing local asset: {asset}")

    if failures:
        print("Static site asset verification failed:")
        for failure in failures:
            print(f"- {failure}")
        return 1

    print(f"Verified {len(parser.assets)} local asset references for sites/index.html")
    return 0


if __name__ == "__main__":
    sys.exit(main())
