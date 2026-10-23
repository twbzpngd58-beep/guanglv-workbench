#!/usr/bin/env python3
"""登记一条功能改动记录（功能清单里可查、可按次回退）。

记录写在 data/feature-history.json（不在版本快照范围，回退程序/前端也不会丢）；
首次运行会从 docs/feature-history.json 播种。

用法：
  python3 scripts/feature_change.py --ids L-01,E-03 --title "调整灯带编号" \\
      --detail "按空间重新编号" --before v1.3.2-...-before --after v1.3.2-...-after
  python3 scripts/feature_change.py --list L-01

约定：每次改功能照旧先存「改前快照」；改完构建、重启、实测后存「改后快照」，再用本脚本登记。
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(__import__("os").getenv("DATA_DIR", str(ROOT / "data"))).resolve()
SEED = ROOT / "docs" / "feature-history.json"
STORE = DATA / "feature-history.json"
ID_RE = re.compile(r"^(?:\*|[A-Z]{1,2}-\d{2})$")


def load() -> dict:
    for path in (STORE, SEED):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(data, dict) and isinstance(data.get("entries"), list):
            return {"entries": [e for e in data["entries"] if isinstance(e, dict)]}
    return {"entries": []}


def save(data: dict) -> None:
    STORE.parent.mkdir(parents=True, exist_ok=True)
    STORE.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser(description="登记功能改动记录")
    ap.add_argument("--ids", help="功能编号，逗号分隔；* 表示全部功能")
    ap.add_argument("--title", help="这次改了什么（短标题）")
    ap.add_argument("--detail", default="", help="补充说明")
    ap.add_argument("--before", default="", help="改前快照 id（回退目标）")
    ap.add_argument("--after", default="", help="改后快照 id")
    ap.add_argument("--at", default="", help="时间（默认当前本地时间）")
    ap.add_argument("--list", metavar="FID", help="列出某个编号的改动记录")
    args = ap.parse_args()

    data = load()

    if args.list:
        rows = [e for e in data["entries"] if "*" in (e.get("ids") or []) or args.list in (e.get("ids") or [])]
        if not rows:
            print(f"{args.list}：还没有改动记录")
            return 0
        for e in sorted(rows, key=lambda x: str(x.get("at")), reverse=True):
            print(f"{e.get('at')} · {e.get('title')}  [改前 {e.get('before') or '—'} / 改后 {e.get('after') or '—'}]")
        return 0

    ids = [x.strip() for x in str(args.ids or "").split(",") if x.strip()]
    bad = [x for x in ids if not ID_RE.match(x)]
    if bad:
        print(f"编号不合法：{', '.join(bad)}（示例 L-01 / S-68 / *）", file=sys.stderr)
        return 2
    if not args.title:
        print("缺 --title（这次改了什么）", file=sys.stderr)
        return 2
    at = args.at or datetime.now().astimezone().isoformat(timespec="seconds")
    entry = {
        "at": at,
        "ids": ids,
        "title": args.title.strip(),
        "detail": (args.detail or "").strip(),
        "before": (args.before or "").strip(),
        "after": (args.after or "").strip(),
    }
    data["entries"].append(entry)
    save(data)
    print(f"已登记：{at} · {entry['title']} · {', '.join(ids)}")
    print(f"记录文件：{STORE}（共 {len(data['entries'])} 条）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
