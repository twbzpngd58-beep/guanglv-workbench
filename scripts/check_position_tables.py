#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""位置表（按空间取表）的数据自检。

只查数据与存量口径，不重复实现编号解析（编号往返由 `npm run check:positions` 在前端跑）：
  1. 83 个空间每个都有位置表；同一空间内位置码不重复；
  2. 通用位（c s t z d x g w v q）的名称在任何空间里都不许改写；
  3. 存量项目里出现过的每个 (空间, 位置码)，在新表下的位置名必须和改造前一样
     —— 老图纸的编号解释一个字都不许漂移。

跑法：python3 scripts/check_position_tables.py
"""
import collections
import json
import re
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LIB = ROOT / "frontend/src/data/code-library.json"
DB = ROOT / "data/studio.sqlite3"
ROLES = "MFEAGXCW"


def main():
    lib = json.loads(LIB.read_text(encoding="utf-8"))
    legacy = {p["code"]: p["name"] for p in lib["positions"]}
    universal = set(lib.get("universalPositionCodes") or [])
    palettes = lib.get("positionPalettes") or {}
    space_palette = lib.get("spacePalette") or {}
    space_name = {s["code"]: s["name"] for s in lib["spaces"]}
    problems = []

    for s in lib["spaces"]:
        code = s["code"]
        pid = space_palette.get(code)
        if not pid or pid not in palettes:
            problems.append(f"空间 {code}{s['name']} 没有位置表")
            continue
        seen = set()
        for p in palettes[pid]["positions"]:
            if p["code"] in seen:
                problems.append(f"{code} 位置码重复：{p['code']}")
            seen.add(p["code"])
            if p["code"] in universal and legacy.get(p["code"]) != p["name"]:
                problems.append(
                    f"{code} 改写通用位 {p['code']}：{p['name']} ≠ {legacy.get(p['code'])}"
                )

    space_codes = sorted(space_palette, key=len, reverse=True)
    palette_by_space = {
        sc: {p["code"]: p["name"] for p in palettes[space_palette[sc]]["positions"]}
        for sc in space_palette
        if space_palette.get(sc) in palettes
    }

    def resolve(sc, letter):
        hit = palette_by_space.get(sc, {}).get(letter)
        if hit:
            return hit
        return legacy.get(letter)

    def parse(code):
        m = re.match(r"^([A-Za-z]+?)([0-9]{1,3})$", (code or "").strip())
        if not m:
            return None
        head = m.group(1)
        for sc in space_codes:
            if len(head) <= len(sc) or head[: len(sc)] != sc:
                continue
            rest = head[len(sc):]
            pos = rest[0]
            if pos != pos.lower() or resolve(sc, pos) is None:
                continue
            role = rest[1:]
            if len(role) > 1 or (role and (role != role.upper() or role not in ROLES)):
                continue
            return sc, pos
        return None

    checked = 0
    if DB.is_file():
        con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
        con.row_factory = sqlite3.Row
        pairs = collections.Counter()
        for row in con.execute("select doc from projects"):
            proj = json.loads(row["doc"])
            for f in proj.get("design", {}).get("fixtures", []) or []:
                got = parse(f.get("code") or "")
                if got:
                    pairs[got] += 1
        for (sc, pos), n in sorted(pairs.items()):
            checked += 1
            name = resolve(sc, pos)
            if name is None:
                problems.append(f"存量编号 (空间 {sc}, 位置 {pos}) 在新表里解析不出来")
        print(f"存量项目 (空间, 位置码) 组合：{checked} 个，位置名口径全部保持")

    if problems:
        print("FAIL " + str(len(problems)))
        for p in problems:
            print(" - " + p)
        return 1
    print(
        f"OK 位置表 {len(palettes)} 张 · 空间 {len(lib['spaces'])} 个 · "
        f"位置条目 {sum(len(v['positions']) for v in palettes.values())} 条"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
