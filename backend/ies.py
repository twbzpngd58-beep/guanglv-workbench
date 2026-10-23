"""LM-63 IES 解析（配光参考，不参与正式照度计算）。

支持：
- IESNA:LM-63-2002 / IESNA91
- TILT=NONE / TILT=INCLUDE（读取 tilt 元数据，但不按 tilt 修正 candela）
- 单/多水平角；多水平角时分别算 0°/各平面的近似光束角
- 解析失败时返回 ok=False，文件仍由上传接口留存
"""
from __future__ import annotations


def _floats(line: str):
    out = []
    for tok in line.replace(",", " ").split():
        try:
            out.append(float(tok))
        except ValueError:
            if "=" in tok:
                continue
    return out


def _beam_for_row(vert: list[float], row: list[float]):
    if not row:
        return None
    peak = max(row)
    if peak <= 0:
        return None
    half = peak * 0.5
    for ang, candela in zip(vert, row):
        if candela <= half:
            return round(float(ang) * 2, 1)
    return round(float(vert[-1]) * 2, 1) if vert else None


def parse(raw: bytes) -> dict:
    try:
        text = raw.decode("utf-8", "replace")
    except Exception as e:
        return {"ok": False, "error": f"decode: {type(e).__name__}"}
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    if not lines:
        return {"ok": False, "error": "空文件"}
    header = lines[0]

    start = None
    tilt = ""
    for i, ln in enumerate(lines):
        if ln.upper().startswith("TILT="):
            tilt = ln.split("=", 1)[1].strip().upper()
            start = i + 1
            break
    if start is None:
        return {"ok": False, "error": "缺少 TILT 行"}

    nums: list[float] = []
    for ln in lines[start:]:
        if ln.upper().startswith("TILT="):
            continue
        nums.extend(_floats(ln))
    if not nums:
        return {"ok": False, "error": "光度数据为空"}

    warnings: list[str] = []
    pos = 0
    tilt_meta = None
    if tilt.startswith("INCLUDE"):
        if len(nums) < 3:
            return {"ok": False, "error": "TILT=INCLUDE 数据不完整"}
        geometry = int(nums[0])
        pairs = int(nums[1])
        nangles = int(nums[2])
        pos = 3
        if pairs < 0 or nangles < 0 or len(nums) < pos + pairs * 2:
            return {"ok": False, "error": "TILT=INCLUDE 角度/因子数量异常"}
        t_angles = nums[pos:pos + pairs]; pos += pairs
        t_factors = nums[pos:pos + pairs]; pos += pairs
        tilt_meta = {"geometry": geometry, "pairs": pairs, "nangles": nangles,
                     "angles": [round(x, 2) for x in t_angles],
                     "factors": [round(x, 4) for x in t_factors]}
        warnings.append("TILT=INCLUDE 已读取，但未按 tilt 角度修正 candela；只作参考")
    elif tilt not in ("NONE", ""):
        warnings.append(f"未知 TILT={tilt}；按 NONE 处理")

    if len(nums) < pos + 10:
        return {"ok": False, "error": "光度数据不足 10 个字段"}
    lamps, lumens_per_lamp, mult, n_vert, n_horiz, photometric, units, w, l, h = nums[pos:pos + 10]
    pos += 10
    n_vert, n_horiz = int(n_vert), int(n_horiz)
    if not (1 <= n_vert <= 2000 and 1 <= n_horiz <= 2000):
        return {"ok": False, "error": "角度数量异常"}
    if lamps < 0:
        pos += 3  # ballast factor / ballast lamp lumens / input watts
    if len(nums) < pos + n_vert + n_horiz + n_vert * n_horiz:
        return {"ok": False, "error": "candela 数据不完整"}
    vert = nums[pos:pos + n_vert]; pos += n_vert
    horiz = nums[pos:pos + n_horiz]; pos += n_horiz
    table = []
    for _ in range(n_horiz):
        table.append(nums[pos:pos + n_vert]); pos += n_vert
    mult = mult if mult > 0 else 1.0
    table = [[c * mult for c in row] for row in table]

    peak = max((max(row) for row in table if row), default=0)
    beams = []
    for hi, row in enumerate(table):
        b = _beam_for_row(vert, row)
        if b is not None:
            beams.append({"horizontal": round(float(horiz[hi]), 2), "beamAngle": b})
    if not beams:
        return {"ok": False, "error": "没有有效 candela 行"}
    beam_values = [b["beamAngle"] for b in beams]
    beam_main = next((b["beamAngle"] for b in beams if abs(b["horizontal"]) < 1e-6), max(beam_values))
    if n_horiz > 1:
        warnings.append(f"非对称/多水平角（{n_horiz} 个）；主光束角取 0° 平面，另给各平面结果")
    if int(photometric) != 1:
        warnings.append(f"配光类型 {int(photometric)}；当前只按 C 平面近似")
    total_lumens = (abs(lamps) * lumens_per_lamp) if lumens_per_lamp > 0 else 0
    return {"ok": True, "data": {
        "format": header[:60],
        "tilt": "include" if tilt_meta else "none",
        "tiltData": tilt_meta,
        "warnings": warnings,
        "lamps": abs(lamps),
        "lumensPerLamp": lumens_per_lamp,
        "totalLumens": round(total_lumens, 1),
        "maxCandela": round(peak, 2),
        "beamAngleApprox": beam_main,
        "beamAngleMin": min(beam_values),
        "beamAngleMax": max(beam_values),
        "beams": beams,
        "verticalAngles": [round(x, 2) for x in vert],
        "horizontalAngles": [round(x, 2) for x in horiz],
        "photometricType": int(photometric),
        "unitsType": int(units),
    }}
