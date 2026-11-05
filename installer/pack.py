#!/usr/bin/env python3
"""按白名单把程序目录复制成安装包载荷，避免施工备份和本地数据被一起打包。"""

import argparse
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INCLUDE = [
    "VERSION",
    "README.md",
    "LICENSE",
    ".env.example",
    "build-baseline.json",
    "requirements.txt",
    "requirements.lock.txt",
    "backend",
    "frontend/dist",
    "frontend/src/data",
    "samples",
    "scripts",
    "installer",
]
SKIP_DIR_NAMES = {"__pycache__", ".pytest_cache", "node_modules", "test-results", "playwright-report"}
SKIP_FILE_SUFFIXES = (".pyc", ".pyo", ".DS_Store")


def skipped(path: Path) -> bool:
    parts = {p.lower() for p in path.parts}
    if parts & SKIP_DIR_NAMES:
        return True
    if any(".bak-" in part for part in parts):
        return True
    return any(str(path).endswith(suffix) for suffix in SKIP_FILE_SUFFIXES)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, help="载荷目录（会先清空）")
    parser.add_argument("--root", default=str(ROOT))
    args = parser.parse_args()

    root = Path(args.root).resolve()
    out = Path(args.out).resolve()
    if out == root or root not in out.parents:
        sys.exit(f"载荷目录必须落在 {root} 之外，收到 {out}")
    missing = [name for name in INCLUDE if not (root / name).exists()]
    if missing:
        sys.exit(f"缺少必需内容：{', '.join(missing)}")

    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    copied = 0
    for name in INCLUDE:
        src = root / name
        if src.is_dir():
            for file in sorted(p for p in src.rglob("*") if p.is_file()):
                if skipped(file.relative_to(src)):
                    continue
                dst = out / name / file.relative_to(src)
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(file, dst)
                copied += 1
        else:
            shutil.copy2(src, out / name)
            copied += 1
    size = sum(f.stat().st_size for f in out.rglob("*") if f.is_file())
    print(f"载荷 {out} 共 {copied} 个文件，{size / 1048576:.1f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
