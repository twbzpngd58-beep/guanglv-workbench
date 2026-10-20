#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""product_library — 工作台自己的产品库（把知识库 15-产品库 写进工作台）

用户口径（2026-09-26）：「把知识库中的产品库写入工作台」。
知识库永远是**只读真源**：这里只读它，把产品写进工作台自己的库（`data/studio.sqlite3` 的 `products` 表）。

## 来源（白名单，一条一条列出来，不搞"扫到什么算什么"）
1. `15-产品库/摇光灯具/统一灯具报价表.xlsx` —— 报价表，**带图纸编号 + 方案类型（缓亮缓灭/无线/总线/开闭）+ 零售价**，
   项目报价与三维空间取价都以它为准。
2. `15-产品库/_产品库全量整合.md` —— 各品牌全量产品表（摇光 / 世聪 / JOCO / CLOWIRE / 睿易 / 大华），
   品牌按文档一级标题（`# 一、摇光灯具` 这种）认出来。
3. 各品牌目录下的产品清单 markdown：`摇光灯具/`、`CITRON世聪智能/`、`JOCO集控/`、`JOCO集控智能/`、`睿易网络/`。

模板 / 规则 / 说明 / 目录 / 附录 / 总览 / 选型指南 / 方案这类小节不当产品（见 SKIP_SECTION_KW）。

## 价格口径（沿用 2026-09-25 确认，别改）
**只进市场零售价**。出厂价 / 含运费出厂价 / 预估运费 / 备注（备注里常写出厂价）一律不进工作台——
写入时只取 `零售价` / `市场价` 列，出厂价列连读都不读。灯具图片是 DISPIMG 公式，跳过。

## 冲突不静默
同一图纸编号在不同资料里零售价不一致时，两条都留着（各自带来源），并在同步报告里列出来让人核对。
"""
from __future__ import annotations

import hashlib
import os
import re
import sqlite3
import json
import time
from pathlib import Path
from typing import Any

from . import kbtext as KB

DEFAULT_DB = Path(os.getenv("DATA_DIR", str(Path(__file__).resolve().parent.parent / "data"))) / "studio.sqlite3"
TABLE = "products"

PRICE_SCOPE = "只进市场零售价（出厂价 / 含运费出厂价 / 预估运费 / 备注不进工作台）"
# 解析口径指纹：改了抽取规则就改它，启动时会自动重灌一次产品库。
BUILD_ID = "pl-2026-10-18-philips"

# 品牌目录 → 品牌名
BRAND_DIRS = {"摇光灯具": "摇光", "CITRON世聪智能": "世聪", "JOCO集控": "JOCO",
              "JOCO集控智能": "JOCO", "睿易网络": "睿易", "飞利浦": "飞利浦"}
XLSX = Path("摇光灯具/统一灯具报价表.xlsx")
INTEGRATED = Path("_产品库全量整合.md")

# 一级标题里出现这些词 → 品牌
BRAND_KW = (("CLOWIRE", "CLOWIRE"), ("克伦", "CLOWIRE"), ("JOCO", "JOCO"), ("集控智能", "JOCO"),
            ("世聪", "世聪"), ("CITRON", "世聪"), ("摇光", "摇光"),
            ("睿易", "睿易"), ("Ruijie", "睿易"), ("大华", "大华"), ("飞利浦", "飞利浦"), ("Philips", "飞利浦"), ("PHILIPS", "飞利浦"))

# 这些小节不是产品清单（模板 / 规则 / 目录 / 附录 / 方案 …）
SKIP_SECTION_KW = ("附录", "下载", "资源汇总", "目录", "说明", "规则", "价格体系", "总览", "速查",
                   "模板", "选型指南", "参考项目", "参考方案", "解决方案", "智能解决", "通讯协议",
                   "品牌信息", "体系结构", "产品线全貌", "关于", "简介", "使用规则", "品牌与产品")
# 明显不是产品名的占位词
PLACEHOLDER = {"射灯", "筒灯", "灯带", "电源", "产品", "名称", "产品名称", "内容", "备注", "项目",
               "合计", "小计", "序号", "单价", "数量", "单位", "—", "-", "/", "无", "待定"}

ANGLE_RE = re.compile(r"(\d{1,2})\s*°")
# 像 `SC-SW1-01` 或 （SC-SW1-01）这样写在标题里的型号
CODE_TOKEN_RE = re.compile(r"`([A-Za-z][A-Za-z0-9\-_./]{2,})`")
PAREN_CODE_RE = re.compile(r"[（(]\s*([A-Za-z]{1,6}[A-Za-z0-9\-_./]{2,})\s*[)）]")
PRICE_KEY_RE = re.compile(r"^\|\s*\**\s*(零售价|市场价|价格|单价)\**\s*\|\s*([^|]+)\|")
CODE_RE = re.compile(r"^[A-Z]{1,3}\d{1,3}[a-z]?$")

DDL = f"""
CREATE TABLE IF NOT EXISTS {TABLE}(
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  brand TEXT NOT NULL DEFAULT '',
  scheme TEXT NOT NULL DEFAULT '',
  unit TEXT NOT NULL DEFAULT '',
  warranty TEXT NOT NULL DEFAULT '',
  cutout TEXT NOT NULL DEFAULT '',
  dimmable TEXT NOT NULL DEFAULT '',
  watt REAL,
  cct TEXT NOT NULL DEFAULT '',
  cct_min INTEGER,
  cct_max INTEGER,
  angle REAL,
  price REAL,
  price_source TEXT NOT NULL DEFAULT '',
  control TEXT NOT NULL DEFAULT '',
  protocol TEXT NOT NULL DEFAULT '',
  dimmable_flag INTEGER NOT NULL DEFAULT 0,
  tunable INTEGER NOT NULL DEFAULT 0,
  price_verified INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT '',
  source_path TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  synced_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_products_category ON {TABLE}(category);
CREATE INDEX IF NOT EXISTS idx_products_brand ON {TABLE}(brand);
CREATE INDEX IF NOT EXISTS idx_products_model ON {TABLE}(model);
"""

# 允许写入的列（白名单：多一列都得先想清楚，尤其别把出厂价带进来）
COLS = ["id", "category", "type", "name", "model", "brand", "scheme", "unit", "warranty",
        "cutout", "dimmable", "watt", "cct", "cct_min", "cct_max", "angle", "price",
        "price_source", "control", "protocol", "dimmable_flag", "tunable",
        "price_verified", "source", "source_path", "notes", "synced_at"]


# ------------------------------------------------------------------ 小工具
def _txt(v) -> str:
    if v is None:
        return ""
    s = str(v).strip()
    return "" if s in ("—", "-", "/", "None", "nan") else s


def _num(v):
    s = _txt(v)
    if not s:
        return None
    m = re.search(r"-?\d+(?:\.\d+)?", s.replace(",", ""))
    return float(m.group(0)) if m else None


def _cct_range(v: str) -> tuple[int | None, int | None]:
    # 只认像色温的数字（1500–10000K）：否则「110超薄吸顶灯」会被读成 110K
    nums = [int(n) for n in re.findall(r"\d{3,5}", _txt(v)) if 1500 <= int(n) <= 10000]
    if not nums:
        return None, None
    return min(nums), max(nums)


def _pid(*parts: str) -> str:
    return "kb-" + hashlib.sha1("|".join(parts).encode("utf-8")).hexdigest()[:16]


def _angle(name: str, model: str) -> float | None:
    m = ANGLE_RE.search(f"{name or ''} {model or ''}")
    return float(m.group(1)) if m else None


def _proto(blob: str, scheme: str) -> tuple[str, str]:
    up = blob.upper()
    control = ""
    if "DALI" in up:
        control = "DALI"
    elif "KNX" in up:
        control = "KNX"
    elif scheme == "无线":
        control = "无线"
    protocol = "KNX" if "KNX" in up else ("DALI" if "DALI" in up else "")
    return control, protocol


DEVICE_KW = ("开关电源", "电源", "磁吸轨道", "轨道", "驱动", "模块", "网关", "面板", "传感器",
             "电机", "主机", "控制器", "执行器", "温控", "接口", "交换机", "AP", "路由器",
             "监控", "插座", "遥控", "背景音乐", "网络", "中枢", "解码器", "灯控")
LIGHT_KW = ("射灯", "筒灯", "灯带", "线性灯", "吊灯", "壁灯", "吸顶灯", "美颜灯", "落地灯",
            "台灯", "脚灯", "灯")


def _is_light(text: str) -> bool:
    if any(k in text for k in DEVICE_KW):
        return False
    return any(k in text for k in LIGHT_KW)


def _fix_category(blend: str, category: str, kind: str) -> str:
    """灯具/设备的判定以名字为准：名字里带「灯」又不是轨道/电源这类，就归灯具。

    （知识库里的表头五花八门，"110超薄护眼吸顶灯" 这类容易被默认成「智能设备」。）
    """
    if _is_light(blend):
        return "light"
    if category == "light":
        return "device"
    return category


def _brand_of(title: str, default: str = "") -> str:
    for kw, brand in BRAND_KW:
        if kw in title or kw.lower() in title.lower():
            return brand
    return default


def _clean_heading(line: str) -> str:
    t = KB.clean(re.sub(r"^#+\s*", "", line))
    return re.sub(r"^[一二三四五六七八九十百\d]+\s*[、.．]\s*", "", t)


def _row(**kw) -> dict:
    base = {c: None for c in COLS}
    base.update({k: v for k, v in kw.items() if k in base})
    for c in COLS:
        if base[c] is None and c not in ("watt", "angle", "price", "cct_min", "cct_max"):
            base[c] = ""
    return base


def _pick(headers: list[str], *keys: str) -> str:
    """按关键词挑列；忽略表头里的空格（「型 号」和「型号」算同一列）。"""
    def norm(s: str) -> str:
        return re.sub(r"\s+", "", s)
    for k in keys:
        nk = norm(k)
        for h in headers:
            if nk in norm(h):
                return h
    return ""


# ------------------------------------------------------------------ 读 xlsx（报价表）
def rows_from_xlsx(path: Path, source: str, synced_at: str) -> list[dict]:
    import openpyxl
    wb = openpyxl.load_workbook(str(path), data_only=True, read_only=True)
    ws = wb.worksheets[0]
    rows: list[dict] = []
    head: dict[str, int] | None = None
    for raw in ws.iter_rows(values_only=True):
        vals = [_txt(v) for v in raw]
        if head is None:
            if "产品名称" in vals and "零售价(元)" in vals:
                head = {v: i for i, v in enumerate(vals) if v}
            continue
        if not any(vals):
            continue

        def g(col: str) -> str:
            j = head.get(col)
            return vals[j] if j is not None and j < len(vals) else ""

        name = g("产品名称")
        if not name:
            continue
        code = g("图纸编号")
        if code in ("—", "-", "/"):
            code = ""
        category_text = g("产品分类")
        scheme = g("方案类型")
        blend = f"{name} {category_text} {code}"
        light = _is_light(blend) or category_text in ("射灯", "筒灯", "灯带", "双色温灯带")
        control, protocol = _proto(blend, scheme)
        cmin, cmax = _cct_range(g("色温(K)"))
        price = _num(g("零售价(元)"))
        rows.append(_row(
            id=_pid(source, g("品牌"), name, code, scheme, g("单位")),
            category="light" if light else "device",
            type=category_text or ("灯具" if light else "智能设备"),
            name=name, model=code, brand=g("品牌") or "摇光", scheme=scheme,
            unit=g("单位") or "个", warranty=g("质保"), cutout=g("开孔尺寸"),
            dimmable=g("是否调光"), watt=_num(g("功率(W)")), cct=g("色温(K)"),
            cct_min=cmin, cct_max=cmax, angle=_angle(name, code),
            price=price, price_source="零售价" if price is not None else "",
            control=control, protocol=protocol,
            dimmable_flag=1 if g("是否调光") == "是" else 0,
            tunable=1 if ("双色" in name or "调光" in name or (cmin and cmax and cmin != cmax)) else 0,
            price_verified=0,
            source=source, source_path=str(path),
            notes=f"知识库报价表 · {scheme or '未标方案'}",
            synced_at=synced_at,
        ))
    wb.close()
    return rows


# ------------------------------------------------------------------ 读 markdown
def rows_from_markdown(path: Path, source: str, default_brand: str, synced_at: str) -> list[dict]:
    """按 markdown 标题层级走。

    两种写法都认：
      · 产品表 —— `| 产品名称 | 型号 | 零售价 |`（价格只取零售价/市场价，出厂价不读）
      · 标题＋规格表 —— `### 五孔插座 `SC-SW1-01`` 这种，标题带型号就算一件产品（价格没有就留空，报价按待补）
    品牌按一级标题认（`# 一、摇光灯具` → 摇光）；模板 / 目录 / 附录 / 总览这类小节整段跳过。
    """
    body = KB.text(path)
    if not body:
        return []
    # 价目表类来源（如飞利浦）标题里天然带「速查 / 价格体系」，不能整段跳过
    skip_kw = tuple(k for k in SKIP_SECTION_KW if k not in ("速查", "价格体系", "解决方案", "智能解决")) if "飞利浦" in str(path) else SKIP_SECTION_KW
    lines = body.splitlines()
    rows: list[dict] = []
    brand = default_brand
    h1 = h2 = h3 = ""
    pending: dict | None = None
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.startswith("#"):
            level = len(line) - len(line.lstrip("#"))
            title = _clean_heading(line)
            if level == 1:
                brand = _brand_of(title, default_brand)
                h1, h2, h3 = title, "", ""
            elif level == 2:
                h2, h3 = title, ""
            else:
                h3 = title
            pending = None
            ctx = f"{h1} {h2} {h3}"
            if level >= 2 and not any(k in ctx for k in skip_kw):
                m = CODE_TOKEN_RE.search(line) or PAREN_CODE_RE.search(title)
                if m and _heading_ok(title):
                    pending = _heading_row(title, m.group(1), brand or default_brand, ctx, source, path, synced_at)
                    if pending:
                        rows.append(pending)
            i += 1
            continue
        if pending is not None:
            pm = PRICE_KEY_RE.search(line.strip())
            if pm:
                price = _num(pm.group(2))
                if price is not None:
                    pending["price"] = price
                    pending["price_source"] = pm.group(1)
                    pending["price_verified"] = 0
                pending = None
        nxt = lines[i + 1] if i + 1 < len(lines) else ""
        if line.lstrip().startswith("|") and nxt.lstrip().startswith("|") and \
                re.fullmatch(r"\|?[\s\-:|]+\|?", nxt.strip()):
            headers = [KB.clean(x) for x in line.strip().strip("|").split("|")]
            i += 2
            skip = any(k in f"{h1} {h2} {h3}" for k in skip_kw)
            while i < len(lines) and lines[i].lstrip().startswith("|"):
                cells = [KB.clean(x) for x in lines[i].strip().strip("|").split("|")]
                if len(cells) == len(headers) and not skip:
                    r = _md_row(headers, cells, brand or default_brand, h3 or h2 or h1, source, path, synced_at)
                    if r:
                        rows.append(r)
                i += 1
            continue
        i += 1
    return rows


def _heading_ok(title: str) -> bool:
    t = re.sub(r"`[^`]*`", "", title)
    t = re.sub(r"[（(][^)）]*[)）]", "", t).strip(" —-·:：")
    return len(t) >= 2 and t not in PLACEHOLDER and not any(k in t for k in ("模板", "规则", "示例"))


def _heading_row(title: str, code: str, brand: str, section: str, source: str,
                 path: Path, synced_at: str) -> dict | None:
    name = re.sub(r"`[^`]*`", "", title)
    name = re.sub(r"[（(][^)）]*[)）]", "", name).strip(" —-·:：")
    if len(name) < 2 or name in PLACEHOLDER:
        return None
    blend = f"{name} {code} {section}"
    category, kind = KB.product_kind(name, section, code)
    category = _fix_category(blend, category, kind)
    if category == "light" and kind in ("智能设备", "其他灯具"):
        kind = "其他灯具"
    control, protocol = _proto(blend, "")
    cmin, cmax = _cct_range(blend)
    return _row(
        id=_pid(source, brand, name, code, "", ""),
        category=category, type=kind, name=name, model=code, brand=brand,
        scheme="", unit="个", warranty="", cutout="", dimmable="调光" if control else "",
        watt=None, cct="", cct_min=cmin, cct_max=cmax, angle=_angle(name, code),
        price=None, price_source="", control=control, protocol=protocol,
        dimmable_flag=1 if control else 0,
        tunable=1 if "调光" in blend else 0, price_verified=0,
        source=source, source_path=str(path), notes=f"知识库 · {section}"[:200],
        synced_at=synced_at,
    )


def _md_row(headers: list[str], cells: list[str], brand: str, section: str,
            source: str, path: Path, synced_at: str) -> dict | None:
    row = dict(zip(headers, cells))
    name_col = _pick(headers, "产品名称", "品名", "名称", "产品")
    model_col = _pick(headers, "型号", "图纸编号", "货号")
    model = _txt(row.get(model_col)) if model_col else ""
    if model in ("—", "-", "/"):
        model = ""
    name = _txt(row.get(name_col)) if name_col else ""
    if not name:
        name = model                     # 像睿易那种表：型号就是产品名
    if name == model:
        # 价目表常把名称/功率写在参数列里（飞利浦：『名称：LED嵌入式深防眩射灯 … 功率：9W』）
        param_col = _pick(headers, "灯具参数", "参数", "规格")
        blob = _txt(row.get(param_col)) if param_col else ""
        m_name = re.search(r"名称[:：]\s*([^材功\n（(]+)", blob)
        m_watt = re.search(r"功率[:：]\s*([0-9.]+)\s*W", blob, re.I)
        if m_name:
            pretty = m_name.group(1).strip()
            if m_watt:
                pretty += f" {m_watt.group(1)}W"
            if len(pretty) >= 2:
                name = pretty
            if m_watt:
                row["__watt__"] = _num(m_watt.group(1))
    if len(name) < 2 or name in PLACEHOLDER:
        return None
    if any(k in name for k in ("模板", "规则", "示例", "合计")):
        return None
    price_col = _pick(headers, "零售价", "市场价")
    price = _num(row.get(price_col)) if price_col else None
    if price is None and not model:
        return None                      # 既没价也没型号：基本是表头/说明行
    power_col = _pick(headers, "功率")
    cct_col = _pick(headers, "色温")
    unit_col = _pick(headers, "单位")
    watt = _num(row.get(power_col)) if power_col else None
    cct = _txt(row.get(cct_col)) if cct_col else ""
    cct = re.sub(r"<br\s*/?>", "-", cct).replace("--", "-").strip(" -")
    model = re.sub(r"<br\s*/?>", " ", model).strip()
    unit = (_txt(row.get(unit_col)) if unit_col else "") or "个"
    if row.get("__watt__") is not None and watt is None:
        watt = row["__watt__"]
    blend = f"{name} {model} {section}"
    category, kind = KB.product_kind(name, section, model)
    category = _fix_category(blend, category, kind)
    if category == "light" and kind in ("智能设备", "其他灯具"):
        kind = "其他灯具"
    control, protocol = _proto(blend, "")
    cmin, cmax = _cct_range(cct or name)
    return _row(
        id=_pid(source, brand, name, model, "", ""),
        category=category, type=kind, name=name, model=model, brand=brand,
        scheme="", unit=unit, warranty="", cutout="",
        dimmable="调光" if control else "",
        watt=watt, cct=cct, cct_min=cmin, cct_max=cmax,
        angle=_angle(name, model), price=price,
        price_source="零售价" if price is not None else "",
        control=control, protocol=protocol,
        dimmable_flag=1 if control else 0,
        tunable=1 if ("调光" in blend or (cmin and cmax and cmin != cmax)) else 0,
        price_verified=0,
        source=source, source_path=str(path),
        notes=f"知识库 · {section}"[:200],
        synced_at=synced_at,
    )


# ------------------------------------------------------------------ 来源
def sources(products_root: Path) -> list[tuple[str, Path, str]]:
    """(来源名, 文件, 默认品牌) —— 顺序即优先级：报价表最优先，重复时它先占位。"""
    out: list[tuple[str, Path, str]] = []
    x = products_root / XLSX
    if x.is_file():
        out.append(("统一灯具报价表.xlsx", x, ""))
    it = products_root / INTEGRATED
    if it.is_file():
        out.append(("产品库全量整合.md", it, ""))
    for folder, brand in BRAND_DIRS.items():
        d = products_root / folder
        if not d.is_dir():
            continue
        for path in sorted(d.glob("*.md")):
            if path.name.startswith("_"):
                continue
            out.append((f"{folder}/{path.name}", path, brand))
    return out


def build(root: Path | str = KB.DEFAULT_ROOT, synced_at: str | None = None):
    root = Path(root)
    products_root = root / "15-产品库"
    synced_at = synced_at or time.strftime("%Y-%m-%d %H:%M:%S")
    rows: list[dict] = []
    seen: set[tuple] = set()
    warnings: list[str] = []
    per_source: dict[str, int] = {}
    if not root.is_dir():
        return [], [f"知识库目录不存在：{root}"], {"sources": [], "per_source": {}}
    for label, path, brand in sources(products_root):
        try:
            got = (rows_from_xlsx(path, label, synced_at) if path.suffix.lower() == ".xlsx"
                   else rows_from_markdown(path, label, brand, synced_at))
        except Exception as e:
            warnings.append(f"{label} 读不了：{type(e).__name__}: {e}")
            continue
        n = 0
        for r in got:
            # 型号是编号（D15 / SC-SW1-01）时按「品牌+型号+方案」去重：同型号的两种叫法只留一条；
            # 没型号的按「类别+品牌+名称」去重。
            if r["brand"] == "飞利浦" and r["model"]:
                key = (r["brand"], r["model"], r["scheme"], r["watt"], r["cct"])
            elif r["model"] and CODE_RE.match(r["model"]):
                key = (r["brand"], r["model"], r["scheme"])
            else:
                key = (r["category"], r["brand"], r["name"], r["model"], r["scheme"])
            if key in seen:
                continue
            seen.add(key)
            rows.append(r)
            n += 1
        if n:
            per_source[label] = n
    # 同一图纸编号零售价不一致：两条都留着，但必须让人看见
    by_code: dict[str, dict[float, list[str]]] = {}
    for r in rows:
        if r["model"] and CODE_RE.match(r["model"]) and r["price"] is not None:
            by_code.setdefault(r["model"], {}).setdefault(r["price"], []).append(r["brand"] or r["source"])
    conflicts = []
    for code, prices in sorted(by_code.items()):
        if len(prices) > 1:
            detail = "；".join(f"¥{p}（{'、'.join(sorted(set(v)))}）" for p, v in sorted(prices.items()))
            conflicts.append(f"{code} {detail}")
    if conflicts:
        warnings.append(f"{len(conflicts)} 个图纸编号有多个零售价（方案不同 / 资料版本不同），"
                        "报价前请核对： " + "； ".join(conflicts[:6]) + ("…" if len(conflicts) > 6 else ""))
    no_price = sum(1 for r in rows if r["price"] is None)
    if no_price:
        warnings.append(f"{no_price} 件资料里没写零售价，报价时按待补处理")
    meta = {"sources": [str(p) for _, p, _ in sources(products_root)], "per_source": per_source,
            "root": str(root)}
    return rows, warnings, meta


# ------------------------------------------------------------------ 写入 / 读取
def sync(db_path: Path | str | None = None, root: Path | str = KB.DEFAULT_ROOT) -> dict:
    """把知识库产品库写进工作台（整表刷新：知识库是唯一真源）。"""
    db_path = str(db_path or DEFAULT_DB)
    t0 = time.time()
    synced_at = time.strftime("%Y-%m-%d %H:%M:%S")
    rows, warnings, meta = build(root, synced_at)
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(db_path)
    con.executescript(DDL)
    con.execute("BEGIN IMMEDIATE")
    con.execute(f"DELETE FROM {TABLE}")
    con.executemany(f"INSERT INTO {TABLE}({','.join(COLS)}) VALUES({','.join('?' * len(COLS))})",
                    [[r[c] for c in COLS] for r in rows])
    con.execute("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)")
    con.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('products_build',?)", (BUILD_ID,))
    con.commit()
    con.close()
    by_cat: dict[str, int] = {}
    by_brand: dict[str, int] = {}
    for r in rows:
        by_cat[r["category"]] = by_cat.get(r["category"], 0) + 1
        b = r["brand"] or "未标品牌"
        by_brand[b] = by_brand.get(b, 0) + 1
    return {"total": len(rows), "by_category": by_cat, "by_brand": by_brand,
            "per_source": meta["per_source"], "sources": meta["sources"], "root": meta["root"],
            "warnings": warnings, "synced_at": synced_at, "scope": PRICE_SCOPE,
            "seconds": round(time.time() - t0, 2)}


def _to_api(r) -> dict:
    d = dict(r)
    d["power"] = d.get("watt") or 0
    # 刀2·R3：库里没色温 = 待核（None + cctPending），不再补 2700/6500 冒充可调。
    d["cctMin"] = d.get("cct_min") or None
    d["cctMax"] = d.get("cct_max") or None
    d["cctPending"] = not (d["cctMin"] and d["cctMax"])
    d["dimmable"] = bool(d.get("dimmable_flag"))
    d["tunable"] = bool(d.get("tunable"))
    d["priceVerified"] = bool(d.get("price_verified"))
    d["priceSource"] = d.get("price_source") or ""
    d["sourcePath"] = d.get("source_path") or ""
    d["amount"] = d.get("price")
    return d


def list_products(db_path: Path | str | None = None, category: str = "", brand: str = "",
                  q: str = "", scheme: str = "", source: str = "", limit: int = 0) -> list[dict]:
    db_path = str(db_path or DEFAULT_DB)
    if not Path(db_path).is_file():
        return []
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    sql = f"SELECT * FROM {TABLE} WHERE 1=1"
    args: list[Any] = []
    if category:
        sql += " AND category=?"
        args.append(category)
    if brand:
        sql += " AND brand=?"
        args.append(brand)
    if scheme:
        sql += " AND scheme=?"
        args.append(scheme)
    if source:
        sql += " AND source=?"
        args.append(source)
    if q:
        sql += " AND (name LIKE ? OR model LIKE ? OR brand LIKE ? OR type LIKE ?)"
        like = f"%{q}%"
        args += [like, like, like, like]
    # 灯具排前面（这是灯光工作台），再按品牌 / 类型 / 名称
    sql += " ORDER BY CASE category WHEN 'light' THEN 0 ELSE 1 END, brand, type, name"
    if limit:
        sql += f" LIMIT {int(limit)}"
    try:
        rows = con.execute(sql, args).fetchall()
    except Exception:
        rows = []
    con.close()
    return [_to_api(r) for r in rows]


def status(db_path: Path | str | None = None, root: Path | str = KB.DEFAULT_ROOT) -> dict:
    db_path = str(db_path or DEFAULT_DB)
    base = {"loaded": False, "total": 0, "root": str(root), "synced_at": "", "by_category": {},
            "by_brand": {}, "by_source": {}, "no_price": 0, "warnings": [], "scope": PRICE_SCOPE}
    if not Path(db_path).is_file():
        return base
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    try:
        total = con.execute(f"SELECT COUNT(*) FROM {TABLE}").fetchone()[0]
        synced = con.execute(f"SELECT MAX(synced_at) FROM {TABLE}").fetchone()[0] or ""
        by_cat = {r[0]: r[1] for r in con.execute(f"SELECT category, COUNT(*) FROM {TABLE} GROUP BY category")}
        by_brand = {r[0] or "未标品牌": r[1] for r in con.execute(
            f"SELECT brand, COUNT(*) FROM {TABLE} GROUP BY brand ORDER BY COUNT(*) DESC")}
        by_source = {r[0]: r[1] for r in con.execute(
            f"SELECT source, COUNT(*) FROM {TABLE} GROUP BY source ORDER BY COUNT(*) DESC")}
        no_price = con.execute(f"SELECT COUNT(*) FROM {TABLE} WHERE price IS NULL").fetchone()[0]
    except Exception:
        total, synced, by_cat, by_brand, by_source, no_price = 0, "", {}, {}, {}, 0
    con.close()
    out = dict(base)
    out.update({"loaded": total > 0, "total": total, "synced_at": synced, "by_category": by_cat,
                "by_brand": by_brand, "by_source": by_source, "no_price": no_price})
    if no_price:
        out["warnings"] = [f"{no_price} 件资料里没写零售价，报价时按待补处理"]
    return out


def _sources_mtime(root: Path | str) -> str:
    newest = 0.0
    for _, path, _ in sources(Path(root) / "15-产品库"):
        try:
            newest = max(newest, path.stat().st_mtime)
        except OSError:
            pass
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(newest)) if newest else ""


def ensure_loaded(db_path: Path | str | None = None, root: Path | str | None = None) -> dict:
    """启动时调：先看随源码分发的 products.json；有外部产品源才走解析。"""
    db_path = str(db_path or DEFAULT_DB)
    root = Path(root or KB.DEFAULT_ROOT)
    # 没有外部产品源（源码分发场景）→ 用随源码带的 products.json
    if not (root / "15-产品库").is_dir():
        return load_seed(db_path)
    try:
        st = status(db_path, root)
    except Exception:
        return load_seed(db_path)
    if st["total"] <= 0:
        return sync(db_path, root)
    built = ""
    try:
        con = sqlite3.connect(db_path)
        con.execute("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)")
        row = con.execute("SELECT value FROM meta WHERE key='products_build'").fetchone()
        built = row[0] if row else ""
        con.close()
    except Exception:
        pass
    if built != BUILD_ID:
        out = sync(db_path, root)
        out["reason"] = "解析口径更新"
        return out
    newest = _sources_mtime(root)
    if newest and newest > (st.get("synced_at") or ""):
        out = sync(db_path, root)
        out["reason"] = "知识库产品资料有更新"
        return out
    return {"skipped": True, **st}


if __name__ == "__main__":
    import json
    import sys
    arg = sys.argv[1] if len(sys.argv) > 1 else None
    print(json.dumps(sync(arg), ensure_ascii=False, indent=1))
    print(json.dumps(status(arg), ensure_ascii=False, indent=1))


# ------------------------------------------------------------------ 随源码分发的产品库
SEED_FILE = LOCAL_DATA_DIR / "products.json" if (LOCAL_DATA_DIR := (Path(__file__).resolve().parent / "local_data")).exists() else Path(__file__).resolve().parent / "local_data" / "products.json"


def load_seed(db_path: Path | str | None = None, seed_path: Path | str | None = None) -> dict:
    """把 backend/local_data/products.json 灌进 products 表（不读知识库，源码自带数据）。"""
    db_path = str(db_path or DEFAULT_DB)
    sp = Path(seed_path or SEED_FILE)
    if not sp.is_file():
        return {"total": 0, "skipped": True, "reason": "没有随源码分发的产品数据"}
    payload = json.loads(sp.read_text(encoding="utf-8"))
    rows = payload.get("products") or []
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(db_path)
    try:
        con.executescript(DDL)
        con.execute("BEGIN IMMEDIATE")
        # 增量补齐（不删已有产品：本地品牌库继续保留）
        con.executemany(f"INSERT OR REPLACE INTO {TABLE}({','.join(COLS)}) VALUES({','.join('?' * len(COLS))})",
                        [[r.get(c) for c in COLS] for r in rows])
        con.execute("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)")
        con.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('products_build',?)", (BUILD_ID,))
        con.commit()
    finally:
        con.close()
    return {"total": len(rows), "synced_at": payload.get("syncedAt"), "scope": payload.get("priceScope"), "seeded": True}
