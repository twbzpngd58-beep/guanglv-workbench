#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""products — 灯具产品库（光律版）

唯一真相源：知识库 `15-产品库/摇光灯具/统一灯具报价表.xlsx`
用户口径（2026-09-25 确认）：**只同步市场零售价**。
出厂价 / 含运费出厂价 / 预估运费 / 备注（备注里常写出厂价）一律不进工作台。
灯具图片是 DISPIMG 公式，无意义，跳过。

表落在光律自己的库 `data/studio.sqlite3`，表名 `lighting3d_products`（新表，不动任何既有表）。
"""
import os
import re
import sqlite3
import time
from pathlib import Path

LOCAL_SEED = Path(__file__).resolve().parent / "local_data" / "products.json"
SRC_XLSX = str(LOCAL_SEED)  # 默认数据源：随源码分发的产品库 JSON
DEFAULT_DB = Path(os.getenv("DATA_DIR", str(Path(__file__).resolve().parent.parent / "data"))) / "studio.sqlite3"
TABLE = "lighting3d_products"

# 允许进工作台的列（白名单，不是黑名单——多一列都得先想清楚）
KEEP = ["图纸编号", "品牌", "产品名称", "产品分类", "方案类型", "功率(W)", "色温(K)",
        "开孔尺寸", "是否调光", "单位", "质保", "零售价(元)"]
DROP = ["出厂价(元)", "含运费出厂价(元)", "预估运费(元)", "备注", "灯具图片"]

ANGLE_RE = re.compile(r"(\d{1,2})\s*°")

DDL = f"""
CREATE TABLE IF NOT EXISTS {TABLE}(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT DEFAULT '', brand TEXT DEFAULT '', name TEXT DEFAULT '',
  category TEXT DEFAULT '', scheme TEXT DEFAULT '',
  watt REAL, cct TEXT DEFAULT '', cutout TEXT DEFAULT '', dimmable TEXT DEFAULT '',
  unit TEXT DEFAULT '', warranty TEXT DEFAULT '',
  angle REAL, price REAL,
  synced_at TEXT,
  UNIQUE(code, name, scheme, unit)
);
"""


def _txt(v):
    if v is None:
        return ""
    s = str(v).strip()
    return "" if s in ("—", "-", "/", "None") else s


def _num(v):
    s = _txt(v)
    if not s:
        return None
    try:
        return float(re.sub(r"[^\d.\-]", "", s))
    except Exception:
        return None


def _rows_from_json(path):
    """products.json → 与报价表同一套行结构（code/brand/name/...）"""
    import json as _json
    payload = _json.loads(Path(path).read_text(encoding="utf-8"))
    rows = []
    for r in payload.get("products", []):
        model = (r.get("model") or "").strip()
        if not model:
            continue
        rows.append(dict(code=model, brand=r.get("brand") or "", name=r.get("name") or model,
                         category="灯具" if r.get("category") == "light" else "智能设备",
                         scheme=r.get("scheme") or "", watt=r.get("watt"), cct=r.get("cct") or "",
                         cutout=r.get("cutout") or "", dimmable=r.get("dimmable") or "",
                         unit=r.get("unit") or "个", warranty=r.get("warranty") or "",
                         angle=r.get("angle"), price=r.get("price")))
    return rows, []


def load_rows(path=SRC_XLSX):
    if str(path).lower().endswith(".json"):
        return _rows_from_json(path)
    """读报价表 → 只保留白名单字段。永远不会带回出厂价/运费。"""
    import openpyxl
    wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
    ws = wb[wb.sheetnames[0]]
    rows = []
    idx = None
    warn = []
    for row in ws.iter_rows(values_only=True):
        vals = [("" if v is None else str(v).strip()) for v in row]
        if idx is None:
            if "图纸编号" in vals and "零售价(元)" in vals:
                idx = {v: i for i, v in enumerate(vals) if v}
                missing = [c for c in KEEP if c not in idx]
                if missing:
                    warn.append("报价表缺列：" + "、".join(missing))
            continue
        if not any(vals):
            continue

        def g(col):
            j = idx.get(col)
            return vals[j] if j is not None and j < len(vals) else ""

        code = _txt(g("图纸编号"))
        name = _txt(g("产品名称"))
        if not name:
            continue
        blob = code + " " + name
        m = ANGLE_RE.search(blob)
        rows.append({
            "code": code, "brand": _txt(g("品牌")), "name": name,
            "category": _txt(g("产品分类")), "scheme": _txt(g("方案类型")),
            "watt": _num(g("功率(W)")), "cct": _txt(g("色温(K)")),
            "cutout": _txt(g("开孔尺寸")), "dimmable": _txt(g("是否调光")),
            "unit": _txt(g("单位")) or "个", "warranty": _txt(g("质保")),
            "angle": float(m.group(1)) if m else None,
            "price": _num(g("零售价(元)")),
        })
    wb.close()
    return rows, warn


def sync(db_path=None, path=SRC_XLSX):
    db_path = str(db_path or DEFAULT_DB)
    rows, warn = load_rows(path)
    con = sqlite3.connect(db_path)
    con.executescript(DDL)
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    ins = upd = 0
    for r in rows:
        cur = con.execute(
            f"SELECT id FROM {TABLE} WHERE code=? AND name=? AND scheme=? AND unit=?",
            (r["code"], r["name"], r["scheme"], r["unit"]))
        old = cur.fetchone()
        if old:
            con.execute(f"""UPDATE {TABLE} SET brand=?,category=?,watt=?,cct=?,cutout=?,dimmable=?,
                           warranty=?,angle=?,price=?,synced_at=? WHERE id=?""",
                        (r["brand"], r["category"], r["watt"], r["cct"], r["cutout"], r["dimmable"],
                         r["warranty"], r["angle"], r["price"], ts, old[0]))
            upd += 1
        else:
            con.execute(f"""INSERT INTO {TABLE}(code,brand,name,category,scheme,watt,cct,cutout,
                           dimmable,unit,warranty,angle,price,synced_at)
                           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                        (r["code"], r["brand"], r["name"], r["category"], r["scheme"], r["watt"],
                         r["cct"], r["cutout"], r["dimmable"], r["unit"], r["warranty"],
                         r["angle"], r["price"], ts))
            ins += 1
    con.commit()
    total = con.execute(f"SELECT COUNT(*) FROM {TABLE}").fetchone()[0]
    con.close()
    return {"rows": len(rows), "inserted": ins, "updated": upd, "total": total,
            "synced_at": ts, "src": path, "scope": "只同步市场零售价（出厂价/运费/备注不进）",
            "warn": warn}


def ensure_synced(db_path=None, max_age_h: int = 12):
    """超过 max_age_h 小时就自动同步一次；页面打开时调"""
    db_path = str(db_path or DEFAULT_DB)
    last = None
    try:
        con = sqlite3.connect(db_path)
        r = con.execute(f"SELECT MAX(synced_at) FROM {TABLE}").fetchone()
        last = r[0] if r else None
        con.close()
    except Exception:
        last = None
    if last:
        try:
            if (time.time() - time.mktime(time.strptime(last, "%Y-%m-%d %H:%M:%S"))) < max_age_h * 3600:
                return {"skipped": True, "last": last}
        except Exception:
            pass
    return sync(db_path)


def map_products(db_path=None, scheme=None):
    """{图纸编号: 产品}；带 scheme 就只取那个方案类型（开闭/缓亮缓灭/无线/总线）"""
    db_path = str(db_path or DEFAULT_DB)
    out = {}
    try:
        con = sqlite3.connect(db_path)
        con.row_factory = sqlite3.Row
        sql = f"SELECT * FROM {TABLE} WHERE code<>''"
        rows = con.execute(sql + " AND scheme=?", (scheme,)) if scheme else con.execute(sql + " ORDER BY scheme")
        for r in rows:
            out.setdefault(r["code"], dict(r))
        con.close()
    except Exception:
        pass
    return out


def lookup(db_path, code, scheme=None):
    con = sqlite3.connect(str(db_path or DEFAULT_DB))
    con.row_factory = sqlite3.Row
    if scheme:
        cur = con.execute(f"SELECT * FROM {TABLE} WHERE code=? AND scheme=? LIMIT 1", (code, scheme))
    else:
        cur = con.execute(f"SELECT * FROM {TABLE} WHERE code=? LIMIT 1", (code,))
    r = cur.fetchone()
    con.close()
    return dict(r) if r else None


if __name__ == "__main__":
    import json
    import sys
    db = sys.argv[1] if len(sys.argv) > 1 else None
    print(json.dumps(sync(db), ensure_ascii=False, indent=1))
    print("D15 ->", lookup(db, "D15"))
