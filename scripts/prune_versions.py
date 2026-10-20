#!/usr/bin/env python3
"""Thin out the versions (snapshot) table. Dry-run by default.

保留规则（任一命中即保留）：
  1. 每个 V 版本的首份与末份快照（版本切换点）
  2. 复核签名 / 冻结 / 归档 / 历史恢复 / 升级迁移等关键节点，以及复核或冻结引用到的修订号
  3. 每个项目最近 50 份快照
  4. 近 7 天：每小时保留最新 1 份
  5. 更早：每天保留最新 1 份
已删除项目残留的快照只列出，不在本脚本里删除。

  .venv/bin/python scripts/prune_versions.py              # 只出报告
  .venv/bin/python scripts/prune_versions.py --apply      # 老板确认后才执行删除
  .venv/bin/python scripts/prune_versions.py --apply --vacuum   # 删除后回收磁盘空间（会锁库数十秒）
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import zlib
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
KEEP_RECENT = 50
HOURLY_DAYS = 7
# 关键节点：这些操作产生的快照是恢复点或签名依据，永远保留。
KEY_NOTES = ("新建设计版本", "人工复核", "冻结版本", "归档项目", "从历史创建新版本", "创建项目", "导入项目", "复制项目",
             "初始化示例项目", "协作升级前保留完整历史", "升级五道人工复核", "2D案例迁入3D工作台")
KEY_WORDS = ("恢复", "迁移", "迁入", "升级", "冻结", "复核", "变更单")


def db_path() -> Path:
    data = Path(os.getenv("DATA_DIR", str(ROOT / "data")))
    if not data.is_absolute():
        data = ROOT / data
    return data.resolve() / "studio.sqlite3"


def load_doc(value) -> dict:
    if isinstance(value, (bytes, memoryview)):
        return json.loads(zlib.decompress(bytes(value)).decode("utf-8"))
    return json.loads(value)


def referenced_revisions(doc: dict) -> set[int]:
    """Revisions a review signature or freeze record points at."""
    found = set()
    for item in (doc.get("reviews") or {}).values():
        if isinstance(item, dict) and isinstance(item.get("revision"), int):
            found.add(item["revision"])
    for item in (doc.get("legacyReviews") or {}).values():
        if isinstance(item, dict) and isinstance(item.get("revision"), int):
            found.add(item["revision"])
    freeze = (doc.get("cooperation") or {}).get("designFreeze") or {}
    if isinstance(freeze.get("revision"), int):
        found.add(freeze["revision"])
    return found


def parse_at(text: str) -> datetime:
    try:
        at = datetime.fromisoformat(text)
    except (TypeError, ValueError):
        return datetime.now(timezone.utc)
    return at if at.tzinfo else at.replace(tzinfo=timezone.utc)


def plan(con: sqlite3.Connection, now: datetime):
    live = {r["id"]: r["name"] for r in con.execute("SELECT id, json_extract(doc,'$.name') AS name FROM projects")}
    rows = con.execute(
        "SELECT rowid, id, project_id, version, revision, created_at, note, length(doc) AS size FROM versions ORDER BY project_id, created_at, rowid"
    ).fetchall()
    by_project: dict[str, list[sqlite3.Row]] = defaultdict(list)
    for r in rows:
        by_project[r["project_id"]].append(r)

    report, delete_ids = [], []
    orphans = []
    for pid, items in by_project.items():
        if pid not in live:
            orphans.append((pid, len(items), sum(r["size"] or 0 for r in items)))
            continue
        refs: set[int] = set()
        current = con.execute("SELECT doc FROM projects WHERE id=?", (pid,)).fetchone()
        refs |= referenced_revisions(json.loads(current["doc"]))
        keep: set[str] = set()
        # 关键节点 + 被引用快照：只解包这些备选行，避免把整张表都解压一遍
        for r in items:
            note = r["note"] or ""
            if note in KEY_NOTES or any(w in note for w in KEY_WORDS):
                keep.add(r["id"])
                doc = load_doc(con.execute("SELECT doc FROM versions WHERE rowid=?", (r["rowid"],)).fetchone()[0])
                refs |= referenced_revisions(doc)
        for r in items:
            if r["revision"] in refs:
                keep.add(r["id"])
        # 每个 V 版本的首份与末份
        first, last = {}, {}
        for r in items:
            first.setdefault(r["version"], r["id"])
            last[r["version"]] = r["id"]
        keep |= set(first.values()) | set(last.values())
        # 最近 50 份
        keep |= {r["id"] for r in items[-KEEP_RECENT:]}
        # 近 7 天每小时 1 份 / 更早每天 1 份（各取该时段最新的一份）
        bucket_last = {}
        for r in items:
            at = parse_at(r["created_at"])
            key = at.strftime("%Y-%m-%dT%H") if now - at <= timedelta(days=HOURLY_DAYS) else at.strftime("%Y-%m-%d")
            bucket_last[key] = r["id"]
        keep |= set(bucket_last.values())

        doomed = [r for r in items if r["id"] not in keep]
        delete_ids += [r["id"] for r in doomed]
        report.append((pid, live[pid], len(items), len(doomed), sum(r["size"] or 0 for r in doomed)))
    return report, delete_ids, orphans


def mb(n: int) -> str:
    return f"{n / 1024 / 1024:.1f} MB"


def main():
    ap = argparse.ArgumentParser(description="versions 表瘦身（默认 dry-run）")
    ap.add_argument("--apply", action="store_true", help="真正删除（需老板确认后再加）")
    ap.add_argument("--vacuum", action="store_true", help="删除后 VACUUM 回收空间（需 --apply）")
    ap.add_argument("--db", default=None, help="数据库路径，默认 DATA_DIR/studio.sqlite3")
    args = ap.parse_args()
    path = Path(args.db) if args.db else db_path()
    if not path.exists():
        sys.exit(f"找不到数据库：{path}")
    con = sqlite3.connect(path, timeout=30)
    con.row_factory = sqlite3.Row
    report, delete_ids, orphans = plan(con, datetime.now(timezone.utc))

    print(f"数据库：{path}（{mb(path.stat().st_size)}）")
    print(f"{'项目ID':<18}{'快照数':>8}{'将删除':>8}{'预计释放':>12}  项目名")
    for pid, name, total, doomed, size in sorted(report, key=lambda x: -x[4]):
        print(f"{pid:<18}{total:>8}{doomed:>8}{mb(size):>12}  {name}")
    total_size = sum(x[4] for x in report)
    print(f"合计：删除 {len(delete_ids)} 份快照，预计释放 {mb(total_size)}（VACUUM 后才会真正缩小文件）")
    if orphans:
        print("\n已删除项目残留的快照（仅列出，不处理，等确认）：")
        for pid, n, size in orphans:
            print(f"  {pid}  {n} 份  {mb(size)}")
    else:
        print("\n没有已删除项目的残留快照。")

    if not args.apply:
        print("\n[dry-run] 未做任何修改。确认后加 --apply 执行。")
        return
    with con:
        con.executemany("DELETE FROM versions WHERE id=?", [(i,) for i in delete_ids])
    print(f"\n已删除 {len(delete_ids)} 份快照。")
    if args.vacuum:
        con.execute("VACUUM")
        print(f"VACUUM 完成，当前文件 {mb(path.stat().st_size)}")
    con.close()


if __name__ == "__main__":
    main()
