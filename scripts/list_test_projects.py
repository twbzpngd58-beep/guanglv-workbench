#!/usr/bin/env python3
"""List suspected test / demo projects. Read-only: never archives or deletes.

  .venv/bin/python scripts/list_test_projects.py
"""
from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEST_NAMES = {"测试", "测试2", "测试3", "test", "text", "11", "22", "333", "444", "编号与场景包验收", "空间确认验收"}


def data_dir() -> Path:
    data = Path(os.getenv("DATA_DIR", str(ROOT / "data")))
    return (data if data.is_absolute() else ROOT / data).resolve()


def dir_size(path: Path) -> int:
    return sum(f.stat().st_size for f in path.rglob("*") if f.is_file()) if path.exists() else 0


def main():
    data = data_dir()
    con = sqlite3.connect(data / "studio.sqlite3")
    con.row_factory = sqlite3.Row
    rows = []
    for r in con.execute("SELECT id, code, doc FROM projects"):
        p = json.loads(r["doc"])
        name = str(p.get("name", "")).strip()
        demo = bool(p.get("isDemo"))
        if name not in TEST_NAMES and not demo:
            continue
        design = p.get("design") or {}
        attach = dir_size(data / "uploads" / "projects" / r["id"])
        attach += sum(f.stat().st_size for f in (data / "lighting3d").glob(r["id"] + ".*") if f.is_file())
        snaps = con.execute("SELECT count(*), coalesce(sum(length(doc)),0) FROM versions WHERE project_id=?", (r["id"],)).fetchone()
        rooms, fixtures = len(design.get("rooms") or []), len(design.get("fixtures") or [])
        # 有实际设计内容的先建议归档（可逆），空壳建议删除
        advice = "归档" if (demo or rooms or fixtures) else "删除"
        rows.append(dict(id=r["id"], code=r["code"], name=name, kind="示例" if demo else "疑似测试",
                         created=str(p.get("createdAt", ""))[:16].replace("T", " "), status=p.get("status", ""),
                         rooms=rooms, fixtures=fixtures, attach=attach, snaps=snaps[0], snapBytes=snaps[1], advice=advice))
    rows.sort(key=lambda x: x["created"])
    print(f"{'编号':<16}{'名称':<14}{'类型':<6}{'创建时间(UTC)':<18}{'状态':<8}{'房间':>4}{'灯具':>5}{'附件':>9}{'快照':>6}{'快照体积':>9}  建议")
    for x in rows:
        print(f"{x['code']:<16}{x['name']:<14}{x['kind']:<6}{x['created']:<18}{x['status']:<8}{x['rooms']:>4}{x['fixtures']:>5}"
              f"{x['attach']/1048576:>8.1f}M{x['snaps']:>6}{x['snapBytes']/1048576:>8.1f}M  {x['advice']}")
    print(f"\n共 {len(rows)} 个。本脚本只读，归档或删除需作者逐个确认后在工作台里操作。")


if __name__ == "__main__":
    main()
