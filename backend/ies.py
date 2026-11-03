"""LM-63 IES 解析（配光参考，不参与正式照度计算）。

支持：
- IESNA:LM-63-2002 / IESNA91；10 字段标准头，以及带 3 个镇流器值的 13 字段头
- TILT=NONE；TILT=INCLUDE 只读出 tilt 元数据作证据，状态按 §5.1 判 `unsupported`
  （正本要求"报不支持、不得忽略"，所以这类文件不能拿去出光斑）
- 单/多水平角；光束角用半峰值线性插值，不再取网格点
- 四态：none / parsed / parse_failed / unsupported（`none`＝没上传，由调用方判断）
- 峰值不在 0°、蝶形配光无半值下降沿、非 C 平面类型、未知 TILT → unsupported，
  不静默返回 180° 之类的假角度

§5.1 补全 2（candela(θ) → 光斑衰减）与补全 4（按 sha256 缓存）的入口在文件下半段：
`radial_profile()` 出实测剖面，`theoretical_profile()` 出硬边剖面（旧算法＝新算法的特例），
`spot_of()` 是灯位取光斑的**唯一**口径——解析失败/不支持一律返回 `red=True`，
由出图侧画红标"未实测"，绝不返回理论剖面冒充实测。
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
from pathlib import Path

# 原矩阵只作证据留存，超过这个规模就不塞进文档，避免把工程 JSON 撑爆
MAX_MATRIX_CELLS = 20000


def _floats(line: str):
    out = []
    for tok in line.replace(",", " ").split():
        try:
            val = float(tok)
        except ValueError:
            if "=" in tok:
                continue
            continue
        out.append(val)
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
    if not (math.isfinite(nv_f) and math.isfinite(nh_f)):
        return None
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


def _axisymmetry(vert: list[float], horiz: list[float], table: list[list[float]]):
    """β 向（水平角）对称程度。

    只有 ε = 各平面极差/均值 ≤ 5% 时才可按「旋转对称」径向近似；否则保留多平面结果，
    不拿某一个平面冒充整灯。近零光强不参与比较，避免小分母把相对误差放大。
    """
    if len(table) < 2:
        return {"epsilon": 0.0, "radialApprox": True, "planes": len(table),
                "anglesUsed": len(vert), "basis": "单一水平角平面，无水平方向差异可比"}
    if not any(abs(float(h)) < 1e-6 for h in horiz):
        return None
    peak = max((max(row) for row in table if row), default=0.0)
    if not math.isfinite(peak) or peak <= 0:
        return None
    idx = [i for i in range(len(vert))
           if any(row[i] >= peak * 0.1 for row in table)]
    if len(idx) < 2:
        return None
    worst = 0.0
    for i in idx:
        vals = [row[i] for row in table]
        mean = sum(vals) / len(vals)
        if mean <= 0:
            continue
        worst = max(worst, (max(vals) - min(vals)) / mean)
    return {"epsilon": round(worst, 4), "radialApprox": worst <= 0.05,
            "planes": len(table), "anglesUsed": len(idx),
            "basis": f"β 向极差/均值 ε={worst:.1%}（仅统计 ≥10% 峰值的 {len(idx)} 个垂直角）"}


def _fail(error: str) -> dict:
    return {"ok": False, "status": "parse_failed", "error": error}


def parse(raw: bytes) -> dict:
    """对外入口：任何畸形数值都归到 parse_failed，不向上抛 500。"""
    try:
        return _parse(raw)
    except Exception as e:  # 数值域错误（nan/inf、int() 溢出等）也必须是受控结果
        return _fail(f"{type(e).__name__}: {e}"[:160])


def _parse(raw: bytes) -> dict:
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
        unsupported.append("TILT=INCLUDE（倾斜＋逐灯修正数据）不支持：本工作台不做 tilt 修正，"
                           "拿未修正的 candela 出光斑＝冒充实测（§5.1 补全 1：报「不支持」，不得忽略）")
    elif tilt != "NONE":
        unsupported.append(f"TILT={tilt} 未支持：不能按 TILT=NONE 读取后当作实测配光")

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
    if any(not math.isfinite(v) for v in head):
        return _fail("表头含非有限数值（nan/inf）")
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
    if any(not math.isfinite(c) for row in table for c in row):
        return _fail("candela 数据含 nan/inf")
    if any(c < 0 for row in table for c in row):
        warnings.append("存在负 candela，已按 0 处理")
        table = [[max(0.0, c) for c in row] for row in table]
    if not math.isfinite(mult):
        return _fail(f"candela 倍率为非有限值（{mult}）")
    if mult <= 0:
        warnings.append(f"candela 倍率 {mult:g} 无效，已按 1 处理")
        mult = 1.0
    table = [[c * mult for c in row] for row in table]

    # β 向对称性：ε ≤5% 才能称旋转对称；否则不按径向近似，也不拿单平面冒充整灯
    symmetry = _axisymmetry(vert, horiz, table)
    radial = bool(symmetry and symmetry["radialApprox"])
    if symmetry is None:
        warnings.append("β 向对称性无法判定（缺 0° 水平角或无有效覆盖），未按径向近似")
    elif n_horiz > 1:
        warnings.append(("β 向可视为旋转对称（" if radial else "β 向不对称（")
                        + symmetry["basis"] + ("）；按径向近似" if radial else "）；不按径向近似"))

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
    # 径向剖面用的就是这一平面（主平面）的一维 I(θ)；矩阵过大时靠它把剖面留住。
    main_hi = next((hi for hi in range(n_horiz)
                    if beam_main_item is not None
                    and beams[hi]["horizontal"] == beam_main_item["horizontal"]), None)
    main_plane = None
    if main_hi is not None:
        main_plane = {"horizontal": beams[main_hi]["horizontal"],
                      "verticalAngles": [round(float(a), 3) for a in vert],
                      "candela": [round(float(c), 3) for c in table[main_hi]]}
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
        "mainPlane": main_plane,
        "verticalAngles": [round(x, 2) for x in vert],
        "horizontalAngles": [round(x, 2) for x in horiz],
        "photometricType": int(photometric),
        "unitsType": int(units),
        "candelaScale": round(mult, 6),
        "radialApprox": radial,
        "symmetry": symmetry,
        "candelaMatrix": (
            [[round(c, 2) for c in row] for row in table]
            if n_vert * n_horiz <= MAX_MATRIX_CELLS else None
        ),
    }}


# ---------------------------------------------------------------- §5.1 补全 2：candela(θ) → 径向剖面
# 四态口径（正本表格原话：静默降级比没有光斑更危险）
STATUS_NONE, STATUS_PARSED = "none", "parsed"
STATUS_FAILED, STATUS_UNSUPPORTED = "parse_failed", "unsupported"
BAD_STATUSES = (STATUS_FAILED, STATUS_UNSUPPORTED)
PHOTOMETRY_MEASURED = "实测IES"
PHOTOMETRY_THEORETICAL = "理论半角"
PHOTOMETRY_UNVERIFIED = "未实测"
DEFAULT_BEAM = 36.0          # 没有产品参数也没有 IES 时的理论光束角（与三维引擎同一默认值）
PROFILE_SAMPLES = 181        # 归一化半径 r/R 上的采样点数（正本要求约 181 点）
CUT_RATIO = 0.05             # θ_cut：亮度降到 5% 处，防无限拖尾
CACHE_MAX_BYTES = 64 * 1024  # 单灯缓存目标 ≤64KB（超了先扔原始矩阵，剖面必须留住）

CACHE_DIR = Path(os.getenv("DATA_DIR", str(Path(__file__).resolve().parent.parent / "data"))) / "ies_cache"


def _ref_candela(row) -> float:
    """剖面归一化的分母：正本年说 I(0)；parsed 的灯峰值一定在 0°，否则早判 unsupported。"""
    return float(row[0]) if row and row[0] > 0 else (max(row) if row else 0.0)


def _cross(vert, row, ref, ratio):
    """最小 θ 使 I(θ) ≤ ratio·ref（线性插值）。找不到＝剖面没有下降沿。"""
    if ref <= 0 or len(vert) != len(row) or len(row) < 2:
        return None
    target = ref * ratio
    for i in range(1, len(row)):
        c0, c1 = float(row[i - 1]), float(row[i])
        if c0 > target >= c1:
            v0, v1 = float(vert[i - 1]), float(vert[i])
            if c0 == c1:
                return v0
            return v0 + (v1 - v0) * ((c0 - target) / (c0 - c1))
    return None


def _candela_at(vert, row, ang):
    """任意垂直角的 I(θ)：表内线性插值，超出覆盖范围按 0（表外没有理由还亮）。"""
    if not vert or not row or len(vert) != len(row):
        return 0.0
    if ang <= float(vert[0]):
        return float(row[0]) if ang >= 0 else 0.0
    if ang >= float(vert[-1]):
        return 0.0
    for i in range(1, len(vert)):
        v0, v1 = float(vert[i - 1]), float(vert[i])
        if v0 <= ang <= v1:
            if v1 == v0:
                return float(row[i - 1])
            t = (ang - v0) / (v1 - v0)
            return float(row[i - 1]) + (float(row[i]) - float(row[i - 1])) * t
    return 0.0


def main_plane_of(data):
    """主平面（0° 水平角优先）的一维 I(θ)；老数据没有 mainPlane 时从矩阵回推。"""
    mp = (data or {}).get("mainPlane")
    if isinstance(mp, dict) and mp.get("verticalAngles") and mp.get("candela"):
        return mp["verticalAngles"], mp["candela"], mp.get("horizontal")
    vert = (data or {}).get("verticalAngles") or []
    rows = (data or {}).get("candelaMatrix") or []
    if not vert or not rows:
        return None, None, None
    horiz = (data or {}).get("horizontalAngles") or [0.0] * len(rows)
    hi = next((i for i, h in enumerate(horiz) if abs(float(h)) < 1e-6), 0)
    return vert, rows[hi], horiz[hi]


def radial_profile(data) -> dict | None:
    """实测剖面：θ_half/θ_cut + R/H + 归一化采样。建不出来就返回 None（调用方标红，不退理论值）。"""
    vert, row, horizontal = main_plane_of(data)
    if not vert or not row:
        return None
    ref = _ref_candela(row)
    if ref <= 0:
        return None
    half = _cross(vert, row, ref, 0.5)
    cut = _cross(vert, row, ref, CUT_RATIO)
    if cut is None:
        # 降到 5% 的沿找不到（覆盖角不够／长尾配光）：不能把外缘硬扯到 90°，交给调用方标红
        return None
    if half is None:
        half = cut
    samples = []
    tan_cut = math.tan(math.radians(cut))
    for i in range(PROFILE_SAMPLES):
        r_norm = i / (PROFILE_SAMPLES - 1)
        ang = math.degrees(math.atan(r_norm * tan_cut)) if r_norm else 0.0
        p = max(0.0, _candela_at(vert, row, ang) / ref)
        samples.append([round(r_norm, 4), round(p, 4)])
    return {
        "photometrySource": PHOTOMETRY_MEASURED,
        "thetaHalfDeg": round(half, 3),
        "thetaCutDeg": round(cut, 3),
        "beamAngleDeg": round(half * 2, 2),
        "rOverH": round(tan_cut, 5),
        "rHalfOverH": round(math.tan(math.radians(half)), 5),
        "cutRatio": CUT_RATIO,
        "plane": horizontal,
        "samples": samples,
        "maxCandela": round(ref, 2),
        "transitionPx": None,   # 由出图侧按半径折算，见 exports.transition_band
    }


def theoretical_profile(beam_angle=None) -> dict:
    """硬边均匀剖面＝旧算法（tan(光束角/2)·H 一个整圆）在新口径下的特例。"""
    deg = float(beam_angle or DEFAULT_BEAM)
    half = max(0.5, min(89.0, deg / 2.0))
    samples = [[round(i / (PROFILE_SAMPLES - 1), 4),
                0.0 if i == PROFILE_SAMPLES - 1 else 1.0] for i in range(PROFILE_SAMPLES)]
    return {
        "photometrySource": PHOTOMETRY_THEORETICAL,
        "thetaHalfDeg": round(half, 3),
        "thetaCutDeg": round(half, 3),
        "beamAngleDeg": round(half * 2, 2),
        "rOverH": round(math.tan(math.radians(half)), 5),
        "rHalfOverH": round(math.tan(math.radians(half)), 5),
        "cutRatio": 1.0,
        "plane": None,
        "samples": samples,
        "maxCandela": None,
        "transitionPx": 0,
    }


def profile_at(samples, r_norm):
    """归一化半径上的亮度比 p(r)：分段线性，r≥1 视为 0。"""
    if not samples:
        return 0.0
    if r_norm <= 0:
        return float(samples[0][1])
    if r_norm >= float(samples[-1][0]):
        return 0.0
    for i in range(1, len(samples)):
        r0, p0 = samples[i - 1]
        r1, p1 = samples[i]
        if r0 <= r_norm <= r1:
            if r1 == r0:
                return float(p0)
            t = (r_norm - r0) / (r1 - r0)
            return float(p0) + (float(p1) - float(p0)) * t
    return 0.0


def drop_heavy(data):
    """缓存/落库用的瘦身版：原始矩阵换不成 64KB 就只留剖面与主平面证据。"""
    if not isinstance(data, dict):
        return data
    out = dict(data)
    out.pop("candelaMatrix", None)
    return out


def cache_path(sha: str) -> Path:
    return CACHE_DIR / f"{sha[:32]}.json"


def read_cache(sha: str):
    try:
        p = cache_path(sha)
        if p.is_file():
            payload = json.loads(p.read_text(encoding="utf-8"))
            if isinstance(payload, dict) and payload.get("sha256") == sha:
                return payload
    except (OSError, ValueError):
        return None
    return None


def write_cache(sha: str, size: int, status: str, data, error: str = "") -> dict:
    """同文件不重算（补全 4）。超 64KB 先削原始矩阵；削完还超就不缓存，别把磁盘当数据库。"""
    payload = {"sha256": sha, "bytes": size, "status": status,
               "parserVersion": PARSER_VERSION, "data": data, "error": error}
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        blob = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        if len(blob) > CACHE_MAX_BYTES:
            payload["data"] = drop_heavy(data)
            payload["trimmed"] = "原始 candela 矩阵超出单灯 64KB 上限，只留剖面与主平面"
            blob = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        if len(blob) <= CACHE_MAX_BYTES:
            tmp = cache_path(sha).with_suffix(".json.tmp")
            tmp.write_bytes(blob)
            tmp.replace(cache_path(sha))
            payload["cacheBytes"] = len(blob)
            payload["cached"] = True
            return payload
        payload["cached"] = False
        payload["cacheBytes"] = len(blob)
    except OSError:
        payload["cached"] = False
    return payload


PARSER_VERSION = "ies-2026-10-29-cut"


def parse_cached(raw: bytes) -> dict:
    """带 sha256 缓存的解析入口：畸形内容照样归到 parse_failed，缓存只加速不改变判定。"""
    sha = hashlib.sha256(raw).hexdigest()
    hit = read_cache(sha)
    if hit is not None:
        return {"ok": hit.get("status") == STATUS_PARSED, "status": hit.get("status") or STATUS_FAILED,
                "data": hit.get("data"), "error": hit.get("error", ""),
                "sha256": sha, "cacheHit": True}
    res = parse(raw)
    data = res.get("data")
    if isinstance(data, dict):
        prof = radial_profile(data) if res.get("status") == STATUS_PARSED else None
        data = {**data, "profile": prof, "sha256": sha}
        if res.get("status") == STATUS_PARSED and prof is None:
            # 能读出头尾却建不出可用剖面＝不能当实测用（正本：失败要可见）
            res = {**res, "status": STATUS_UNSUPPORTED,
                   "data": {**data, "unsupportedReason": "主平面建不出可用的径向剖面（无 5% 下降沿）"}}
        write_cache(sha, len(raw), res.get("status"), drop_heavy(data) if prof is None else data,
                    res.get("error", ""))
    return {**res, "data": data, "sha256": sha, "cacheHit": False}


def spot_of(fixture: dict, project: dict | None = None) -> dict:
    """灯位取光斑的唯一口径：实测→剖面；理论→硬边剖面并标"理论配光"；失败/不支持→red，不出光斑。

    这里任何一条分支都不许把 parse_failed/unsupported 折回理论剖面冒充实测（§5.1 补全 3）。
    """
    ies = (fixture or {}).get("ies")
    ies = ies if isinstance(ies, dict) else {}
    status = str(ies.get("status") or STATUS_NONE)
    data = ies.get("parsed") if isinstance(ies.get("parsed"), dict) else None
    if status == STATUS_PARSED:
        # 交付物脱敏会把 parsed 置空，剖面单独存一份，出图/清单两处都能读到同一个口径
        prof = (data or {}).get("profile") or ies.get("profile") or \
               (radial_profile(data) if data else None)
        if prof:
            return {"status": STATUS_PARSED, "red": False, "profile": prof,
                    "photometry": PHOTOMETRY_MEASURED,
                    "legend": f"实测配光（IES {ies.get('uploadedAt') or ies.get('name') or '未注明日期'}）",
                    "sha256": (data or {}).get("sha256") or ies.get("sha256") or "",
                    "why": ""}
        return {"status": STATUS_PARSED, "red": True, "profile": None,
                "photometry": PHOTOMETRY_UNVERIFIED, "legend": "未实测（剖面建不出来）",
                "sha256": "", "why": "IES 状态是 parsed 但读不出可用径向剖面，不退回理论值"}
    if status in BAD_STATUSES:
        why = ies.get("parseError") or (data or {}).get("unsupportedReason") or \
              (ies.get("note") or "").strip() or ("解析失败" if status == STATUS_FAILED else "配光不能用")
        return {"status": status, "red": True, "profile": None,
                "photometry": PHOTOMETRY_UNVERIFIED, "legend": f"未实测（{why}）",
                "sha256": ies.get("sha256") or "", "why": why}
    beam = (fixture or {}).get("beamAngle") or (project or {}).get("beamAngle") or DEFAULT_BEAM
    prof = theoretical_profile(beam)
    return {"status": STATUS_NONE, "red": False, "profile": prof,
            "photometry": PHOTOMETRY_THEORETICAL,
            "legend": f"理论配光（光束角 {prof['beamAngleDeg']:g}°）", "sha256": "", "why": ""}


def pool_radius_m(spot: dict, height_m: float) -> float:
    """光斑外缘半径一律取 R＝tan(θ_cut)·H；θ_half 只作等效光束角标注（A-16 收口，两者不得混用）。"""
    prof = (spot or {}).get("profile") or {}
    return max(0.0, float(height_m or 0) * float(prof.get("rOverH") or 0))


def height_m_of(fixture: dict, project: dict | None = None) -> float:
    """灯到受照面的距离：安装高度优先，缺省按吊顶后层高（与三维引擎同一口径）。"""
    project = project or {}
    for v in (fixture.get("installHeight"), project.get("ceilingNet"), project.get("ceiling")):
        try:
            f = float(v)
        except (TypeError, ValueError):
            continue
        if f > 0:
            return f
    return 2.8
