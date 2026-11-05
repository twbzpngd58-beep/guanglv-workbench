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

from . import quality as Q

TEXT = json.loads((Path(__file__).resolve().parents[1] / "frontend" / "src" / "data"
                   / "circuit-rules-text.json").read_text("utf-8"))


def t(key, **kw):
    """取共享原文并按名替换占位。"""
    s = TEXT[key]
    for k, v in kw.items():
        s = s.replace("{" + k + "}", str(v))
    return s


WIRELESS = ("Zigbee", "Wi-Fi", "蓝牙 Mesh")
# 总线方案里的第三种灯具载体（2026-11-04 用户口径）：飞利浦 WiZ/Hue 灯本身 Wi-Fi 控制，
# 加一台飞利浦 Hue 网桥就并进 KNX，和 DALI 一样单灯单控——所以它没有「回路」这一层：
# 既不进回路表，也不能被「有灯没分回路」拦下。前端 frontend/src/busBridge.ts 同口径。
BRIDGE_CONTROL = "WiZ/Hue"
BRIDGE_CAP = 40            # 每台 Hue 网桥最多 40 个设备（每层至少 1 台）
BRIDGE_MODEL = "Hue Bridge"


def is_bridge_lamp(f) -> bool:
    return str((f or {}).get("control") or "").strip() == BRIDGE_CONTROL


def is_philips_wireless(v) -> bool:
    """是否飞利浦 WiZ/Hue 的产品：选型目录按 catalogId/catalogBrand 认，产品库按品牌＋型号认。
    与 frontend/src/busBridge.ts isPhilipsWireless 同口径。"""
    v = v if isinstance(v, dict) else {}
    s = lambda x: str(x or "").strip()  # noqa: E731
    i = s(v.get("catalogId")) or s(v.get("id"))
    if i.lower().startswith(("philips-", "philips_")) or s(v.get("catalogBrand")).lower() == "philips":
        return True
    text = " ".join(s(v.get(k)) for k in ("brand", "model", "series", "name"))
    return ("飞利浦" in text or "philips" in text.lower()) and any(
        k in (s(v.get("series")) + s(v.get("model")) + i).lower() for k in ("wiz", "hue"))


# 人明确写了开关控制的灯不跟着归位：现场可能就是要单独一路开关它（与前端 applyBusDefaults 同口径）。
BRIDGE_KEEP_CONTROL = "开关控制"


def converge_bus_carriers(design, smart) -> int:
    """存量归位：总线智能（KNX）项目里，型号是飞利浦 WiZ/Hue 的灯落网桥单灯单控、摘掉回路。

    为什么要有这一步：这类灯的载体在 2026-11-04 才进工作台，存量设计里它们的 control 还写着
    DALI 或空、回路挂在 C01 上。按已拍板口径（总线智能下飞利浦 WiZ/Hue 没有「回路」这一层），
    这些值是错的；不归位就永远报「有灯没分回路」，交付物里也凭空多一条不含飞利浦灯的回路。
    开闭灯（开关控制）不动。返回改写的盏数，调用方用它出可见提示（H6 不静默修）。
    """
    if str(smart or "").strip() != "KNX":
        return 0
    n = 0
    for f in design.get("fixtures") or []:
        if not isinstance(f, dict) or f.get("type") == "窗帘":
            continue
        ctrl = str(f.get("control") or "").strip()
        if ctrl in (BRIDGE_CONTROL, BRIDGE_KEEP_CONTROL) or not is_philips_wireless(f):
            continue
        f["control"] = BRIDGE_CONTROL
        f["dimmable"] = True
        if str(f.get("colorMode") or "").strip() not in ("", "单色"):
            f["tunable"] = True
        f.pop("circuit", None)
        f.pop("circuitId", None)
        n += 1
    return n

# 未附型号手册时的参考值，唯一来源是 quality.REFERENCE_LIMITS（D03/D05：参考值不是已验证上限）。
RELAY_MAX_DRIVERS = Q.REFERENCE_LIMITS["relay"]["maxDrivers"]
RELAY_MAX_WATTS = Q.REFERENCE_LIMITS["relay"]["maxWatts"]
DALI_MAX_ADDRESSES = Q.REFERENCE_LIMITS["dali"]["maxAddresses"]
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
    """按回路编号分组（只算灯，窗帘不算），保留出现顺序。

    WiZ/Hue 网桥灯不参与：单灯单控没有回路，它们不进分组、不进「未分配」桶，
    也不会因为没填回路而被拦下。
    """
    out = {}
    for f in design.get("fixtures") or []:
        if f.get("type") == "窗帘":
            continue
        if is_bridge_lamp(f):
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


def reference_limits(ctrls, members=None):
    """本条回路可用的容量依据。附了逐灯型号依据就用它；否则返回参考值并标未附手册。"""
    if len(ctrls) != 1:
        return None
    kind = {"开关控制": "relay", "DALI": "dali"}.get(ctrls[0])
    if not kind:
        return None
    specs = []
    for f in members or []:
        spec = f.get("resourceSpec") if isinstance(f.get("resourceSpec"), dict) else None
        if not spec:
            continue
        key = "maxDrivers" if kind == "relay" else "maxAddresses"
        if isinstance(spec.get(key), (int, float)) and spec.get(key) > 0:
            specs.append(spec)
    if specs:
        spec = min(specs, key=lambda s: float(s.get("maxDrivers") or s.get("maxAddresses") or 0))
        out = {"kind": kind, "verified": True, "basis": str(spec.get("source") or "逐灯型号依据")}
        if kind == "relay":
            out["maxDrivers"] = int(spec["maxDrivers"])
            out["maxWatts"] = int(spec.get("maxWatts") or Q.REFERENCE_LIMITS["relay"]["maxWatts"])
        else:
            out["maxAddresses"] = int(spec["maxAddresses"])
        return out
    return {**Q.REFERENCE_LIMITS[kind], "kind": kind, "verified": False}


def over_reference(members):
    """超参考值也按「未知·从严」处理：没有手册时不宣布这是已验证的失败。"""
    ctrls = controls(members)
    ref = reference_limits(ctrls, members)
    if not ref:
        return False
    n, w = drivers(members), watts(members)
    if ref["kind"] == "relay":
        return n > ref["maxDrivers"] or w > ref["maxWatts"]
    return n > ref["maxAddresses"]


def _over_d3(members):
    return over_reference(members)


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
