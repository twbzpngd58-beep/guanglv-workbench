#!/usr/bin/env python3
"""Bump the workbench version in one place.

VERSION at the repo root is the single source of truth: the backend reads it at
startup and vite.config.ts injects it into the frontend bundle. Run this after
*every* functional change so the running workbench reports the revision it is
actually serving.

    python3 scripts/bump_version.py patch   # 1.1.0 -> 1.1.1
    python3 scripts/bump_version.py minor   # 1.1.0 -> 1.2.0
    python3 scripts/bump_version.py major   # 1.1.0 -> 2.0.0
    python3 scripts/bump_version.py --set 1.4.2
"""
import argparse, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VERSION_FILE = ROOT / "VERSION"
PKG_FILE = ROOT / "frontend" / "package.json"


def read_version() -> str:
    return VERSION_FILE.read_text(encoding="utf-8").strip()


def write_version(value: str) -> None:
    VERSION_FILE.write_text(value + "\n", encoding="utf-8")
    # Keep package.json in step so npm tooling never reports a different number.
    if PKG_FILE.exists():
        raw = PKG_FILE.read_text(encoding="utf-8")
        updated, count = re.subn(
            r'("version"\s*:\s*")[^"]*(")', lambda m: m.group(1) + value + m.group(2), raw, count=1
        )
        if count:
            PKG_FILE.write_text(updated, encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description="Bump the Guanglv workbench version")
    parser.add_argument("part", nargs="?", choices=["major", "minor", "patch"], default="patch")
    parser.add_argument("--set", dest="explicit", help="set an exact version instead of incrementing")
    args = parser.parse_args()

    current = read_version()
    if args.explicit:
        if not re.fullmatch(r"\d+\.\d+\.\d+", args.explicit):
            sys.exit(f"版本号必须是 x.y.z 形式：{args.explicit}")
        new = args.explicit
    else:
        match = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)", current)
        if not match:
            sys.exit(f"VERSION 不是 x.y.z 形式：{current}")
        major, minor, patch = (int(v) for v in match.groups())
        if args.part == "major":
            major, minor, patch = major + 1, 0, 0
        elif args.part == "minor":
            minor, patch = minor + 1, 0
        else:
            patch += 1
        new = f"{major}.{minor}.{patch}"

    write_version(new)
    print(f"工作台版本 {current} -> {new}")
    # Archive the source so this version can later be switched back to as a whole.
    try:
        sys.path.insert(0, str(ROOT))
        from backend.releases import snapshot_release

        info = snapshot_release(ROOT, ROOT / "data", new)
        extra = f"；已存档 data/releases/{new}.tar.gz（{round(info['bytes'] / 1024)} KB）"
    except Exception as e:  # archiving must never block a version bump
        extra = f"；存档失败：{e}"
    print(f"记得重建前端并重启后端，界面与 /api/health 才会显示新版本{extra}。")


if __name__ == "__main__":
    main()
