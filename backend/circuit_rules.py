"""R5 回路检查（统筹批准方案）：混用调光方式、超 D3 默认上限、有灯没分回路、无线回路跨空间。

前端 frontend/src/circuitRules.ts 是同一套规则的另一份实现；提示原文只有一份，
在 frontend/src/data/circuit-rules-text.json，两边都从那里读。tests/fixtures/circuit_rules_cases.json
只用来核两边算出的条数和原文一致。放不放行以本文件 export_gate 为准，前端只负责显示。

D3 上限（智能工程师）：模块网关还没有「LED 负载额定」「总线或节点上限」字段，这一单先用默认上限：
继电器（开关控制）≤12 驱动、≤300W；DALI ≤55 地址。每盏灯算 1 个驱动，灯带按独立电源个数算。
可控硅和 DALI 组数这一单不判。开闭、总线（DALI、KNX）跨空间不拦不提示，只有无线跨空间算问题。
"""

import json
from pathlib import Path

TEXT = json.loads((Path(__file__).resolve().parents[1] / "frontend" / "src" / "data"
                   / "circuit-rules-text.json").read_text("utf-8"))


def t(key, **kw):
    """取共享原文并按名替换占位。"""
    s = TEXT[key]
    for k, v in kw.items():
        s = s.replace("{" + k + "}", str(v))
    return s


WIRELESS = ("Zigbee", "Wi-Fi", "蓝牙 Mesh")
RELAY_MAX_DRIVERS, RELAY_MAX_WATTS, DALI_MAX_ADDRESSES = 12, 300, 55
UNASSIGNED = TEXT["unassigned"]
# 拦截档：施工包（zip、dxf、pdf、xlsx、docx）+ 厂家包（panels）+ 订货单（order，S9a 再接入口）。
# 只提示档：业主 HTML、png、jpg、报价单（/quote）。json 是数据备份，不拦也不提示。
BLOCKED_EXPORTS = ("zip", "dxf", "pdf", "xlsx", "docx", "panels", "order")
WARN_EXPORTS = ("html", "png", "jpg", "quote")


def num(v):
    """数字统一写法：最多 1 位小数，去掉多余的 0（前端 fmtNum 同口径）。"""
    v = round(float(v or 0) + 1e-9, 1)
    return str(int(v)) if v == int(v) else f"{v:.1f}"


def circuit_key(f):
    c = str(f.get("circuit") or "").strip()
    # 同步图纸时没归属的灯写成「未归属」/「未归属·D50」，导出侧老写法是「未分配」。
    return UNASSIGNED if not c or c.startswith("未归属") or c.startswith("未分配") else c


def _room(f, rooms):
    return f.get("space") or rooms.get(f.get("roomId")) or TEXT["unassignedRoom"]


def groups(design):
    """按回路编号分组（只算灯，窗帘不算），保留出现顺序。"""
    out = {}
    for f in design.get("fixtures") or []:
        if f.get("type") == "窗帘":
            continue
        out.setdefault(circuit_key(f), []).append(f)
    return out


def drivers(members):
    """驱动个数：普通灯 1 盏 = 1 个；灯带按独立电源编号去重（没填电源的每段各算 1 个）。"""
    supplies, n = set(), 0
    for f in members:
        ps = str(f.get("powerSupply") or "").strip()
        if f.get("type") == "灯带" and ps:
            supplies.add(ps)
        else:
            n += 1
    return n + len(supplies)


def fixture_watts(f) -> float:
    """灯带 power 是 W/m，按 length 折算；其它灯具 power 就是单灯功率。"""
    w = float(f.get("power") or 0)
    if f.get("type") == "灯带":
        length = float(f.get("length") or 0)
        if length > 0:
            w *= length
    return w


def watts(members):
    return sum(fixture_watts(f) for f in members)


def controls(members):
    return list(dict.fromkeys(str(f.get("control") or "").strip() for f in members if str(f.get("control") or "").strip()))


def reading(members):
    """「按回路看」读数，例如「驱动 9/12、功率 260/300W（按 D3 默认上限）」。"""
    ctrls = controls(members)
    n, w = drivers(members), watts(members)
    if len(ctrls) == 1 and ctrls[0] == "开关控制":
        return t("readingRelay", n=n, maxDrivers=RELAY_MAX_DRIVERS, w=num(w), maxWatts=RELAY_MAX_WATTS,
                 d3Note=TEXT["d3Note"])
    if len(ctrls) == 1 and ctrls[0] == "DALI":
        return t("readingDali", n=n, maxAddresses=DALI_MAX_ADDRESSES, w=num(w),
                 d3Note=TEXT["d3Note"], daliNote=TEXT["daliNote"])
    return t("readingOther", n=n, w=num(w))


def _over_d3(members):
    ctrls = controls(members)
    if len(ctrls) != 1:
        return False
    n, w = drivers(members), watts(members)
    if ctrls[0] == "开关控制":
        return n > RELAY_MAX_DRIVERS or w > RELAY_MAX_WATTS
    if ctrls[0] == "DALI":
        return n > DALI_MAX_ADDRESSES
    return False


def _room_counts(members, rooms):
    counts = {}
    for f in members:
        r = _room(f, rooms)
        counts[r] = counts.get(r, 0) + 1
    return counts


def flags(members, rooms, key):
    """回路表「缺项」要追加的两种文字：「超 D3」「无线跨空间」。"""
    if key == UNASSIGNED:
        return []
    out = []
    if _over_d3(members):
        out.append(TEXT["flagOverD3"])
    if any(c in WIRELESS for c in controls(members)) and len(_room_counts(members, rooms)) > 1:
        out.append(TEXT["flagWirelessCross"])
    return out


def problems(design):
    """红色问题，逐条一句话（前端红色提示、导出拦截说明都用这句原文）。"""
    rooms = {r.get("id"): r.get("name") for r in design.get("rooms") or []}
    out = []
    for key, members in groups(design).items():
        if key == UNASSIGNED:
            continue
        ctrls = controls(members)
        if len(ctrls) > 1:
            out.append(t("mixed", circuit=key, controls=TEXT["listSep"].join(ctrls)))
        if _over_d3(members):
            out.append(t("overD3", circuit=key, reading=reading(members)))
        counts = _room_counts(members, rooms)
        wl = [c for c in ctrls if c in WIRELESS]
        if wl and len(counts) > 1:
            detail = TEXT["listSep"].join(t("wirelessCrossItem", room=r, n=n) for r, n in counts.items())
            out.append(t("wirelessCross", circuit=key, controls=TEXT["listSep"].join(wl), n=len(counts),
                         detail=detail))
    for r, n in _room_counts(groups(design).get(UNASSIGNED, []), rooms).items():
        out.append(t("unassignedLamps", room=r, n=n))
    return out


def block_message(items):
    return t("block", n=len(items), items=TEXT["issueSep"].join(items))


# 以后 R7（面板）、R13（复核）各写一个 project -> [问题原文] 的函数追加进来，并进同一个 N。
GATE_SOURCES = [lambda p: problems(p.get("design") or {})]


def export_gate(p, kind):
    """两档拦截，返回 ("block" | "warn" | "pass", 问题原文列表)。

    拦截档（施工包、厂家包、订货单）有问题 → block；提示档（业主 HTML、图片、报价单）有问题 → warn；
    没问题，或 json 这类不算交付物的 → pass。
    """
    if kind not in BLOCKED_EXPORTS and kind not in WARN_EXPORTS:
        return "pass", []
    items = [x for src in GATE_SOURCES for x in src(p)]
    if not items:
        return "pass", []
    return ("block" if kind in BLOCKED_EXPORTS else "warn"), items
