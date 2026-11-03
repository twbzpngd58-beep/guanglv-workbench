"""§10 协同包 → 回传 → 合图（阶段 4，走文件不做登录）。

一句话：把「已定平面方案」里必须供应商回应的对象打成一个 zip 发出去，
供应商线下填 `selection/slots.csv` 寄回来，制图器按 §10.2 六条硬拒＋C1–C6
校验，只取白名单字段落位（`origin=supplier`），冲突只标记不自动修。

口径（照文档，不许自己放宽）：
- **沉默不算回传**：包内每个必挂对象都要有回应，无回应＝整包打回（§10.1 硬规则）。
- **拒≠丢**：硬拒的包裹原文进「退回箱」等人复核，不静默删（§10.2）。
- **写权限**：供应商只许写 `sku/params/price/delivery` 加本专业附属（柜厂：板号/板厚/
  板面实际尺寸/改位 (u,v)/可用开孔灯槽；智能商：网关/安装位/通道占用/场景/断电默认态/
  不支持项）。灯位坐标、回路归属、D1/D9/D10/D11、图号版本、客户信息＝写权限 0（§15 权限一句话）。
- **合图不覆盖原始值**：回传原样存在包记录里（`returns[].rows_raw`），落位值是另一份。
- **无 PII 入包**：外发只带匿名项目号；客户名/电话/地址/项目名出现在包里任何位置即拒绝发送（§10.2-4、R4）。
- 包账本存在 `projects.doc` 的 `collab` 段里——**不新建表、不动库结构**（H4）。
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import math
import os
import re
import sqlite3
import uuid
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter, Body, File, HTTPException, UploadFile
from starlette.responses import Response

from . import brandwall as W
from . import circuit_rules as CR
from . import price_terms as PT
from . import product_library as PL
from . import quality as Q
from . import v3_fields as V

ROOT = Path(__file__).resolve().parent.parent
DB = Path(os.getenv("DATA_DIR", str(ROOT / "data"))).resolve() / "studio.sqlite3"

router = APIRouter(prefix="/api/supplierpack", tags=["supplierpack"])

SCHEMA_VERSION = 1
KNOWN_SCHEMA_VERSIONS = (1,)
LEDGER = "collab"
DEADLINE_DAYS = 7
MAX_PACKS = 200
MAX_SLOTS = 2000

VENDOR_KINDS = ("定制", "智能")
VENDOR_LABEL = {"定制": "柜厂／定制供应商", "智能": "智能供应商"}

# 包内只读列（供应商不许动，改了就是绕工具手改 → 硬拒 3）
LOCKED_COLS = ("slot_id", "object_type", "object_no", "room", "current_sku", "need")
# §5.2 拍板：价格只有零售价一种口径，所以口径列也是必填白名单列
BASE_FILL = ("sku", "params", "price", "price_scope", "delivery")
VENDOR_FILL = {
    "定制": ("verdict", "plate_code", "plate_thickness", "plate_w_mm", "plate_h_mm",
             "u", "v", "cutouts", "reject_reason"),
    "智能": ("verdict", "gateway_model", "gateway_channel", "channel_limit", "load_type", "rated",
             "install_pos", "scene_no", "trigger_source", "poweroff_default",
             "unsupported", "reject_reason"),
}
# 写权限为 0 的字段：出现在回传列里直接点名拒绝（不只说「白名单外」）
ZERO_WRITE = {
    "x": "灯位坐标", "y": "灯位坐标", "z": "灯位坐标",
    "circuit": "回路归属", "circuit_id": "回路归属", "circuitId": "回路归属",
    "d9_1": "D9 暗盒", "d9_2": "D9 暗盒定位", "d10_1": "D10 开孔", "d10_2": "D10 对应 SKU",
    "d10_3": "D10 净空", "d11": "D11 避让", "d1_1": "D1 回路九格",
    "d4_1": "D4 驱动", "d4_2": "D4 驱动位置", "d4_3": "D4 带灯数",
    "version": "图号版本", "revision": "图号版本", "drawing_no": "图号版本",
    "client": "客户信息", "endCustomerName": "客户信息", "phone": "客户信息",
    "address": "客户信息", "project_name": "客户信息",
}

ACCEPT_VERDICTS = ("确认", "改位", "拒绝", "不支持")
PRICE_SCOPES = ("零售价", "市场零售价")

PHONE_RE = re.compile(r"(?<!\d)1[3-9]\d{9}(?!\d)")
TEL_RE = re.compile(r"(?<!\d)0\d{2,3}-?\d{7,8}(?!\d)")
IDCARD_RE = re.compile(r"(?<!\d)\d{17}[\dXx](?!\d)")
PII_KEY_RE = re.compile(r"(client|customer|phone|mobile|address|姓名|客户|业主|电话|地址)", re.I)

# C3 的留边起值：§14 拍板 6「柜内灯带留边 10mm 起，按柜厂回传覆盖」
EDGE_GAP_MIN_MM = 10.0
# C6 双向一致性容差（mm）：柜厂给的是整毫米，超过 0.5mm 就是两套坐标
UV_TOLERANCE_MM = 0.5

CHECK_NAMES = {
    "C1": "编号反查（回传对象能在图上找到，图上对象在回传里有回应）",
    "C2": "板面局部坐标在板内（0≤u≤板宽、0≤v≤板高）",
    "C3": "同板开孔/槽不重叠、不出板边、净空≥板厚＋散热",
    "C4": "回路-通道 1:1 且额定≥功率",
    "C5": "已用通道≤机型上限",
    "C6": "双向一致性（世界坐标改动后重算的 (u,v) 与回传值一致）",
}
PASS, FAIL, UNKNOWN = "pass", "fail", "unknown"


# ---------------------------------------------------------------- 账本


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.isoformat(timespec="seconds")


def _doc_ledger(p: dict) -> dict:
    c = p.get(LEDGER)
    if not isinstance(c, dict):
        c = {"packs": [], "conflicts": [], "return_box": [], "security_events": [], "channel_map": []}
        p[LEDGER] = c
    for key, blank in (("packs", []), ("conflicts", []), ("return_box", []),
                       ("security_events", []), ("channel_map", [])):
        if not isinstance(c.get(key), list):
            c[key] = blank
    return c


def _pack(p: dict, pack_id: str) -> dict | None:
    return next((x for x in _doc_ledger(p).get("packs") or [] if x.get("pack_id") == pack_id), None)


def _status(pack: dict) -> str:
    """派出后过期限没回传＝超时（读时判，不改写历史）。"""
    st = str(pack.get("status") or "")
    deadline = str(pack.get("deadline_at") or "")
    if st == "dispatched" and deadline and deadline <= _iso(_now()):
        return "timeout"
    return st


def _sqlite():
    con = sqlite3.connect(str(DB), timeout=15)
    con.row_factory = sqlite3.Row
    return con


def _product(model: str) -> dict | None:
    model = str(model or "").strip()
    if not model:
        return None
    try:
        rows = PL.list_products(q=model, limit=0)
    except Exception:
        rows = []
    for r in rows:
        if str(r.get("model") or "").strip() == model or str(r.get("id") or "").strip() == model:
            return r
    return None


# ---------------------------------------------------------------- §10.1 slots


def _room_of(design: dict, room_id: str) -> str:
    r = next((x for x in design.get("rooms") or [] if x.get("id") == room_id), None)
    return str((r or {}).get("name") or room_id or "")


def _plate_index(design: dict) -> dict:
    """plate_id → (柜体, 柜格, 板面)。§9.1 三级骨架。"""
    out = {}
    for cab in design.get("cabinets") or []:
        for cell in cab.get("cells") or []:
            if not isinstance(cell, dict):
                continue
            for plate in cell.get("plates") or []:
                if isinstance(plate, dict) and plate.get("id"):
                    out[plate["id"]] = (cab, cell, plate)
    return out


def _fixture_index(design: dict) -> dict:
    return {f.get("id"): f for f in design.get("fixtures") or [] if isinstance(f, dict) and f.get("id")}


def build_slots(p: dict, kind: str, vendor_name: str = "") -> list[dict]:
    """图上「必挂对象」清单：一 slot 一行，待填 SKU/参数/价/交期。"""
    if kind not in VENDOR_KINDS:
        raise HTTPException(422, f"供应商类型只允许 {'／'.join(VENDOR_KINDS)}")
    design = p.get("design") or {}
    slots: list[dict] = []

    if kind == "定制":
        plates = _plate_index(design)
        for cab in design.get("cabinets") or []:
            for cell in cab.get("cells") or []:
                if not isinstance(cell, dict):
                    continue
                if vendor_name and str(cell.get("cabinet_vendor") or "").strip() != vendor_name.strip():
                    continue
                for plate in cell.get("plates") or []:
                    if not isinstance(plate, dict):
                        continue
                    slots.append({
                        "slot_id": str(plate.get("id") or ""),
                        "object_type": "plate",
                        "object_no": str(plate.get("no") or plate.get("plate_code") or plate.get("id") or ""),
                        "room": _room_of(design, cab.get("room_id") or ""),
                        "current_sku": "",
                        "need": ("板面实际尺寸 W×H＋板厚（权威值在柜厂，标称值只是初值，"
                                 f"§14 拍板 1）；这格空着＝本槽位不予确认"),
                    })
        for m in design.get("mounts") or []:
            if not isinstance(m, dict):
                continue
            host = plates.get(str(m.get("plate_id") or ""))
            if vendor_name:
                if not host or str((host[1] or {}).get("cabinet_vendor") or "").strip() != vendor_name.strip():
                    continue
            slots.append({
                "slot_id": str(m.get("id") or ""),
                "object_type": "mount",
                "object_no": str(m.get("mount_no") or m.get("id") or ""),
                "room": _room_of(design, (host[0] or {}).get("room_id") if host else ""),
                "current_sku": str(m.get("sku") or ""),
                "need": ("确认 / 改位（新 u,v）/ 拒绝＋原因；可开的开孔与灯槽；"
                         "SKU／参数／零售价／交期。灯位坐标与回路归属不在此列——写权限 0"),
            })
    else:
        for c in design.get("circuits") or []:
            if not isinstance(c, dict):
                continue
            slots.append({
                "slot_id": str(c.get("id") or ""),
                "object_type": "circuit",
                "object_no": str(c.get("circuit_no") or c.get("id") or ""),
                "room": "",
                "current_sku": str(c.get("gateway_model") or ""),
                "need": ("通道占用表（设备号＋通道号＋负载类型＋额定）＋网关机型＋安装位＋断电默认态；"
                         "控制方式超出通道能力要写「不支持」＋原因。回路归属/D1 九格写权限 0"),
            })
        for s in design.get("scenes") or []:
            if not isinstance(s, dict):
                continue
            slots.append({
                "slot_id": str(s.get("id") or ""),
                "object_type": "scene",
                "object_no": str(s.get("no") or s.get("name") or s.get("id") or ""),
                "room": _room_of(design, s.get("roomId") or s.get("room_id") or ""),
                "current_sku": "",
                "need": "场景点位号＋触发源＋断电默认态（断电后这个场景回到什么状态）",
            })

    slots = [x for x in slots if x["slot_id"]]
    if len(slots) > MAX_SLOTS:
        raise HTTPException(422, f"必挂对象 {len(slots)} 条超过 {MAX_SLOTS} 上限：请分柜/分层发多个包")
    return slots[:MAX_SLOTS]


def _fill_cols(kind: str) -> tuple[str, ...]:
    return BASE_FILL + VENDOR_FILL[kind]


def slots_csv_header(kind: str) -> list[str]:
    return list(LOCKED_COLS) + list(_fill_cols(kind))


def slots_csv_text(slots: list[dict], kind: str) -> str:
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    header = slots_csv_header(kind)
    w.writerow(header)
    for s in slots:
        w.writerow([s.get(c, "") for c in header])
    return buf.getvalue()


def checksum_of(pack: dict) -> str:
    """对包身份（含只读列）取指纹：供应商只能往白名单列里填值。

    改只读列、换 pack_id ＝指纹不符 → 硬拒 3（绕过工具手改）。
    少填几行不在这里拒——沉默归 C1，退回原因才分得清是「手改」还是「没回话」。
    """
    body = {"pack_id": pack.get("pack_id"), "project_ref": pack.get("project_ref"),
            "schema_version": pack.get("schema_version"), "vendor_kind": pack.get("vendor_kind"),
            "locked": sorted([[str(r.get(c, "")) for c in LOCKED_COLS]
                              for r in pack.get("slots") or []])}
    return hashlib.sha256(json.dumps(body, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


# ---------------------------------------------------------------- 匿名化与 PII


def _anon_strings(p: dict) -> list[str]:
    out = []
    for key in ("client", "endCustomerName", "address", "phone", "tel", "mobile", "name"):
        v = str(p.get(key) or "").strip()
        if len(v) >= 2:
            out.append(v)
    return out


def pii_hits(text: str, p: dict) -> list[str]:
    hits = []
    t = str(text or "")
    for s in _anon_strings(p):
        if s and s in t:
            hits.append(f"含项目/客户原文「{s[:12]}」")
    if PHONE_RE.search(t):
        hits.append("含手机号")
    if TEL_RE.search(t):
        hits.append("含固定电话")
    if IDCARD_RE.search(t):
        hits.append("含身份证号")
    return hits


def _anon_project(p: dict) -> dict:
    """给预览图用的匿名副本：只留匿名项目号，客户/项目名/设计人联系方式全部拿掉。"""
    data = Q.delivery_redact(p, "site")
    data["name"] = p.get("code") or data.get("code") or ""
    for key in ("client", "endCustomerName", "address", "phone", "tel", "mobile", "designer"):
        data[key] = ""
    return data


def readme_text(pack: dict) -> str:
    kind = pack.get("vendor_kind")
    fills = "、".join(_fill_cols(kind))
    return f"""# 协同包 {pack['pack_id']}

- 项目：**{pack['project_ref']}**（匿名项目号；本包不含客户姓名、电话、地址）
- 供应商：{VENDOR_LABEL.get(kind, kind)} · {pack.get('vendor_name') or '未指名'}
- 图纸版本：V{pack['baseline']['version']} R{pack['baseline']['revision']}　绘图基准 hash：`{pack['baseline']['design_hash'][:16]}`
- 派出：{pack['dispatched_at']}　**回传期限：{pack['deadline_at']}**（超期按超时计数）
- 待回应对象：{len(pack['slots'])} 条（见 `selection/slots.csv`）
- 包校验码 checksum：`{pack['checksum']}`

## 怎么回传

1. 只填这些列：`{fills}`；`{'、'.join(LOCKED_COLS)}` 是制图器写死的身份列，**改一个字符就整包硬拒**（校验码对不上）。
2. 填完把整个 zip 寄回（也可以只寄 `selection/slots.csv`，但文件头三行注释里的
   `# pack_id= / # schema_version= / # checksum=` 要留着，那是我们认包的唯一凭据）。
3. **沉默不算回传**：包内每一条 `slot_id` 都要有回应。漏一条＝整包打回，不是漏的那条不算。

## 白名单之外的东西不要写

能写的只有：SKU、参数、零售价、交期，加{('板号／板厚／板面实际尺寸／改位 (u,v)／可用开孔与灯槽' if kind == '定制' else '网关机型／安装位／通道占用／场景点位／断电默认态／明确的不支持项')}。

写权限为 0（写了即拒，整包退回）：**灯位坐标、回路归属、D1／D9／D10／D11、图号版本、客户信息**。
这些是制图器和设计师的责任范围，供应商改不了也不该改。

## 会被拒绝的原因清单（§10.2 六条硬拒）

| # | 规则 | 后果 |
|---|---|---|
| 1 | `schema_version` 不认识（本包＝1） | 即拒 |
| 2 | `pack_id` 不在本项目派出记录里 | 即拒 |
| 3 | `checksum` 不符（绕过工具手改） | 即拒 |
| 4 | 含客户姓名／电话／地址等 PII | 即拒＋记安全事件 |
| 5 | 写了白名单外字段 | 即拒 |
| 6 | SKU 不在库／不满足第 0 层／价格口径不是零售价 | 即拒 |

**拒≠丢**：被拒的包裹原文进退回箱，由设计师逐条复核，不会静默删除。

## 回传之后

制图器按 C1–C6 自动校验（编号反查、板内坐标、同板开孔不打架、回路与通道 1:1、
通道不超机型上限、坐标双向一致），合图只取白名单值并标 `origin=supplier`；
**冲突只标记、不自动修**，设计师逐条选择接受或打回——打回会生成派生包 v2。
"""


# ---------------------------------------------------------------- §10.1 包组装


def _preview_pdf(p: dict, floor: int) -> bytes:
    """把匿名平面渲染成 PNG 再装进 PDF：无 CAD 也能看，且栅格化后不含任何可提取文本。"""
    from PIL import Image

    from . import exports as EX

    anon = _anon_project(p)
    png = EX.plain_plan_bytes(anon, "png", floor)
    out = io.BytesIO()
    Image.open(io.BytesIO(png)).convert("RGB").save(out, format="PDF")
    return out.getvalue()


def _drawing_dxf(p: dict) -> bytes:
    from . import exports as EX

    body, _mime, _name = EX.export_bytes(p, "dxf")
    return body


def build_zip(p: dict, pack: dict) -> bytes:
    """§10.1 包结构：manifest.json＋draw/drawing.dxf＋draw/preview.pdf＋selection/slots.csv＋README.md"""
    anon = str(p.get("code") or "")
    if anon != str(pack.get("project_ref") or ""):
        raise HTTPException(409, "项目匿名号与本包派出时不一致：本包作废，请按当前版本重新发包")

    dxf = _drawing_dxf(p)
    manifest = {
        "pack_id": pack["pack_id"],
        "project_ref": pack["project_ref"],
        "schema_version": pack["schema_version"],
        "app_version": pack["app_version"],
        "drawing_hash": pack["baseline"]["drawing_hash"],
        "created_at": pack["created_at"],
        "slots": pack["slots"],
        "checksum": pack["checksum"],
        "vendor_kind": pack["vendor_kind"],
        "vendor_name": pack.get("vendor_name") or "",
        "deadline_at": pack.get("deadline_at") or "",
        "rule": "§10.1 协同包包结构（走文件不做登录）",
    }
    manifest_text = json.dumps(manifest, ensure_ascii=False, indent=2)
    csv_text = slots_csv_text(pack["slots"], pack["vendor_kind"])
    readme = readme_text(pack)

    # ③无 PII 入包：文本成员逐个扫；图纸/预览是二进制，扫描其中是否含客户原文
    for label, text in (("manifest.json", manifest_text), ("selection/slots.csv", csv_text),
                        ("README.md", readme)):
        hits = pii_hits(text, p)
        if hits:
            raise HTTPException(422, f"协同包 {label} 含客户信息，拒绝外发：{('；'.join(hits))}")

    head = (f"# pack_id={pack['pack_id']}\n# schema_version={pack['schema_version']}\n"
            f"# checksum={pack['checksum']}\n")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("manifest.json", manifest_text)
        z.writestr("draw/drawing.dxf", dxf)
        z.writestr("draw/preview.pdf", _preview_pdf(p, int(p.get("floor") or 1)))
        z.writestr("selection/slots.csv", head + csv_text)
        z.writestr("README.md", readme)
    blob = buf.getvalue()
    leak = [s for s in _anon_strings(p) if s.encode() in blob or s in zipfile.ZipFile(io.BytesIO(blob)).read("README.md").decode("utf-8")]
    if leak:
        raise HTTPException(422, f"协同包内检出客户原文，拒绝外发：{leak[:3]}")
    return blob


# ---------------------------------------------------------------- 派出


def _design_hash(p: dict) -> str:
    return hashlib.sha256(json.dumps(p.get("design") or {}, sort_keys=True,
                                     ensure_ascii=False).encode()).hexdigest()


def validate_return_columns(kind: str, header: list[str]) -> list[dict]:
    """硬拒 5：白名单外字段。点名说清是「写权限 0」的那批还是拼错列名。"""
    allowed = set(slots_csv_header(kind))
    bad = []
    for col in header:
        c = str(col or "").strip()
        if not c or c in allowed:
            continue
        if c in ZERO_WRITE:
            bad.append({"column": c, "rule": "5", "why": f"{ZERO_WRITE[c]}写权限为 0（供应商不许碰）"})
        else:
            bad.append({"column": c, "rule": "5", "why": f"字段「{c}」不在白名单里（只许 {'／'.join(_fill_cols(kind))}）"})
    return bad


def _app_version() -> str:
    try:
        return (ROOT / "VERSION").read_text("utf-8").strip()
    except Exception:
        return ""


def _new_pack(p: dict, kind: str, vendor_name: str, slots: list[dict],
              parent_pack_id: str = "", reject_sheet: list[dict] | None = None,
              deadline_days: int = DEADLINE_DAYS) -> dict:
    code = str(p.get("code") or "").strip()
    if not code:
        raise HTTPException(422, "项目没有匿名项目号（code），协同包不发：包内只许带匿名号，不许带客户信息")
    now = _now()
    h = _design_hash(p)
    pack = {
        "pack_id": "PK-" + uuid.uuid4().hex[:12],
        "schema_version": SCHEMA_VERSION,
        "app_version": _app_version(),
        "project_ref": code,
        "vendor_kind": kind,
        "vendor_name": vendor_name or "",
        "slots": slots,
        "fill_columns": list(_fill_cols(kind)),
        "created_at": _iso(now),
        "dispatched_at": _iso(now),
        "deadline_at": _iso(now + timedelta(days=max(1, int(deadline_days or 1)))),
        "status": "dispatched",
        # DXF 字节每次导出都带创建时间戳，按文件取指纹会把同一版图判成两个版本；
        # 所以 drawing_hash 打在图纸内容（design）上，文件名与时间戳不参与。
        "baseline": {"version": int(p.get("version") or 0), "revision": int(p.get("revision") or 0),
                     "design_hash": h, "drawing_hash": h},
        "returns": [],
        "parent_pack_id": parent_pack_id,
        "reject_sheet": reject_sheet or [],
        "checksum": "",
    }
    pack["checksum"] = checksum_of(pack)
    return pack


def dispatch(p: dict, kind: str, vendor_name: str = "", deadline_days: int = DEADLINE_DAYS) -> dict:
    """发包：组一次包（PII 闸在组装里）→ 合格才登记派出记录。"""
    if kind not in VENDOR_KINDS:
        raise HTTPException(422, f"供应商类型只允许 {'／'.join(VENDOR_KINDS)}")
    if not (p.get("reviews") or {}).get("layout"):
        raise HTTPException(422, "平面方案未定稿（布置闸门未签认）：§10 协同包的输入是「已定平面方案」")
    design = p.get("design") or {}
    if kind == "定制":
        named = set()
        for cab in design.get("cabinets") or []:
            for cell in cab.get("cells") or []:
                if isinstance(cell, dict) and V.is_named(cell.get("cabinet_vendor")):
                    named.add(str(cell.get("cabinet_vendor")).strip())
        if not named:
            raise HTTPException(422, "柜体供应商未登记（§7.4：cabinet_vendor 有值才可发协同包）")
        if vendor_name and vendor_name.strip() not in named:
            raise HTTPException(422, f"柜体供应商「{vendor_name}」名下没有任何柜格；已登记：{sorted(named)}")
    slots = build_slots(p, kind, vendor_name)
    if not slots:
        raise HTTPException(422, f"{VENDOR_LABEL[kind]} 这条线上没有可发的必挂对象"
                                 f"（定制要柜体/柜格/板面/挂载，智能要回路/场景）")
    ledger = _doc_ledger(p)
    if len(ledger["packs"]) >= MAX_PACKS:
        raise HTTPException(422, f"派出记录已达 {MAX_PACKS} 条上限：请归档旧包后再发")
    pack = _new_pack(p, kind, vendor_name, slots)
    build_zip(p, pack)          # 不过 PII 闸就抛 422，包不落账
    ledger["packs"].append(pack)
    return pack


# ---------------------------------------------------------------- 回传解析


def _identity_rejects(pack: dict, rows: list[dict]) -> list[dict]:
    """逐行核身份列（§10.2 硬拒 3）。

    只核「在册行」的身份列：少几行不在这里拒——那是沉默，归 C1，退回原因才分得清
    是「手改」还是「没回话」；包外的新编号归 C1 的 ghost。
    """
    dispatched = {str(s.get("slot_id") or ""): s for s in pack.get("slots") or []}
    out = []
    for r in rows:
        sid = str(r.get("slot_id") or "")
        base = dispatched.get(sid)
        if base is None:
            continue
        for col in LOCKED_COLS:
            if str(r.get(col, "")) != str(base.get(col, "")):
                out.append({"rule": "3", "why": f"{sid} 的只读列「{col}」被改成"
                                                f"「{r.get(col) or '空'}」（派出时「{base.get(col) or '空'}」）"})
    return out


def parse_return(blob: bytes, name: str = "") -> tuple[dict, list[str], list[dict]]:
    """回传形态二选一：整个 zip（原样寄回）或只寄 selection/slots.csv（带 # 注释头）。"""
    text = ""
    meta: dict = {}
    if zipfile.is_zipfile(io.BytesIO(blob)):
        with zipfile.ZipFile(io.BytesIO(blob)) as z:
            names = z.namelist()
            if "manifest.json" in names:
                try:
                    man = json.loads(z.read("manifest.json").decode("utf-8"))
                except Exception:
                    raise HTTPException(422, "manifest.json 读不出来：包不是制图器发的")
                meta = {k: man.get(k) for k in ("pack_id", "schema_version", "checksum")}
            target = next((n for n in names if str(n).endswith("slots.csv")), "")
            if not target:
                raise HTTPException(422, "回传包里没有 selection/slots.csv：无从校验")
            text = z.read(target).decode("utf-8-sig", errors="replace")
    else:
        text = blob.decode("utf-8-sig", errors="replace")
    for line in text.splitlines():
        s = line.strip()
        if not s.startswith("#"):
            break
        m = re.match(r"^#\s*(pack_id|schema_version|checksum)\s*=\s*(.+)$", s)
        if m:
            meta[m.group(1)] = m.group(2).strip()
    body = [ln for ln in text.splitlines() if not ln.strip().startswith("#")]
    rows = list(csv.reader(body))
    if not rows or not any(str(x).strip() for x in rows[0]):
        raise HTTPException(422, "回传的 slots.csv 没有表头：无法按列校验")
    header = [str(c).strip() for c in rows[0]]
    out = []
    for raw in rows[1:]:
        if not any(str(x).strip() for x in raw):
            continue
        out.append({header[i]: (str(raw[i]).strip() if i < len(raw) else "") for i in range(len(header))})
    return meta, header, out


def _responded(row: dict | None, kind: str) -> bool:
    if not row:
        return False
    return any(str(row.get(c) or "").strip() for c in _fill_cols(kind))


def _slot_requirement(p: dict, row: dict) -> dict:
    """按需求侧已定的参数核 L0：格子里没填的就不核（不拿空白当通过）。"""
    design = p.get("design") or {}
    sid = str(row.get("slot_id") or "")
    req: dict = {}
    if row.get("object_type") == "mount":
        m = next((x for x in design.get("mounts") or [] if x.get("id") == sid), {}) or {}
        fx = _fixture_index(design).get(str(m.get("fixture_id") or "")) or {}
        req["category"] = "灯具"
        if V.is_named(fx.get("cct")):
            req["cct"] = fx.get("cct")
        if V.is_named(fx.get("beamAngle")):
            req["angle_max"] = _num(fx.get("beamAngle"))
        if V.is_named(fx.get("d10_1")):
            req["cutout_max_mm"] = W._cutout_mm(fx.get("d10_1"))
        if V.is_named(fx.get("power")):
            req["watt_min"] = _num(fx.get("power"))
    elif row.get("object_type") in ("circuit", "scene", "gateway"):
        req["category"] = "智能设备"
        c = next((x for x in design.get("circuits") or [] if x.get("id") == sid), {}) or {}
        if V.is_named(c.get("control_mode")):
            req["control"] = c.get("control_mode")
    return req


def row_rejects(p: dict, row: dict) -> list[str]:
    """硬拒 6：SKU 不在库／不过第 0 层／价格口径非零售价。"""
    out = []
    sku = str(row.get("sku") or "").strip()
    if sku:
        prod = _product(sku)
        if not prod:
            out.append(f"SKU 不在产品库：{sku}")
        else:
            bad = W.l0_failures(prod, _slot_requirement(p, row))
            if bad:
                out.append(f"SKU {sku} 不过 L0：" + "；".join(bad))
    price = str(row.get("price") or "").strip()
    scope = str(row.get("price_scope") or "").strip()
    blob = " ".join([price, scope, str(row.get("params") or "")])
    if any(t in blob for t in PT.WORD_TERMS):
        out.append("含成本口径词（成本不进工作台，§5.2 拍板）")
    if price:
        if not scope:
            out.append("填了价格但没写口径：只进市场零售价")
        elif scope not in PRICE_SCOPES:
            out.append(f"价格口径「{scope}」不是零售价")
        if not re.search(r"\d", price):
            out.append("价格读不出数字")
    verdict = str(row.get("verdict") or "").strip()
    if verdict and verdict not in ACCEPT_VERDICTS:
        out.append(f"回应值「{verdict}」无效（只许 {'／'.join(ACCEPT_VERDICTS)}）")
    if verdict in ("拒绝", "不支持") and not str(row.get("reject_reason") or "").strip():
        out.append("拒绝／不支持没写原因（打回单只写结论不算回应）")
    return out


def check_return(p: dict, pack: dict, meta: dict, header: list[str], rows: list[dict]) -> dict:
    """§10.2 六条硬拒＋C1–C6 自动校验。硬拒命中＝整包退回，一条都不落位。"""
    kind = pack["vendor_kind"]
    hard: list[dict] = []
    try:
        schema = int(meta.get("schema_version"))
    except (TypeError, ValueError):
        schema = 0
    if schema not in KNOWN_SCHEMA_VERSIONS:
        hard.append({"rule": "1", "why": f"schema_version 不认识：{meta.get('schema_version')}"
                                        f"（本工具只认 {'、'.join(str(x) for x in KNOWN_SCHEMA_VERSIONS)}）"})
    if str(meta.get("pack_id") or "") != pack["pack_id"]:
        hard.append({"rule": "2", "why": f"pack_id 不在本项目派出记录里：{meta.get('pack_id') or '空'}"})
    got = str(meta.get("checksum") or "").strip()
    if got != pack["checksum"]:
        hard.append({"rule": "3", "why": f"manifest 里的 checksum 与派出记录不符：{got or '空'}"})
    hard.extend(_identity_rejects(pack, rows))
    hard.extend(validate_return_columns(kind, header))

    pii = []
    for col in header:
        c = str(col or "")
        if c not in ("object_no", "room") and PII_KEY_RE.search(c):
            pii.append(f"列名「{c}」涉客户信息")
    for r in rows:
        for k, v in r.items():
            if k in LOCKED_COLS:
                continue
            hits = pii_hits(v, p)
            if hits:
                pii.append(f"{r.get('slot_id', '?')} 的 {k}：" + "；".join(hits))
    if pii:
        hard.append({"rule": "4", "why": "含 PII：" + "；".join(pii[:5]), "security": True})

    for r in rows:
        for why in row_rejects(p, r):
            hard.append({"rule": "6", "why": f"{r.get('slot_id', '?')}：{why}"})

    by_slot = {}
    for r in rows:
        by_slot.setdefault(str(r.get("slot_id") or ""), r)
    if hard:
        # 整包已即拒：C2–C6 不再计数，免得拿脏行算出假红（拒≠丢，原文已进退回箱）
        checks = {k: {"state": UNKNOWN, "why": "整包硬拒，未跑", "issues": []}
                  for k in ("C2", "C3", "C4", "C5", "C6")}
        conflicts = []
    else:
        checks, conflicts = run_checks(p, pack, by_slot)
    silent = [s["slot_id"] for s in pack["slots"] if not _responded(by_slot.get(s["slot_id"]), kind)]
    ghost = sorted(sid for sid in by_slot if sid and sid not in {s["slot_id"] for s in pack["slots"]})
    if hard:
        checks["C1"] = {"state": UNKNOWN, "why": "整包硬拒，C1–C6 不再计数（先过 §10.2）",
                        "issues": []}
    elif silent:
        checks["C1"] = {"state": FAIL, "why": f"沉默不算回传：{len(silent)} 条无回应",
                        "issues": [{"slot_id": x, "why": "图上必挂对象，回传里没有回应"} for x in silent]}
    elif ghost:
        checks["C1"] = {"state": FAIL, "why": f"回传里有 {len(ghost)} 个包外编号",
                        "issues": [{"slot_id": x, "why": "这个编号不在派出的包里"} for x in ghost]}
    else:
        checks["C1"] = {"state": PASS, "why": f"{len(pack['slots'])} 条编号双向对得上", "issues": []}

    order = ["C1", "C2", "C3", "C4", "C5", "C6"]
    summary = [{"id": k, "name": CHECK_NAMES[k], **checks[k]} for k in order]
    return {
        "received_at": _iso(_now()),
        "pack_id": pack["pack_id"],
        "schema_version": schema,
        "verdict": "rejected" if hard else "accepted",
        "hard_rejects": hard,
        "checks": summary,
        "failed": [x["id"] for x in summary if x["state"] == FAIL],
        "unknown": [x["id"] for x in summary if x["state"] == UNKNOWN],
        "silent_slots": silent,
        "ghost_slots": ghost,
        "conflicts": conflicts,
        "rows_raw": rows,
        "rows_kept": len(rows),
        "security": [x for x in hard if x.get("security")],
    }


# ---------------------------------------------------------------- C2–C6


def _num(v):
    try:
        f = float(str(v).replace("φ", "").replace("Φ", "").strip())
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _hole_r(p: dict, row: dict) -> float | None:
    """开孔半径 mm：回传 SKU 的孔径优先，其次挂载自带的 D10-1。读不出就 None（不猜）。"""
    sku = str(row.get("sku") or "").strip()
    prod = _product(sku) if sku else None
    if prod:
        got = W._cutout_mm(prod.get("cutout"))
        if got:
            return got / 2.0
    design = p.get("design") or {}
    m = next((x for x in design.get("mounts") or [] if x.get("id") == str(row.get("slot_id") or "")), {}) or {}
    fx = _fixture_index(design).get(str(m.get("fixture_id") or "")) or {}
    got = W._cutout_mm(m.get("d10_1") or fx.get("d10_1"))
    return got / 2.0 if got else None


def _plate_geom(p: dict, pack: dict, by_slot: dict, row: dict) -> dict:
    """挂载槽位所在板面：几何取包里的基线（派出时的图），板面实际尺寸若有柜厂回传则用它重判。"""
    design = p.get("design") or {}
    sid = str(row.get("slot_id") or "")
    mount = next((x for x in design.get("mounts") or [] if x.get("id") == sid), None)
    plate = None
    cab = None
    if mount:
        host = _plate_index(design).get(str(mount.get("plate_id") or ""))
        if host:
            cab, _cell, plate = host
    elif row.get("object_type") == "plate":
        plate = next((pl for _c, ce, pl in _plate_index(design).values()
                      if pl.get("id") == sid), None)
        cab = next((c for c, ce, pl in _plate_index(design).values() if pl.get("id") == sid), None)
    plate_row = by_slot.get(str((plate or {}).get("id") or "")) or {}
    w = _num(row.get("plate_w_mm")) or _num(plate_row.get("plate_w_mm")) or _num((plate or {}).get("width_mm"))
    h = _num(row.get("plate_h_mm")) or _num(plate_row.get("plate_h_mm")) or _num((plate or {}).get("height_mm"))
    th = _num(row.get("plate_thickness")) or _num(plate_row.get("plate_thickness")) \
        or _num((plate or {}).get("thickness_mm"))
    u = _num(row.get("u")) if row.get("u") not in (None, "") else _num((mount or {}).get("u"))
    v = _num(row.get("v")) if row.get("v") not in (None, "") else _num((mount or {}).get("v"))
    return {"mount": mount, "plate": plate, "cabinet": cab, "w": w, "h": h,
            "thickness": th, "u": u, "v": v,
            "from_supplier": bool(row.get("plate_w_mm") or row.get("plate_h_mm")
                                  or plate_row.get("plate_w_mm") or plate_row.get("plate_h_mm"))}


def run_checks(p: dict, pack: dict, by_slot: dict) -> tuple[dict, list[dict]]:
    """C2–C6：只算当下能算的；缺手册/缺尺寸的一律 unknown＋【需核验】，不冒充通过。"""
    kind = pack["vendor_kind"]
    conflicts: list[dict] = []
    mount_rows = [r for r in by_slot.values() if r.get("object_type") == "mount"]
    unknown_bits = []

    # —— C2 板内坐标 ——
    c2_issues = []
    for r in mount_rows:
        if str(r.get("verdict") or "") in ("拒绝", "不支持"):
            continue
        g = _plate_geom(p, pack, by_slot, r)
        if g["u"] is None or g["v"] is None or not g["w"] or not g["h"]:
            unknown_bits.append(f"{r.get('slot_id')}：板面尺寸或 (u,v) 未填，C2 核不了")
            continue
        if V.plate_out_of_range({"width_mm": g["w"], "height_mm": g["h"]}, g["u"], g["v"]):
            c2_issues.append({"slot_id": r.get("slot_id"),
                              "why": f"(u,v)=({g['u']:g},{g['v']:g}) 出了板面 {g['w']:g}×{g['h']:g}"})
    c2 = {"state": FAIL if c2_issues else (UNKNOWN if unknown_bits else PASS),
          "why": f"{len(mount_rows)} 条挂载坐标", "issues": c2_issues}

    # —— C3 同板开孔不打架／不出板边／净空 ——
    by_plate: dict[str, list] = {}
    clearance_unknown = []
    for r in mount_rows:
        if str(r.get("verdict") or "") in ("拒绝", "不支持"):
            continue
        g = _plate_geom(p, pack, by_slot, r)
        rad = _hole_r(p, r)
        if g["u"] is None or g["v"] is None:
            continue
        if rad is None:
            clearance_unknown.append(f"{r.get('slot_id')}：孔径读不出，出板边与重叠核不了")
        by_plate.setdefault(str((g["plate"] or {}).get("id") or r.get("slot_id")), []).append(
            {"row": r, "u": g["u"], "v": g["v"], "r": rad, "geom": g})
    c3_issues = []
    for plate_id, items in by_plate.items():
        for i, a in enumerate(items):
            if a["r"] is None:
                continue
            if all(x is not None for x in (a["geom"]["w"], a["geom"]["h"])):
                w, h = a["geom"]["w"], a["geom"]["h"]
                if a["u"] - a["r"] < -1e-6 or a["v"] - a["r"] < -1e-6 \
                        or a["u"] + a["r"] > w + 1e-6 or a["v"] + a["r"] > h + 1e-6:
                    c3_issues.append({"slot_id": a["row"].get("slot_id"), "plate_id": plate_id,
                                      "why": f"孔 Φ{2*a['r']:g} 出板边（板面 {w:g}×{h:g}）"})
            for b in items[i + 1:]:
                if b["r"] is None:
                    continue
                d = math.hypot(a["u"] - b["u"], a["v"] - b["v"])
                if d < a["r"] + b["r"] - 1e-6:
                    c3_issues.append({"slot_id": a["row"].get("slot_id"), "plate_id": plate_id,
                                      "why": f"与 {b['row'].get('slot_id')} 孔心距 {d:.1f}mm "
                                             f"< 两孔半径和 {a['r'] + b['r']:.1f}mm（重叠）"})
                gap = d - a["r"] - b["r"]
                if gap < EDGE_GAP_MIN_MM:
                    c3_issues.append({"slot_id": a["row"].get("slot_id"), "plate_id": plate_id,
                                      "why": f"与 {b['row'].get('slot_id')} 孔边净距 {gap:.1f}mm "
                                             f"< {EDGE_GAP_MIN_MM:g}mm（§14 拍板 6 留边起值）"})
        for a in items:
            th = a["geom"]["thickness"]
            mount = a["geom"]["mount"] or {}
            fx = _fixture_index(p.get("design") or {}).get(str(mount.get("fixture_id") or "")) or {}
            need = mount.get("d10_3") or fx.get("d10_3")
            if th is None or _num(need) is None:
                clearance_unknown.append(f"{a['row'].get('slot_id')}：板厚或净空未填，"
                                         f"「净空≥板厚＋散热」核不了【需核验】")
            elif _num(need) < th + EDGE_GAP_MIN_MM:
                c3_issues.append({"slot_id": a["row"].get("slot_id"), "plate_id": plate_id,
                                  "why": f"净空 {_num(need):g} < 板厚 {th:g}＋留边 {EDGE_GAP_MIN_MM:g}"})
    c3 = {"state": FAIL if c3_issues else (UNKNOWN if clearance_unknown else PASS),
          "why": f"{len(by_plate)} 块板上有开孔", "issues": c3_issues,
          "note": "；".join(clearance_unknown[:3])}

    # —— C4 / C5（智能线才有通道占用）——
    c4_issues, c5_issues = [], []
    c4_unknown, c5_unknown, c5_ok_basis = [], [], []
    if kind == "智能":
        claims = []
        for r in by_slot.values():
            if r.get("object_type") != "circuit":
                continue
            ch = str(r.get("gateway_channel") or "").strip()
            gw = str(r.get("gateway_model") or "").strip()
            if ch:
                claims.append({"slot_id": r.get("slot_id"), "gateway": gw, "channel": ch,
                               "limit": r.get("channel_limit"),
                               "rated": r.get("rated"), "load": r.get("load_type")})
        if not claims:
            c4_unknown.append("回传里没有一条通道占用，C4 无从核（沉默已在 C1 拦）")
            c5_unknown.append("同上")
        seen: dict[tuple, list] = {}
        per_gateway: dict[str, set] = {}
        for c in claims:
            seen.setdefault((c["gateway"].lower(), c["channel"].lower()), []).append(c["slot_id"])
            per_gateway.setdefault(c["gateway"] or "未填机型", set()).add(c["channel"])
            if not c["rated"]:
                c4_unknown.append(f"{c['slot_id']}：通道额定未填，无法核「额定≥功率」【需核验】")
                continue
            rated_w = _num(re.sub(r"[^\d.]", "", str(c["rated"])) or "")
            design = p.get("design") or {}
            circuit = next((x for x in design.get("circuits") or [] if x.get("id") == c["slot_id"]), {}) or {}
            members = [f for f in design.get("fixtures") or []
                       if f.get("circuitId") == c["slot_id"] or f.get("circuit") == circuit.get("circuit_no")]
            load_w = CR.watts(members) if members else 0.0
            if str(c["rated"]).strip().upper().endswith("A"):
                c4_unknown.append(f"{c['slot_id']}：额定给的是电流 {c['rated']}，换算系数【需核验】，"
                                  f"不宣布通过（负载 {load_w:g}W）")
            elif rated_w is not None and rated_w + 1e-6 < load_w:
                c4_issues.append({"slot_id": c["slot_id"],
                                  "why": f"通道额定 {rated_w:g}W < 回路功率 {load_w:g}W"})
        for key, ids in seen.items():
            if len(set(ids)) > 1:
                c4_issues.append({"slot_id": ",".join(ids), "gateway": key[0],
                                  "why": f"同一通道 {key[1] or '未填'} 被 {len(set(ids))} 条回路占用"
                                         f"（T1：回路与通道 1:1）"})
            if len(ids) != len(set(ids)):
                c4_issues.append({"slot_id": ",".join(ids),
                                  "why": f"同一回路重复占用通道 {key[1]}"})
        per_gateway_limit: dict[str, list] = {}
        for c in claims:
            per_gateway_limit.setdefault(c["gateway"] or "未填机型", []).append(_num(
                re.sub(r"[^\d.]", "", str(c.get("limit") or "")) or ""))
        for gw, chans in per_gateway.items():
            limits = [x for x in per_gateway_limit.get(gw, []) if x]
            used = len(chans)
            if not limits:
                ref = Q.REFERENCE_LIMITS["dali"]
                note = (f"{gw}：已用通道 {used}；机型上限未回传，参考值 {ref['maxAddresses']}"
                        f"（{ref['basis']}）【需核验】，不自动降级")
                if used > ref["maxAddresses"]:
                    c5_issues.append({"slot_id": gw, "gateway": gw, "why": note + "·已超参考值"})
                else:
                    c5_unknown.append(note)
                continue
            limit = min(limits)
            if used > limit:
                c5_issues.append({"slot_id": gw, "gateway": gw,
                                  "why": f"{gw}：已用通道 {used} > 机型上限 {limit:g}"
                                         f"（回传声明值，已声明·未交叉核）"})
            else:
                c5_ok_basis.append(f"{gw}：{used} ≤ {limit:g}（上限取智能商回传声明值，"
                                   f"口径＝已声明·未交叉核）")
    else:
        c4_unknown.append("定制包不含通道占用：C4/C5 属智能线，本包不适用")
        c5_unknown.append("同上")
    c4 = {"state": FAIL if c4_issues else (UNKNOWN if c4_unknown else PASS),
          "why": "回路-通道 1:1 与额定", "issues": c4_issues, "note": "；".join(c4_unknown[:3])}
    c5 = {"state": FAIL if c5_issues else (UNKNOWN if c5_unknown else PASS),
          "why": ("已用通道≤机型上限 · " if c5_ok_basis else "已用通道≤机型上限 · ")
                 + (c5_ok_basis[0] if c5_ok_basis else "见 note"),
          "issues": c5_issues, "note": "；".join(c5_unknown[:3])}

    # —— C6 双向一致性 ——
    c6_issues, c6_unknown = [], []
    for r in mount_rows:
        if str(r.get("verdict") or "") in ("拒绝", "不支持"):
            continue
        g = _plate_geom(p, pack, by_slot, r)
        if g["u"] is None or g["v"] is None or g["plate"] is None or g["cabinet"] is None:
            c6_unknown.append(f"{r.get('slot_id')}：没有宿主板面或 (u,v)，双向一致性核不了")
            continue
        code = str(g["plate"].get("plate_code") or "")
        world = V.plate_to_world(g["cabinet"], code, g["u"], g["v"])
        back_u, back_v = V.world_to_plate(g["cabinet"], code, world)
        if back_u is None:
            c6_unknown.append(f"{r.get('slot_id')}：板代号 {code} 不在 L/R/B/T/K/D 里，变换算不出来")
            continue
        if abs(back_u - g["u"]) > UV_TOLERANCE_MM or abs(back_v - g["v"]) > UV_TOLERANCE_MM:
            c6_issues.append({"slot_id": r.get("slot_id"),
                              "why": f"(u,v)=({g['u']:g},{g['v']:g}) 经世界坐标往返后成 "
                                     f"({back_u:.1f},{back_v:.1f})，超出 {UV_TOLERANCE_MM:g}mm"})
        if g["from_supplier"] and g["w"] and g["h"]:
            nominal_w = _num(g["plate"].get("width_mm"))
            nominal_h = _num(g["plate"].get("height_mm"))
            if nominal_w and nominal_h and (abs(g["w"] - nominal_w) > 1 or abs(g["h"] - nominal_h) > 1):
                conflicts.append({"type": "回传", "rule_id": "C6", "severity": V.HINT,
                                  "object_ids": [str(g["plate"].get("id")), r.get("slot_id")],
                                  "ours": f"标称 {nominal_w:g}×{nominal_h:g}",
                                  "theirs": f"柜厂实际 {g['w']:g}×{g['h']:g}",
                                  "why": "板面实际尺寸与标称不同 → 挂载越界须重判（§14 拍板 1）"})
    c6 = {"state": FAIL if c6_issues else (UNKNOWN if c6_unknown else PASS),
          "why": "§9.1 唯一变换的往返一致", "issues": c6_issues, "note": "；".join(c6_unknown[:3])}

    for cid in ("C2", "C3", "C4", "C5", "C6"):
        blk = {"C2": c2, "C3": c3, "C4": c4, "C5": c5, "C6": c6}[cid]
        for it in blk["issues"]:
            conflicts.append({"type": "回传" if cid in ("C4", "C5") else
                              ("开孔" if cid == "C3" else "空间"),
                              "rule_id": cid, "severity": V.BLOCK,
                              "object_ids": [x for x in [it.get("slot_id"), it.get("plate_id")] if x],
                              "ours": "", "theirs": "", "why": it.get("why") or ""})
    return {"C2": c2, "C3": c3, "C4": c4, "C5": c5, "C6": c6}, conflicts


# ---------------------------------------------------------------- 合图（§10.3）


def merge_pack(p: dict, pack: dict) -> dict:
    """接收→校验→只取白名单→落位(origin=supplier)→重算 derived→冲突表。

    冲突只标记不自动修；供应商原始值留在 `returns[].rows_raw`，合图不覆盖。
    """
    ledger = _doc_ledger(p)
    ok = [i for i, r in enumerate(pack.get("returns") or []) if r.get("verdict") == "accepted"]
    if not ok:
        raise HTTPException(422, "这个包没有可用回传（全部硬拒或还没回传）：合图只能在校验通过后做")
    ri = ok[-1]
    ret = pack["returns"][ri]
    design = p["design"]
    kind = pack["vendor_kind"]
    applied, skipped = [], []
    mounts = {m.get("id"): m for m in design.get("mounts") or [] if isinstance(m, dict)}
    plates = _plate_index(design)
    at = _iso(_now())

    for row in ret["rows_raw"]:
        sid = str(row.get("slot_id") or "")
        verdict = str(row.get("verdict") or "").strip()
        if verdict in ("拒绝", "不支持"):
            skipped.append({"slot_id": sid, "why": f"供应商{verdict}："
                                                    f"{row.get('reject_reason') or row.get('unsupported') or '未写原因'}"})
            continue
        fill = {k: v for k, v in row.items() if k in _fill_cols(kind) and str(v or "").strip()}
        if not fill:
            skipped.append({"slot_id": sid, "why": "整行空白（沉默不算回传，已由 C1 拦过则不会走到这里）"})
            continue
        if row.get("object_type") == "mount" and sid in mounts:
            m = mounts[sid]
            if fill.get("sku"):
                m["sku"] = fill["sku"]
            for key in ("params", "delivery"):
                if fill.get(key):
                    m[key] = fill[key]
            if fill.get("price"):
                price = _num(re.sub(r"[^\d.]", "", str(fill["price"])) or "")
                if price is None:
                    skipped.append({"slot_id": sid, "why": f"价格「{fill['price']}」读不出数字，"
                                                           "不写进对象（写进去会让全图保存不了）"})
                else:
                    m["price"] = price
                    m["price_scope"] = str(row.get("price_scope") or "零售价")
            for key in ("u", "v"):
                if fill.get(key) and _num(fill[key]) is not None:
                    m[key] = _num(fill[key])
            if fill.get("plate_code"):
                m["supplier_plate_code"] = fill["plate_code"]
            if fill.get("cutouts"):
                m["supplier_cutouts"] = fill["cutouts"]
            m["origin"] = "supplier"
            m["supplier_ref"] = {"pack_id": pack["pack_id"], "at": at, "return_index": ri}
            applied.append({"slot_id": sid, "table": "mount",
                            "fields": sorted(fill)})
        elif row.get("object_type") == "plate":
            host = plates.get(sid)
            if not host:
                skipped.append({"slot_id": sid, "why": "板面不在当前版图里（图已改过：请重发包）"})
                continue
            _cab, _cell, plate = host
            w, h = _num(row.get("plate_w_mm")), _num(row.get("plate_h_mm"))
            th = _num(row.get("plate_thickness"))
            if w and h:
                plate["actual_size_mm"] = {"w": w, "h": h, "pack_id": pack["pack_id"], "at": at}
            if th:
                plate["actual_thickness_mm"] = {"value": th, "pack_id": pack["pack_id"], "at": at}
            for key in ("sku", "params", "delivery"):
                if fill.get(key):
                    plate[key] = fill[key]
            if fill.get("price"):
                pv = _num(re.sub(r"[^\d.]", "", str(fill["price"])) or "")
                plate["price"] = pv if pv is not None else fill["price"]
                plate["price_scope"] = str(row.get("price_scope") or "零售价")
            plate["origin"] = "supplier"
            applied.append({"slot_id": sid, "table": "plate", "fields": sorted(fill)})
        elif row.get("object_type") == "circuit":
            ledger["channel_map"].append({
                "circuit_id": sid,
                "circuit_no": next((c.get("circuit_no") for c in design.get("circuits") or []
                                    if c.get("id") == sid), ""),
                "gateway_model": str(row.get("gateway_model") or ""),
                "gateway_channel": str(row.get("gateway_channel") or ""),
                "load_type": str(row.get("load_type") or ""),
                "rated": str(row.get("rated") or ""),
                "install_pos": str(row.get("install_pos") or ""),
                "poweroff_default": str(row.get("poweroff_default") or ""),
                "unsupported": str(row.get("unsupported") or ""),
                "sku": str(row.get("sku") or ""), "params": str(row.get("params") or ""),
                "price": str(row.get("price") or ""), "price_scope": str(row.get("price_scope") or ""),
                "delivery": str(row.get("delivery") or ""),
                "pack_id": pack["pack_id"], "at": at,
            })
            applied.append({"slot_id": sid, "table": "channel_map",
                            "fields": sorted(fill)})
        elif row.get("object_type") == "scene":
            for sc in design.get("scenes") or []:
                if isinstance(sc, dict) and sc.get("id") == sid:
                    sc["supplier_scene"] = {
                        "point_no": str(row.get("scene_no") or ""),
                        "trigger": str(row.get("trigger_source") or ""),
                        "poweroff_default": str(row.get("poweroff_default") or ""),
                        "pack_id": pack["pack_id"], "at": at}
                    applied.append({"slot_id": sid, "table": "scene", "fields": sorted(fill)})
                    break
            else:
                skipped.append({"slot_id": sid, "why": "场景不在当前版图里"})
        else:
            skipped.append({"slot_id": sid, "why": "包外编号不落位（C1 已拦，走到这里是图改了）"})

    # derived 只算不写（§7.4）：合图报告里给出重算结果，不把这些值塞进对象
    derived = []
    for c in design.get("circuits") or []:
        if not isinstance(c, dict):
            continue
        members = [f for f in design.get("fixtures") or []
                   if f.get("circuitId") == c.get("id") or f.get("circuit") == c.get("circuit_no")]
        derived.append({"circuit_id": c.get("id"), "circuit_no": c.get("circuit_no") or "",
                        "watts": CR.watts(members), "drivers": CR.drivers(members),
                        "basis": "circuit_rules（回路功率/驱动数按灯位重算）"})

    conflicts = _record_conflicts(ledger, pack["pack_id"], ret.get("conflicts") or [])
    pack["status"] = "merged"
    pack["merged_at"] = _iso(_now())
    return {"pack_id": pack["pack_id"], "applied": applied, "skipped": skipped,
            "derived": derived, "conflict_ids": conflicts,
            "rule": "§10.3 只取白名单落位；origin=supplier；原始值在 returns[].rows_raw；"
                    "冲突只标记不自动修",
            "not_written": "灯位坐标、回路归属、D1/D9/D10/D11、图号版本、客户信息：写权限 0"}


def _record_conflicts(ledger: dict, pack_id: str, items: list[dict]) -> list[str]:
    known = {(c.get("pack_id"), c.get("rule_id"), tuple(c.get("object_ids") or []), c.get("why"))
             for c in ledger["conflicts"]}
    ids = []
    for it in items:
        key = (pack_id, it.get("rule_id"), tuple(it.get("object_ids") or []), it.get("why"))
        if key in known:
            continue
        known.add(key)
        cid = "CF-" + uuid.uuid4().hex[:10]
        ledger["conflicts"].append({
            "conflict_id": cid, "pack_id": pack_id, "created_at": _iso(_now()),
            "type": it.get("type") or "回传", "rule_id": it.get("rule_id") or "",
            "severity": it.get("severity") or V.BLOCK,
            "object_ids": [str(x) for x in (it.get("object_ids") or []) if x],
            "ours": it.get("ours") or "", "theirs": it.get("theirs") or "",
            "suggestion": it.get("suggestion") or "",
            "source": it.get("source") or "supplier_return",
            "why": it.get("why") or "", "state": "未处理", "decision_note": ""})
        ids.append(cid)
    return ids


def conflict_rows(ledger: dict) -> list[dict]:
    """出表时补一个 from_pack：pack_id 里「scan@…」只是扫描挂账的去重前缀，不是派出去过的包。
    前端不许自己按字符串猜——能不能打回，以「在册的包里有没有它」为准（§10.3）。"""
    packs = {str(x.get("pack_id") or "") for x in (ledger.get("packs") or [])}
    return [dict(c, from_pack=str(c.get("pack_id") or "") in packs)
            for c in (ledger.get("conflicts") or [])]


def resolve_conflict(p: dict, conflict_id: str, decision: str, note: str = "") -> dict:
    """人逐条 接受／打回——决策层永远在人（§10.3）。"""
    ledger = _doc_ledger(p)
    c = next((x for x in ledger["conflicts"] if x.get("conflict_id") == conflict_id), None)
    if not c:
        raise HTTPException(404, "冲突记录不存在")
    if decision not in ("接受", "打回", "挂起"):
        raise HTTPException(422, "决策只许 接受／打回／挂起")
    if decision == "接受" and not str(note or "").strip():
        raise HTTPException(422, "接受冲突要写理由（决策层必须可追溯）")
    c["state"] = decision
    c["decision_note"] = str(note or "").strip()
    c["decided_at"] = _iso(_now())
    return c


REJECT_MUST = {"开孔": ("plate_id", "ours_uv", "theirs_uv", "hole_mm", "ours_version", "theirs_version"),
               "空间": ("ours", "theirs", "timestamp", "baseline_version"),
               "回路": ("circuit_no", "channel_a", "channel_b"),
               "通道": ("gateway_no", "model", "limit", "used"),
               "参数": ("param", "requirement")}


def validate_reject_sheet(items: list[dict]) -> list[dict]:
    """打回单必带项（§10.3 表）：只写「冲突」二字＝无效打回。"""
    bad = []
    if not items:
        return [{"why": "打回单是空的：没有一条冲突条目"}]
    for i, it in enumerate(items):
        t = str(it.get("type") or "").strip()
        must = REJECT_MUST.get(t, ())
        miss = [k for k in must if not str(it.get(k) or "").strip()]
        detail = " ".join(str(v) for k, v in (it or {}).items() if k not in ("type", "supplier", "object_ids"))
        if t not in REJECT_MUST:
            bad.append({"index": i, "why": f"打回类型「{t or '空'}」不在开孔／空间／回路／通道／参数五类里"})
        if len(str(detail).strip()) <= len("冲突") + 1:
            bad.append({"index": i, "why": "打回单只写「冲突」二字＝无效回传，直接退回"})
        if miss:
            bad.append({"index": i, "why": f"{t} 打回单缺必带项：{'、'.join(miss)}"})
        if not str(it.get("object_ids") or it.get("slot_id") or "").strip():
            bad.append({"index": i, "why": "打回单没指向具体对象（追不到对象＝不算冲突条目）"})
    return bad


def build_reject_pack(p: dict, pack: dict, items: list[dict], deadline_days: int = DEADLINE_DAYS) -> dict:
    """打回 → 生成派生包 v2：只带被点名的槽位，附双方值与版本号。"""
    bad = validate_reject_sheet(items)
    if bad:
        raise HTTPException(422, "打回单不合格：" + "；".join(x["why"] for x in bad[:4]))
    wanted = set()
    for it in items:
        for x in ([it.get("slot_id")] if it.get("slot_id") else []) + list(it.get("object_ids") or []):
            if x:
                wanted.add(str(x))
    slots = [s for s in pack.get("slots") or [] if s["slot_id"] in wanted]
    if not slots:
        raise HTTPException(422, "打回条目指向的槽位不在原包里：无从生成派生包")
    for s in slots:
        s["need"] = "【打回重填】" + s["need"]
    ledger = _doc_ledger(p)
    derived = _new_pack(p, pack["vendor_kind"], pack.get("vendor_name") or "", slots,
                        parent_pack_id=pack["pack_id"],
                        reject_sheet=[dict(it, pack_id=pack["pack_id"]) for it in items],
                        deadline_days=deadline_days)
    derived["version_tag"] = "v2"
    derived["baseline"]["parent_design_hash"] = pack["baseline"]["design_hash"]
    build_zip(p, derived)
    ledger["packs"].append(derived)
    pack["status"] = "rejected"
    pack["rejected_at"] = _iso(_now())
    pack["derived_pack_id"] = derived["pack_id"]
    return derived


# ---------------------------------------------------------------- 四数与退回箱


def stats(p: dict) -> dict:
    """验收①：派出／回传／退回／超时四数可计数＋退回原因计数。"""
    ledger = _doc_ledger(p)
    packs = ledger.get("packs") or []
    counts = {"dispatched": 0, "returned": 0, "merged": 0, "rejected": 0, "timeout": 0}
    reasons: dict[str, int] = {}
    for pack in packs:
        st = _status(pack)
        counts["dispatched"] += 1
        if (pack.get("returns") or []):
            counts["returned"] += 1
        if st == "merged":
            counts["merged"] += 1
        if st == "rejected":
            counts["rejected"] += 1
        if st == "timeout":
            counts["timeout"] += 1
        for ret in pack.get("returns") or []:
            for hr in ret.get("hard_rejects") or []:
                reasons[f"规则{hr.get('rule')}：{str(hr.get('why') or '')[:24]}"] = \
                    reasons.get(f"规则{hr.get('rule')}：{str(hr.get('why') or '')[:24]}", 0) + 1
            for cid in ret.get("failed") or []:
                reasons[f"{cid} 未过"] = reasons.get(f"{cid} 未过", 0) + 1
            if ret.get("silent_slots"):
                reasons["C1 沉默（无回应）"] = reasons.get("C1 沉默（无回应）", 0) + 1
    accepted = sum(1 for pack in packs for ret in pack.get("returns") or []
                   if ret.get("verdict") == "accepted")
    total_returns = sum(len(pack.get("returns") or []) for pack in packs)
    return {
        "counts": counts,
        "校验通过率": round(accepted / total_returns, 3) if total_returns else None,
        "returns": total_returns,
        "退回原因计数": reasons,
        "退回箱": len(ledger.get("return_box") or []),
        "安全事件": len(ledger.get("security_events") or []),
        "冲突": {"未处理": sum(1 for c in ledger["conflicts"] if c.get("state") == "未处理"),
                 "总": len(ledger["conflicts"])},
        "rule": "§10 阶段 4 验收①：v1 的「丢失率可接受」改成这四个数可计数",
    }


# ---------------------------------------------------------------- 路由


def _load(pid: str) -> tuple[sqlite3.Connection, dict]:
    con = _sqlite()
    row = con.execute("SELECT doc FROM projects WHERE id=?", (pid,)).fetchone()
    if not row:
        con.close()
        raise HTTPException(404, "项目不存在")
    return con, json.loads(row[0])


@router.get("/{pid}/slots")
def slots_preview(pid: str, vendor_kind: str = "定制", vendor_name: str = ""):
    _con, p = _load(pid)
    try:
        slots = build_slots(p, vendor_kind, vendor_name)
    finally:
        _con.close()
    return {"vendor_kind": vendor_kind, "count": len(slots), "slots": slots,
            "columns": slots_csv_header(vendor_kind),
            "fill_columns": list(_fill_cols(vendor_kind))}


@router.post("/{pid}/dispatch")
def route_dispatch(pid: str, payload: dict = Body(...)):
    from .app import connect, get, commit_note
    with connect() as con:
        con.execute("BEGIN IMMEDIATE")
        project = get(con, pid)
        pack = dispatch(project, str(payload.get("vendor_kind") or ""),
                        str(payload.get("vendor_name") or "").strip(),
                        int(payload.get("deadline_days") or DEADLINE_DAYS))
        commit_note(con, project, "导出协同包",
                    f"{pack['pack_id']} → {VENDOR_LABEL[pack['vendor_kind']]}"
                    f"·{pack['vendor_name'] or '未指名'}：{len(pack['slots'])} 条必挂对象，"
                    f"期限 {pack['deadline_at']}")
        con.commit()
        return pack


@router.get("/{pid}/packs")
def route_packs(pid: str):
    _con, p = _load(pid)
    try:
        ledger = _doc_ledger(p)
        return {"packs": [dict(x, status=_status(x)) for x in ledger["packs"]],
                "return_box": ledger["return_box"],
                "channel_map": ledger["channel_map"],
                "conflicts": conflict_rows(ledger)}
    finally:
        _con.close()


@router.get("/{pid}/pack/{pack_id}/download")
def route_download(pid: str, pack_id: str):
    _con, p = _load(pid)
    try:
        pack = _pack(p, pack_id)
        if not pack:
            raise HTTPException(404, "这个包不在本项目的派出记录里")
        if _design_hash(p) != pack["baseline"]["design_hash"]:
            raise HTTPException(409, "图纸自派出后已改动：这张包的内容和基线对不上，"
                                     "请重新发包（或先按 §10.3 走打回派生包）")
        blob = build_zip(p, pack)
        return Response(content=blob, media_type="application/zip",
                        headers={"Content-Disposition": f'attachment; filename="{pack_id}.zip"'})
    finally:
        _con.close()


@router.post("/{pid}/pack/{pack_id}/return")
async def route_return(pid: str, pack_id: str, file: UploadFile = File(...)):
    from .app import connect, get, commit_note
    blob = await file.read()
    if len(blob) > 8 * 1024 * 1024:
        raise HTTPException(400, "回传文件超过 8MB")
    with connect() as con:
        con.execute("BEGIN IMMEDIATE")
        project = get(con, pid)
        pack = _pack(project, pack_id)
        if not pack:
            raise HTTPException(404, "pack_id 不在本项目的派出记录里（§10.2 硬拒 2 同样成立，"
                                     "但没有可挂账的记录）")
        meta, header, rows = parse_return(blob, file.filename or "")
        result = check_return(project, pack, meta, header, rows)
        ledger = _doc_ledger(project)
        if result["verdict"] == "rejected":
            ledger["return_box"].append({"pack_id": pack_id, "at": result["received_at"],
                                         "name": file.filename or "slots.csv",
                                         "hard_rejects": result["hard_rejects"],
                                         "rows": rows})
            for x in result["security"]:
                ledger["security_events"].append({"pack_id": pack_id, "at": result["received_at"],
                                                  "detail": x["why"],
                                                  "note": "客户数据外发即一次泄露（R4）"})
        pack.setdefault("returns", []).append(result)
        # 冲突在「校验」这一刻就进表——不合图也得留痕，只标记不自动修（§10.3）
        result["conflict_ids"] = _record_conflicts(ledger, pack_id, result.get("conflicts") or [])
        pack["status"] = "returned" if result["verdict"] == "accepted" else pack.get("status") or "dispatched"
        commit_note(con, project, "收到供应商回传",
                    f"{pack_id}：{'校验通过' if result['verdict'] == 'accepted' else '硬拒进退回箱'}"
                    f"（{len(result['hard_rejects'])} 条）·未过 {result['failed'] or '无'}"
                    f"·待核 {result['unknown'] or '无'}")
        con.commit()
        return result


@router.post("/{pid}/pack/{pack_id}/merge")
def route_merge(pid: str, pack_id: str):
    from .app import connect, get, editable, validate_design, commit
    with connect() as con:
        con.execute("BEGIN IMMEDIATE")
        project = get(con, pid)
        editable(project)
        pack = _pack(project, pack_id)
        if not pack:
            raise HTTPException(404, "包不存在")
        report = merge_pack(project, pack)
        validate_design(project["design"], project)
        commit(con, project, "协同包合图",
               f"{pack_id}：落位 {len(report['applied'])} 条（origin=supplier）、"
               f"跳过 {len(report['skipped'])} 条、冲突 {len(report['conflict_ids'])} 条",
               invalidate=True)
        con.commit()
        return {**report, "revision": project["revision"]}


@router.post("/{pid}/pack/{pack_id}/reject")
def route_reject(pid: str, pack_id: str, payload: dict = Body(...)):
    from .app import connect, get, commit_note
    with connect() as con:
        con.execute("BEGIN IMMEDIATE")
        project = get(con, pid)
        pack = _pack(project, pack_id)
        if not pack:
            raise HTTPException(404, "包不存在")
        derived = build_reject_pack(project, pack, list(payload.get("items") or []),
                                    int(payload.get("deadline_days") or DEADLINE_DAYS))
        commit_note(con, project, "协同包打回",
                    f"{pack_id} 打回 {len(payload.get('items') or [])} 条 → 派生包 "
                    f"{derived['pack_id']}（v2），基线 V{pack['baseline']['version']}"
                    f"R{pack['baseline']['revision']}")
        con.commit()
        return derived


@router.post("/{pid}/conflicts/{conflict_id}")
def route_conflict(pid: str, conflict_id: str, payload: dict = Body(...)):
    from .app import connect, get, commit_note
    with connect() as con:
        con.execute("BEGIN IMMEDIATE")
        project = get(con, pid)
        row = resolve_conflict(project, conflict_id, str(payload.get("decision") or ""),
                               str(payload.get("note") or ""))
        commit_note(con, project, "冲突逐条处置",
                    f"{conflict_id}：{row['state']}（{row['decision_note'][:40]}）")
        con.commit()
        return row


@router.get("/{pid}/stats")
def route_stats(pid: str):
    _con, p = _load(pid)
    try:
        return stats(p)
    finally:
        _con.close()


def register(app):
    app.include_router(router)

