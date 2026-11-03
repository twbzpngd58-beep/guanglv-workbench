"""§8.3 电工接手验收清单（12 条二值）＋ §8.2 图框三字段 ＋ §7.8 交底签字落库。

判定线（§8.3 原文照搬）：12 条全「是」＝可开工；仅 3、11 条为否且属缺件红项＝只做不封板的活；
其余任一否＝不接手。

三条口径先说死，免得后来人以为机器替人点了头：
1. 判据全部从项目数据派生（缺件单／回路算式／取电链／材料表对账），人不填就永远是否；
2. 签字是「人对这条判据的确认」，签了「否」还是否——签字不改变事实，只闭环责任（Q16）；
3. 签字记当时的 revision；设计再改动，旧签字自动标失效，要重签（§7.8 留人留时间的另一半是留版本）。
"""
from __future__ import annotations

import re

from . import quality as Q
from . import v3_fields as V

YES, NO = "是", "否"

# §8.3 表里的「若否，电工的处境」原文，导出件上必须带——工人看得懂后果才叫交底。
ITEMS = [
    {"no": 1, "q": "每个灯位都有暗盒规格＋定位（X/Y/Z 或双基准）？",
     "if_no": "封板前没有预埋依据，只能按经验放盒——会砸墙",
     "open": {"fixture": {"d9_1", "d9_2", "x/y", "installHeight"}},
     "need": {"fixture"}, "preseal": "暗盒", "top10": [1]},
    {"no": 2, "q": "每个开孔都有孔径＋对应 SKU＋净空？",
     "if_no": "开孔凭手感，装不进或漏光",
     "open": {"fixture": {"d10_1", "d10_2", "d10_3"}, "mount": {"sku"}},
     "need": {"fixture"}, "preseal": "开孔", "top10": [2, 3]},
    {"no": 3, "q": "每个灯位避让状态都不是「冲突未解／待现场确认」？",
     "if_no": "不敢封板，或封了必拆",
     "open": {"fixture": {"d11"}},
     "need": {"fixture"}, "preseal": "避让", "top10": [4]},
    {"no": 4, "q": "封板前交底单逐项已签认（暗盒／开孔／驱动位／取电位／避让）？",
     "if_no": "只能自己猜，责任说不清",
     "preseal": None, "top10": [4]},
    {"no": 5, "q": "回路表九字段齐全，功率合计与线径、断路器匹配？",
     "if_no": "配不出配电箱，会跳闸",
     "open": {"circuit": {f["key"] for f in V.CIRCUIT_FIELDS if f["tier"] != V.DERIVED}},
     "need": {"circuit"}, "top10": [6]},
    {"no": 6, "q": "系统图能从进户追到每个回路末端？",
     "if_no": "不知道线往哪接",
     "need": {"circuit", "power_entry", "fixture"}, "top10": [6]},
    {"no": 7, "q": "每个驱动有位置＋参数＋带灯数／回路？",
     "if_no": "驱动位置无人知，坏了拆顶",
     "open": {"fixture": {"d4_1", "d4_2", "d4_3"}},
     "na_when_empty": {"fixture": {"d4_1"}}, "top10": [5, 7]},
    {"no": 8, "q": "进户有相数／容量／进线位置，主进线有线径与敷设方式？",
     "if_no": "总包不给你接",
     "open": {"power_entry": {"d8_1", "d8_3"}},
     "need": {"power_entry"}, "top10": []},
    {"no": 9, "q": "配电箱有位置＋尺寸＋位数（含备用）？",
     "if_no": "箱买错、装不下",
     "open": {"power_entry": {"d8_2"}},
     "need": {"power_entry"}, "top10": []},
    {"no": 10, "q": "每个柜体柜格有取电点（位置／用途／回路／预留）？",
     "if_no": "柜装完再开孔，板材报废",
     "open": {"power_entry": {"d8_4", "d8_5"}, "mount": {"plate_id", "u", "v", "circuit_id"}},
     "na_when_empty": {"cabinet"}, "top10": [8]},
    {"no": 11, "q": "材料表 SKU 数量与图面灯位差异为 0，缺型号项全部标红在缺件单？",
     "if_no": "到场少件错件，停工等货",
     "open": {"fixture": {"d10_2"}},
     "need": {"fixture"}, "top10": [9]},
    {"no": 12, "q": "图号／版本／日期唯一且是最新一版？",
     "if_no": "按旧图干，返工",
     "top10": [10]},
]

# §8.3 第 4 条的封板前五类（原文口径：暗盒／开孔／驱动位／取电位／避让）。
PRESEAL_CATEGORIES = ("暗盒", "开孔", "驱动位", "取电位", "避让")

LINE_OK, LINE_NOSEAL, LINE_STOP = "可开工", "只做不封板的活", "不接手"

# D3 同口径的参考载流量：只作读数参考，未附型号手册时不作判据（basis 里如实标注）。
WIRE_AMPACITY_REF = {1.5: 13.0, 2.5: 20.0, 4.0: 27.0}
WIRE_AMPACITY_BASIS = ("线径载流量按 D3 参考值（1.5→13A / 2.5→20A / 4→27A），"
                       "未附电缆型号手册，属" + V.NEED_VERIFY_MARK + "读数，签署人须按实载复核")
VOLTAGE_REF = 220.0

# §8.2 图框行 + Q17 裁决：1.0 只落图号/版本/日期三字段，变更记录进 1.x。
SHEETS = {
    "plan": ("平面布置图", "PM"),
    "circuit": ("回路表", "EL"),
    "material": ("材料表", "ML"),
    "missing": ("缺件单", "MI"),
    "handover": ("电工交底页", "HD"),
    "dxf": ("成品 DXF 平面图", "DX"),
    "scene": ("灯光情景演示", "SC"),
    "panels": ("面板刻字排版图", "PN"),
    "data": ("结构化数据包", "JS"),
}


def _num(v):
    return Q._num(v)


def _design(p: dict) -> dict:
    d = p.get("design")
    return d if isinstance(d, dict) else {}


def _field_of(field_path: str) -> str:
    try:
        return V.parse_path(str(field_path))[2]
    except ValueError:
        return str(field_path).rsplit(".", 1)[-1]


def open_rows(p: dict) -> list[dict]:
    """未回填的缺件行（已豁免的也算断链，但不再算「未回填」——§7.8 硬规矩 4）。"""
    return [r for r in Q.missing_items(p) if r["status"] == "未回填"]


def _open_index(rows: list[dict]) -> dict:
    idx: dict[tuple[str, str], list[dict]] = {}
    for r in rows:
        idx.setdefault((r["kind"], _field_of(r["field_path"])), []).append(r)
    return idx


def _refs(rows: list[dict], limit: int = 12) -> list[str]:
    return [r["field_path"] for r in rows[:limit]]


def _red_only(rows: list[dict]) -> bool:
    """§8.3 判定线里「属缺件红项」的机器口径：造成这条为否的原因全是缺件单里
    未回填的标红行（缺数据）。人已经填过但填的是「冲突未解」＝看过未决，
    不是缺件红项——那种情况不能按「只做不封板」放行。"""
    return bool(rows) and all(r.get("redmark") and r["status"] == "未回填" for r in rows)


# ---------------------------------------------------------------- 结构判据

def circuit_loads(p: dict) -> list[dict]:
    """回路电流按 Σ 灯位功率 / 220V 推定，与断路器额定、线径载流量对账。"""
    d = _design(p)
    circuits = [c for c in d.get("circuits") or [] if isinstance(c, dict)]
    fixtures = [f for f in d.get("fixtures") or [] if isinstance(f, dict)]
    out = []
    for c in circuits:
        cid = str(c.get("id") or c.get("circuit_no") or "")
        members = [f for f in fixtures
                   if cid and str(f.get("circuitId") or "") == cid]
        watts = sum(_num(f.get("power")) or 0.0 for f in members)
        amps = round(watts / VOLTAGE_REF, 2) if watts else 0.0
        mb = re.search(r"(\d+(?:\.\d+)?)\s*[Aa]", str(c.get("breaker") or ""))
        breaker = float(mb.group(1)) if mb else None
        gauge = _num(c.get("wire_gauge"))
        cap = WIRE_AMPACITY_REF.get(gauge) if gauge in WIRE_AMPACITY_REF else None
        problems = []
        if breaker is None:
            problems.append("断路器额定读不出（要形如 1P-10A）")
        elif amps and breaker < amps:
            problems.append(f"断路器 {breaker:g}A < 回路电流 {amps:g}A：频跳闸")
        if cap is None:
            problems.append("线径不在 1.5/2.5/4 参考表内，载流量无法核")
        elif breaker is not None and breaker > cap:
            problems.append(f"断路器 {breaker:g}A > 线径 {gauge:g}mm² 参考载流量 {cap:g}A：线发热无保护")
        out.append({"circuit": c.get("circuit_no") or cid, "watts": round(watts, 1),
                    "amps": amps, "breaker": breaker, "gauge": gauge,
                    "ampacity": cap, "problems": problems})
    return out


def _circuit_ids(p: dict) -> set:
    return {str(c.get("id") or "") for c in _design(p).get("circuits") or []
            if isinstance(c, dict)}


def _panel_ids(p: dict) -> set:
    d = _design(p)
    ids = set()
    for e in d.get("powerEntries") or []:
        if isinstance(e, dict):
            ids.add(str(e.get("id") or ""))
    for dev in d.get("devices") or []:
        if isinstance(dev, dict) and dev.get("type") in ("配电箱", "配电柜"):
            ids.add(str(dev.get("id") or ""))
    return ids


def chain_state(p: dict) -> dict:
    """第 6 条：进户→箱→回路→灯位单线链，断在哪一环就写哪一环。"""
    d = _design(p)
    entries = [e for e in d.get("powerEntries") or [] if isinstance(e, dict)]
    circuits = [c for c in d.get("circuits") or [] if isinstance(c, dict)]
    fixtures = [f for f in d.get("fixtures") or [] if isinstance(f, dict)
                and f.get("type") != "窗帘"]
    pids, cids = _panel_ids(p), _circuit_ids(p)
    breaks = []
    if not entries:
        breaks.append("没有进户/配电箱台账：链头缺失")
    no_panel = [str(c.get("circuit_no") or c.get("id") or "") for c in circuits
                if not V.is_named(c.get("panel_id"))
                or str(c.get("panel_id")) not in pids]
    if no_panel:
        breaks.append(f"{len(no_panel)} 个回路没挂到存在的配电箱：" + "、".join(x for x in no_panel[:5] if x))
    orphan = [str(f.get("code") or f.get("id") or "") for f in fixtures
              if not V.is_named(f.get("circuitId"))
              or str(f.get("circuitId")) not in cids]
    if orphan:
        breaks.append(f"{len(orphan)} 个灯位不在任何回路里（孤儿灯）：" + "、".join(x for x in orphan[:5] if x))
    return {"entries": len(entries), "circuits": len(circuits), "fixtures": len(fixtures),
            "breaks": breaks}


def material_table(p: dict) -> list[dict]:
    """材料表按 SKU（品牌＋型号＋功率＋色温）聚合；无型号的进「待选」桶，不允许隐身。"""
    d = _design(p)
    room_names = {r.get("id"): r.get("name") for r in d.get("rooms") or []
                  if isinstance(r, dict)}
    buckets: dict[tuple, dict] = {}
    for f in d.get("fixtures") or []:
        if not isinstance(f, dict) or f.get("type") == "窗帘":
            continue
        sku_ok = V.is_named(f.get("model")) or V.is_named(f.get("d10_2"))
        key = ((f.get("brand") or "品牌待选"),
               (f.get("model") or f.get("d10_2") or "（缺型号·待选）") if sku_ok else "（缺型号·待选）",
               str(f.get("power") or ""), str(f.get("cct") or ""))
        row = buckets.setdefault(key, {
            "brand": key[0], "model": key[1], "power": key[2], "cct": key[3],
            "qty": 0, "positions": [], "sku_pending": not sku_ok})
        row["qty"] += 1
        row["positions"].append("%s/%s" % (room_names.get(f.get("roomId"), "未分配"),
                                           f.get("code") or f.get("id") or ""))
    return sorted(buckets.values(), key=lambda r: (r["sku_pending"], r["brand"], r["model"]))


def material_reconcile(p: dict) -> dict:
    """第 11 条：表上数量合计 vs 图面灯位数，差异必须＝0；缺型号项必须都在缺件单里标红。"""
    d = _design(p)
    n_plan = len([f for f in d.get("fixtures") or [] if isinstance(f, dict)
                  and f.get("type") != "窗帘"])
    mt = material_table(p)
    n_mat = sum(r["qty"] for r in mt)
    pending = [r for r in mt if r["sku_pending"]]
    rows = open_rows(p)
    sku_open = [r for r in rows if r["kind"] == "fixture" and _field_of(r["field_path"]) == "d10_2"]
    unred = [r["id"] for r in sku_open if not r["redmark"]]
    return {"planCount": n_plan, "materialCount": n_mat, "diff": n_mat - n_plan,
            "pendingSkus": [{"model": r["model"], "qty": r["qty"]} for r in pending],
            "missingModelCount": len(sku_open), "notRedMarked": unred,
            "rows": mt}


# ---------------------------------------------------------------- 签字

def signs(p: dict) -> dict:
    out = {}
    for s in _design(p).get("handoverSigns") or []:
        if isinstance(s, dict) and s.get("key") and s.get("by"):
            out[str(s["key"])] = s
    return out


def sign(p: dict, key: str, by: str, note: str = "") -> dict:
    """交底签字必须留人（§7.8 同一条硬规矩用在签字上）；同时记下当时的版本。"""
    key = str(key or "").strip()
    if not key:
        raise ValueError("签字必须指明签哪一条")
    if not (by or "").strip():
        raise ValueError("交底签字必须留人")
    d = _design(p)
    rec = {"key": key, "by": str(by)[:100], "at": Q._now(),
           "revision": p.get("revision"), "note": str(note or "")[:300]}
    rows = d.setdefault("handoverSigns", [])
    rows[:] = [s for s in rows if isinstance(s, dict) and str(s.get("key")) != key]
    rows.append(rec)
    return rec


def sign_state(p: dict, key: str) -> dict:
    s = signs(p).get(key)
    if not s:
        return {"signed": False, "by": "", "at": "", "valid": False, "why": "未签"}
    stale = s.get("revision") != p.get("revision")
    return {"signed": True, "by": s.get("by") or "", "at": s.get("at") or "",
            "revision": s.get("revision"), "note": s.get("note") or "",
            "valid": not stale,
            "why": "签字后设计有改动，本条签字已失效，须重签" if stale else ""}


# ---------------------------------------------------------------- 图框三字段

def drawing_no(p: dict, sheet: str, floor: int | None = None) -> str:
    code = re.sub(r"[^\w\-]", "_", str(p.get("code") or "PROJECT"))
    abbr = SHEETS.get(sheet, (sheet, "DW"))[1]
    return f"{code}-{abbr}-F{floor}" if (sheet == "plan" and floor) else f"{code}-{abbr}"


def version_tag(p: dict) -> str:
    return f"V{int(p.get('version') or 0):02}_R{int(p.get('revision') or 0):03}"


def issue_date(p: dict) -> str:
    return str(p.get("updatedAt") or "")[:10]


def frame(p: dict, sheet: str, floor: int | None = None) -> dict:
    """§8.2 图框行 + Q17：图号/版本/日期三字段为准，其余只做提示不缺件。"""
    title, _ = SHEETS.get(sheet, (sheet, "DW"))
    fl = floor_label(p, floor) if floor else ""
    return {
        "sheet": sheet,
        "drawing_no": drawing_no(p, sheet, floor),
        "title": f"{title}{('·' + fl) if fl else ''}",
        "project": str(p.get("name") or ""),
        "version": version_tag(p),
        "date": issue_date(p),
        "designer": str(p.get("designer") or ""),
        "gaps": [x for x in (("图号" if not p.get("code") else ""),
                            ("版本" if not (p.get("version") or p.get("revision")) else ""),
                            ("日期" if not issue_date(p) else "")) if x],
        "label": "｜".join([x for x in (
            f"图号 {drawing_no(p, sheet, floor)}",
            f"版本 {version_tag(p)}",
            f"出图日期 {issue_date(p) or '未记录'}",
            f"图名 {title}", f"项目 {p.get('name') or '未命名'}",
            f"设计人 {p.get('designer') or '未填'}") if x]),
    }


def floor_label(p: dict, floor) -> str:
    from .floors import floor_label as fl
    try:
        return fl(int(floor), p.get("basements", 0))
    except Exception:
        return f"{floor}F"


def registry_state(p: dict, sheets: list[tuple] | None = None) -> dict:
    """图号唯一性：同一图号只能属于一张图；同图号不同版本是改版，记成「旧版待回收」。"""
    reg = _design(p).get("drawingRegistry")
    reg = reg if isinstance(reg, dict) else {}
    items = sheets if sheets is not None else [(s, None) for s in SHEETS]
    owner: dict[str, str] = {}
    dup, stale, current = [], [], []
    for sheet, floor in items:
        fr = frame(p, sheet, floor)
        key = fr["drawing_no"] + (f"|F{floor}" if floor else "")
        if fr["gaps"]:
            dup.append(f"{key}：缺 {'、'.join(fr['gaps'])}")
        prev = reg.get(key)
        if isinstance(prev, dict) and prev.get("version") and prev["version"] != fr["version"]:
            stale.append({"drawing_no": key, "issued": prev["version"], "now": fr["version"],
                          "at": prev.get("at") or ""})
        current.append(key)
        if key in owner and owner[key] != sheet:
            dup.append(f"{key}：图号被 {owner[key]} 与 {sheet} 同时占用")
        owner[key] = sheet
    return {"unique": not dup, "problems": dup, "outdatedIssues": stale,
            "registered": len(current),
            "rule": "图号＝项目编号＋图别（+楼层）；同图号出过旧版要回收替换（§8.2 图框行 / Q17 三字段）"}


def register_frames(p: dict, sheets: list[tuple] | None = None) -> dict:
    """出图即登记：把本次图号/版本/日期写进 drawingRegistry，供「按旧图干」对账。"""
    d = _design(p)
    reg = d.setdefault("drawingRegistry", {})
    items = sheets if sheets is not None else [(s, None) for s in SHEETS]
    for sheet, floor in items:
        fr = frame(p, sheet, floor)
        reg[fr["drawing_no"] + (f"|F{floor}" if floor else "")] = {
            "sheet": sheet, "version": fr["version"], "date": fr["date"], "at": Q._now()}
    return reg


# ---------------------------------------------------------------- 12 条判据

def _empty_na(p: dict, item: dict) -> tuple[bool, str]:
    """「不适用」不是「通过」：只有这一条根本不存在对象时才允许标不适用，并写出为什么。"""
    need = item.get("na_when_empty")
    if not need:
        return False, ""
    d = _design(p)
    if "fixture" in need:
        driver = [f for f in d.get("fixtures") or [] if isinstance(f, dict)
                  and (Q._needs_driver(f) or f.get("type") == "灯带" or f.get("powerSupply"))]
        if not driver:
            return True, "不适用：项目里没有带外接驱动的灯具（灯带/调光/带电源），无驱动可交"
    if "cabinet" in need and not d.get("cabinets"):
        return True, "不适用：项目里没有柜体，柜内取电无从谈起"
    return False, ""


def handover(p: dict) -> dict:
    """§8.3 十二条：每条一个二值判据＋依据＋回填口＋签字位。"""
    d = _design(p)
    rows = open_rows(p)
    idx = _open_index(rows)
    loads = circuit_loads(p)
    chain = chain_state(p)
    mat = material_reconcile(p)
    reg = registry_state(p)
    fixtures = [f for f in d.get("fixtures") or [] if isinstance(f, dict)]

    out = []
    for item in ITEMS:
        no, basis, refs = item["no"], [], []
        na, na_why = _empty_na(p, item)
        rows_behind = []
        # structural＝否的原因里掺了「不是缺数据」的成分（链断、未签、旧图）；
        # §8.3 判定线只对缺件红项松口，这类否必须走「不接手」。
        structural = False
        red_only = None
        for table, keys in (item.get("open") or {}).items():
            for k in keys:
                hit = idx.get((table, k)) or []
                rows_behind += hit
                if hit:
                    basis.append(f"{table}.{k} 未回填 {len(hit)} 处")
                    refs += _refs(hit)
        verdict, why = YES, []
        if na:
            basis.append(na_why)
            why = [na_why]
        elif item.get("need"):
            missing_obj = [t for t in item["need"]
                           if not [x for x in Q.v3_objects(p) if x[0] == t]]
            if missing_obj:
                verdict = NO
                structural = True
                why.append("对象层为空：" + "、".join(missing_obj) + " 一个都没有，机器不能说「是」")
        if verdict == YES and rows_behind:
            verdict = NO
            why += [f"{r['field_path']}（{r['what']}｜{r['severity']}｜{r['ask_whom']}）"
                    for r in rows_behind[:6]]
            if len(rows_behind) > 6:
                why.append(f"…另有 {len(rows_behind) - 6} 处同类")
        # 每条专属的结构判据
        if no == 3:
            blank = [f for f in fixtures if not V.is_named(f.get("d11"))]
            undecided = [f for f in fixtures
                         if str(f.get("d11") or "").strip() in ("待现场确认", V.D11_DEFAULT)]
            bad = blank + undecided
            if bad:
                verdict = NO
                why.append(f"{len(bad)} 个灯位避让状态是「冲突未解／待现场确认/空」"
                           f"（D11 默认值＝{V.D11_DEFAULT}，默认不算已核）")
                refs += [V.path("fixture", str(f.get("id") or ""), "d11") for f in bad[:6]]
                # 只有「没填」才是缺件红项；填了「冲突未解」是人看过未决，不能按不封板放行。
                red_only = bool(blank) and not undecided
        elif no == 4:
            miss_cat = []
            for cat in PRESEAL_CATEGORIES:
                st = sign_state(p, "preseal:" + cat)
                if not (st["signed"] and st["valid"]):
                    miss_cat.append(f"{cat}（{st['why'] or '签字已失效'}）")
            if miss_cat:
                verdict = NO
                structural = True
                why.append("封板前项未签认：" + "、".join(miss_cat))
        elif no == 5:
            bad = [x for x in loads if x["problems"]]
            if bad and verdict == YES:
                verdict = NO
                structural = True
                why += [f"回路 {x['circuit']}：{ '；'.join(x['problems'])}"
                        f"（{x['watts']:g}W→{x['amps']:g}A）" for x in bad[:5]]
                basis.append(WIRE_AMPACITY_BASIS)
            elif loads:
                basis.append(WIRE_AMPACITY_BASIS)
        elif no == 6:
            if chain["breaks"]:
                verdict = NO
                structural = True
                why += chain["breaks"]
            why = why or [f"进户 {chain['entries']} 条／回路 {chain['circuits']} 个／"
                          f"灯位 {chain['fixtures']} 个：单线链无断点"]
        elif no == 11:
            # 「差异＝0」与「缺型号项全部标红」是两个条件；对电工来说，还有 待选 型号
            # 就是买不到货，所以缺型号项存在即为否——只有「纯粹缺数据且已标红」才走不封板口。
            if mat["diff"] or mat["notRedMarked"] or mat["missingModelCount"]:
                verdict = NO
                if mat["diff"] or mat["notRedMarked"]:
                    structural = True
                if mat["diff"]:
                    why.append(f"材料表合计 {mat['materialCount']} 与图面灯位 {mat['planCount']} 差 "
                               f"{mat['diff']:+d} 盏（要求＝0）")
                if mat["notRedMarked"]:
                    why.append(f"{len(mat['notRedMarked'])} 个缺型号灯位未在缺件单标红（静默吞掉）")
                if mat["missingModelCount"]:
                    why.append(f"缺型号 {mat['missingModelCount']} 项：到场少件错件，停工等货")
            else:
                why = [f"材料表 {mat['materialCount']} 盏＝图面 {mat['planCount']} 盏；无缺型号项"]
        elif no == 12:
            if not reg["unique"] or reg["outdatedIssues"]:
                verdict = NO
                structural = True
                why += reg["problems"][:5]
                if reg["outdatedIssues"]:
                    why.append(f"{len(reg['outdatedIssues'])} 个图号出过旧版未回收：" +
                               "、".join(f"{x['drawing_no']}（{x['issued']}）"
                                        for x in reg["outdatedIssues"][:5]))
            else:
                why = [f"图号 {reg['registered']} 个全部唯一；当前版本 {version_tag(p)}"
                       f"·出图日期 {issue_date(p) or '未记录'}"]
                if not d.get("drawingRegistry"):
                    why.append("图号登记表还是空：本次是首次出图，没有旧版可对账")

        key = "item:%d" % no
        st = sign_state(p, key)
        if red_only is None:
            red_only = verdict == NO and not structural and _red_only(rows_behind)
        out.append({
            "no": no, "question": item["q"], "if_no": item["if_no"],
            "verdict": verdict, "na": na,
            "basis": basis or [], "why_no": why if verdict == NO else [],
            "evidence": why if verdict == YES and not basis else [],
            "refs": sorted(set(refs))[:20],
            "red_only": red_only, "openCount": len(rows_behind),
            "sign": st, "sign_key": key, "top10": item.get("top10") or [],
        })

    nos = [r for r in out if r["verdict"] == NO]
    ids = {r["no"] for r in nos}
    if not nos:
        line, line_why = LINE_OK, "12 条全「是」：电工只看图能直接干"
    elif ids and ids <= {3, 11} and all(r["red_only"] for r in nos):
        line, line_why = LINE_NOSEAL, (
            "只有第 " + "、".join(str(x) for x in sorted(ids)) +
            " 条为否，且都是缺件单里的标红断链：可以做不封板的活，封板前必须回填并重签")
    else:
        line, line_why = LINE_STOP, (
            "第 " + "、".join(str(x) for x in sorted(ids)) +
            " 条为否（不止 3、11 条的缺件红项）：不接手，先把这些缺口补齐")
    signed = [r for r in out if r["sign"]["signed"] and r["sign"]["valid"]]
    return {
        "items": out,
        "yesCount": len(out) - len(nos),
        "noCount": len(nos),
        "noItems": sorted(ids),
        "line": line, "lineWhy": line_why,
        "allYes": not nos,
        "signsDone": len(signed), "signsRequired": len(out),
        "signsComplete": len(signed) == len(out),
        "preseal": {c: sign_state(p, "preseal:" + c) for c in PRESEAL_CATEGORIES},
        "chain": chain, "material": mat,
        "circuits": loads, "registry": reg,
        "rule": "12 条全「是」＝可开工；仅 3、11 条为否且属缺件红项＝只做不封板的活；"
                "其余任一否＝不接手（§8.3 判定线）",
    }


def handover_a11(p: dict) -> dict:
    """A11 施工可交接口径：12 条全「是」＋逐项签字（Q16）齐且在当前 revision 上有效。"""
    h = handover(p)
    return {"allYes": h["allYes"], "signsComplete": h["signsComplete"],
            "line": h["line"], "noItems": h["noItems"],
            "unsigned": [r["no"] for r in h["items"]
                         if not (r["sign"]["signed"] and r["sign"]["valid"])],
            "pass": h["allYes"] and h["signsComplete"]}
