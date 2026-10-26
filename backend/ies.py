"""LM-63 IES 解析（配光参考，不参与正式照度计算）。

支持：
- IESNA:LM-63-2002 / IESNA91；10 字段标准头，以及带 3 个镇流器值的 13 字段头
- TILT=NONE / TILT=INCLUDE（读取 tilt 元数据，但不按 tilt 修正 candela）
- 单/多水平角；光束角用半峰值线性插值，不再取网格点
- 四态：parsed / parse_failed / unsupported（none 表示未上传，由调用方判断）
- 峰值不在 0°、蝶形配光无半值下降沿、非 C 平面类型、未知 TILT → unsupported，
  不静默返回 180° 之类的假角度
"""
from __future__ import annotations

import re


def _floats(line: str):
    out = []
    for tok in line.replace(",", " ").split():
        try:
            out.append(float(tok))
        except ValueError:
            if "=" in tok:
                continue
    return out


def _tilt_value(line: str) -> str | None:
    m = re.match(r"(?i)^TILT\s*=\s*(\S+)", line)
    return m.group(1).upper() if m else None


def _crossing_angle(vert: list[float], row: list[float]) -> tuple[float | None, str]:
    """半峰值穿越角（度）。返回 (angle, reason)；angle=None 表示不能按半角定义。"""
    if len(row) < 2 or len(vert) != len(row):
        return None, "角度与光强数量不一致"
    peak = max(row)
    if peak <= 0:
        return None, "峰值光强为 0"
    peak_i = row.index(peak)
    if peak_i > 0 and float(vert[peak_i]) > 0.01:
        return None, (
            f"峰值不在 0°（峰值角 {float(vert[peak_i]):g}°），非对称配光不能按半角定义光束角"
        )
    half = peak * 0.5
    for i in range(1, len(row)):
        c0, c1 = row[i - 1], row[i]
        if c0 > half >= c1:
            v0, v1 = float(vert[i - 1]), float(vert[i])
            if c0 == c1:
                return v0, ""
            t = (c0 - half) / (c0 - c1)
            return v0 + (v1 - v0) * t, ""
    return None, "光强在 0–90° 内始终高于半峰值（蝶形/全向配光），半角光束角不适用"


def _layout(nums: list[float], pos: int, header_len: int):
    """按给定的表头字段数，检查角度数量与 candela 数据是否刚好对得上。"""
    if len(nums) < pos + header_len:
        return None
    nv_f, nh_f = nums[pos + 3], nums[pos + 4]
    nv, nh = int(nv_f), int(nh_f)
    if nv_f != nv or nh_f != nh:
        return None
    if not (1 <= nv <= 2000 and 1 <= nh <= 2000):
        return None
    need = header_len + nv + nh + nv * nh
    rest = len(nums) - pos
    if rest < need:
        return None
    return {"header": header_len, "nv": nv, "nh": nh, "need": need, "extra": rest - need}


def _fail(error: str) -> dict:
    return {"ok": False, "status": "parse_failed", "error": error}


def parse(raw: bytes) -> dict:
    try:
        text = raw.decode("utf-8", "replace")
    except Exception as e:
        return _fail(f"decode: {type(e).__name__}")
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    if not lines:
        return _fail("空文件")
    header = lines[0]

    start = None
    tilt = ""
    for i, ln in enumerate(lines):
        tv = _tilt_value(ln)
        if tv is not None:
            tilt = tv
            start = i + 1
            break
    if start is None:
        return _fail("缺少 TILT 行")

    nums: list[float] = []
    for ln in lines[start:]:
        nums.extend(_floats(ln))
    if not nums:
        return _fail("光度数据为空")

    warnings: list[str] = []
    unsupported: list[str] = []
    pos = 0
    tilt_meta = None
    if tilt == "INCLUDE":
        if len(nums) < 3:
            return _fail("TILT=INCLUDE 数据不完整")
        geometry = int(nums[0])
        pairs = int(nums[1])
        nangles = int(nums[2])
        pos = 3
        if pairs < 0 or nangles < 0 or len(nums) < pos + pairs * 2:
            return _fail("TILT=INCLUDE 角度/因子数量异常")
        t_angles = nums[pos:pos + pairs]; pos += pairs
        t_factors = nums[pos:pos + pairs]; pos += pairs
        tilt_meta = {"geometry": geometry, "pairs": pairs, "nangles": nangles,
                     "angles": [round(x, 2) for x in t_angles],
                     "factors": [round(x, 4) for x in t_factors]}
        warnings.append("TILT=INCLUDE 已读取，但未按 tilt 角度修正 candela；只作参考")
    elif tilt != "NONE":
        unsupported.append(f"TILT={tilt} 未支持；按 TILT=NONE 读取，结果只作参考")

    # 标准 LM-63 是 10 字段头；带镇流器三值时是 13 字段头。
    # 过去只看 lamps<0 跳三值，遇到「lamps=1 但仍带三值」会把镇流器值当成垂直角。
    cands = [x for x in (_layout(nums, pos, 10), _layout(nums, pos, 13)) if x]
    if not cands:
        return _fail("表头角度数量与实际 candela 数据对不上（可能缺行或表头字段错位）")
    exact = [x for x in cands if x["extra"] == 0]
    pick = exact[0] if exact else min(cands, key=lambda x: x["extra"])
    if pick["extra"]:
        warnings.append(f"文件末尾有 {pick['extra']} 个多余数值未使用")

    head = nums[pos:pos + pick["header"]]
    lamps, lumens_per_lamp, mult, n_vert, n_horiz, photometric, units, w, l, h = head[:10]
    n_vert, n_horiz = int(n_vert), int(n_horiz)
    pos += pick["header"]

    ballast = None
    if pick["header"] == 13:
        ballast = {"factor": round(head[10], 4), "lampLumens": round(head[11], 2),
                   "inputWatts": round(head[12], 2)}
    elif lamps < 0:
        warnings.append("绝对光度文件（lamps<0）但未找到镇流器三值；按无三值处理")

    if len(nums) < pos + n_vert + n_horiz + n_vert * n_horiz:
        return _fail("candela 数据不完整")
    vert = nums[pos:pos + n_vert]; pos += n_vert
    horiz = nums[pos:pos + n_horiz]; pos += n_horiz
    if any(not (0.0 <= a <= 180.0) for a in vert):
        return _fail("垂直角超出 0–180° 范围")
    if any(vert[i] > vert[i + 1] + 1e-9 for i in range(n_vert - 1)):
        return _fail("垂直角序列不单调（疑似表头字段错位）")
    if any(not (0.0 <= a <= 360.0) for a in horiz):
        return _fail("水平角超出 0–360° 范围")
    if any(horiz[i] > horiz[i + 1] + 1e-9 for i in range(n_horiz - 1)):
        return _fail("水平角序列不单调")

    table = []
    for _ in range(n_horiz):
        row = nums[pos:pos + n_vert]; pos += n_vert
        if len(row) != n_vert:
            return _fail("candela 数据不完整")
        table.append(row)
    if any(c < 0 for row in table for c in row):
        warnings.append("存在负 candela，已按 0 处理")
        table = [[max(0.0, c) for c in row] for row in table]
    if mult <= 0:
        warnings.append(f"candela 倍率 {mult:g} 无效，已按 1 处理")
        mult = 1.0
    table = [[c * mult for c in row] for row in table]

    peak = max((max(row) for row in table if row), default=0)
    beams = []
    for hi, row in enumerate(table):
        angle, reason = _crossing_angle(vert, row)
        item = {"horizontal": round(float(horiz[hi]), 2)}
        if angle is None:
            item.update({"beamAngle": None, "halfAngle": None, "supported": False,
                         "reason": reason})
        else:
            item.update({"beamAngle": round(angle * 2, 2), "halfAngle": round(angle, 2),
                         "supported": True})
        beams.append(item)
    supported = [b for b in beams if b["beamAngle"] is not None]
    beam_main_item = next((b for b in supported if abs(b["horizontal"]) < 1e-6), None)
    if beam_main_item is None and supported:
        beam_main_item = supported[0]
        warnings.append("没有 0° 水平角平面；主光束角取第一个可用平面")
    if n_horiz > 1:
        warnings.append(f"非对称/多水平角（{n_horiz} 个）；主光束角取 0° 平面，另给各平面结果")

    # 不能按 C 平面半角描述的情况：主平面缺失/无下降沿、非 C 型配光。
    if beam_main_item is None:
        main_reason = next((b["reason"] for b in beams if not b["supported"]), "")
        unsupported.append(main_reason or "主平面没有可用的半峰值下降沿")
    elif int(photometric) != 1:
        unsupported.append(f"配光类型 {int(photometric)}（非 C 平面）；当前只按 C 平面近似")
    elif n_horiz > 1:
        bad = [b for b in beams if not b["supported"]]
        if bad:
            warnings.append(f"{len(bad)} 个水平角平面无半峰值下降沿，未计入光束角范围")

    beam_values = [b["beamAngle"] for b in supported]
    beam_main = beam_main_item["beamAngle"] if beam_main_item else None
    status = "unsupported" if unsupported else "parsed"
    warnings.extend(unsupported)
    total_lumens = (abs(lamps) * lumens_per_lamp) if lumens_per_lamp > 0 else 0
    return {"ok": True, "status": status, "data": {
        "format": header[:60],
        "tilt": "include" if tilt_meta else "none",
        "tiltData": tilt_meta,
        "warnings": warnings,
        "unsupportedReason": unsupported[0] if unsupported else "",
        "headerFields": pick["header"],
        "ballast": ballast,
        "lamps": abs(lamps),
        "lumensPerLamp": lumens_per_lamp,
        "totalLumens": round(total_lumens, 1),
        "maxCandela": round(peak, 2),
        "beamAngleApprox": beam_main,
        "halfAngleApprox": beam_main_item["halfAngle"] if beam_main_item else None,
        "beamAngleMin": min(beam_values) if beam_values else None,
        "beamAngleMax": max(beam_values) if beam_values else None,
        "beams": beams,
        "verticalAngles": [round(x, 2) for x in vert],
        "horizontalAngles": [round(x, 2) for x in horiz],
        "photometricType": int(photometric),
        "unitsType": int(units),
    }}
