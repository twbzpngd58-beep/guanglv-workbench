"""尺度标定后的整体缩放：把「画布单位」换算回 26 单位＝1 米这个全局口径。

为什么用缩放而不是给每个消费方加一个比例参数：三维引擎（lighting3d/space_geometry）、导出、
光斑与遮光都按 DESIGN_UNITS_PER_M=26 硬算米（实测 13 处 / 26）。项目里再存一个「本项目每米多少单位」
就得让每一处都记得读它，漏一处就是面积、开孔、灯光三套尺寸互相打脸。标定＝一次性把几何换算到
26 单位/米，之后所有人继续用同一个不变量。

只动画布单位的字段（实测口径，见各条注释）；带 M/mm 后缀的一律是真实尺寸，不跟缩放走。
"""

UNITS_PER_METRE = 26.0

# 集合 → 需要乘系数的「画布单位」标量字段。
SCALAR_KEYS = {
    "rooms": ("x", "y", "width", "height"),
    "walls": ("x", "y", "x2", "y2"),
    # 门窗的 x/y/x2/y2/width 是画布单位；heightM/sillHeight/widthMm 是真实尺寸，start/end 是边上比例。
    "openings": ("x", "y", "x2", "y2", "width"),
    "fixtures": ("x", "y"),
    "devices": ("x", "y"),
    "furniture": ("x", "y"),
    "texts": ("x", "y"),
}
# 这些字段是 [{x, y}, ...] 的画布单位折线/多边形。
PATH_KEYS = ("points", "stripPath", "coveragePoints", "path", "poly", "polygon")
# 面积随系数平方走（存的是 m²）。
AREA_KEYS = ("area",)
# 灯具的 length 存的是米，且恒等于 stripPath 折线长 / 26（实测 0531b403 灯带 cqD001：
# 折线 114.8 单位 ÷26 = 4.42 ＝ 库里的 length），所以灯带缩放后它跟着乘系数。
METRES_ALONG_PATH = ("length",)


def as_num(value, default=0.0) -> float:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    return out if out == out else default


def _scaled(value, factor):
    """画布单位数值 ×系数；None/非数值原样留着（挂边界的门窗 x/y 就是 null）。"""
    if value is None or isinstance(value, bool):
        return value
    try:
        float(value)
    except (TypeError, ValueError):
        return value
    return round(float(value) * factor, 3)


def scale_design(design: dict, factor: float) -> tuple[dict, dict]:
    """把整份设计按 factor 缩放，返回 (新设计, 报告)。原对象不改，调用方可放心比对。"""
    import copy

    factor = as_num(factor, 1.0)
    out = copy.deepcopy(design or {})
    touched = {"scalar": 0, "points": 0, "area": 0, "length": 0}
    for key, fields in SCALAR_KEYS.items():
        rows = out.get(key)
        if not isinstance(rows, list):
            continue
        for obj in rows:
            if not isinstance(obj, dict):
                continue
            for field in fields:
                if field in obj and obj[field] is not None:
                    obj[field] = _scaled(obj[field], factor)
                    touched["scalar"] += 1
            for path_key in PATH_KEYS:
                pts = obj.get(path_key)
                if isinstance(pts, list):
                    for p in pts:
                        if isinstance(p, dict) and "x" in p and "y" in p:
                            p["x"] = _scaled(p.get("x"), factor)
                            p["y"] = _scaled(p.get("y"), factor)
                            touched["points"] += 2
            for area_key in AREA_KEYS:
                if area_key in obj and obj[area_key] is not None:
                    obj[area_key] = _scaled(obj[area_key], factor * factor)
                    touched["area"] += 1
            if key == "fixtures" and isinstance(obj.get("stripPath"), list) and len(obj["stripPath"]) >= 2:
                for metre_key in METRES_ALONG_PATH:
                    if metre_key in obj and obj[metre_key] is not None:
                        obj[metre_key] = _scaled(obj[metre_key], factor)
                        touched["length"] += 1
    # 挂边界的门窗只存比例（start/end）：边界整体缩放后，它在同一面墙的相对位置不变，
    # 但 widthMm 是真实值不会变——这不算错，只是要人眼再看一眼门窗宽，所以报出去。
    anchored = sum(1 for o in (out.get("openings") or [])
                   if isinstance(o, dict) and o.get("edgeIndex") is not None and o.get("x") is None)
    report = {"factor": round(factor, 6), **touched, "openingsAnchored": anchored}
    if anchored:
        report["notice"] = (f"{anchored} 个门窗挂在空间边界上（只记比例）：缩放后请在门窗页核一遍宽度读数。")
    return out, report


def scale_recognition_draft(rec: dict, factor: float) -> bool:
    """识别草稿（还没确认的那些空间/边界段）跟着同一系数走。

    不清掉草稿：草稿是设计师眼前的候选空间，作废等于把人正在看的东西抹了。
    但留着不换算就会出「标定后确认草稿＝按老比例落进新几何」的两套尺度。
    """
    if not isinstance(rec, dict) or not rec:
        return False
    changed = False
    for room in rec.get("rooms") or []:
        if not isinstance(room, dict):
            continue
        for field in SCALAR_KEYS["rooms"]:
            if room.get(field) is not None:
                room[field] = _scaled(room[field], factor)
        for p in room.get("points") or []:
            if isinstance(p, dict) and "x" in p and "y" in p:
                p["x"] = _scaled(p.get("x"), factor)
                p["y"] = _scaled(p.get("y"), factor)
        changed = True
    for seg in rec.get("boundarySegments") or []:
        if isinstance(seg, dict):
            for field in ("x", "y", "x2", "y2"):
                if seg.get(field) is not None:
                    seg[field] = _scaled(seg[field], factor)
            changed = True
    box = rec.get("canvasTransform")
    if isinstance(box, dict):
        for field in ("x", "y", "width", "height"):
            if box.get(field) is not None:
                box[field] = _scaled(box[field], factor)
        changed = True
    return changed


def rooms_area_before_after(design: dict) -> list[dict]:
    """给界面预览用的每空间面积对照（按 26 单位/米现算，不读存储的 area）。"""
    out = []
    for room in (design or {}).get("rooms") or []:
        if not isinstance(room, dict):
            continue
        pts = room.get("points") or []
        if len(pts) < 3:
            x, y = as_num(room.get("x")), as_num(room.get("y"))
            w, h = as_num(room.get("width")), as_num(room.get("height"))
            if w <= 0 or h <= 0:
                continue
            pts = [{"x": x, "y": y}, {"x": x + w, "y": y}, {"x": x + w, "y": y + h}, {"x": x, "y": y + h}]
        area = abs(sum(as_num(pts[i]["x"]) * as_num(pts[(i + 1) % len(pts)]["y"])
                       - as_num(pts[(i + 1) % len(pts)]["x"]) * as_num(pts[i]["y"])
                       for i in range(len(pts)))) / 2.0 / (UNITS_PER_METRE ** 2)
        out.append({"id": room.get("id"), "name": room.get("name") or "未命名空间",
                    "areaM2": round(area, 2)})
    return out
