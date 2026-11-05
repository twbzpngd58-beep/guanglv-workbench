"""conflict_scan — §10.4 三类冲突（开孔／回路／空间）的 v0 扫描（§11 阶段 5）。

口径（逐条对着定稿写，不擅自加戏）：
· v0 只做硬的：开孔 ①②③、回路 ①③＝阻断；回路 ②④、空间 ②＝提示，不进 1.0 拦截。
· 实现按 §10.4 实现建议：全降成「2D 圆／矩形 ＋ 高度区间一维相交」，不引几何内核。
· 三处共用一张冲突表——写在 projects.doc 的 collab.conflicts，字段与 §10.3 同一张
  （conflict_id／type／涉及对象／rule_id／severity／原始值／建议值／状态）。
· 只标记不自动修；决策层永远在人（§10.3）。
· 尺度未核时空间规则不判红：图内坐标单位没核到 verified，就只报「未核」，
  不许说定位尺寸冲突（§14 尺度红线）。
· 建议值只给「按现场已填尺寸该怎么挪」的算法结果，不声称加工尺寸已核实。
"""
from __future__ import annotations
import math
import re
from fastapi import APIRouter, HTTPException

from . import brandwall as W
from . import circuit_rules as CR
from . import quality as Q
from . import supplier_pack as SP
from . import v3_fields as V

router = APIRouter(prefix="/api/conflict", tags=["conflict"])

EDGE_GAP_MM = SP.EDGE_GAP_MIN_MM          # §14 拍板 6：留边起值 10mm
REQUIRED_MIN_GAP_MM = 0.0                  # 最小间距＝半径和＋留边（不再叠经验值）
UNKNOWN = "unknown"

# rule_id → (类型, 严重度, 一句话规则)
RULES = {
    "K1": ("开孔", V.BLOCK, "同板两孔心距 < 两孔半径和＋留边"),
    "K2": ("开孔", V.BLOCK, "孔出板边，或孔心到板边 < 留边"),
    "K3": ("开孔", V.BLOCK, "图注开孔孔径 ≠ SKU 手册孔径"),
    "L1": ("回路", V.BLOCK, "孤儿灯：灯位没挂到存在的回路"),
    "L3": ("回路", V.BLOCK, "同一通道挂了两条回路（回路与通道须 1:1）"),
    "L2": ("回路", V.HINT, "回路功率 > 断路器×电压×PF×降额（系数【需核验】）"),
    "L4": ("回路", V.HINT, "一回路灯数 > 网关/继电器参考上限（未附手册）"),
    "S1": ("空间", V.BLOCK, "灯体／暗盒／驱动包围盒相交"),
    "S2": ("空间", V.HINT, "吊顶净高 < 暗盒深＋驱动厚"),
}


def _num(v, default=0.0):
    try:
        f = float(str(v).strip())
    except (TypeError, ValueError):
        return default
    return f if math.isfinite(f) else default


def _mm_only(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _phi(text):
    """从「φ75／75mm／开孔 75」里取直径 mm；取不到＝None（不猜）。"""
    return W._cutout_mm(text)


def _height_mm(raw):
    """安装高度：§7 字典声明 mm，但现场图普遍按 m 填（2.8）。
    <20 判为米制×1000，并在依据里写「按 m 读」——单位口径如实暴露，不静默换算。"""
    v = _mm_only(raw)
    if v is None:
        return None, ""
    if 0 < v < 20:
        return v * 1000.0, "按 m 读"
    return v, "按 mm 读"


def _box_depth_mm(text):
    m = re.search(r"[×xX*]\s*(\d+(?:\.\d+)?)\s*深?", str(text or ""))
    return float(m.group(1)) if m else None


def _product_phi(model: str) -> tuple[float | None, str]:
    prod = SP._product(model)
    if not prod:
        return None, "SKU 不在产品库"
    return _phi(prod.get("cutout")), ""


# ---------------------------------------------------------------- 对象几何

def _plate_lookup(design: dict) -> dict:
    """板面 id → (柜体, 柜格, 板)。"""
    return SP._plate_index(design)


def _hole_phi_mm(p: dict, row: dict, model: str) -> tuple[float | None, str]:
    """开孔直径：图注 D10-1 优先，其次 SKU 手册孔径。两个都没有＝核不了。"""
    declared = _phi(row.get("d10_1") or row.get("cutouts"))
    sku_phi, why = _product_phi(model)
    if declared is not None:
        return declared, f"图注 D10-1 φ{declared:g}"
    if sku_phi is not None:
        return sku_phi, f"取 SKU 手册孔径 φ{sku_phi:g}"
    return None, why or "图注 D10-1 与 SKU 孔径都读不出"


def plan_objects(p: dict) -> tuple[list[dict], list[str]]:
    """把灯位／柜内挂载摊成一张平面圆＋高度区间清单（§10.4 实现建议的 v0 几何）。"""
    design = p.get("design") or {}
    sc = Q.scale_state(p)
    factor = _num(sc.get("factor"), 1.0) or 1.0
    mounts = [m for m in design.get("mounts") or [] if isinstance(m, dict)]
    plates = _plate_lookup(design)
    hosted = {str(m.get("fixture_id")): m for m in mounts if m.get("fixture_id")}
    out: list[dict] = []
    unknown: list[str] = []

    for f in design.get("fixtures") or []:
        if not isinstance(f, dict) or not f.get("id"):
            continue
        model = str(f.get("d10_2") or f.get("model") or f.get("sku") or "")
        phi, basis = _hole_phi_mm(p, f, model)
        m = hosted.get(str(f.get("id")))
        host = plates.get(str(m.get("plate_id") or "")) if m else None
        h_mm, h_basis = _height_mm(f.get("installHeight"))
        obj = {"id": str(f.get("id")), "label": str(f.get("code") or f.get("id")),
               "r": None if phi is None else phi / 2.0, "z": h_mm,
               "box_depth": _box_depth_mm(f.get("d9_1")),
               "plate_id": str(m.get("plate_id") or "") if m else "",
               "phi_basis": basis, "h_basis": h_basis, "model": model}
        if host and m:
            cab = host[0] or {}
            world = V.plate_to_world(cab, str((host[2] or {}).get("plate_code") or ""),
                                     _num(m.get("u")), _num(m.get("v")))
            if len(world) == 3:
                obj["x"], obj["y"] = world[0], world[1]   # 板面变换出来就是 mm
                obj["mm_native"] = True
            else:
                obj["x"] = obj["y"] = None
        elif f.get("x") is not None and f.get("y") is not None:
            obj["x"], obj["y"] = _num(f.get("x")) * factor, _num(f.get("y")) * factor
            obj["mm_native"] = False
        else:
            obj["x"] = obj["y"] = None
        if obj["x"] is None:
            unknown.append(f"{obj['label']}：没有坐标，空间相交核不了")
        elif not obj["mm_native"] and sc.get("status") != Q.SCALE_VERIFIED:
            unknown.append(f"{obj['label']}：{sc.get('notice') or '尺度未核'}"
                           f"——平面距离不判红（§14 尺度红线）")
        elif obj["r"] is None:
            unknown.append(f"{obj['label']}：{obj['phi_basis']}——孔径不知道，相交判不了")
        out.append(obj)
    return out, unknown


# ---------------------------------------------------------------- 开孔（板面）

def scan_openings(p: dict) -> tuple[list[dict], list[str]]:
    design = p.get("design") or {}
    plates = _plate_lookup(design)
    rows: list[dict] = []
    unknown: list[str] = []
    by_plate: dict[str, list[dict]] = {}
    for m in design.get("mounts") or []:
        if not isinstance(m, dict):
            continue
        host = plates.get(str(m.get("plate_id") or ""))
        if not host:
            unknown.append(f"{m.get('id')}：挂载没有宿主板面（§7.4 plate_id 必须存在）")
            continue
        cab, _cell, plate = host
        plate = plate or {}
        fx = next((f for f in design.get("fixtures") or []
                   if isinstance(f, dict) and f.get("id") == m.get("fixture_id")), {}) or {}
        model = str(m.get("sku") or fx.get("d10_2") or fx.get("model") or "")
        phi, basis = _hole_phi_mm(p, {**fx, "cutouts": m.get("supplier_cutouts")}, model)
        actual = plate.get("actual_size_mm") or {}
        w = _mm_only(actual.get("w")) or _mm_only(plate.get("width_mm"))
        h = _mm_only(actual.get("h")) or _mm_only(plate.get("height_mm"))
        size_basis = ("柜厂实际" if actual.get("w") else "标称（未回传实测，§14 拍板 1）")
        u, v = _mm_only(m.get("u")), _mm_only(m.get("v"))
        item = {"id": str(m.get("id")), "plate_id": str(plate.get("id") or ""),
                "u": u, "v": v, "r": None if phi is None else phi / 2.0,
                "phi": phi, "w": w, "h": h, "size_basis": size_basis,
                "code": str(plate.get("no") or plate.get("plate_code") or ""),
                "model": model}
        if u is None or v is None:
            unknown.append(f"{m.get('id')}：(u,v) 未填，开孔冲突核不了")
            continue
        if item["r"] is None:
            unknown.append(f"{m.get('id')}：{basis}——孔径不知道，重叠与留边判不了")
        if phi is not None and model:
            sku_phi, _ = _product_phi(model)
            if sku_phi is not None and abs(sku_phi - phi) > 0.5:
                rows.append(_row("K3", [item["id"], item["plate_id"]],
                                 ours=f"图注开孔 φ{phi:g}", theirs=f"SKU {model} 手册 φ{sku_phi:g}",
                                 why=f"开孔 φ{phi:g} ≠ 手册 φ{sku_phi:g}（{basis}）",
                                 suggestion=f"改成 φ{sku_phi:g}，或换回手册孔径＝φ{phi:g} 的型号"))
            elif sku_phi is None:
                unknown.append(f"{m.get('id')}：SKU {model} 在库里没有孔径字段，K3 核不了")
        if w and h and item["r"] is not None:
            gap = min(u, v, w - u, h - v) - item["r"]
            if gap < EDGE_GAP_MM - 1e-6:
                rows.append(_row("K2", [item["id"], item["plate_id"]],
                                 ours=f"(u,v)=({u:g},{v:g})／板面 {w:g}×{h:g}（{size_basis}）",
                                 theirs=f"最小孔边距 {EDGE_GAP_MM:g}mm",
                                 why=f"孔边到板边只剩 {gap:.1f}mm < 留边 {EDGE_GAP_MM:g}mm"
                                     f"（§14 拍板 6；板面尺寸按{size_basis}读）",
                                 suggestion=f"孔心沿越界方向外移 ≥{EDGE_GAP_MM - gap:.0f}mm，"
                                            f"或改用更小孔径"))
        elif not (w and h):
            unknown.append(f"{m.get('id')}：板面尺寸缺失（柜厂未回传实测），K2 核不了")
        by_plate.setdefault(item["plate_id"], []).append(item)

    for plate_id, items in by_plate.items():
        for i, a in enumerate(items):
            for b in items[i + 1:]:
                if a["r"] is None or b["r"] is None:
                    continue
                d = math.hypot(a["u"] - b["u"], a["v"] - b["v"])
                need = a["r"] + b["r"] + REQUIRED_MIN_GAP_MM + EDGE_GAP_MM
                if d < need - 1e-6:
                    rows.append(_row("K1", [a["id"], b["id"], plate_id],
                                     ours=f"两孔心距 {d:.1f}mm", theirs=f"须 ≥{need:.1f}mm",
                                     why=f"{a['id']} 与 {b['id']} 在 {a['code']} 上孔心距 {d:.1f}mm"
                                         f" < 半径和＋留边 {need:.1f}mm"
                                         f"（孔径分别 φ{a['phi']:g}／φ{b['phi']:g}）",
                                     suggestion=f"沿连线方向错开 ≥{need - d:.1f}mm，"
                                                f"或把其中一盏挪到别的板面"))
    return rows, unknown


# ---------------------------------------------------------------- 回路

def _breaker_capacity(text: str) -> tuple[float | None, str]:
    m = re.search(r"(\d+)\s*P[^0-9A-Za-z]*?(\d+(?:\.\d+)?)\s*A", str(text or "").upper())
    if not m:
        return None, ""
    poles, amps = float(m.group(1)), float(m.group(2))
    volt = 400.0 if poles >= 3 else 230.0
    return poles * amps * volt, f"{poles:g}P×{amps:g}A×{volt:g}V"


def scan_circuits(p: dict) -> tuple[list[dict], list[str]]:
    design = p.get("design") or {}
    circuits = [c for c in design.get("circuits") or [] if isinstance(c, dict)]
    by_id = {str(c.get("id")): c for c in circuits}
    rows: list[dict] = []
    unknown: list[str] = []

    for f in design.get("fixtures") or []:
        if not isinstance(f, dict):
            continue
        # WiZ/Hue 网桥单灯单控本来就不分回路（2026-11-04 口径），不是孤儿灯，L1 不判它。
        if CR.is_bridge_lamp(f):
            continue
        cid = str(f.get("circuitId") or "").strip()
        if cid and cid in by_id:
            continue
        if not cid and str(f.get("circuit") or "").strip() and \
                any(str(c.get("circuit_no")) == str(f.get("circuit")).strip() for c in circuits):
            rows.append(_row("L1", [str(f.get("id"))],
                             ours=f"只写了回路号「{f.get('circuit')}」", theirs="circuitId 为空",
                             why="孤儿灯：回路号写了但没挂到回路对象，现场只能猜哪路线管",
                             suggestion=f"把灯位 {f.get('code')} 的 circuitId 指到 "
                                        f"{str(f.get('circuit'))} 对应的回路 id"))
        else:
            rows.append(_row("L1", [str(f.get("id"))],
                            ours=f"circuitId＝{cid or '空'}", theirs=f"在册回路 {sorted(by_id)}",
                            why="孤儿灯：灯位没有可指的回路对象（§7.5 circuitId 未挂＝阻断）",
                            suggestion="先在 D1 建回路并挂上灯位，或改指已有回路"))

    # L3：一通道两回路——通道占用表（柜厂/智能商回传落表）＋ 图内 actuator_channel
    occupancy: dict[tuple, list[str]] = {}
    for x in SP._doc_ledger(p).get("channel_map") or []:
        key = (str(x.get("gateway_model") or "").strip().lower(),
               str(x.get("gateway_channel") or "").strip())
        if key[1]:
            occupancy.setdefault(key, []).append(str(x.get("circuit_no") or x.get("circuit_id")))
    for c in circuits:
        ch = str(c.get("actuator_channel") or "").strip()
        if ch:
            occupancy.setdefault((str(c.get("gateway_model") or "").strip().lower(), ch), []) \
                .append(str(c.get("circuit_no") or c.get("id")))
    for (gw, ch), ids in occupancy.items():
        uniq = sorted({i for i in ids if i})
        if len(uniq) > 1:
            rows.append(_row("L3", uniq,
                             ours=f"通道 {gw or '未填机型'}／{ch}", theirs="／".join(uniq),
                             why=f"执行器通道 {ch} 同时挂了 {len(uniq)} 条回路"
                                 f"（{ '、'.join(uniq) }）：回路与通道必须 1:1",
                             suggestion=f"留一条回路在通道 {ch}，其余改到空闲通道"
                                        f"（机型上限以回传手册为准）"))
    if not occupancy:
        unknown.append("通道占用表为空（智能包还没回传合图）：L3 无从核")

    # 提示级：L2 容量、L4 灯数——系数全是参考值，报出来但不拦
    for c in circuits:
        members = [f for f in design.get("fixtures") or [] if isinstance(f, dict)
                   and not CR.is_bridge_lamp(f)
                   and (str(f.get("circuitId") or "") == str(c.get("id"))
                        or str(f.get("circuit") or "") == str(c.get("circuit_no")))]
        load = CR.watts(members)
        cap, basis = _breaker_capacity(c.get("breaker"))
        if cap is None:
            unknown.append(f"{c.get('circuit_no')}：断路器「{c.get('breaker') or '空'}」"
                           "读不出极数×电流，容量核不了")
        else:
            limit = cap * 0.9 * 0.8
            if load > limit:
                rows.append(_row("L2", [str(c.get("id"))],
                                 ours=f"回路功率 {load:g}W",
                                 theirs=f"{basis}×PF0.9×降额0.8≈{limit:g}W",
                                 why=f"{c.get('circuit_no')} 功率 {load:g}W 超按断路器估的 {limit:g}W"
                                     "（PF 与降额系数是拍的，【需核验】）",
                                 suggestion="拆回路，或按具体断路器型号手册重算后再判"))
        drivers = CR.drivers(members)
        ref = Q.REFERENCE_LIMITS["relay"]
        if drivers > ref["maxDrivers"]:
            rows.append(_row("L4", [str(c.get("id"))],
                             ours=f"{drivers} 个驱动／{len(members)} 盏灯",
                             theirs=f"参考上限 {ref['maxDrivers']}",
                             why=f"{c.get('circuit_no')} 驱动数 {drivers} 超参考值"
                                 f"（{ref['basis']}）【需核验】",
                             suggestion="拆回路，或附继电器／网关型号手册后按型号判"))
    return rows, unknown


# ---------------------------------------------------------------- 空间

def scan_space(p: dict) -> tuple[list[dict], list[str]]:
    objs, unknown = plan_objects(p)
    design = p.get("design") or {}
    sc = Q.scale_state(p)
    rows: list[dict] = []
    usable = [o for o in objs if o.get("x") is not None and o.get("r")]
    if sc.get("status") != Q.SCALE_VERIFIED:
        unknown.append(f"平面相交整组未判：{sc.get('notice') or sc.get('basis')}"
                       "（§14 尺度红线：未核不判红）")
        return rows, unknown
    for i, a in enumerate(usable):
        for b in usable[i + 1:]:
            if a["plate_id"] and a["plate_id"] == b["plate_id"]:
                continue     # 同板两孔归开孔（K1），不在这里报第二遍
            d = math.hypot(a["x"] - b["x"], a["y"] - b["y"])
            need = a["r"] + b["r"]
            if d >= need - 1e-6:
                continue
            z_top_a, z_top_b = a.get("z"), b.get("z")
            hi_a = None if z_top_a is None else z_top_a + (a.get("box_depth") or 0)
            hi_b = None if z_top_b is None else z_top_b + (b.get("box_depth") or 0)
            if None not in (z_top_a, z_top_b, hi_a, hi_b) and (z_top_a > hi_b or z_top_b > hi_a):
                continue     # 高度区间不重叠＝上下让开，不算相交
            rows.append(_row("S1", [a["id"], b["id"]],
                             ours=f"平面圆心距 {d:.1f}mm（半径 φ{2*a['r']:g}／φ{2*b['r']:g}）",
                             theirs=f"须 ≥{need:.1f}mm",
                             why=f"{a['label']} 与 {b['label']} 灯体／暗盒包围盒相交"
                                 f"（平面差 {need - d:.1f}mm，高度区间同层）",
                             suggestion=f"平面错开 ≥{need - d:.1f}mm，或让其中一盏改变安装高度"))
    net = _mm_only(design.get("ceilingNet_mm")) or _mm_only(p.get("ceilingNet_mm"))
    for o in objs:
        if not o.get("box_depth"):
            continue
        if net is None:
            unknown.append(f"{o['label']}：吊顶净高没登记（D7），净空够不够核不了")
        elif net < o["box_depth"]:
            rows.append(_row("S2", [o["id"]],
                             ours=f"吊顶净高 {net:g}mm",
                             theirs=f"暗盒深 {o['box_depth']:g}mm（D9-1）",
                             why=f"{o['label']} 暗盒深 {o['box_depth']:g}mm 已超吊顶净高 "
                                 f"{net:g}mm，装不进去（驱动厚另计，未填）",
                             suggestion=f"改浅盒／局部降顶至 ≥{o['box_depth']:g}mm，"
                                        "并补 D4 驱动厚度后重算"))
        else:
            unknown.append(f"{o['label']}：暗盒深 {o['box_depth']:g}mm 在净高 {net:g}mm 内，"
                           "但 D4 驱动厚度未填 → 净空余量核不了【需核验】")
    return rows, unknown


# ---------------------------------------------------------------- 组表

def _row(rule: str, object_ids: list[str], *, ours: str, theirs: str,
         why: str, suggestion: str) -> dict:
    kind, sev, _ = RULES[rule]
    return {"type": kind, "rule_id": rule, "severity": sev,
            "object_ids": [str(x) for x in object_ids if x],
            "ours": ours, "theirs": theirs, "why": why, "suggestion": suggestion,
            "source": "conflict_scan"}


def scan(p: dict) -> dict:
    """三类扫一遍：返回冲突行（未落表）＋判不了的清单＋口径。"""
    design = p.get("design") or {}
    if not isinstance(design, dict):
        raise HTTPException(422, "项目还没有设计数据（design 为空）：无从扫冲突")
    if not any(design.get(k) for k in ("fixtures", "mounts", "circuits")):
        # 白图扫出「0 条」会被当成「查过了，没问题」——那不是结论，是还没得查。
        raise HTTPException(422, "图上还没有灯位／挂载／回路：无从扫冲突（这不等于「没有冲突」）")
    out, unknown = [], []
    for fn in (scan_openings, scan_circuits, scan_space):
        rows, unk = fn(p)
        out.extend(rows)
        unknown.extend(unk)
    sc = Q.scale_state(p)
    blocked = [r for r in out if r["severity"] == V.BLOCK]
    return {
        "scanned_at": SP._iso(SP._now()),
        "conflicts": out,
        "unknown": unknown,
        "counts": {"阻断": len(blocked), "提示": len(out) - len(blocked),
                   "开孔": sum(1 for r in out if r["type"] == "开孔"),
                   "回路": sum(1 for r in out if r["type"] == "回路"),
                   "空间": sum(1 for r in out if r["type"] == "空间")},
        "scale": {"status": sc.get("status"), "label": sc.get("label"),
                  "notice": sc.get("notice"), "basis": sc.get("basis")},
        "rule": "§10.4 v0：开孔①②③／回路①③／空间①＝阻断；回路②④与空间②＝提示不进 1.0；"
                "几何只做 2D 圆＋高度区间一维相交；只标记不自动修",
    }


def persist(p: dict) -> dict:
    """扫一遍并写进共用的冲突表（collab.conflicts）；已存在的不重复挂账。"""
    result = scan(p)
    ledger = SP._doc_ledger(p)
    ids = SP._record_conflicts(ledger, f"scan@{SP._design_hash(p)[:8]}", result["conflicts"])
    result["recorded"] = ids
    result["open"] = [c for c in ledger["conflicts"] if c.get("state") == "未处理"]
    return result


@router.get("/{pid}/scan")
def route_scan(pid: str):
    from .app import connect, get
    with connect() as con:
        p = get(con, pid)
    return scan(p)


@router.post("/{pid}/scan")
def route_persist(pid: str):
    from .app import connect, get, commit_note
    with connect() as con:
        con.execute("BEGIN IMMEDIATE")
        p = get(con, pid)
        report = persist(p)
        commit_note(con, p, "冲突扫描",
                    f"阻断 {report['counts']['阻断']} 条／提示 {report['counts']['提示']} 条"
                    f"·新增挂账 {len(report['recorded'])} 条"
                    f"·判不了 {len(report['unknown'])} 项")
        con.commit()
        return {**report, "revision": p["revision"]}


@router.get("/{pid}/list")
def route_list(pid: str):
    from .app import connect, get
    with connect() as con:
        p = get(con, pid)
    ledger = SP._doc_ledger(p)
    rows = SP.conflict_rows(ledger)
    return {"rows": rows,
            "counts": {"未处理": sum(1 for c in rows if c.get("state") == "未处理"),
                       "阻断": sum(1 for c in rows if c.get("severity") == V.BLOCK),
                       "总": len(rows)},
            "rule": "三处共用一张冲突表（§10.4 实现建议）；决策层永远在人（§10.3）"}


def register(app):
    app.include_router(router)
