"""质量契约的公共落点（需求 D01–D12）＋ §7 数据字典闸门（缺件单/指名率/版本级别）。

只往项目 doc 里加顶层 quality 键（projects.doc 是 JSON 列），不改库表结构；
不重复 circuit_rules / ies 的计算，只汇总并如实标注「未知 / 不适用」。

四态口径（D04）：pass 通过 / fail 失败 / unknown 未知 / na 不适用。
适用性未知不等于不适用；缺件回填只代表收到值，重新检查通过才算 pass。
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

from . import ies as _IES
from . import price_terms as PT
from . import v3_fields as V

SCHEMA_VERSION = 1

PASS, FAIL, UNKNOWN, NA = "pass", "fail", "unknown", "na"
STATES = (PASS, FAIL, UNKNOWN, NA)
STATE_LABELS = {PASS: "通过", FAIL: "失败", UNKNOWN: "未知", NA: "不适用"}

# 未附具体型号手册时的参考值：只作读数参考，不当作已验证上限（D03/D05）。
# 与 frontend/src/data/control-reference.json 同源；改数要两边一起改。
REFERENCE_LIMITS = {
    "relay": {"maxDrivers": 12, "maxWatts": 300,
              "basis": "D3 参考值（未附继电器型号手册，不作判据）"},
    "dali": {"maxAddresses": 55,
             "basis": "D3 参考值（未附网关型号手册；SC-DK2-1C 标称 64 地址）"},
}

SCALE_VERIFIED, SCALE_DECLARED = "verified", "declared"
SCALE_PROBABLE, SCALE_UNVERIFIED, SCALE_CONFLICT = "probable", "unverified", "conflict"
SCALE_LABELS = {
    SCALE_VERIFIED: "已核",
    SCALE_DECLARED: "已声明·未交叉核",
    SCALE_PROBABLE: "推定（唯一候选）",
    SCALE_UNVERIFIED: "未核",
    SCALE_CONFLICT: "冲突",
}

# D08：业主/施工交付物里不该出现的内部字段。
# 成本口径的字段名只在 price_terms 声明一次（闸③的 grep 正本），这里只做引用。
_INTERNAL_KEYS = {
    "cooperation", "recognition", "quality", "renders", "invalidatedReviews",
    "unresolvedRegions", "semanticFallback", "sourcePath", "priceSource",
    "purchasePrice", "margin", "debug",
    # 缺件单/豁免/回填留痕是内部追责台账，不随业主版/施工版外发（D08）
    "fieldStamps", "missingWaivers", "namingExceptions",
} | set(PT.FIELD_TERMS)
# IES：只留文件级元数据，原始 candela 矩阵与派生角度表不进业主/施工交付物。
# profile 是光斑画图的依据（归一化 p(r)，181 点、不含光通量绝对值），随图出；
# 缺了它业主版会把实测灯画成「未实测」，那是另一种静默降级。
_IES_KEEP = ("name", "bytes", "uploadedAt", "status", "note", "source", "version",
             "profile", "sha256", "photometry")

RECESSED_KW = ("筒灯", "射灯", "嵌入式", "地埋", "线条灯", "洗墙")
DRIVER_CONTROLS = ("DALI", "KNX", "0-10V", "0–10V", "PWM", "可控硅", "调光")
MOUNTED_DEVICES = ("面板", "传感器", "网关", "电源", "执行器", "主机")


def _now() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


def _num(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f and abs(f) != float("inf") else None


def ensure(p: dict) -> dict:
    """幂等：保证项目里有 quality 骨架。绝不在这里抛 HTTP 错误。"""
    q = p.get("quality")
    if not isinstance(q, dict):
        q = p["quality"] = {}
    q.setdefault("schemaVersion", SCHEMA_VERSION)
    if not isinstance(q.get("scale"), dict):
        q["scale"] = {}
    q["scale"].setdefault("checks", [])
    if not isinstance(q.get("evidence"), dict):
        q["evidence"] = {}
    if not isinstance(q.get("checks"), dict):
        q["checks"] = {}
    return q


def _data_dir() -> Path:
    return Path(os.getenv("DATA_DIR", str(Path(__file__).resolve().parents[1] / "data")))


def _read_json(path: Path):
    try:
        return json.loads(path.read_text("utf-8"))
    except Exception:
        return {}


def _unit_evidence(p: dict) -> list[dict]:
    """图纸解析留下的尺度证据：项目附件里的识别结果 + 三维解析存储（只读）。"""
    out = []
    for f in p.get("files") or []:
        if not isinstance(f, dict):
            continue
        rec = f.get("recognition")
        src = (rec.get("source") if isinstance(rec, dict) else {}) or {}
        scheme = src.get("unit_scheme") if isinstance(src, dict) else None
        if isinstance(scheme, dict):
            out.append({"fileId": f.get("id"), "file": f.get("name") or src.get("file"), **scheme})
    st = _read_json(_data_dir() / "lighting3d" / (str(p.get("id")) + ".json"))
    parsed = st.get("parsed") if isinstance(st, dict) else {}
    src = (parsed.get("source") if isinstance(parsed, dict) else {}) or {}
    scheme = src.get("unit_scheme") if isinstance(src, dict) else None
    if isinstance(scheme, dict) and not any(x.get("file") == src.get("file") for x in out):
        out.append({"fileId": "", "file": src.get("file"), **scheme})
    return out


def scale_state(p: dict) -> dict:
    """D02：尺度状态。只有 verified 才允许说「已核尺寸 / 可定位开孔」。"""
    q = ensure(p)
    explicit = q["scale"]
    ev = _unit_evidence(p)
    conflicts = [e for e in ev if e.get("status") == SCALE_CONFLICT]
    declared = [e for e in ev if e.get("status") == SCALE_DECLARED]
    probable = [e for e in ev if e.get("status") == SCALE_PROBABLE]
    checks = [c for c in (explicit.get("checks") or []) if isinstance(c, dict)]
    valid = [(c, _num(c.get("factor"))) for c in checks]
    factors = sorted({round(f, 9) for _, f in valid if f and f > 0})
    # 同一次读数贴两遍不算两处独立校准：按「文件 + 图纸读数」去重，读数缺失时逐个计。
    sites = set()
    for i, (c, f) in enumerate(valid):
        if not f or f <= 0:
            continue
        dv = _num(c.get("drawingValue"))
        sites.add((str(c.get("fileId") or ""), round(dv, 6) if dv else f"#{i}"))

    if len(factors) > 1:
        # 同一份图纸给出两种比例：谁对不知道，只能标冲突，不能挑一个当已核
        status, factor = SCALE_CONFLICT, factors[-1]
        basis = "多处已知尺寸校准结果不一致（" + " / ".join(f"{f:g}" for f in factors[:3]) + "）"
    elif len(factors) == 1 and len(sites) >= 2:
        status, factor = SCALE_VERIFIED, factors[0]
        basis = f"{len(sites)} 处已知尺寸独立校准一致"
    elif conflicts:
        status, factor = SCALE_CONFLICT, _num(conflicts[0].get("factor")) or 1.0
        basis = "声明单位与图纸总体尺度冲突"
    elif len(sites) == 1 and factors:
        status, factor = SCALE_DECLARED, factors[0]
        basis = "一处已知尺寸校准（还需第二处独立尺寸交叉核）"
    elif declared:
        status, factor = SCALE_DECLARED, _num(declared[0].get("factor")) or 1.0
        basis = str(declared[0].get("basis") or "图纸声明了单位，未做独立尺寸交叉核")
    elif probable:
        status, factor = SCALE_PROBABLE, _num(probable[0].get("factor")) or 1.0
        basis = str(probable[0].get("basis") or "无单位声明，按住宅尺度推定出唯一候选")
    else:
        status, factor = SCALE_UNVERIFIED, 1.0
        basis = "没有单位声明，也没有已知尺寸可校准"

    unit = explicit.get("unit") or (ev[0].get("unit") if ev else "unknown")
    return {
        "status": status,
        "label": SCALE_LABELS[status],
        "factor": factor,
        "unit": unit,
        "basis": basis,
        "sources": ev[:8],
        "calibrations": checks[:8],
        "conflicts": conflicts[:8],
        "canClaimVerifiedDimensions": status == SCALE_VERIFIED,
        "notice": "" if status == SCALE_VERIFIED else
                  "尺度未核：草稿可看，但定位/开孔/加工尺寸不得称为已核",
    }


def add_calibration(p: dict, file_id: str, known_m: float, drawing_value: float,
                    note: str = "", by: str = "") -> dict:
    """D02：用一处已知尺寸校准。两处独立校准一致才升到 verified。"""
    known, drawing = _num(known_m), _num(drawing_value)
    if not known or not drawing or known <= 0 or drawing <= 0:
        raise ValueError("已知尺寸与图纸读数都要大于 0")
    factor = round(known * 1000.0 / drawing, 9)
    q = ensure(p)
    cal = {"fileId": file_id, "knownM": known, "drawingValue": drawing,
           "factor": factor, "unit": "mm", "note": str(note or "")[:200],
           "by": str(by or "")[:100], "at": _now()}
    checks = q["scale"].setdefault("checks", [])
    # 同一条读数重复提交只是修正，不是第二处独立校准；按文件 + 读数覆盖旧记录。
    same = next((i for i, c in enumerate(checks) if isinstance(c, dict)
                 and str(c.get("fileId") or "") == cal["fileId"]
                 and _num(c.get("drawingValue")) == drawing), None)
    if same is None:
        checks.append(cal)
    else:
        checks[same] = cal
    q["scale"].pop("unit", None)
    return scale_state(p)


def _pairs(p: dict):
    d = p.get("design") or {}
    for key in ("fixtures", "devices", "rooms", "openings", "furniture"):
        for obj in d.get(key) or []:
            if isinstance(obj, dict):
                yield key, obj


def provenance(p: dict, kind: str, obj: dict) -> dict:
    """D01：对象 → 原件/位置/版本。人工建立的对象如实标 manual，不伪造 CAD 来源。"""
    out = {"kind": kind, "id": obj.get("id"), "state": "missing", "origin": ""}
    fid = obj.get("sourceFileId")
    if fid:
        f = next((x for x in p.get("files") or [] if x.get("id") == fid), {})
        out.update({
            "state": "sourced", "origin": obj.get("source") or "cad",
            "fileId": fid, "file": f.get("name") or "",
            "fileSha256": f.get("sha256") or "",
            "locator": {
                "layer": obj.get("layer") or "",
                "handle": obj.get("handle") or "",
                "blockPath": obj.get("blockPath") or [],
                "layout": obj.get("layout") or "Model",
            },
            "transform": obj.get("transform") or {},
        })
        if not out["locator"]["handle"]:
            out["state"] = "sourced-unlocated"
            out["why"] = "只有文件级来源，没有原图 handle/实例路径，重复块无法区分"
        return out
    if obj.get("productId") or obj.get("model"):
        out.update({"state": "product", "origin": "product-library", "productId": obj.get("productId") or "",
                    "productVersion": obj.get("productVersion") or obj.get("productBuild") or "",
                    "productSource": obj.get("sourcePath") or ""})
        if not out["productVersion"]:
            out["state"] = "product-unpinned"
            out["why"] = "选了型号但没有记录产品库版本/指纹"
        return out
    out.update({"state": "manual", "origin": obj.get("source") or "manual"})
    if obj.get("createdBy") or obj.get("notes"):
        out["note"] = obj.get("createdBy") or ""
    return out


def _is_recessed(f: dict) -> bool:
    t = str(f.get("type") or "")
    return any(k in t for k in RECESSED_KW)


def _needs_driver(f: dict) -> bool:
    c = str(f.get("control") or "").strip()
    return c in DRIVER_CONTROLS or c.startswith("DALI")


def _row(kind, obj, field, why, fix, gates, code=""):
    return {"kind": kind, "id": obj.get("id"), "code": code or obj.get("code") or obj.get("name") or obj.get("id"),
            "field": field, "state": UNKNOWN, "why": why, "fix": fix, "gates": list(gates),
            "clause": "D04"}

def project_checks(p: dict) -> list[dict]:
    """D03/D04/D05：高后果的已知/未知项。这里只列「必须有人管」的，不刷满整张表。"""
    rows: list[dict] = []
    sc = scale_state(p)
    rows.append({"kind": "project", "id": "scale", "code": "尺度", "field": "scale",
                 "state": PASS if sc["status"] == SCALE_VERIFIED else UNKNOWN,
                 "why": sc["basis"], "fix": "用两处独立已知尺寸校准" if sc["status"] != SCALE_VERIFIED else "",
                 "gates": ["layout", "delivery"], "clause": "D02"})
    for kind, obj in _pairs(p):
        if kind == "fixtures":
            code = obj.get("code") or ""
            if (_num(obj.get("power")) or 0) <= 0:
                rows.append(_row(kind, obj, "power", "功率未填或为 0：回路负载未知，不能按 0 计",
                                 "在产品库选型或按厂家参数补功率", ["lighting", "pricing", "delivery"], code))
            if _is_recessed(obj) and not (_num(obj.get("cutout")) or 0) > 0:
                rows.append(_row(kind, obj, "cutout", "嵌入式灯具没有开孔尺寸",
                                 "按所选型号手册补开孔尺寸", ["lighting", "delivery"], code))
            if _needs_driver(obj) and not (obj.get("model") or obj.get("driverSpec") or obj.get("driver")):
                rows.append(_row(kind, obj, "driver", "调光灯具没有型号/驱动依据，适配性未知",
                                 "绑定具体型号并核驱动/最低负载", ["lighting", "pricing", "delivery"], code))
            # D06/D13：配光文件只有「能解析」还不够；不对称配光不能当单平面径向用。
            # 判定与出图共用 ies.spot_of 一个口径：画不出光斑的灯在这里也必须是红项，
            # 不能图上标红、清单里却算过（§5.1 补全 3）。
            ies = obj.get("ies") if isinstance(obj.get("ies"), dict) else None
            if ies:
                spot = _IES.spot_of(obj)
                if spot["red"]:
                    rows.append(_row(kind, obj, "ies",
                                     f"配光文件状态 {ies.get('status') or '未知'}：{spot['why'] or '未形成可用配光'}，光斑按「未实测」标红",
                                     "补可解析的 IES 或改用型号手册光通量", ["lighting", "delivery"], code))
                elif isinstance(ies.get("parsed"), dict) and ies["parsed"].get("radialApprox") is False:
                    rows.append(_row(kind, obj, "ies-symmetry", "配光 β 向不对称，不能按单平面径向近似",
                                     "按实际水平方向复核光斑与照度", ["lighting"], code))
        elif kind == "devices":
            if obj.get("type") in MOUNTED_DEVICES and _num(obj.get("x")) is None and not obj.get("host"):
                rows.append(_row(kind, obj, "mount", "设备没有落位，也没有安装宿主，安装关系未知",
                                 "落位或指定宿主/检修位置", ["lighting", "delivery"]))
        elif kind == "openings":
            if "edgeIndex" in obj and not obj.get("anchor"):
                rows.append(_row(kind, obj, "anchor", "门窗只按边号挂接，边界重排后位置无法复核",
                                 "重挂时按几何重新锚定（系统自动）", ["layout"], obj.get("name") or obj.get("type") or ""))
    rows.extend(circuit_rows(p))
    return rows


def circuit_rows(p: dict) -> list[dict]:
    """D05：回路读数只作参考；没有型号手册时状态是未知，不是通过。"""
    from . import circuit_rules as CR
    design = p.get("design") or {}
    out = []
    for key, members in CR.groups(design).items():
        if key == CR.UNASSIGNED:
            continue
        ctrls = CR.controls(members)
        ref = CR.reference_limits(ctrls)
        if not ref:
            continue
        read = CR.reading(members)
        over = CR.over_reference(members)
        out.append({
            "kind": "circuit", "id": key, "code": key, "field": "resources",
            "state": UNKNOWN, "why": (read + ("；已超参考值，按未知从严" if over else "；未附型号手册")),
            "fix": "附继电器/网关型号手册后按实际容量核", "gates": ["lighting", "delivery"],
            "clause": "D05", "over": over, "reference": ref,
        })
    return out


def four_state(rows: list[dict]) -> dict:
    counts = {s: 0 for s in STATES}
    for r in rows:
        st = r.get("state") if r.get("state") in STATES else UNKNOWN
        counts[st] += 1
    counts["denominator"] = counts[PASS] + counts[FAIL] + counts[UNKNOWN]
    counts["unknownHighRisk"] = sum(1 for r in rows if r.get("state") == UNKNOWN)
    return counts


def high_risk_unknowns(p: dict) -> list[dict]:
    return [r for r in project_checks(p) if r.get("state") == UNKNOWN]


def quality_hash(p: dict) -> str:
    rows = project_checks(p)
    body = {
        "scale": scale_state(p)["status"],
        # 一律转字符串再排序：id/field 可能是 None，混着 int 会让 sorted 抛错
        "checks": sorted([str(r["kind"]), str(r.get("id")), str(r.get("field")), str(r.get("state"))]
                         for r in rows),
        # §7 缺件单进指纹：回填一条缺件＝质量状态变了，旧签名不能继续算数
        "missing": sorted(str(r["field_path"]) for r in missing_items(p) if r["status"] == "未回填"),
    }
    return hashlib.sha256(json.dumps(body, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()


def review_cover(p: dict, key: str) -> dict:
    """D10：签名必须写清核了什么、没核什么、适用范围与依据版本。"""
    from .gates import design_hash
    rows = [r for r in project_checks(p) if key in r.get("gates", [])]
    unknowns = [r for r in rows if r.get("state") == UNKNOWN]
    sc = scale_state(p)
    vl = version_level(p)
    return {
        "gate": key,
        "revision": p.get("revision"),
        "designHash": design_hash(p),
        "qualityHash": quality_hash(p),
        "scale": sc["status"],
        "scaleLabel": sc["label"],
        "versionLevel": vl["level"],
        "blockingMissing": vl["blocking"],
        "postSealBlocking": vl["postSealBlocking"],
        "covers": [f"{r['kind']}:{r.get('code') or r.get('id')}:{r.get('field')}" for r in rows if r.get("state") == PASS][:200],
        "excludes": [f"{r['kind']}:{r.get('code') or r.get('id')}:{r.get('field')}" for r in unknowns][:200],
        "unknownHighRisk": len(unknowns),
        "note": "签名只覆盖本版本本机所列范围；未知项不因签字变通过" if unknowns else "",
    }


def has_source_dxf(p: dict) -> bool:
    if (p.get("design") or {}).get("source3dHash"):
        return True
    return (_data_dir() / "lighting3d" / (str(p.get("id")) + ".source.dxf")).is_file()


def required_files(p: dict, audience: str = "internal") -> list[dict]:
    keys = ("json", "xlsx", "docx", "pdf", "html", "panels", "handover")
    rows = [{"key": k, "required": True, "why": ""} for k in keys]
    src = has_source_dxf(p)
    rows.append({"key": "dxf", "required": src,
                 "why": "" if src else "项目没有原图/三维源 DXF，成品 DXF 不适用"})
    return rows


def _redact_ies(ies):
    if not isinstance(ies, dict):
        return ies
    out = {k: v for k, v in ies.items() if k in _IES_KEEP}
    out["parsed"] = None
    out["redacted"] = "原始配光矩阵与派生角度表不随交付物提供"
    return out


# 交付物里的附件只留身份与指纹；本机路径、识别原文/派生数据不随包外发。
_FILE_KEEP = ("id", "name", "type", "bytes", "sha256", "uploadedAt", "floor")


def _redact_file(f):
    if not isinstance(f, dict):
        return f
    return {k: f.get(k) for k in _FILE_KEEP if k in f}


def _redact_obj(kind: str, obj: dict, audience: str) -> dict:
    out = {k: v for k, v in obj.items() if k not in _INTERNAL_KEYS and not str(k).startswith("_")}
    if isinstance(out.get("ies"), dict):
        out["ies"] = _redact_ies(out["ies"])
    if audience == "site":
        for k in ("price", "amount", "subtotal"):
            if k in out:
                out[k] = 0
        for k in ("priceVerified", "priceSource"):
            out.pop(k, None)
    return out


def delivery_redact(p: dict, audience: str = "internal") -> dict:
    """D08：按受众给内容，不只看文件名/标签。internal 保持原样。"""
    if audience == "internal":
        return p
    data = json.loads(json.dumps(p, ensure_ascii=False))
    data = {k: v for k, v in data.items() if k not in _INTERNAL_KEYS}
    if isinstance(data.get("files"), list):
        data["files"] = [_redact_file(x) for x in data["files"]]
    design = data.get("design") or {}
    for key in ("fixtures", "devices", "rooms", "openings", "furniture", "scenes", "texts", "walls",
                "circuits", "cabinets", "powerEntries", "mounts"):
        if isinstance(design.get(key), list):
            design[key] = [_redact_obj(key, x, audience) if isinstance(x, dict) else x for x in design[key]]
    for key in ("fieldStamps", "missingWaivers", "namingExceptions"):
        design.pop(key, None)
    data["design"] = design
    data.pop("missingItems", None)
    return data


def evidence_manifest(p: dict, files: list[dict] | None = None, audience: str = "internal") -> dict:
    """D12：随包给出构建、输入指纹、规则版本、未覆盖项，不写自我评价。"""
    root = Path(__file__).resolve().parents[1]
    version = ""
    try:
        version = (root / "VERSION").read_text("utf-8").strip()
    except Exception:
        pass
    baseline = _read_json(root / "build-baseline.json")
    rows = project_checks(p)
    sc = scale_state(p)
    return {
        "schemaVersion": 1,
        "generatedAt": _now(),
        "audience": audience,
        "build": {"version": version, "buildId": baseline.get("buildId") or baseline.get("build_id") or "",
                  "baselineFile": "build-baseline.json"},
        "inputs": [{"fileId": f.get("id"), "name": f.get("name"), "bytes": f.get("bytes"),
                    "sha256": f.get("sha256") or ""} for f in (p.get("files") or [])][:200],
        "rules": {"circuit": REFERENCE_LIMITS, "scale": sc},
        "fourState": four_state(rows),
        "unknowns": [{"kind": r["kind"], "id": r["id"], "code": r.get("code"), "field": r.get("field"),
                      "why": r.get("why")} for r in rows if r.get("state") == UNKNOWN][:200],
        "notVerifiableInThisBuild": [
            "不同 CAD 引擎重开与打印实测（T07 剩余）",
            "真人接图 / 实板实灯试装（T11）",
            "封存盲测与独立真值 TP/FP/FN（T10）",
        ],
        "files": [{"name": x.get("name"), "bytes": x.get("bytes"), "sha256": x.get("sha256")}
                  for x in (files or [])],
    }


# ---------------------------------------------------------------- §7 缺件单 / 指名率 / 版本级别

V3_TABLES = ("circuit", "cabinet", "cabinet_cell", "plate", "power_entry", "fixture", "mount")


def _design(p: dict) -> dict:
    d = p.get("design")
    return d if isinstance(d, dict) else {}


def v3_objects(p: dict):
    """遍历 §7 对象层的三类＋灯位＋挂载表；柜格/板面是柜体的子对象。"""
    d = _design(p)
    for obj in d.get("circuits") or []:
        if isinstance(obj, dict):
            yield "circuit", obj
    for cab in d.get("cabinets") or []:
        if not isinstance(cab, dict):
            continue
        yield "cabinet", cab
        for cell in cab.get("cells") or []:
            if not isinstance(cell, dict):
                continue
            yield "cabinet_cell", cell
            for plate in cell.get("plates") or []:
                if isinstance(plate, dict):
                    yield "plate", plate
    for obj in d.get("powerEntries") or []:
        if isinstance(obj, dict):
            yield "power_entry", obj
    for obj in d.get("mounts") or []:
        if isinstance(obj, dict):
            yield "mount", obj
    for obj in d.get("fixtures") or []:
        if isinstance(obj, dict):
            yield "fixture", obj


def _obj_id(table: str, obj: dict) -> str:
    return str(obj.get("id") or obj.get("cell_id") or obj.get("plate_code")
               or obj.get("circuit_no") or "")


def _applies(table: str, spec: dict, obj: dict, ctx: dict) -> bool:
    """格子的适用范围：不适用不是缺件（D04 口径），但不适用要能说清为什么。"""
    key = spec["key"]
    if table == "fixture" and key.startswith("d4"):
        # D4 是驱动三格：只有带外接驱动的灯才要求（灯带按电源、调光按控制方式）。
        return _needs_driver(obj) or obj.get("type") == "灯带" or bool(obj.get("powerSupply"))
    if table == "power_entry" and key in ("d8_4", "d8_5"):
        return ctx["has_cabinet"]
    if table == "mount" and key == "circuit_id":
        return str(obj.get("kind") or "") in ("灯具", "取电")
    if table == "fixture" and key == "circuitId":
        return ctx["has_circuit"]
    return True


def _waivers(p: dict) -> dict:
    out = {}
    for w in _design(p).get("missingWaivers") or []:
        if isinstance(w, dict) and w.get("field_path"):
            out[str(w["field_path"])] = w
    return out


def _stamps(p: dict) -> dict:
    st = _design(p).get("fieldStamps")
    return st if isinstance(st, dict) else {}


def missing_items(p: dict) -> list[dict]:
    """§7.8 缺件单：唯一的断链登记口。每行 12 列，field_path 必须可解析。

    表是派生的：值回填了行就变「已回填」，不是往表里再写一行状态——
    状态存两份必然一值两份。
    """
    d = _design(p)
    ctx = {"has_cabinet": bool(d.get("cabinets")),
           "has_circuit": bool(d.get("circuits"))}
    waivers, stamps = _waivers(p), _stamps(p)
    rows: list[dict] = []
    for table, obj in v3_objects(p):
        oid = _obj_id(table, obj)
        if not oid:
            continue
        for spec in V.fields_of(table):
            if spec["tier"] == V.DERIVED or not _applies(table, spec, obj, ctx):
                continue
            filled = _field_filled(table, spec, obj)
            field_path = V.path(table, oid, spec["key"])
            waiver = waivers.get(field_path)
            stamp = stamps.get(field_path) or {}
            if waiver and waiver.get("reason") and waiver.get("by"):
                status, closed_at, closed_by, reason = (
                    "已豁免", waiver.get("at") or "", str(waiver.get("by")), str(waiver.get("reason")))
            elif filled:
                status, closed_at, closed_by, reason = ("已回填", str(stamp.get("at") or ""),
                                                        str(stamp.get("by") or ""), "")
            else:
                status, closed_at, closed_by, reason = ("未回填", "", "", "")
            if status == "已回填":
                continue
            rows.append({
                "what": spec["label"], "field_path": field_path,
                "ask_whom": spec["ask_whom"] or "设计师",
                "ask_where": spec.get("ask_where") or "",
                "severity": V.severity_of(spec), "status": status,
                "redmark": status == "未回填", "stage_group": V.STAGE_LABELS[spec["stage"]],
                "created_at": stamp.get("firstSeen") or "",
                "closed_at": closed_at, "closed_by": closed_by, "reason": reason,
                "kind": table, "id": oid,
                "code": obj.get("code") or obj.get("circuit_no") or obj.get("cell_id") or oid,
                "accident": spec["accident"], "domain": spec["domain"],
                "tier": spec["tier"],
            })
    # A9 落位违规并进同一张登记口：field_path 指向 placement.<id>.sku，
    # 关掉它的唯一方式就是把选品换成过 L0 的 SKU（§7.8 硬规矩 1：不在别处再写一份状态）
    for x in a9_state(p)["problems"]:
        field_path = V.path("placement", x["fixture_id"], x["field_key"])
        stamp = stamps.get(field_path) or {}
        waiver = waivers.get(field_path)
        waivered = bool(waiver and waiver.get("reason") and waiver.get("by"))
        rows.append({
            "what": ("选品 SKU 不过 L0 硬闸" if x["field_key"] == "sku" else "价格口径不是零售价"),
            "field_path": field_path, "ask_whom": "产品资料", "ask_where": "产品库",
            "severity": V.BLOCK,
            "status": "已豁免" if waivered else "未回填",
            "redmark": not waivered,
            "stage_group": V.STAGE_LABELS[V.PRE],
            "created_at": stamp.get("firstSeen") or "",
            "closed_at": (waiver or {}).get("at") or "",
            "closed_by": str((waiver or {}).get("by") or "") if waivered else "",
            "reason": str((waiver or {}).get("reason") or "") if waivered else "",
            "kind": "placement", "id": x["fixture_id"],
            "code": x["fixture_id"], "accident": x["why"],
            "domain": V.field_of("placement", x["field_key"])["domain"],
            "tier": V.REQUIRED,
        })
    return rows


def _field_filled(table: str, spec: dict, obj: dict) -> bool:
    keys = spec["key"].split("/")
    if len(keys) > 1:
        return all(V.is_named(obj.get(k)) for k in keys)
    if V.is_named(obj.get(spec["key"])):
        return True
    # 嵌套在柜体里的格（板面尺寸、挂载的 D10 三格）允许用子字典给值
    nested = obj.get(spec["key"])
    return isinstance(nested, dict) and any(V.is_named(v) for v in nested.values())


def blocking_items(p: dict, stage: str | None = None) -> list[dict]:
    """阻断级未回填；stage=封板后 时只取封板后才暴露的缺件（＝砸墙项）。"""
    return [r for r in missing_items(p)
            if r["severity"] == V.BLOCK and r["status"] == "未回填"
            and (stage is None or r["stage_group"] == V.STAGE_LABELS[stage])]


def naming_coverage(p: dict) -> dict:
    """§7.2 指名率：分母＝自动长出的对象总数，分子＝ref_name 非占位词或 id_no 非空。"""
    d = _design(p)
    pool = [("circuit", x) for x in d.get("circuits") or [] if isinstance(x, dict)]
    pool += [("cabinet", x) for x in d.get("cabinets") or [] if isinstance(x, dict)]
    for cab in d.get("cabinets") or []:
        if isinstance(cab, dict):
            pool += [("cabinet_cell", x) for x in cab.get("cells") or [] if isinstance(x, dict)]
    pool += [("power_entry", x) for x in d.get("powerEntries") or [] if isinstance(x, dict)]
    pool += [("fixture", x) for x in d.get("fixtures") or [] if isinstance(x, dict)]
    named, unnamed = 0, []
    for table, obj in pool:
        if V.has_number(obj):
            named += 1
        else:
            unnamed.append({"kind": table, "id": _obj_id(table, obj),
                            "room": obj.get("roomId") or obj.get("room_id") or ""})
    # 人工例外：每房 ≤3 条且必须带原因（§7.2 门槛）
    per_room: dict[str, dict] = {}
    for e in d.get("namingExceptions") or []:
        if not isinstance(e, dict):
            continue
        room = str(e.get("roomId") or "")
        bucket = per_room.setdefault(room, {"count": 0, "noReason": 0})
        bucket["count"] += 1
        if not (e.get("reason") and e.get("by")):
            bucket["noReason"] += 1
    over = {k: v["count"] for k, v in per_room.items() if v["count"] > 3}
    no_reason = sum(v["noReason"] for v in per_room.values())
    total = len(pool)
    return {
        "denominator": total, "named": named, "uncovered": unnamed,
        "autoNumberCoverage": 100.0 if total and named == total else (
            round(100.0 * named / total, 1) if total else 0.0),
        "exceptionsByRoom": {k: v["count"] for k, v in per_room.items()},
        "exceptionsOverLimit": over, "exceptionsWithoutReason": no_reason,
        "pass": bool(total) and named == total and not over and not no_reason,
        "emptyProject": total == 0,
        "rule": "自动编号覆盖 100%；每房人工例外 ≤3 条且必须带原因（§7.2 v3）",
    }


# 尚未接进版本级别判据的验收项——如实列出，避免 formalReady 被读成「A1–A11 全过」。
NOT_YET_WIRED = ["A3b 断路器/线径系数需型号手册核验", "A6 四类导出对象数一致性（本机有 export_matrix_smoke）"]


def a9_state(p: dict) -> dict:
    """A9 选品参数硬闸（1.0 只验 L0，§5.2/§12.1）。懒导入同 a11_state：产品库读盘，
    没落位记录时不该为版本判据去打文件。"""
    from . import brandwall as W
    pl = W.placements_of(p)
    if not pl:
        return {"violations": 0, "problems": [], "placed": [], "placementCount": 0,
                "pass": True, "emptySelection": True,
                "rule": "A9：参数不符的 SKU 不得保存/落位，出现＝0（§12.1）"}
    return W.selection_gate(p)


def selection_gate_state(p: dict) -> dict:
    return a9_state(p)


def a11_state(p: dict) -> dict:
    """A11 施工可交接（§8.3 十二条＋Q16 逐项签字）。懒导入：delivery 依赖本模块，
    版本判据又要把 A11 算进来，模块级互相引用会绕圈。"""
    from . import delivery as D
    return D.handover_a11(p)


def version_level(p: dict) -> dict:
    """§12.0 三级版本判据：阻断级>0 或人工例外>3 → 只能草稿版。"""
    items = missing_items(p)
    blocking = [r for r in items if r["severity"] == V.BLOCK and r["status"] == "未回填"]
    post = [r for r in blocking if r["stage_group"] == V.STAGE_LABELS[V.POST]]
    nc = naming_coverage(p)
    reasons = []
    if blocking:
        reasons.append(f"阻断级红项 {len(blocking)} 条")
    if post:
        reasons.append(f"封板后红项 {len(post)} 条")
    if nc["exceptionsOverLimit"]:
        reasons.append("人工例外超每房 3 条：" + "、".join(f"{k} {v} 条" for k, v in nc["exceptionsOverLimit"].items()))
    if nc["exceptionsWithoutReason"]:
        reasons.append(f"人工例外缺原因/缺人 {nc['exceptionsWithoutReason']} 条")
    if nc["uncovered"]:
        reasons.append(f"未指名对象 {len(nc['uncovered'])} 个（A1 要求＝0）")
    a11 = a11_state(p)
    if not a11["pass"]:
        if not a11["allYes"]:
            reasons.append("A11 施工可交接未过：电工 12 条里第 " +
                           "、".join(str(x) for x in a11["noItems"]) + " 条为否")
        if not a11["signsComplete"]:
            reasons.append("A11 未逐项签字（含失效）：第 " +
                           "、".join(str(x) for x in a11["unsigned"]) + " 条")
    a9 = selection_gate_state(p)
    if a9["violations"]:
        reasons.append(f"A9 选品硬闸：{a9['violations']} 条落位 SKU 不过 L0"
                       + "（" + "；".join(x["why"] for x in a9["problems"][:3]) + "）")
    formal = not reasons
    return {
        "level": "正式版" if formal else "草稿版",
        "formalReady": formal,
        "blocking": len(blocking), "postSealBlocking": len(post),
        "registeredBreaks": len(items), "hintOpen": len(
            [r for r in items if r["severity"] == V.HINT and r["status"] == "未回填"]),
        "a11": a11, "a9": a9,
        "reasons": reasons,
        "notChecked": NOT_YET_WIRED,
        "rule": "阻断级>0→只能草稿；提示级＋已登记断链→可随正式版；封板后红项必须为 0；"
                "A11＝12 条全「是」＋逐项签字（§12.0/§12.1）",
    }


def red_points(p: dict) -> list[dict]:
    """图上红点的来源：缺件单派生，不靠人记得改色（§7.1 标红即派生）。

    只回能落到图纸坐标的对象——回路/配电箱类缺件在清单里标红，画不到平面上。
    """
    d = _design(p)
    fixtures = {str(f.get("id")): f for f in d.get("fixtures") or [] if isinstance(f, dict)}
    out = []
    for r in missing_items(p):
        if not r["redmark"]:
            continue
        host = fixtures.get(str(r["id"]))
        if host is None:
            host = next((o for t, o in v3_objects(p) if _obj_id(t, o) == str(r["id"])), None)
        if not isinstance(host, dict) or host.get("x") is None or host.get("y") is None:
            continue
        out.append({**{k: r[k] for k in ("what", "field_path", "severity", "stage_group", "kind",
                                         "id", "code", "ask_whom")},
                    "point": {"x": _num(host.get("x")), "y": _num(host.get("y")),
                              "floor": host.get("floor", 1), "room": host.get("roomId") or ""}})
    return out


def stamp_first_seen(p: dict) -> None:
    """created_at 创建即写（§7.8）：登记表是派生的，首次观察到某条缺件时留时间戳。"""
    d = _design(p)
    stamps = d.setdefault("fieldStamps", {})
    now = _now()
    for row in missing_items(p):
        stamps.setdefault(row["field_path"], {}).setdefault("firstSeen", now)


def resolve_field(p: dict, field_path: str):
    """按 field_path 找到载体对象（回填口的路径校验）。"""
    table, obj_id, field = V.parse_path(field_path)
    if table == "placement":
        # 选品落位不是 §7 对象层遍历里的一张表，但回填口径必须一致：
        # placement.<灯位 id>.sku 只能指回那条落位记录。
        for i, row in enumerate(_design(p).get("placements") or []):
            if isinstance(row, dict) and (str(row.get("fixture_id") or "") == obj_id
                                          or f"placement{i + 1}" == obj_id):
                return row, field
        raise ValueError(f"回填口指向不存在的落位记录：{field_path}")
    for t, obj in v3_objects(p):
        if t == table and _obj_id(t, obj) == obj_id:
            return obj, field
    raise ValueError(f"回填口指向不存在的对象：{field_path}")


def backfill(p: dict, field_path: str, value, by: str = "") -> dict:
    """§7.8 硬规矩 1＋4：值只能从 field_path 写进去，写进去才算关闭，并留下人与时间。"""
    obj, field = resolve_field(p, field_path)
    d = _design(p)
    stamps = d.setdefault("fieldStamps", {})
    key = str(field_path)
    prev = stamps.get(key) or {}
    if not (by or "").strip():
        raise ValueError("回填必须留人")
    obj[field] = value
    stamps[key] = {"at": _now(), "by": str(by)[:100], "firstSeen": prev.get("firstSeen") or _now()}
    return {"field_path": key, "status": "已回填", "closed_at": stamps[key]["at"],
            "closed_by": stamps[key]["by"]}


def waive(p: dict, field_path: str, reason: str, by: str = "") -> dict:
    """豁免不是解除：必须留人和理由（§7.8 硬规矩 4）。"""
    V.parse_path(field_path)
    if not (reason or "").strip() or not (by or "").strip():
        raise ValueError("豁免必须写理由并留人")
    d = _design(p)
    rows = d.setdefault("missingWaivers", [])
    rows[:] = [w for w in rows if isinstance(w, dict) and str(w.get("field_path")) != str(field_path)]
    rows.append({"field_path": str(field_path), "reason": str(reason)[:500],
                 "by": str(by)[:100], "at": _now()})
    return {"field_path": str(field_path), "status": "已豁免", "closed_by": str(by)[:100]}

