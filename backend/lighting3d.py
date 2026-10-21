"""三维灯光模块（独立预览引擎，与主画布同一套解析器）

一句话：**导图纸 → 自动建三维 → 点场景出讲解词 → 出一套报价**。

**三维是项目的一种「建模方式」，不是一个单独的页面**：建项目时选了 3D，
项目里就是三维空间（选了就不能改成 2D，反之亦然）。工作台里直接内嵌渲染引擎，
不另开网页。

- 引擎：`/lighting3d-engine/*`（three.js + 引擎脚本，给工作台内嵌用，没有独立页面）
- 接口：`/api/lighting3d/*`
- 生成：`POST /api/lighting3d/<pid>/generate` 后台跑，`GET /api/lighting3d/<pid>/job`
  轮询进度（含成功/失败/失败原因），前端据此画进度条。
- 项目数据：`<DATA>/lighting3d/<pid>.json`（解析结果 + 房间名 + 讲解词 + 两个层高），旁挂 `<pid>.source.dxf`
- 产品参数：`lighting3d_products` 表（studio.sqlite3 里的新表），数据源=随源码分发的产品资料，
  **只同步市场零售价**（出厂价/运费/备注按白名单挡掉）

口径（用户 2026-09 拍板，别改）：
1. 每盏灯必须有看得见的三维光锥，不能只做地面亮斑
2. 不用 IES 光度学，光斑/光锥用程序化渐变贴图；光斑半径 =（吊顶后层高 - 灯具安装高度）× tan(光束角/2)
3. 默认墙剖切 1.5m + 鸟瞰；默认暗场，留「白天看图」
4. 房间名图纸里没有 → 靠吊顶轮廓推 + 人来确认；编号对不上的灯位进「待确认清单」，不静默丢
"""
from __future__ import annotations

import json
import hashlib
import math
import os
import re
import shutil
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Literal, TypedDict

from fastapi import APIRouter, Body, File, Form, HTTPException, UploadFile
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool

from . import dxf_lighting as DL
from . import products as PR
from .space_geometry import design_geometry

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.getenv("DATA_DIR", str(ROOT / "data"))).resolve()
DB = DATA / "studio.sqlite3"
STORE = DATA / "lighting3d"
PAGE = Path(__file__).resolve().parent / "lighting3d_page"

MAX_MB = 80
UPLOADS = DATA / "uploads" / "projects"
SCHEMES = ["缓亮缓灭", "开闭", "无线", "总线"]

router = APIRouter(prefix="/api/lighting3d", tags=["lighting3d"])


def _furn_poly_geom(row: dict):
    """画过多边形边界的家具件：**轮廓才是真形状**，回 (x, y, 宽m, 深m)；没有轮廓回 None。

    现场 2026-10-16 的 `text` 项目就是这里破的：三维页「语义调整」重建家具行时用图纸里的老 x/z
    覆盖了 x/y，而轮廓 points 还留在新位置——三维那只盒子于是画回老地方、甚至穿出墙体，
    二维看轮廓却是对的，越看越像「形状全错」。
    """
    pts = row.get("points") if isinstance(row, dict) else None
    if not isinstance(pts, list) or len(pts) < 3:
        return None
    try:
        xs = [float(p["x"]) for p in pts]
        ys = [float(p["y"]) for p in pts]
    except (KeyError, TypeError, ValueError):
        return None
    return ((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2,
            (max(xs) - min(xs)) / DESIGN_UNITS_PER_M, (max(ys) - min(ys)) / DESIGN_UNITS_PER_M)


# ---------------------------------------------------------------- 存取
def _store_path(pid: str) -> Path:
    return STORE / f"{pid}.json"


def load_store(pid: str) -> dict:
    p = _store_path(pid)
    if p.is_file():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def save_store(pid: str, st: dict) -> None:
    STORE.mkdir(parents=True, exist_ok=True)
    target = _store_path(pid)
    temp = target.with_name(target.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        temp.write_text(json.dumps(st, ensure_ascii=False, indent=1), encoding="utf-8")
        os.replace(temp, target)
    finally:
        temp.unlink(missing_ok=True)


# 注：以下仅冻结 store 字段契约；现有读写、接口与引擎行为暂不接入。
class StoreLight(TypedDict, total=False):
    id: str                  # 落库时生成一次并持久化；引用不使用 code 或下标
    code: str                # 2D 编号规则，显示用、可重算
    x: float                 # store 米坐标
    z: float
    room: str
    type: str
    product_id: str          # 选型标识，不承载价格或合计
    cct: int | None          # 缺值保持 null，不自行补默认值
    cct_source: Literal["原始", "默认补值", "待补"]


class StoreScene(TypedDict, total=False):
    id: str
    name: str
    levels: dict[str, float]  # 回路 id -> 0..1；转灯 id 的 states 留待后续
    script: str


class StoreCircuit(TypedDict, total=False):
    id: str
    name: str
    members: list[str]       # 灯 id；未归属桶也是一条 id="__unassigned__" 的记录


class SourceTransform(TypedDict, total=False):
    source_unit: Literal["mm", "cm", "m", "inch"] | None
    source_scale: float | None
    source_base_xy: list[float] | None  # [x, y]，源图基点偏移
    source_y_flip: bool | None
    lamp_layer: str | None


class Lighting3DStoreSchema(TypedDict, total=False):
    parsed: dict[str, Any]  # 保留原样；日后 parsed.source 可采用 SourceTransform
    lights: list[StoreLight]
    scenes: list[StoreScene]
    circuits: list[StoreCircuit]


UNASSIGNED_CIRCUIT_ID = "__unassigned__"  # 保留 id，不能分配给真实回路


def store_schema_lists(st: dict) -> tuple[list, list, list]:
    """旧 store 缺字段时仅在读取视图中返回空列表，不改写原始 parsed/store。"""
    return (st["lights"] if "lights" in st else [],
            st["scenes"] if "scenes" in st else [],
            st["circuits"] if "circuits" in st else [])


def schema_lights_for_read(st: dict) -> list:
    """契约：有 store.lights（包括 []）就用它；无字段才回落 parsed.lamps。"""
    if "lights" in st:
        return st["lights"]
    return (st.get("parsed") or {}).get("lamps") or []


# 注：仅新 lights 接口接线；既有解析、摘要、引擎和报价接口不改读写行为。
_LIGHTS_LOCK = threading.RLock()
_LIGHT_FIELDS = frozenset({"code", "x", "z", "room", "type", "product_id",
                           "cct", "cct_source"})
_LIGHT_SOURCES = frozenset({"原始", "默认补值", "待补"})


def _new_light_id(used: set[str]) -> str:
    while True:
        lid = "lamp-" + uuid.uuid4().hex
        if lid not in used and lid != UNASSIGNED_CIRCUIT_ID:
            return lid


def _light_fields(payload: dict) -> dict:
    """只接收冻结字段；未知键（包括任何价格、数量和合计）明确拒绝。"""
    unknown = set(payload) - _LIGHT_FIELDS
    if unknown:
        raise HTTPException(400, "灯具字段不允许：" + ", ".join(sorted(unknown)))
    for key in ("code", "room", "type", "product_id"):
        if key in payload and not isinstance(payload[key], str):
            raise HTTPException(400, f"{key} 必须是字符串")
    for key in ("x", "z"):
        if key in payload and (isinstance(payload[key], bool)
                               or not isinstance(payload[key], (int, float))
                               or not math.isfinite(payload[key])):
            raise HTTPException(400, f"{key} 必须是有限数字")
    if "cct" in payload and (payload["cct"] is not None and
                             (isinstance(payload["cct"], bool) or
                              not isinstance(payload["cct"], int))):
        raise HTTPException(400, "cct 必须是整数或 null")
    if "cct_source" in payload and payload["cct_source"] not in _LIGHT_SOURCES:
        raise HTTPException(400, "cct_source 来源无效")
    if payload.get("cct_source") == "默认补值":
        raise HTTPException(400, "本轮不允许未确认的默认补值")
    if "cct" in payload and payload["cct"] is None and \
            payload.get("cct_source", "待补") != "待补":
        raise HTTPException(400, "缺色温只能标记待补")
    return dict(payload)


def _stored_lights(pid: str, st: dict) -> list:
    """旧项目首次打开补发 id 并写盘；显式 lights=[] 不回落。调用方持锁。"""
    if "lights" not in st:
        lamps = schema_lights_for_read(st)
        if not lamps:
            return []
        used: set[str] = set()
        lights: list[dict] = []
        for lamp in lamps:
            # 不把 parsed 的 circuit/source/价格等解析字段带进持久 lights。
            item = {key: lamp[key] for key in _LIGHT_FIELDS - {"cct_source"}
                    if key in lamp and lamp[key] is not None}
            item["id"] = _new_light_id(used)
            used.add(item["id"])
            item["cct"] = item.get("cct")  # 无色温不猜值
            item["cct_source"] = "原始" if item["cct"] is not None else "待补"
            lights.append(item)
        st["lights"] = lights
        save_store(pid, st)
    return st["lights"]


# ---------------------------------------------------------------- 生成任务（进度 / 成败）
JOBS: dict[str, dict] = {}
_JOBS_LOCK = threading.Lock()


def _job_path(pid: str) -> Path:
    return STORE / f"{pid}.job.json"


def set_job(pid: str, **kw) -> dict:
    """写生成任务状态：内存 + `<pid>.job.json`（服务重启后前端仍能读到上次结果）。"""
    with _JOBS_LOCK:
        j = dict(JOBS.get(pid) or {})
        j.update(kw)
        JOBS[pid] = j
    try:
        STORE.mkdir(parents=True, exist_ok=True)
        _job_path(pid).write_text(json.dumps(j, ensure_ascii=False), encoding="utf-8")
    except Exception:
        pass
    return j


def get_job(pid: str) -> dict:
    with _JOBS_LOCK:
        j = JOBS.get(pid)
    if j:
        return j
    p = _job_path(pid)
    if p.is_file():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"state": "idle", "pct": 0.0, "stage": "", "error": "", "message": ""}


def _generate_worker(pid: str, src: Path, name: str, sync_to_project: bool = True) -> None:
    """后台解析图纸 → 存三维数据。进度写进 job，失败原因原样带出来，不吞。"""
    set_job(pid, state="running", pct=0.02, stage="准备解析", error="", message="",
            file=name, warn=[], stats={},
            started_at=time.strftime("%Y-%m-%d %H:%M:%S"), finished_at="")

    def prog(pct, stage):
        set_job(pid, state="running", pct=round(0.02 + float(pct) * 0.9, 4), stage=str(stage))

    try:
        t0 = time.time()
        parsed = DL.parse(str(src), progress=prog)
        set_job(pid, state="running", pct=0.95, stage="保存三维数据")
        st = load_store(pid)
        st.update({
            "parsed": parsed, "file": name,
            "uploaded_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "warn": parsed.get("warnings") or [],
            # 图纸换了：旧图纸上的家具类型 / 朝向覆盖（按序号存的）作废，别张冠李戴。
            "furn_kinds": {},
            "furn_rots": {},
            "furn_sizes": {},
            "furn_hidden": [],
            "furn_extra": [],
            "stats": {
                "rooms": len(parsed["rooms"]), "lamps": len(parsed["lamps"]),
                "strips": len(parsed["strips"]), "circuits": len(parsed["circuits"]),
                "walls": len(parsed["walls"]),
                "furniture": len(DL.furniture_of(parsed)),
                "sec": round(time.time() - t0, 1),
            },
        })
        # A new source drawing invalidates all geometry-bound edits. A parser
        # rerun of the same source is likewise explicit regeneration, not a
        # silent mixing of old light ids with newly parsed lamps.
        for key in ("lights", "circuits", "scenes"):
            st.pop(key, None)
        # ⚠️ 层高不在这里写默认值：建档表单填的原始/吊顶后层高原样生效。
        # 以前这里 setdefault("ceiling", 2.9) 会把建档填的层高永久盖住（光斑直径全靠它）。
        save_store(pid, st)
        # 顺手把 DXF 渲染成底图（「在 DXF 底图上画多边形改空间边界」要用，实测 2026-10-14）：
        # 在同一后台线程里做，不占用户等待；失败也不影响三维生成。
        try:
            from .app import ensure_project_dxf_preview
            ensure_project_dxf_preview(pid)
        except Exception:
            pass
        st2 = st["stats"]
        set_job(pid, state="running", pct=0.97, stage="等待房间确认" if not sync_to_project else "同步灯位到灯具配置")
        sync_note = " · 待确认房间，未写入正式设计"
        if sync_to_project:
            try:
                synced = sync_design(pid)
                sync_note = " · 已同步 %d 盏灯到灯具配置" % synced["lights"]
            except Exception as e:  # 同步失败不让三维白做：原因带出来，可在三维页手动重试
                detail = getattr(e, "detail", None) or str(e)
                sync_note = " · 灯位未同步：%s" % (detail if isinstance(detail, str) else json.dumps(detail, ensure_ascii=False))
        set_job(pid, state="done", pct=1.0, stage="完成", error="", warn=st["warn"], stats=st2,
                message=("三维模型已生成：%d 空间 · %d 灯位 · %d 灯带 · %d 家具 · %.1fs"
                         % (st2["rooms"], st2["lamps"], st2["strips"], st2["furniture"], st2["sec"])) + sync_note,
                finished_at=time.strftime("%Y-%m-%d %H:%M:%S"))
    except Exception as e:
        set_job(pid, state="error", pct=0.0, stage="生成失败",
                error=f"{type(e).__name__}: {e}"[:500], message="三维模型没生成出来",
                finished_at=time.strftime("%Y-%m-%d %H:%M:%S"))


def _norm_h(v, default=None):
    if v in (None, ""):
        return default
    m = re.search(r"\d+(\.\d+)?", str(v))
    return float(m.group(0)) if m else default


def _products_map(scheme: str | None = None) -> dict:
    return PR.map_products(str(DB), scheme)


def _project_doc(pid: str) -> dict:
    con = sqlite3.connect(DB)
    try:
        row = con.execute("SELECT doc FROM projects WHERE id=?", (pid,)).fetchone()
        return json.loads(row[0]) if row else {}
    except Exception:
        return {}
    finally:
        con.close()


def _projects() -> list[dict]:
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    out = []
    try:
        for r in con.execute("SELECT id, code, doc FROM projects"):
            try:
                d = json.loads(r["doc"])
            except Exception:
                d = {}
            out.append({
                "pid": r["id"],
                "code": r["code"] or d.get("code", ""),
                "name": d.get("name") or d.get("client") or d.get("title") or r["id"],
                "status": d.get("status", ""),
                "mode": d.get("mode", "2D"),
                "ceiling": d.get("ceiling") or 0,
                "ceilingNet": d.get("ceilingNet") or 0,
            })
    except Exception:
        pass
    con.close()
    out.sort(key=lambda x: (x["status"] != "设计中", x["name"]))
    return out


# ---------------------------------------------------------------- 硬闸与只读（2026-10-12 本地拍板）
# 拍板6「硬性不给」：空间没在预览里确认过，就不许往下走（图纸灯位不许同步进设计）。
# 拍板8「只读」：空间一确认，三维就是只读视图——布灯/回路/场景一律在布灯画布改。
def _design_now(pid: str) -> dict:
    return (_project_doc(pid) or {}).get("design") or {}


def space_confirmed(pid: str) -> bool:
    """空间是否已在「三维空间预览」里确认冻结。"""
    return (_design_now(pid).get("spaceDefinition") or {}).get("status") == "confirmed"


def _assert_3d_readonly(pid: str) -> None:
    if space_confirmed(pid):
        raise HTTPException(409, "空间已确认，三维只读：布灯 / 回路 / 场景请在布灯画布改")


def _assert_space_confirmed(pid: str) -> None:
    if not space_confirmed(pid):
        raise HTTPException(422, "硬闸：请先在三维「空间预览」里确认空间，再往下走")


# ---------------------------------------------------------------- 接口
@router.get("/{pid}/lights")
def get_lights(pid: str):
    with _LIGHTS_LOCK:
        st = load_store(pid)
        return {"pid": pid, "lights": _stored_lights(pid, st)}


@router.post("/{pid}/lights", status_code=201)
def add_light(pid: str, payload: dict = Body(...)):
    _assert_3d_readonly(pid)
    fields = _light_fields(payload)
    with _LIGHTS_LOCK:
        # A light can only be attached to an existing 3D store; otherwise a
        # misspelled project id would silently create an orphan project file.
        if not _store_path(pid).is_file():
            raise HTTPException(404, "三维项目不存在")
        st = load_store(pid)
        lights = _stored_lights(pid, st)
        _stored_circuits(st, lights)
        lid = _new_light_id({x["id"] for x in lights})
        item = {"id": lid, **fields}
        if "cct" not in item:
            item["cct"] = None
        if "cct_source" not in item:
            item["cct_source"] = "原始" if item["cct"] is not None else "待补"
        if item["cct"] is None and item["cct_source"] != "待补":
            raise HTTPException(400, "缺色温只能标记待补")
        if "lights" not in st:
            st["lights"] = lights
        lights.append(item)
        next(c for c in st["circuits"] if c["id"] == UNASSIGNED_CIRCUIT_ID)["members"].append(lid)
        save_store(pid, st)
        return item


@router.patch("/{pid}/lights/{lid}")
def update_light(pid: str, lid: str, payload: dict = Body(...)):
    _assert_3d_readonly(pid)
    fields = _light_fields(payload)
    with _LIGHTS_LOCK:
        st = load_store(pid)
        lights = _stored_lights(pid, st)
        _stored_circuits(st, lights)
        light = next((x for x in lights if x["id"] == lid), None)
        if light is None:
            raise HTTPException(404, "灯具 id 不存在")
        updated = {**light, **fields}
        if "cct" in fields and "cct_source" not in fields:
            updated["cct_source"] = "原始" if fields["cct"] is not None else "待补"
        if updated.get("cct") is None and updated.get("cct_source") != "待补":
            raise HTTPException(400, "缺色温只能标记待补")
        light.clear()
        light.update(updated)
        save_store(pid, st)
        return light


@router.delete("/{pid}/lights/{lid}")
def delete_light(pid: str, lid: str):
    _assert_3d_readonly(pid)
    with _LIGHTS_LOCK:
        st = load_store(pid)
        lights = _stored_lights(pid, st)
        _stored_circuits(st, lights)
        light = next((x for x in lights if x["id"] == lid), None)
        if light is None:
            raise HTTPException(404, "灯具 id 不存在")
        lights.remove(light)
        for circuit in st.get("circuits") or []:
            circuit["members"] = [x for x in circuit["members"] if x != lid]
        save_store(pid, st)
        return {"ok": True, "id": lid}


def _existing_store(pid: str) -> dict:
    if not _store_path(pid).is_file():
        raise HTTPException(404, "三维项目不存在")
    return load_store(pid)


def _default_circuits(lights: list[dict], st: dict) -> list[dict]:
    parsed_lamps = (st.get("parsed") or {}).get("lamps") or []
    groups: dict[str, dict] = {}
    for i, light in enumerate(lights):
        source = parsed_lamps[i] if i < len(parsed_lamps) else {}
        if i >= len(parsed_lamps):
            continue
        name = str(source.get("circuit") or light.get("room") or "未归属")
        if name == "未归属":
            continue
        cid = "circuit-" + uuid.uuid5(uuid.NAMESPACE_URL, name).hex[:16]
        groups.setdefault(cid, {"id": cid, "name": name, "members": []})["members"].append(light["id"])
    owned = {lid for c in groups.values() for lid in c["members"]}
    return [*groups.values(), {"id": UNASSIGNED_CIRCUIT_ID, "name": "未归属",
                               "members": [l["id"] for l in lights if l["id"] not in owned]}]


def _stored_circuits(st: dict, lights: list[dict]) -> list[dict]:
    if "circuits" not in st:
        st["circuits"] = _default_circuits(lights, st)
    return st["circuits"]


def _validate_circuits(items: Any, lights: list[dict]) -> list[dict]:
    if not isinstance(items, list) or len(items) > 5000:
        raise HTTPException(422, "回路必须是列表")
    ids, members = set(), set()
    valid = {l["id"] for l in lights}
    result = []
    for c in items:
        if not isinstance(c, dict) or set(c) != {"id", "name", "members"}:
            raise HTTPException(422, "回路字段无效")
        cid, name, group = c["id"], c["name"], c["members"]
        if not isinstance(cid, str) or not cid or cid in ids or not isinstance(name, str) or not name.strip():
            raise HTTPException(422, "回路 id 或名称无效")
        if not isinstance(group, list) or any(not isinstance(x, str) or x not in valid or x in members for x in group):
            raise HTTPException(422, "回路灯具不存在或重复归属")
        ids.add(cid)
        members.update(group)
        result.append({"id": cid, "name": name.strip(), "members": group})
    bucket = next((c for c in result if c["id"] == UNASSIGNED_CIRCUIT_ID), None)
    if bucket is None or bucket["name"] != "未归属" or members != valid:
        raise HTTPException(422, "必须包含未归属桶，且每盏灯恰好归属一次")
    return result


@router.get("/{pid}/circuits")
def get_circuits(pid: str):
    with _LIGHTS_LOCK:
        st = _existing_store(pid)
        lights = _stored_lights(pid, st)
        return {"circuits": _stored_circuits(st, lights)}


@router.put("/{pid}/circuits")
def put_circuits(pid: str, payload: dict = Body(...)):
    _assert_3d_readonly(pid)
    with _LIGHTS_LOCK:
        st = _existing_store(pid)
        lights = _stored_lights(pid, st)
        circuits = _validate_circuits(payload.get("circuits"), lights)
        old_ids = {c["id"] for c in _stored_circuits(st, lights)}
        removed = old_ids - {c["id"] for c in circuits}
        if any(removed & set(s.get("levels", {})) for s in st.get("scenes") or []):
            raise HTTPException(409, "回路仍被场景引用，请先修改场景")
        st["circuits"] = circuits
        save_store(pid, st)
        return {"circuits": circuits}


# 二维设计单位与三维米的关系：同一原点，二维 = 三维 × 26（与 sync_design 的 ×26 互为逆）。
DESIGN_UNITS_PER_M = 26.0


def _design_rooms_for_engine(project: dict) -> list[dict]:
    """已确认的二维空间 → 三维引擎的房间结构。

    §十.8 的「必须先修的一条：手动修改后，3D 必须跟着变」。三维房间以**确认过的设计空间**
    为准，DXF 解析只负责出草稿。有 points 就用多边形，只有 x/y/width/height 就按矩形算。
    """
    out: list[dict] = []
    for r in (project.get("design") or {}).get("rooms") or []:
        pts = [p for p in (r.get("points") or [])
               if isinstance(p, dict) and "x" in p and "y" in p]
        if len(pts) >= 3:
            poly = [[round(float(p["x"]) / DESIGN_UNITS_PER_M, 3),
                     round(float(p["y"]) / DESIGN_UNITS_PER_M, 3)] for p in pts]
        else:
            try:
                x, y = float(r.get("x") or 0), float(r.get("y") or 0)
                w, h = float(r.get("width") or 0), float(r.get("height") or 0)
            except (TypeError, ValueError):
                continue
            if w <= 0 or h <= 0:
                continue
            poly = [[round(x / DESIGN_UNITS_PER_M, 3), round(y / DESIGN_UNITS_PER_M, 3)],
                    [round((x + w) / DESIGN_UNITS_PER_M, 3), round(y / DESIGN_UNITS_PER_M, 3)],
                    [round((x + w) / DESIGN_UNITS_PER_M, 3), round((y + h) / DESIGN_UNITS_PER_M, 3)],
                    [round(x / DESIGN_UNITS_PER_M, 3), round((y + h) / DESIGN_UNITS_PER_M, 3)]]
        xs = [p[0] for p in poly]
        zs = [p[1] for p in poly]
        area = abs(sum(poly[i][0] * poly[(i + 1) % len(poly)][1]
                       - poly[(i + 1) % len(poly)][0] * poly[i][1]
                       for i in range(len(poly)))) / 2.0
        out.append({
            "id": r.get("id") or f"design-room-{len(out) + 1}",
            "name": r.get("name") or "未命名空间",
            "area": round(area, 1) if area else float(r.get("area") or 0),
            "bbox": [min(xs), min(zs), max(xs), max(zs)],
            "cx": round((min(xs) + max(xs)) / 2, 3),
            "cz": round((min(zs) + max(zs)) / 2, 3),
            "poly": poly,
            "rects": [],
        })
    return out


def _furn_poly_pts(f: dict) -> list | None:
    """家具轮廓点 → 三维米坐标 [[x, z], ...]（与引擎同口径：x＝设计 x/26，z＝设计 y/26，不镜像）。

    画过轮廓的家具（现场 2026-10-16 的衣帽间柜子）在三维里必须按轮廓挤出，
    只给外接框的话引擎只能画一个方盒子——那就是「轮廓改了没生效」。
    """
    pts = f.get("points")
    if not isinstance(pts, list) or len(pts) < 3:
        return None
    out = []
    for q in pts:
        if not isinstance(q, dict):
            return None
        try:
            out.append([round(float(q["x"]) / DESIGN_UNITS_PER_M, 3),
                        round(float(q["y"]) / DESIGN_UNITS_PER_M, 3)])
        except (KeyError, TypeError, ValueError):
            return None
    return out


def _engine_view(pid: str, st: dict, parsed: dict, opts: dict) -> dict:
    """Only the 3D view is overlaid: original parsed data stays untouched."""
    engine = DL.to_engine(parsed, opts)
    # §十.8：空间一旦确认过，三维房间就以确认后的设计空间为准——否则在「底图与空间」手绘 /
    # 改名 / 改边界之后，三维还是那张图刚解析出来的老样子。
    confirmed_design = None
    try:
        project = _project_doc(pid)
        status = ((project.get("design") or {}).get("spaceDefinition") or {}).get("status")
        # 2026-10-12 本地口径：导入图纸 → 空间预览 → 确认 / 修改。预览阶段（status=previewing）
        # 也要用**设计里的空间**——不然在预览里改了名字/边界，回到预览还是图纸刚解析出来的老样子。
        # 灯位仍然只在确认后改走设计（预览这一步只看空间，见 §十.8 / §十.9）。
        if status in ("confirmed", "previewing") or (status == "draft" and any(
                r.get("source") not in ("cad", CAD_ROOM_SOURCE) for r in project.get("design", {}).get("rooms") or [])):
            geometry = design_geometry(project)
            engine.update(geometry)
            # 手绘边界是结构的唯一来源；原 CAD 的异常外接框不能继续决定相机和楼板。
            engine["area"] = round(sum(r["area"] for r in geometry["rooms"]), 2)
            if geometry["rooms"]:
                engine["ceiling"] = max(r["originalHeightM"] for r in geometry["rooms"])
                engine["ceiling_net"] = max(r["heightM"] for r in geometry["rooms"])
            x0, z0, x1, z1 = geometry["bbox"]
            engine["furniture"] = [f for f in engine["furniture"] if x0 <= f["x"] <= x1 and z0 <= f["z"] <= z1]
            if "furniture" in project.get("design", {}):
                engine_rows = []
                for f in project["design"]["furniture"]:
                    poly = _furn_poly_geom(f)     # 画过轮廓的件以轮廓为准（见 _furn_poly_geom 注释）
                    engine_rows.append({
                        "id": f["id"], "kind": f["kind"],
                        "x": poly[0] if poly else f["x"] / DESIGN_UNITS_PER_M,
                        "z": poly[1] if poly else f["y"] / DESIGN_UNITS_PER_M,
                        "w": poly[2] if poly else f["widthM"],
                        "d": poly[3] if poly else f["depthM"],
                        "h": f["heightM"], "rot": -f.get("rotation", 0), "floor": f.get("floor", 1),
                        "roomId": f.get("roomId", ""), "designFurniture": True,
                        # 画过轮廓的件：轮廓点（三维米坐标 [[x, z], ...]）给引擎挤出成棱柱。
                        # 现场 2026-10-16「主卧衣帽间的柜子轮廓我改过、没生效」＝引擎只拿到外接框。
                        "pts": _furn_poly_pts(f)})
                engine["furniture"] = engine_rows
            if status == "confirmed":
                confirmed_design = project
    except Exception:
        pass
    with _LIGHTS_LOCK:
        lights = _stored_lights(pid, st)
        circuits = _stored_circuits(st, lights)
    old_circuits = engine["circuits"]
    original_lights = engine["lights"]
    fallback = old_circuits[0] if old_circuits else {}
    engine["circuits"] = [{**fallback, "id": c["id"], "room": c["name"],
                           "type": c["name"], "code": "", "price": None}
                          for c in circuits]
    ownership = {lid: c["id"] for c in circuits for lid in c["members"]}
    engine["lights"] = [{"id": l["id"], "c": ownership.get(l["id"], UNASSIGNED_CIRCUIT_ID),
                         "x": l.get("x", 0), "z": l.get("z", 0)}
                        for l in lights]
    # §十.11 第 2 项：补「布灯画布 → 三维灯位」这条通道（原来只有三维 → 二维的反向同步，
    # 人工在画布上布的灯进不了三维）。空间确认过之后，三维灯位也以**设计里的灯具**为准：
    # 二维坐标是「设计单位」（＝三维 × 26），这里 ÷26 回到三维米。没确认的项目照旧读三维自己的灯。
    if confirmed_design is not None:
        design_lights = [f for f in (confirmed_design.get("design") or {}).get("fixtures") or []
                         if f.get("type") != "窗帘"]
        if design_lights:
            seen: dict = {}
            for f in design_lights:
                cid = str(f.get("circuitId") or f.get("circuit") or UNASSIGNED_CIRCUIT_ID)
                seen.setdefault(cid, {"id": cid, "room": str(f.get("circuit") or ""),
                                      "type": "灯具", "code": "", "price": None})
            engine["circuits"] = list(seen.values())
            engine["lights"] = [{"id": f["id"],
                                 "c": str(f.get("circuitId") or f.get("circuit") or UNASSIGNED_CIRCUIT_ID),
                                 "x": round(float(f.get("x") or 0) / DESIGN_UNITS_PER_M, 3),
                                 "z": round(float(f.get("y") or 0) / DESIGN_UNITS_PER_M, 3),
                                 "cct": f.get("cct") or 3000,
                                 "half": float(f.get("beamAngle") or 36) / 2,
                                 "mount": float(f.get("installHeight") or engine.get("ceiling_net") or 2.8)}
                                for f in design_lights if f.get("type") != "灯带"]
            engine["strips"] = [{"id": f["id"],
                                  "c": str(f.get("circuitId") or f.get("circuit") or UNASSIGNED_CIRCUIT_ID),
                                  "path": [[round(float(p["x"]) / DESIGN_UNITS_PER_M, 3),
                                            round(float(p["y"]) / DESIGN_UNITS_PER_M, 3)]
                                           for p in f.get("stripPath") or []],
                                  "mount": float(f.get("installHeight") or engine.get("ceiling_net") or 2.8),
                                  "cct": f.get("cct") or 3000}
                                 for f in design_lights if f.get("type") == "灯带"]
        else:
            engine["lights"] = []
            engine["strips"] = []
    # 现场 2026-10-16：三维里两盏灯一盏都不亮。根因＝情景等级还挂在**解析时的回路 id**
    # （circuit-159ebb94…）上，而确认后引擎的回路已经换成设计里的（C01…）→ 一条都对不上 →
    # 连「全开」也是 0。这里改成：确认过的项目优先用**设计里的情景**（按灯具状态折成回路等级），
    # 设计里没有情景时，把自带预设按「整屋强度」折到当前回路上（全开 1.0 / 全关 0 / 会客 0.3…）。
    design_scenes = ((confirmed_design or {}).get("design") or {}).get("scenes") if confirmed_design else None
    if confirmed_design is not None and design_scenes:
        members: dict = {}
        for l in engine["lights"] + engine.get("strips", []):
            members.setdefault(l["c"], []).append(l["id"])
        engine["scenes"] = [{
            **s,
            "id": s.get("id"), "name": s.get("name") or s.get("id"),
            "states": s.get("states") or {},
            "levels": {cid: round(max([((s.get("states") or {}).get(fid) or {}).get("brightness", 0) / 100.0
                                       for fid in ids
                                       if (((s.get("states") or {}).get(fid) or {}).get("on"))] or [0.0]), 3)
                       for cid, ids in members.items()},
        } for s in design_scenes]
    elif confirmed_design is not None:
        def _intensity(sc):
            vals = [float(v) for v in (sc.get("levels") or {}).values()
                    if isinstance(v, (int, float)) and not isinstance(v, bool)]
            return max(vals) if vals else 0.0
        engine["scenes"] = [{**sc, "levels": {c["id"]: _intensity(sc) for c in engine["circuits"]}}
                            for sc in engine["scenes"]]
    elif "scenes" in st:
        engine["scenes"] = [{**s, "id": s["id"]} for s in st["scenes"]]
    else:
        engine["scenes"] = [{**s, "levels": {
            c["id"]: max((s["levels"].get(original_lights[i]["c"], 0)
                           for i, l in enumerate(lights)
                           if l["id"] in c["members"] and i < len(original_lights)), default=0)
            for c in circuits if c["id"] != UNASSIGNED_CIRCUIT_ID}}
            for s in engine["scenes"]]
    return engine


@router.get("/{pid}/scenes")
def get_scenes(pid: str):
    with _LIGHTS_LOCK:
        st = _existing_store(pid)
        lights = _stored_lights(pid, st)
        circuits = _stored_circuits(st, lights)
        if "scenes" not in st:
            parsed = st.get("parsed") or {}
            template = DL.to_engine(parsed, {"products": {}}) if parsed else {"scenes": [], "lights": []}
            original = template["lights"]
            st["scenes"] = [
                {"id": s["id"], "name": s["id"], "levels": {
                    c["id"]: max((float(s["levels"].get(original[i]["c"], 0))
                                  for i, l in enumerate(lights)
                                  if l["id"] in c["members"] and i < len(original)), default=0)
                    for c in circuits if c["id"] != UNASSIGNED_CIRCUIT_ID},
                 "script": s["script"]}
                for s in template["scenes"]]
            save_store(pid, st)
        return {"scenes": st["scenes"]}


@router.put("/{pid}/scenes")
def put_scenes(pid: str, payload: dict = Body(...)):
    _assert_3d_readonly(pid)
    with _LIGHTS_LOCK:
        st = _existing_store(pid)
        ids = {c["id"] for c in _stored_circuits(st, _stored_lights(pid, st))}
        incoming = payload.get("scenes")
        if not isinstance(incoming, list) or len(incoming) > 500:
            raise HTTPException(422, "场景必须是列表")
        scenes, seen = [], set()
        for s in incoming:
            if not isinstance(s, dict) or set(s) != {"id", "name", "levels", "script"}:
                raise HTTPException(422, "场景字段无效")
            sid, name, levels, script = (s[k] for k in ("id", "name", "levels", "script"))
            if not isinstance(sid, str) or not sid or sid in seen or not isinstance(name, str) or not name.strip() or not isinstance(script, str) or not isinstance(levels, dict):
                raise HTTPException(422, "场景 id 或内容无效")
            if any(k not in ids or k == UNASSIGNED_CIRCUIT_ID or isinstance(v, bool) or
                   not isinstance(v, (int, float)) or not math.isfinite(v) or not 0 <= v <= 1
                   for k, v in levels.items()):
                raise HTTPException(422, "场景引用无效回路或亮度超界")
            seen.add(sid)
            scenes.append({"id": sid, "name": name.strip(), "levels": levels, "script": script})
        st["scenes"] = scenes
        save_store(pid, st)
        return {"scenes": scenes}


# ---------------------------------------------------------------- 图纸灯位 → 灯具配置
# 导入 DXF 后解析出的空间与灯位，直接写进项目设计（灯具配置 / 三维画布 / 报价同一份数据）。
# 坐标沿用全站口径：设计单位 = 米 × 26，原点为解析后的图纸原点（导出 DXF 叠图同一套换算）。
# 图纸没有色温：按 3000K 单色占位并标 cctPending（待核），不是猜值。
CAD_SOURCE = "cad-import"
CAD_ROOM_SOURCE = "cad-3d"
CCT_PLACEHOLDER = 3000
_CODE_LIB = Path(__file__).resolve().parents[1] / "frontend" / "src" / "data" / "code-library.json"


def _space_of(name: str) -> tuple[str, str]:
    """空间名 → (空间码, 空间库名)。精确 → 别名 → 前缀，认不出 = 其他空间 x。"""
    try:
        spaces = json.loads(_CODE_LIB.read_text(encoding="utf-8")).get("spaces") or []
    except Exception:
        spaces = []
    nm = (name or "").strip()
    for match in (lambda s: s["name"] == nm,
                  lambda s: nm in (s.get("aliases") or []),
                  lambda s: nm.startswith(s["name"]),
                  lambda s: any(nm.startswith(a) for a in (s.get("aliases") or []))):
        hit = next((s for s in spaces if nm and match(s)), None)
        if hit:
            return hit["code"], hit["name"]
    return "x", "其他空间"


def _cad_rooms(st: dict, net: float) -> list[dict]:
    names = st.get("room_names") or {}
    rooms = []
    for r in (st.get("parsed") or {}).get("rooms") or []:
        b = [float(v) for v in r["bbox"]]
        name = names.get(r["id"]) or r.get("name") or "未命名空间"
        code, lib_name = _space_of(name)
        x, y = b[0] * 26, b[1] * 26
        w, h = max(1.0, (b[2] - b[0]) * 26), max(1.0, (b[3] - b[1]) * 26)
        points = [{"x": round(float(p[0]) * 26, 2), "y": round(float(p[1]) * 26, 2)}
                  for p in (r.get("poly") or [])]
        if len(points) < 3:
            points = [{"x": round(x, 2), "y": round(y, 2)}, {"x": round(x + w, 2), "y": round(y, 2)},
                      {"x": round(x + w, 2), "y": round(y + h, 2)}, {"x": round(x, 2), "y": round(y + h, 2)}]
        rooms.append({
            "id": "cad3d-" + str(r["id"]), "name": name, "type": lib_name, "spaceCode": code,
            "floor": 1, "x": round(x, 2), "y": round(y, 2), "width": round(w, 2), "height": round(h, 2),
            "points": points,
            "area": float(r.get("area") or 0), "heightM": net, "color": "#e6e3d8",
            "source": CAD_ROOM_SOURCE, "cadRoomId": r["id"],
            "notes": "来自 DXF 空间名；边界取外接矩形，需人工核对",
        })
    return rooms


def _freeze_preview_space(pid: str, st: dict, reviewer=None, semantic_payload=None) -> tuple[int, bool]:
    """拍板7：把「预览里看到的那套空间」固化成设计空间并冻结。

    返回 (空间数, 是否本来就已确认)。设计里已经有非自动来源的房间（＝「手动修改」画过）
    时，冻结的是那套；否则用预览（图纸解析）那套落成设计房间再冻结。
    """
    from .app import connect, get, editable, commit, confirm_space_now, validate_design
    with connect() as con:
        con.execute("BEGIN IMMEDIATE")
        p = get(con, pid)
        editable(p)
        d = p["design"]
        semantic_changed = False
        if semantic_payload and "furniture" in d and "furn_extra" in semantic_payload:
            from .task_geometry import inside
            old = {f["id"]: f for f in d["furniture"]}
            rows = []
            for item in st.get("furn_extra") or []:
                prior = old.get(item["id"], {})
                x, y = item["x"]*26, item["z"]*26
                width_m, depth_m = item["w"], item["d"]
                poly = _furn_poly_geom(prior)
                if poly:                       # 画过轮廓的件：位置/宽深一律按轮廓外接框算
                    x, y, width_m, depth_m = poly
                room = next((r for r in d["rooms"] if inside({**r, "w": r["width"], "h": r["height"]}, x, y)), None)
                height = prior.get("heightM") or DL.FURN_H[item["kind"]]
                row = {**prior, "id": item["id"], "kind": item["kind"], "x": x, "y": y,
                       "widthM": width_m, "depthM": depth_m, "heightM": height,
                       "rotation": (-item.get("rot", 0))%360, "floor": room.get("floor", 1) if room else prior.get("floor", 1),
                       "roomId": room["id"] if room else "", "source": prior.get("source", "manual")}
                row.pop("width", None); row.pop("height", None)   # 空间口径的字段不留在家具行上
                rows.append(row)
            d["furniture"] = rows
            semantic_changed = True
        if semantic_payload:
            names = semantic_payload.get("room_names") or {}
            for room in d["rooms"]:
                name = names.get(room["id"]) or names.get(room.get("cadRoomId"))
                if name and room["name"] != name:
                    room["name"] = str(name).strip()[:100]
                    semantic_changed = True
        if (d.get("spaceDefinition") or {}).get("status") == "confirmed":
            if semantic_changed:
                validate_design(d, p)
                commit(con, p, "空间与家具调整", "保存空间名称和家具尺寸、朝向", True)
            return len(d.get("rooms") or []), True
        own = [r for r in (d.get("rooms") or []) if r.get("source") not in (CAD_ROOM_SOURCE, "cad")]
        if not own and (d.get("spaceDefinition") or {}).get("status") != "previewing":
            _, net = _ceilings(st, {"ceiling": p.get("ceiling"), "ceilingNet": p.get("ceilingNet")})
            own = _cad_rooms(st, net)
            for r in own:
                # 「预览所见即确认」：这批房间从此就是设计空间，不再是可随手清掉的自动草稿
                # （source 仍写 cad-3d 的话，sync_design 会把它们当自动房间剔掉 → 变「没有空间」）。
                r["source"] = "cad-confirmed"
                r["notes"] = "三维预览确认过的空间（来自图纸解析，边界为外接矩形）"
                r.pop("cadRoomId", None)
            d["rooms"] = own
        if not own:
            raise HTTPException(422, "图纸没有识别到空间，无法确认；请先在「底图与空间」页手绘空间")
        n = confirm_space_now(p, reviewer or "设计师")
        commit(con, p, "确认空间（三维预览）",
               f"预览所见即确认：冻结 {n} 个空间{'（手绘）' if own and own[0].get('source') not in (CAD_ROOM_SOURCE,) else '（图纸解析）'}",
               {"layout": ["空间已经人工确认"]}, status="设计中")
    return n, False


def sync_design(pid: str) -> dict:
    """把三维解析出的空间与灯位同步进项目灯具配置（幂等，可反复点）。

    - 只动 source=cad-import 的灯与 cad-3d 空间；手动布的灯、设备、情景不动。
    - 已同步过的灯按 id 只更新坐标与空间，用户改过的型号/色温/类型保留。
    - 三维页删掉的灯同步删除；重新解析图纸（灯 id 全换）= 整批替换。
    """
    from .app import connect, get, editable, validate_design, commit

    with _LIGHTS_LOCK:
        st = _existing_store(pid)
        if not st.get("parsed"):
            raise HTTPException(422, "请先生成三维图纸")
        # 拍板6（2026-10-12 本地口径「硬性不给」）：空间没确认过就不许把图纸灯位同步进设计。
        # 顺序因此固定为：导入 → 三维预览 → 确认空间 → 才同步/布灯。
        _assert_space_confirmed(pid)
        lights = _stored_lights(pid, st)
        circuits = _stored_circuits(st, lights)
        save_store(pid, st)
    ownership = {lid: c for c in circuits for lid in c["members"]}
    source = STORE / f"{pid}.source.dxf"
    with connect() as con:
        con.execute("BEGIN IMMEDIATE")
        project = get(con, pid)
        editable(project)
        _, net = _ceilings(st, {"ceiling": project.get("ceiling"), "ceilingNet": project.get("ceilingNet")})
        d = project["design"]
        confirmed = (d.get("spaceDefinition") or {}).get("status") == "confirmed"
        used_rooms = {x.get("roomId") for k in ("fixtures", "devices") for x in d.get(k) or []
                      if x.get("source") != CAD_SOURCE}
        # 图纸里有空间名就用它：未确认的「闭合区域 N」草稿（ezdxf 基础几何）且没挂灯/设备的清掉。
        cad_rooms = _cad_rooms(st, net)
        keep = []
        for r in d["rooms"]:
            if r.get("source") == CAD_ROOM_SOURCE:
                continue
            if cad_rooms and not confirmed and r.get("source") == "cad" and r["id"] not in used_rooms:
                continue
            keep.append(r)
        # §十.7 记的坑：空间确认过就**不再**把解析出的自动房间追加回去——手绘的与自动的
        # 并存必然重叠，点「确认空间」会被「存在重叠空间」422 拦下。确认后的单一数据源
        # 就是设计里的房间（十.11）。
        d["rooms"] = keep + ([] if confirmed else cad_rooms)
        if cad_rooms and not confirmed:
            # ezdxf 基础几何是另一套缩放（铺满画布），和灯位不在一个坐标系：换成三维解析的墙（米 × 26）。
            for key in ("walls", "texts", "openings"):
                d[key] = [x for x in d.get(key) or [] if x.get("source") not in ("cad", CAD_ROOM_SOURCE)]
            for i, w in enumerate((st.get("parsed") or {}).get("walls") or []):
                d["walls"].append({"id": f"cad3d-w{i}", "x": round(float(w["x0"]) * 26, 2),
                                   "y": round(float(w["z0"]) * 26, 2), "x2": round(float(w["x1"]) * 26, 2),
                                   "y2": round(float(w["z1"]) * 26, 2), "floor": 1, "source": CAD_ROOM_SOURCE})
        if not d["rooms"]:
            raise HTTPException(422, "图纸没有识别到空间，无法归属灯具")
        by_cad = {r["cadRoomId"]: r for r in cad_rooms}
        old = {f["id"]: f for f in d["fixtures"] if f.get("source") == CAD_SOURCE}
        d["fixtures"] = [f for f in d["fixtures"] if f.get("source") != CAD_SOURCE]
        codes = {f.get("code") for f in d["fixtures"]}

        def room_for(light: dict, x: float, y: float) -> dict:
            # 空间已确认过：灯位一律归到设计里那套空间（确认后的单一数据源）；没确认才用解析草稿。
            if not confirmed:
                if light.get("room") in by_cad:
                    return by_cad[light["room"]]
                named = next((r for r in cad_rooms if r["name"] == light.get("room")), None)
                if named:
                    return named
            pool = d["rooms"] if confirmed else (cad_rooms or d["rooms"])
            inside = [r for r in pool if r["x"] <= x <= r["x"] + r["width"] and r["y"] <= y <= r["y"] + r["height"]]
            if inside:
                return min(inside, key=lambda r: r["width"] * r["height"])
            return min(pool, key=lambda r: math.hypot(r["x"] + r["width"] / 2 - x, r["y"] + r["height"] / 2 - y))

        def next_code(space: str) -> str:
            n = 1
            while f"{space}qM{n:03d}" in codes:
                n += 1
            code = f"{space}qM{n:03d}"
            codes.add(code)
            return code

        added = updated = 0
        for l in lights:
            x, y = round(float(l.get("x") or 0) * 26, 2), round(float(l.get("z") or 0) * 26, 2)
            room = room_for(l, x, y)
            c = ownership.get(l["id"])
            # 图纸没写回路标注的灯：按所属空间自动分回路（与「不做智能」项目按空间分回路同口径）。
            # 否则它们一直挂在「未归属」，回路 QA 会在导出时把它们拦下——而「导入图纸 → 生成三维
            # → 交付」这条最短路径必然会踩到。人工要改名随时可以在回路列表里改。
            # 判定要与回路 QA 同口径（circuit_rules.circuit_key）：空、id 是未归属桶、
            # 或名字以「未归属 / 未分配」开头（三维里会写成「未归属·D50」这种），都算没分回路。
            name = str((c or {}).get("name") or "").strip()
            unlabeled = (not c) or c["id"] == UNASSIGNED_CIRCUIT_ID or name.startswith(("未归属", "未分配"))
            circuit = (room.get("name") or "未归属") if unlabeled else name
            prev = old.get(l["id"])
            if prev:
                prev.update({"x": x, "y": y, "roomId": room["id"], "floor": 1, "circuit": circuit,
                             "circuitId": c["id"] if c else UNASSIGNED_CIRCUIT_ID})
                if prev.get("code") in codes:
                    prev["code"] = next_code(room.get("spaceCode") or "空间")
                else:
                    codes.add(prev.get("code"))
                # 三维页上新定的色温才覆盖（灯具配置里手调过的色温不被同一个旧值反复冲掉）
                if l.get("cct") is not None and l["cct"] != prev.get("cadCct"):
                    cct = int(l["cct"])
                    prev.update({"cct": cct, "cctMin": cct, "cctMax": cct, "cadCct": cct})
                    prev.pop("cctPending", None)
                    for s in d.get("scenes") or []:
                        if prev["id"] in (s.get("states") or {}):
                            s["states"][prev["id"]]["cct"] = cct
                d["fixtures"].append(prev)
                updated += 1
                continue
            pending = l.get("cct") is None
            cct = CCT_PLACEHOLDER if pending else int(l["cct"])
            label = str(l.get("code") or "").strip()
            control = {"无": "开关控制", "无线": "蓝牙 Mesh"}.get(project.get("smart"), "开关控制")
            fx = {
                "id": l["id"], "code": next_code(room.get("spaceCode") or "空间"),
                "name": l.get("type") or "筒射灯", "type": l.get("type") or "射灯",
                "model": l.get("product_id") or label, "brand": "待选型",
                "roomId": room["id"], "floor": 1, "x": x, "y": y,
                "space": room.get("type") or "其他空间", "position": "其他位置", "role": "M",
                "installHeight": net, "power": 12, "brightnessMax": 100,
                "cctMin": cct, "cctMax": cct, "cct": cct, "colorMode": "单色", "tunable": False,
                # 与前端口径一致：开闭＝不可调光（否则灯具页显示「可调光」，DALI 地址与造价也会被多算）。
                "dimmable": control != "开关控制", "quote": True, "price": 0, "priceVerified": False,
                # 控制方式只用光律现在的词表（开闭＝开关控制 / 调光＝DALI）；早先写死 "KNX"
                # 不是合法值，会让灯具配置页显示「旧值，请重选」，并与 DALI 灯同回路时触发
                # 导出拦截「混用调光方式：DALI、KNX」。不猜调光：没有调光依据的灯按开闭落。
                "control": control,
                "circuit": circuit, "circuitId": c["id"] if c else UNASSIGNED_CIRCUIT_ID,
                "length": 1, "powerSupply": "", "controller": "", "stripPath": [],
                "source": CAD_SOURCE, "cadLabel": label, "cadCct": l.get("cct"),
                "notes": "图纸导入" + (f"（图纸标注 {label}）" if label else "") +
                         "；类型/型号待核" + ("；色温待核（3000K 占位）" if pending else ""),
                **({"cctPending": True} if pending else {}),
            }
            d["fixtures"].append(fx)
            for s in d.get("scenes") or []:
                s.setdefault("states", {})[fx["id"]] = {"on": True, "brightness": 80, "cct": cct}
            added += 1
        live = {f["id"] for f in d["fixtures"]}
        removed = len(set(old) - live)
        for s in d.get("scenes") or []:
            s["states"] = {k: v for k, v in (s.get("states") or {}).items() if k in live}
        if source.is_file():
            d["source3dHash"] = hashlib.sha256(source.read_bytes()).hexdigest()
            d["source3dGeneration"] = st.get("uploaded_at") or ""
        validate_design(d, project)
        project["design"] = d
        commit(con, project, "同步图纸灯位",
               f"空间 {len(d['rooms'])} 个（{'已确认，按设计空间' if confirmed else '图纸解析草稿'}）；"
               f"灯具新增 {added}、更新 {updated}、移除 {removed}", True)
    return {"ok": True, "rooms": len(cad_rooms), "lights": len(lights), "added": added,
            "updated": updated, "removed": removed, "revision": project["revision"]}


@router.post("/{pid}/sync-design")
def sync_design_route(pid: str):
    return sync_design(pid)


@router.get("/projects")
def projects():
    """给页面用的项目列表（读光律自己的 projects 表）；顺手保证产品库别过期"""
    try:
        PR.ensure_synced(str(DB))          # 超 12 小时才真同步，其余时候是空跑
    except Exception:
        pass
    return _projects()


@router.get("/products")
def products_list(scheme: str = ""):
    items = list(_products_map(scheme or None).values())
    return {"count": len(items), "items": items}


@router.post("/products/sync")
def products_sync():
    """产品库同步：源=随源码分发的产品资料，只进零售价"""
    try:
        return PR.sync(str(DB))
    except Exception as e:
        raise HTTPException(500, f"产品库同步失败：{e}")


def _ceilings(st: dict, proj: dict) -> tuple[float, float]:
    """层高优先级：三维页上手动改过的（store.ceiling_user）→ 建档时填的 → 兜底。

    ⚠️ store 里那个 2.9/2.65 是历史遗留的默认值，不是用户填的，不能盖住建档值。
    """
    ceil = (_norm_h(st.get("ceiling")) if st.get("ceiling_user") else None) \
        or _norm_h(proj.get("ceiling")) or _norm_h(st.get("ceiling")) or 3.0
    net = (_norm_h(st.get("ceiling_net")) if st.get("ceiling_user") else None) \
        or _norm_h(proj.get("ceilingNet")) or _norm_h(st.get("ceiling_net")) \
        or ceil
    return ceil, net


def _project_files(pid: str) -> list[dict]:
    """项目里的文件清单（底图摆放要靠它拿 previewBox）。"""
    con = sqlite3.connect(DB)
    try:
        row = con.execute("SELECT doc FROM projects WHERE id=?", (pid,)).fetchone()
        return list((json.loads(row[0]) or {}).get("files") or []) if row else []
    except Exception:
        return []
    finally:
        con.close()


def plan_background(pid: str) -> dict | None:
    """DXF 底图在设计坐标（单位＝三维米 × 26）里该摆的位置。

    底图 PNG 是按**图纸原始坐标**（一般 mm）渲的，而空间边界用的是三维那套「米」坐标。
    不换算就直接往画布上铺，边界跟图纸对不上——实测 2026-10-14「我怎么确认空间范围是否正确呢」。
    换算参数取解析时记下的 source（source_scale / source_base_xy / source_y_flip）。
    """
    st = load_store(pid)
    src = (st.get("parsed") or {}).get("source") or {}
    base = list(src.get("source_base_xy") or [])
    try:
        scale = float(src.get("source_scale") or 0)
    except Exception:
        scale = 0.0
    if len(base) != 2 or scale <= 0:
        return None
    f = next((x for x in _project_files(pid)
              if str(x.get("type", "")).upper() == "DXF"
              or str(x.get("name", "")).lower().endswith(".dxf")), None)
    box = (f or {}).get("previewBox") or {}
    from .dxf_preview import MAPPING_VERSION, apartment_bbox
    if f and (box.get("mappingVersion") != MAPPING_VERSION
              or box.get("cropBox") != apartment_bbox(st.get("parsed"))):
        # Existing drawings work without re-uploading; regenerate only cached image metadata.
        from .app import _ensure_dxf_preview
        _ensure_dxf_preview(pid, f)
        f = next((x for x in _project_files(pid) if x.get("id") == f["id"]), f)
        box = f.get("previewBox") or {}
    if not f or not all(k in box for k in ("minX", "minY", "maxX", "maxY", "pixelScale")):
        return None
    u = DESIGN_UNITS_PER_M * scale
    # PNG padding and integer pixel rounding are part of its world-space rectangle.
    pixel_unit = u / float(box["pixelScale"])
    pad = float(box.get("margin", 0)) * pixel_unit
    # 图纸 y 向上、画布 y 向下：渲图时翻过，这里同口径。
    top = (base[1] - box["maxY"]) if src.get("source_y_flip", True) else (box["minY"] - base[1])
    return {
        "url": f"/api/projects/{pid}/files/{f['id']}?preview=true",
        "x": (box["minX"] - base[0]) * u - pad,
        "y": top * u - pad,
        "w": float(box["width"]) * pixel_unit,
        "h": float(box["height"]) * pixel_unit,
    }


@router.get("/{pid}")
def summary(pid: str):
    st = load_store(pid)
    proj = next((p for p in _projects() if p["pid"] == pid), {})
    parsed = st.get("parsed") or {}
    ceil, net = _ceilings(st, proj)
    # 图纸体检：解析错了不该等用户在三维里自己发现（三轮全是这个毛病）
    health = None
    if parsed:
        health = DL.drawing_health(parsed, ceiling_from_archive=bool(_norm_h(proj.get("ceiling"))),
                                  ceil=ceil, net=net)
    parse_stale = bool(parsed) and (parsed.get("parser_version") or "") != DL.PARSER_VERSION
    project = _project_doc(pid)
    geometry = design_geometry(project)
    status = (project.get("design") or {}).get("spaceDefinition", {}).get("status")
    use_design = status in ("confirmed", "previewing") or (status == "draft" and any(
        r.get("source") not in ("cad", CAD_ROOM_SOURCE) for r in project.get("design", {}).get("rooms") or []))
    return {
        "pid": pid, "name": proj.get("name", ""), "code": proj.get("code", ""),
        "mode": proj.get("mode", "2D"),
        "health": health, "parser_version": DL.PARSER_VERSION, "parse_stale": parse_stale,
        "parsed_version": (parsed or {}).get("parser_version") or "",
        "has3d": bool(parsed) or bool(geometry["rooms"]),
        "file": st.get("file"), "uploaded_at": st.get("uploaded_at"),
        "stats": st.get("stats") or {}, "warn": st.get("warn") or [],
        "ceiling": ceil, "ceiling_net": net,
        "room_names": st.get("room_names") or {}, "scripts": st.get("scripts") or {},
        "rooms": geometry["rooms"] if use_design else [{"id": r["id"], "area": r["area"], "bbox": r["bbox"],
                   "name": (st.get("room_names") or {}).get(r["id"], r["name"])}
                  for r in parsed.get("rooms", [])],
        "unassigned": parsed.get("unassigned") or [],
        # 家具与房型都是「识别出来可能不对」的东西：这里给全，前端逐条改（语义调整）。
        "furniture": [{**f, "extra": True} for f in _engine_view(pid, st, parsed, {"ceiling": ceil, "ceiling_net": net})["furniture"]] if "furniture" in project.get("design", {}) else DL.furniture_of(parsed, st.get("furn_kinds"), st.get("furn_rots"), net,
                                     st.get("furn_sizes"), st.get("furn_hidden"),
                                     st.get("furn_extra")) if parsed else [],
        "furn_kinds": {} if "furniture" in project.get("design", {}) else st.get("furn_kinds") or {},
        "furn_rots": {} if "furniture" in project.get("design", {}) else st.get("furn_rots") or {},
        "furn_sizes": {} if "furniture" in project.get("design", {}) else st.get("furn_sizes") or {},
        "furn_hidden": [] if "furniture" in project.get("design", {}) else st.get("furn_hidden") or [],
        "furn_extra": st.get("furn_extra") or [],
        "furn_kind_options": list(DL.FURN_KINDS),
        "furn_kind_groups": [{"label": g, "kinds": list(ks)} for g, ks in DL.FURN_GROUPS],
        # 「确认空间范围」要对着图纸看：底图在哪、多大，这里一并给前端（实测 2026-10-14）
        "plan_background": plan_background(pid),
        "job": get_job(pid),
    }


@router.get("/{pid}/data.json")
def data_json(pid: str, ceiling: float = 0, ceiling_net: float = 0):
    st = load_store(pid)
    if not st.get("parsed") and not design_geometry(_project_doc(pid))["rooms"]:
        return {"error": "这个项目还没有图纸数据：先在顶部选 DXF 上传"}
    parsed = json.loads(json.dumps(st.get("parsed") or {}, ensure_ascii=False))
    names = st.get("room_names") or {}
    for r in parsed.get("rooms", []):
        if names.get(r["id"]):
            r["name"] = names[r["id"]]
    proj = next((p for p in _projects() if p["pid"] == pid), {})
    # 层高：三维页上手动改过的 → 建档时填的 → 兜底（与 summary 同一口径）
    st_ceil, st_net = _ceilings(st, proj)
    ceil = ceiling or st_ceil
    net = ceiling_net or st_net
    return _engine_view(pid, st, parsed, {
        "name": (proj.get("name") or pid) + (" · " + proj["code"] if proj.get("code") else ""),
        "ceiling": ceil, "ceiling_net": net,
        "products": _products_map(),
        "scripts": st.get("scripts") or {},
        "furn_kinds": st.get("furn_kinds") or {},
        "furn_rots": st.get("furn_rots") or {},
        "furn_sizes": st.get("furn_sizes") or {},
        "furn_hidden": st.get("furn_hidden") or [],
        "furn_extra": st.get("furn_extra") or [],
    })


@router.get("/{pid}/ueyi-scene.json")
def ueyi_scene(pid: str, floor: int = 1, height: float = 0, ceiling_net: float = 0):
    """给「优邑珺和」渲染内核喂的场景数据（`window.__SCENE__` 的结构）。

    同一个 `_engine_view()`，只换一层皮：内核只认这份 JSON，我们不改它一行代码。
    """
    from . import ueyi_scene as US
    st = load_store(pid)
    if not st.get("parsed") and not design_geometry(_project_doc(pid))["rooms"]:
        return {"error": "这个项目还没有图纸数据：先在顶部选 DXF 上传"}
    parsed = json.loads(json.dumps(st.get("parsed") or {}, ensure_ascii=False))
    names = st.get("room_names") or {}
    for r in parsed.get("rooms", []):
        if names.get(r["id"]):
            r["name"] = names[r["id"]]
    proj = next((p for p in _projects() if p["pid"] == pid), {})
    st_ceil, st_net = _ceilings(st, proj)
    ceil = height or st_ceil
    net = ceiling_net or st_net or ceil
    if height:
        net = height
    view = _engine_view(pid, st, parsed, {
        "name": (proj.get("name") or pid) + (" · " + proj["code"] if proj.get("code") else ""),
        "ceiling": ceil, "ceiling_net": net,
        "products": _products_map(),
        "scripts": st.get("scripts") or {},
        "furn_kinds": st.get("furn_kinds") or {},
        "furn_rots": st.get("furn_rots") or {},
        "furn_sizes": st.get("furn_sizes") or {},
        "furn_hidden": st.get("furn_hidden") or [],
        "furn_extra": st.get("furn_extra") or [],
    })
    return US.build(view, floor=floor)


@router.post("/{pid}/generate")
async def generate(pid: str, dxf: UploadFile | None = File(None), file_id: str = Form(""),
                   *, sync_to_project: bool = True):
    """生成三维模型：图纸二选一，然后后台跑、前端轮询 `/{pid}/job` 看进度。

    - `dxf=`：直接传一张 DXF（建项目时/在三维空间页重传）
    - `file_id=`：用项目里已经上传的那张图纸，不重复传（29MB 的图纸省一次上传）
    """
    name = ""
    if dxf is not None and (dxf.filename or ""):
        name = dxf.filename or "drawing.dxf"
        if not name.lower().endswith(".dxf"):
            raise HTTPException(400, "三维模型只吃 DXF（DWG 请先在 CAD 里另存为 DXF）")
        blob = await dxf.read()
        if len(blob) > MAX_MB * 1024 * 1024:
            raise HTTPException(400, f"文件超过 {MAX_MB}MB")
        STORE.mkdir(parents=True, exist_ok=True)
        (STORE / f"{pid}.source.dxf").write_bytes(blob)
    elif file_id:
        proj = _project_doc(pid)
        f = next((x for x in (proj.get("files") or []) if x.get("id") == file_id), None)
        if not f:
            raise HTTPException(400, "项目里找不到这张图纸")
        if str(f.get("type", "")).upper() != "DXF" and not str(f.get("name", "")).lower().endswith(".dxf"):
            raise HTTPException(400, "三维模型只吃 DXF；这张图纸不是 DXF")
        src_path = UPLOADS / pid / str(f.get("path") or "")
        if not src_path.is_file():
            raise HTTPException(400, "图纸文件不在磁盘上，请重新上传")
        STORE.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src_path, STORE / f"{pid}.source.dxf")
        name = str(f.get("name") or "drawing.dxf")
    else:
        raise HTTPException(400, "请选择要建模的 DXF 图纸")
    if get_job(pid).get("state") == "running":
        raise HTTPException(409, "这个项目正在生成三维模型，稍等一下")
    threading.Thread(target=_generate_worker, args=(pid, STORE / f"{pid}.source.dxf", name, sync_to_project),
                     daemon=True).start()
    return {"ok": True, "state": "running", "file": name}


@router.post("/{pid}/regenerate")
def regenerate(pid: str):
    """按**当前解析器**重新解析这个项目已有的图纸（不用再传一次 DXF）。

    解析逻辑升级后老项目不会自己变新——三维页据此提示「解析已过期」，用户点一下就走这里。
    """
    src_path = STORE / f"{pid}.source.dxf"
    if not src_path.is_file():
        raise HTTPException(400, "这个项目还没有图纸，请先上传 DXF 生成三维")
    if get_job(pid).get("state") == "running":
        raise HTTPException(409, "这个项目正在生成三维模型，稍等一下")
    name = load_store(pid).get("file") or src_path.name
    threading.Thread(target=_generate_worker, args=(pid, src_path, name), daemon=True).start()
    return {"ok": True, "state": "running", "file": name, "parser_version": DL.PARSER_VERSION}


@router.get("/{pid}/job")
def job(pid: str):
    """生成进度：state = idle / running / done / error，error 里是失败原因原文。"""
    return get_job(pid)


@router.post("/{pid}/confirm")
def confirm(pid: str, payload: dict = Body(default_factory=dict)):
    st = load_store(pid)
    if not st.get("parsed") and not design_geometry(_project_doc(pid))["rooms"]:
        raise HTTPException(400, "这个项目还没有图纸数据")
    if "room_names" in payload:
        st["room_names"] = {k: v for k, v in (payload.get("room_names") or {}).items() if v}
    if "scripts" in payload:
        st["scripts"] = {k: v for k, v in (payload.get("scripts") or {}).items() if v}
    st.setdefault("room_names", {})
    st.setdefault("scripts", {})
    # 层高只有在这里（三维页手动保存过）才落到 store，并打上「是用户填的」标记：
    # 建档时填的层高要能生效，不能被生成时写的默认值盖住。
    c_in = str(payload.get("ceiling") or "").strip()
    n_in = str(payload.get("ceiling_net") or "").strip()
    if c_in or n_in:
        st["ceiling_user"] = True
        st["ceiling"] = _norm_h(c_in, st.get("ceiling") or 2.9)
        st["ceiling_net"] = _norm_h(n_in, st.get("ceiling_net")
                                   or round(max(2.1, st["ceiling"] - 0.25), 2))
    # 家具类型逐件改（键 = 家具序号，来自解析结果），空值＝清掉覆盖、回到自动识别。
    if "furn_kinds" in payload:
        st["furn_kinds"] = {str(k): str(v) for k, v in (payload.get("furn_kinds") or {}).items()
                            if str(v) in DL.FURN_H}
    # 家具朝向逐件改（度，0/90/180/270）：空值＝回到「自动贴墙」。
    if "furn_rots" in payload:
        rots = {}
        for k, v in (payload.get("furn_rots") or {}).items():
            try:
                rots[str(k)] = int(round(float(v))) % 360
            except (TypeError, ValueError):
                continue
        st["furn_rots"] = rots
    # 逐件手填的宽深（米）：默认跟图纸，填了就以手填的为准；清空＝回到图纸尺寸。
    if "furn_sizes" in payload:
        sizes = {}
        for k, v in (payload.get("furn_sizes") or {}).items():
            try:
                w = float((v or {}).get("w") or 0)
                d = float((v or {}).get("d") or 0)
            except (TypeError, ValueError, AttributeError):
                continue
            if 12 >= w > 0.3 and 12 >= d > 0.3:
                sizes[str(k)] = {"w": round(w, 3), "d": round(d, 3)}
        st["furn_sizes"] = sizes
    # 删掉的家具（图纸识别错的：门弧、梁、楼梯那些）
    if "furn_hidden" in payload:
        st["furn_hidden"] = sorted({str(x) for x in (payload.get("furn_hidden") or [])
                                    if re.fullmatch(r"\d+", str(x))}, key=int)
    # 手动添加的家具（坐标与尺寸都是米，与图纸识别的同一坐标系）
    if "furn_extra" in payload:
        extra = []
        canonical = "furniture" in _project_doc(pid).get("design", {})
        for e in (payload.get("furn_extra") or [])[:2000 if canonical else 60]:
            if not isinstance(e, dict) or str(e.get("kind") or "") not in DL.FURN_H:
                continue
            try:
                x, z = float(e.get("x")), float(e.get("z"))
                w, d = float(e.get("w") or 0.6), float(e.get("d") or 0.6)
            except (TypeError, ValueError):
                continue
            minimum, maximum = (.05, 20) if canonical else (.3, 12)
            if not (-500 <= x <= 500 and -500 <= z <= 500 and minimum <= w <= maximum and minimum <= d <= maximum):
                continue
            item = {"id": str(e.get("id") or os.urandom(4).hex()), "kind": str(e["kind"]),
                    "x": round(x, 3), "z": round(z, 3), "w": round(w, 3), "d": round(d, 3)}
            try:
                item["rot"] = int(round(float(e.get("rot") or 0))) % 360
            except (TypeError, ValueError):
                pass
            extra.append(item)
        st["furn_extra"] = extra
    save_store(pid, st)
    # 拍板7（2026-10-12 本地口径「就按这个执行」）：预览所见即确认——三维预览里点确认，就把
    # 预览里看到的这套空间固化成 design.rooms 并冻结（spaceDefinition=confirmed）。
    # 已经手绘改过空间的项目（「手动修改」那条路），冻结的是手绘那套，不是解析草稿。
    # 层高键兜底：生成时不写默认层高（建档填的不能被盖），所以没传 ceiling 的老 store
    # 下面读 st["ceiling"] 会 KeyError —— 这里补上与建档默认一致的值。
    st.setdefault("ceiling", 2.9)
    st.setdefault("ceiling_net", round(max(2.1, st["ceiling"] - 0.25), 2))
    try:
        frozen, already = _freeze_preview_space(pid, st, payload.get("reviewer"), payload)
    except HTTPException as e:
        # 三维 store 可以先于项目存在（只读三维页 / 冒烟脚本），已确认的项目也允许重复点：
        # 这两种都不是错，不挡三维页自己的「确认」；真正的口径冲突（重叠 422 等）照旧抛出去。
        if e.status_code not in (404, 409):
            raise
        frozen, already = len((st.get("parsed") or {}).get("rooms") or []), e.status_code == 409
    return {"ok": True, "ceiling": st["ceiling"], "ceiling_net": st["ceiling_net"],
            "room_names": st["room_names"], "spaceConfirmed": True,
            "alreadyConfirmed": already, "rooms": frozen}


@router.post("/{pid}/preview-to-design")
def preview_to_design(pid: str):
    """把「预览里看到的那套空间」落成**可编辑**的设计空间（不冻结）。

    2026-10-12 本地口径：导入图纸后的这一界面上，预览与修改在同一处——
    改名字、拖边界要能立刻在预览里看到，所以先把解析/预览的房间写成 design.rooms
    （source=cad-preview，尚未确认），后面的编辑都作用在它上面；
    「确认」仍走 /{pid}/confirm（预览所见即确认，把它冻结）。
    已经是 confirmed 的项目不动。
    """
    from .app import connect, get, editable, validate_design, commit
    st = load_store(pid)
    with connect() as con:
        con.execute("BEGIN IMMEDIATE")
        p = get(con, pid)
        editable(p)
        d = p["design"]
        if not st.get("parsed"):
            # 图片/PDF 已识别的空间也必须进入三维预览，不能只让 DXF 有 previewing 状态。
            if (d.get("spaceDefinition") or {}).get("status") != "confirmed" and design_geometry(p)["rooms"]:
                current = d.get("spaceDefinition") or {}
                d["spaceDefinition"] = {**current, "status": "previewing",
                                        "workflowStep": current.get("workflowStep") if current.get("workflowStep") in ("spaces", "openings", "furniture") else "review"}
                validate_design(d, p)
                commit(con, p, "空间预览", "预览已识别的设计空间，待确认", True)
            return {"ok": True, "confirmed": (d.get("spaceDefinition") or {}).get("status") == "confirmed",
                    "rooms": len(d.get("rooms") or []), "revision": p["revision"]}
        if (d.get("spaceDefinition") or {}).get("status") == "confirmed":
            return {"ok": True, "confirmed": True, "rooms": len(d.get("rooms") or [])}
        if ((d.get("spaceDefinition") or {}).get("status") == "previewing"
                and (d.get("spaceDefinition") or {}).get("previewSourceUploadedAt") == st.get("uploaded_at")):
            return {"ok": True, "confirmed": False, "rooms": len(d.get("rooms") or []), "revision": p["revision"]}
        _, net = _ceilings(st, {"ceiling": p.get("ceiling"), "ceilingNet": p.get("ceilingNet")})
        rooms = _cad_rooms(st, net)
        for r in rooms:
            r["source"] = "cad-preview"
            r["notes"] = "图纸解析出的空间草稿：名字与边界都可改，确认后冻结"
            r.pop("cadRoomId", None)
        if not rooms:
            raise HTTPException(422, "图纸没有识别到空间；请用「新建空间」手绘后再确认")
        d["rooms"] = rooms
        d["spaceDefinition"] = {
            **(d.get("spaceDefinition") or {}),
            "status": "previewing",
            "previewedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
            "previewSourceUploadedAt": st.get("uploaded_at"),
            "workflowStep": "review", "roomsConfirmedAt": "", "openingsConfirmedAt": "",
        }
        validate_design(d, p)
        commit(con, p, "空间预览", f"图纸解析出 {len(rooms)} 个空间，待确认（可改名 / 改边界）", True)
    return {"ok": True, "confirmed": False, "rooms": len(rooms), "revision": p["revision"]}


@router.get("/{pid}/quote")
def quote(pid: str, scheme: str = ""):
    """一套报价：按方案类型出（总线=KNX / 无线=飞利浦 / 开闭·缓亮缓灭=普通灯具），只出零售价"""
    st = load_store(pid)
    project = _project_doc(pid)
    approved = ([f for f in project.get("design", {}).get("fixtures", [])
                 if f.get("source") == "outsourcing-approved"]
                if project.get("outsourcingReview") else [])
    if not st.get("parsed") and not approved:
        raise HTTPException(400, "这个项目还没有图纸数据")
    default_scheme = {"无线": "无线", "KNX": "总线", "无": "开闭"}.get(project.get("smart"), "缓亮缓灭")
    scheme = default_scheme if approved else (scheme if scheme in SCHEMES else default_scheme)
    prods = _products_map(scheme)
    agg, order = {}, []
    # §十.11 第 1 项：报价以**设计里的灯具**为准（布灯画布是唯一编辑面）；图纸解析只在
    # 设计还没有灯时兜底：直接读图纸解析结果。
    design_lamps = [f for f in project.get("design", {}).get("fixtures", [])
                    if f.get("type") != "灯带"]
    from_design = bool(approved) or bool(design_lamps)
    lamps = ([f for f in approved if f.get("type") != "灯带"] if approved
             else (design_lamps or st["parsed"]["lamps"]))
    for lp in lamps:
        # After approval, quote the reviewed fixtures, never the unconfirmed
        # raw DXF lamp count. Unknown models remain explicit missing products.
        code = (lp.get("model") or lp.get("code") or "") if from_design else (lp.get("code") or "")
        if code not in agg:
            agg[code] = 0
            order.append(code)
        agg[code] += 1
    rows, missing, total = [], [], 0.0
    for code in order:
        p = prods.get(code)
        if not p:
            missing.append({"code": code, "qty": agg[code]})
            continue
        qty = agg[code]
        sub = round((p.get("price") or 0) * qty, 2)
        total += sub
        rows.append({"code": code, "name": p["name"], "watt": p.get("watt"), "cct": p.get("cct"),
                     "price": p.get("price"), "qty": qty, "unit": p.get("unit") or "个", "subtotal": sub})
    design_strips = [f for f in project.get("design", {}).get("fixtures", [])
                     if f.get("type") == "灯带" and (f.get("length") or 0)]
    strip_len = round(sum(s.get("length") or 0 for s in (
        [f for f in approved if f.get("type") == "灯带"] if approved
        else (design_strips or st["parsed"]["strips"])
    )), 2)
    strip_prod = next((p for p in prods.values() if p.get("category") == "灯带"), None)
    if strip_len and strip_prod:
        sub = round((strip_prod.get("price") or 0) * strip_len, 2)
        total += sub
        rows.append({"code": "", "name": strip_prod["name"] + "（按图纸长度）", "watt": strip_prod.get("watt"),
                     "cct": strip_prod.get("cct"), "price": strip_prod.get("price"),
                     "qty": strip_len, "unit": "米", "subtotal": sub})
    # R5：报价单是提示档，有回路问题照出，带提示原文。
    from .app import connect, get
    from . import circuit_rules
    with connect() as con:
        _, warnings = circuit_rules.export_gate(get(con, pid), "quote")
    return {"pid": pid, "scheme": scheme, "schemes": SCHEMES, "rows": rows,
            "missing": missing, "total": round(total, 2), "warnings": warnings,
            "note": "零售价口径 · 未含智能控制设备（主机、面板、网关）；出厂价不进工作台"}


# ---------------------------------------------------------------- 挂载
def register(app):
    """在 app.py 的 SPA 兜底路由之前调用；挂载必须在 include_router 之后也行（都是先注册先匹配）。

    只挂渲染引擎（three.js + 引擎脚本），工作台把画布内嵌进项目里——
    没有独立页面，所以也没有 index.html。
    """
    app.include_router(router)
    if PAGE.is_dir():
        app.mount("/lighting3d-engine", StaticFiles(directory=str(PAGE)), name="lighting3d-engine")
    # 优邑珺和渲染内核（原样搬运，见 scene3d/shell.html 顶部说明）
    scene3d = Path(__file__).resolve().parent / "scene3d"
    if scene3d.is_dir():
        app.mount("/scene3d", StaticFiles(directory=str(scene3d)), name="scene3d")
