from __future__ import annotations
import os, json, re, sqlite3, uuid, shutil, math, copy, threading, base64, subprocess, hashlib, unicodedata, logging, zlib, secrets, asyncio
from urllib.request import Request as UrlRequest, urlopen
from urllib.error import URLError, HTTPError
from pathlib import Path
from datetime import datetime, timedelta, timezone
from contextlib import asynccontextmanager
from urllib.parse import quote
from io import BytesIO
from typing import Any
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")
from fastapi import FastAPI, HTTPException, UploadFile, File, Body, Form, Request
from fastapi.exceptions import RequestValidationError
from fastapi.exception_handlers import http_exception_handler, request_validation_exception_handler
from fastapi.responses import FileResponse, Response, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool
from pydantic import BaseModel, Field
from . import auth
from PIL import Image, ImageOps
from .providers import recognition_provider, image_provider, DxfRecognitionProvider
from .seed import empty_design, sample_design
from .recognition import raster_image, semantic_plan_configured, semantic_plan_from_external, semantic_labels_from_external, should_use_semantic_vision, polygon_overlap_violations, _resolve_overlapping_rooms
from .exports import export_bytes, scene_html
from .floors import (
    above_floors,
    floor_choice_label,
    floor_label,
    levels,
    present_floors,
    safe_basements,
    shift_project_floors,
)
from . import gates as coop
from . import circuit_rules
from . import panels
from . import product_library as PL
from . import access
from . import review_scope

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")


def read_app_version() -> str:
    """Workbench version, read from the single ``VERSION`` file at the repo root.

    Bump it with ``scripts/bump_version.py`` so backend, frontend build and UI all
    report the same number.
    """
    try:
        value = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
    except OSError:
        return "0.0.0"
    return value or "0.0.0"


APP_VERSION = read_app_version()
VERSION_FILE = ROOT / "VERSION"


def workbench_history_file() -> Path:
    return DATA / "workbench-versions.json"


def workbench_history() -> list[dict]:
    """Every workbench version number this installation has run, newest last."""
    try:
        items = json.loads(workbench_history_file().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    return [x for x in items if isinstance(x, dict) and x.get("version")] if isinstance(items, list) else []


def remember_workbench_version(version: str, note: str = "") -> list[dict]:
    items = workbench_history()
    if not any(x.get("version") == version for x in items):
        items.append({"version": version, "at": now(), "note": note})
    items = items[-100:]
    try:
        target = workbench_history_file()
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(items, ensure_ascii=False, indent=1), encoding="utf-8")
    except OSError:
        pass
    return items
DATA = Path(os.getenv("DATA_DIR", str(ROOT / "data"))).resolve()
UPLOADS = DATA / "uploads" / "projects"
DB = DATA / "studio.sqlite3"
KNOWLEDGE_ROOT = Path(os.getenv("KNOWLEDGE_BASE_PATH", str(ROOT / "backend" / "local_data"))).resolve()

# 单机版：没有账号与密码，请求一律按本机用户处理。
LOCAL_USER = {"id": "local", "username": "localhost", "role": "admin",
              "disabled": False, "mustChangePassword": False}
_KNOWLEDGE_CACHE: dict[str, Any] | None = None
STATES = [
    "草稿",
    "识别中",
    "待人工确认",
    "设计中",
    "待复核",
    "已确认",
    "已冻结",
    "已导出",
    "已归档",
]
REVIEW_KEYS = coop.GATES


def now():
    return datetime.now(timezone.utc).isoformat()


def ident():
    return uuid.uuid4().hex[:16]


def connect():
    con = sqlite3.connect(DB, timeout=15)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON")
    return con


def init_db():
    UPLOADS.mkdir(parents=True, exist_ok=True)
    with connect() as c:
        c.executescript(
            """PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, doc TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS versions(id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id) ON DELETE CASCADE, version INTEGER, revision INTEGER, created_at TEXT, note TEXT, doc TEXT);
        CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id) ON DELETE CASCADE, at TEXT, action TEXT, detail TEXT);
        CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
        CREATE INDEX IF NOT EXISTS idx_versions_project ON versions(project_id, created_at);
        """
        )
        # 快照去重用的内容哈希；旧库没有这一列，补上即可，旧快照的哈希留空。
        if "doc_hash" not in {r["name"] for r in c.execute("PRAGMA table_info(versions)")}:
            c.execute("ALTER TABLE versions ADD COLUMN doc_hash TEXT")
        # 操作日志记录来源地址（谁在什么地方点的）；旧记录留空。
        if "ip" not in {r["name"] for r in c.execute("PRAGMA table_info(events)")}:
            c.execute("ALTER TABLE events ADD COLUMN ip TEXT")
        # 操作日志记录操作人；单机版恒为空，但老库升级 / 新库都要有这一列。
        if "user" not in {r["name"] for r in c.execute("PRAGMA table_info(events)")}:
            c.execute("ALTER TABLE events ADD COLUMN user TEXT")
        # 认证和权限表
        if not c.execute("SELECT 1 FROM meta WHERE key='cooperation_v1'").fetchone():
            for row in c.execute("SELECT doc FROM projects").fetchall():
                p=json.loads(row['doc'])
                snapshot(c,p,'协作升级前保留完整历史')
                coop.ensure(p);p['legacyReviews']=copy.deepcopy(p.get('reviews',{}));p['reviews']={};p['approved']=False
                if p.get('status')=='已确认':p['status']='待复核'
                commit(c,p,'升级五道人工复核','旧审批不自动转成新五道审批；设计、附件、冻结保护不变')
            c.execute("INSERT INTO meta VALUES('cooperation_v1','1')")
        if not c.execute("SELECT 1 FROM meta WHERE key='seeded'").fetchone():
            if os.getenv("SEED_DEMO", "0") == "1":
                for i, (name, client, city, area, kind, status) in enumerate(
                    [
                        (
                            "栖岸 · 自然主义私宅",
                            "林女士",
                            "杭州",
                            168,
                            "平层",
                            "设计中",
                        ),
                        ("云境 · 山居别墅", "陈先生", "苏州", 386, "别墅", "待复核"),
                        ("木白 · 城市公寓", "许女士", "上海", 126, "平层", "草稿"),
                    ]
                ):
                    p = make_project(
                        dict(
                            name=name,
                            client=client,
                            city=city,
                            area=area,
                            type=kind,
                            code=f"GL-{datetime.now().year}-{i+1:03}",
                            designer="设计工作室",
                            floors=2 if i == 1 else 1,
                        )
                    )
                    p.update(design=sample_design(i), status=status, isDemo=True)
                    save_new(c, p, "初始化示例项目", "内置演示数据，非客户真实资料")
            c.execute("INSERT INTO meta VALUES('seeded','1')")
    # 产品库：把自带产品数据写进 products 表（空表才灌）
    try:
        PL.ensure_loaded(DB)
    except Exception:
        pass


LOCAL_DATA = ROOT / "backend" / "local_data"


def sync_knowledge_index(force: bool = False):
    """本地数据索引：场景包随源码分发，不再读任何外部知识库。"""
    global _KNOWLEDGE_CACHE
    if _KNOWLEDGE_CACHE is not None and not force:
        return _KNOWLEDGE_CACHE
    package = {}
    p = LOCAL_DATA / "scene_package.json"
    if p.exists():
        try:
            package = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            package = {}
    _KNOWLEDGE_CACHE = {
        "available": False,
        "syncedAt": None,
        "channels": [],
        "products": [],
        "sceneTemplates": [],
        "scenePackage": package,
    }
    return _KNOWLEDGE_CACHE


def knowledge_index():
    return sync_knowledge_index()


def make_project(info):
    stamp = now()
    code = (
        info.get("code") or f"GL-{datetime.now().year}-{uuid.uuid4().hex[:6].upper()}"
    )
    return dict(
        id=ident(),
        code=code,
        name=info.get("name", "未命名项目"),
        client=info.get("client", ""),
        city=info.get("city", ""),
        address=info.get("address", ""),
        type=info.get("type", "平层"),
        area=info.get("area", 0),
        floors=info.get("floors", 1),
        basements=safe_basements(info.get("basements", 0), info.get("floors", 1)),
        smart=(info.get("smart") if info.get("smart") in ("无线", "KNX", "无") else "无线"),
        designer=info.get("designer", ""),  # legacy display field; channel is the canonical relation
        relationshipType=info.get("relationshipType", "direct_b2c"),
        channelId=info.get("channelId", ""),
        channelNameSnapshot=info.get("channelNameSnapshot", ""),
        channelContactSnapshot=info.get("channelContactSnapshot", ""),
        endCustomerName=info.get("endCustomerName", info.get("client", "")),
        projectOwnerId=info.get("projectOwnerId", ""),  # reserved for future project-owner workflow
        # 建模方式与层高：3D 项目的三维页要靠它们算光锥长度与光斑大小
        # 2026-10-14 修复：原为写死 "3D"，从不读入参 ⇒ 新建项目弹窗里选的 2D 被静默丢弃，
        # 所有项目都变 3D（连带 exports.py 的 3D 交付、细则 §十.20 讲的 3D 链接都跟着错）。
        mode=(info.get("mode") if info.get("mode") in ("2D", "3D") else "3D"),
        ceiling=float(info.get("ceiling") or 3),
        ceilingNet=float(info.get("ceilingNet") or 0),
        firstOrder=info.get("firstOrder", {"show": True, "reason": "待确认"}),
        requirementsBaseline={"versions": [], "currentId": None},
        notes=info.get("notes", ""),
        status="草稿",
        version=1,
        revision=1,
        createdAt=stamp,
        updatedAt=stamp,
        design=empty_design(),
        files=[],
        reviews={},
        approved=False,
        frozen=False,
        isDemo=False,
        recognition=None,
        renders=[],
        cooperation=coop.initial(),
    )


def event(c, p, action, detail=""):
    c.execute(
        "INSERT INTO events(id,project_id,at,action,detail,ip,user) VALUES(?,?,?,?,?,?,?)",
        (ident(), p["id"], now(), action, detail, access.CLIENT_IP.get() or None, auth.CURRENT_USER.get() or None),
    )


# 快照里每次保存都会变、但不代表内容变化的字段，不参与去重哈希。
SNAPSHOT_VOLATILE = ("revision", "updatedAt")


def snapshot_hash(p) -> str:
    body = {k: v for k, v in p.items() if k not in SNAPSHOT_VOLATILE}
    return hashlib.sha256(json.dumps(body, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()


def pack_snapshot(p) -> bytes:
    """New snapshots are zlib-compressed JSON stored as a BLOB."""
    return zlib.compress(json.dumps(p, ensure_ascii=False).encode("utf-8"), 6)


def unpack_snapshot(value) -> dict:
    """Read a snapshot doc: compressed BLOB (new) or plain JSON text (legacy rows, never migrated)."""
    if isinstance(value, (bytes, memoryview)):
        return json.loads(zlib.decompress(bytes(value)).decode("utf-8"))
    return json.loads(value)


def snapshot(c, p, note):
    digest = snapshot_hash(p)
    last = c.execute(
        "SELECT doc_hash FROM versions WHERE project_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1",
        (p["id"],),
    ).fetchone()
    if last and last["doc_hash"] == digest:
        # 内容与上一份快照完全相同（只是修订号/时间变了），不再多存一份。
        return False
    c.execute(
        "INSERT INTO versions(id,project_id,version,revision,created_at,note,doc,doc_hash) VALUES(?,?,?,?,?,?,?,?)",
        (
            ident(),
            p["id"],
            p["version"],
            p["revision"],
            now(),
            note,
            pack_snapshot(p),
            digest,
        ),
    )
    return True


def save_new(c, p, action, detail=""):
    try:
        c.execute(
            "INSERT INTO projects VALUES(?,?,?)",
            (p["id"], p["code"], json.dumps(p, ensure_ascii=False)),
        )
    except sqlite3.IntegrityError:
        raise HTTPException(409, "项目编号已存在，请换一个编号")
    snapshot(c, p, action)
    event(c, p, action, detail)


def get(c, pid):
    r = c.execute("SELECT doc FROM projects WHERE id=?", (pid,)).fetchone()
    if not r:
        raise HTTPException(404, "项目不存在")
    p=coop.ensure(json.loads(r["doc"]))
    # Backward-compatible migration for projects created before knowledge-base relations.
    p.setdefault("relationshipType", "direct_b2c")
    p.setdefault("channelId", "")
    p.setdefault("channelNameSnapshot", "")
    p.setdefault("channelContactSnapshot", "")
    p.setdefault("endCustomerName", p.get("client", ""))
    p.setdefault("projectOwnerId", "")
    p.setdefault("firstOrder", {"show": p.get("relationshipType") == "direct_b2c", "reason": "历史项目待人工核定"})
    p.setdefault("requirementsBaseline", {"versions": [], "currentId": None})
    # 地下室支持（旧项目没有这个字段，默认 0 = 全部地上层）。
    p["basements"] = safe_basements(p.get("basements", 0), p.get("floors", 1))
    # 智能方案：旧项目没有这个字段，默认按「无线智能」处理，保持逐灯情景不变。
    if p.get("smart") not in ("无线", "KNX", "无"):
        p["smart"] = "无线"
    # 已确认空间的老项目（现场 2026-10-17 text）：首次导入时留下的另一套缩放的 CAD 线 / 文字不再显示，
    # 只在读取时剔除；下次保存时随之落库（不单独改库）。
    d = p.get("design") or {}
    if (d.get("spaceDefinition") or {}).get("status") == "confirmed":
        drop_stale_drawing_geometry(d)
    return p


def editable(p):
    if p["frozen"] or p["status"] == "已归档":
        raise HTTPException(409, "项目已冻结或归档，请新建版本后编辑")


def commit(c, p, action, detail="", invalidate=False, status=None):
    """invalidate：False 不动复核；True 按设计差异分项失效；
    dict{复核项: [原因]} 额外指定失效项（再叠加设计差异）；"all" 全部设计类复核失效。"""
    before=c.execute("SELECT doc FROM projects WHERE id=?",(p['id'],)).fetchone()
    before_design=json.loads(before['doc']).get('design') if before else None
    if before and before_design!=p.get('design'):
        coop.assert_design_edit(p)
        p['cooperation']['packageReviews']={}
        p['cooperation']['closure']=None
    p["revision"] += 1
    p["updatedAt"] = now()
    lost = []
    if invalidate:
        if invalidate == "all":
            reasons = {g: [action] for g in review_scope.DESIGN_GATES}
        else:
            reasons = review_scope.design_impact(before_design, p.get("design"))
            for gate, why in (invalidate.items() if isinstance(invalidate, dict) else []):
                reasons.setdefault(gate, [])
                reasons[gate] = list(why) + [x for x in reasons[gate] if x not in why]
            if reasons and "delivery" not in reasons:
                reasons["delivery"] = ["设计内容变更：" + "、".join(review_scope.LABELS[g] for g in reasons) + "相关"]
        lost = review_scope.apply(p, reasons, p["updatedAt"])
        p["approved"] = all(k in p["reviews"] for k in REVIEW_KEYS) and not p.get("isDemo")
        if status:
            p["status"] = status
        elif lost:
            p["status"] = "设计中"
    elif status:
        p["status"] = status
    c.execute(
        "UPDATE projects SET doc=? WHERE id=?",
        (json.dumps(p, ensure_ascii=False), p["id"]),
    )
    snapshot(c, p, action)
    event(c, p, action, detail)
    if lost:
        event(c, p, "复核失效", f"{action}：" + "；".join(lost))


class ProjectInput(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    client: str = Field(default="", max_length=100)
    code: str = Field(default="", max_length=80, pattern=r"^[\w\-]*$")
    city: str = Field(default="", max_length=100)
    address: str = Field(default="", max_length=500)
    type: str = "平层"
    area: float = Field(default=0, ge=0, le=1000000)
    floors: int = Field(default=1, ge=1, le=200)
    # 地下层数：地下层不写负数，最下面的这几层就是地下层（B1、B2…）。
    basements: int = Field(default=0, ge=0, le=20)
    # 智能方案：无线（飞利浦，2026-10-11 起；原 JOCO 停用）/ KNX 总线 / 无（灯具按回路开闭）。
    smart: str = Field(default="无线", pattern=r"^(无线|KNX|无)$")
    designer: str = Field(default="", max_length=100)
    relationshipType: str = Field(default="direct_b2c", pattern=r"^(direct_b2c|b2b|b2b_referral)$")
    channelId: str = Field(default="", max_length=100)
    channelNameSnapshot: str = Field(default="", max_length=160)
    channelContactSnapshot: str = Field(default="", max_length=160)
    endCustomerName: str = Field(default="", max_length=100)
    projectOwnerId: str = Field(default="", max_length=100)
    notes: str = Field(default="", max_length=5000)
    # 建模方式：2D（现状流程）/ 3D（导图纸自动出三维演示页 + 一套报价）
    mode: str = Field(default="3D", pattern=r"^(2D|3D)$")
    # 原始层高（结构层高）/ 吊顶后层高（净高），米。3D 里灯具安装高度与光斑大小都按它算：
    # 光斑半径 =（吊顶后层高 - 灯具安装高度）× tan(光束角/2)
    ceiling: float = Field(default=3, ge=0, le=20)
    ceilingNet: float = Field(default=0, ge=0, le=20)


class DesignInput(BaseModel):
    revision: int
    design: dict[str, Any]


def validate_design(d, p):
    for key in ("rooms", "fixtures", "walls", "openings", "scenes", "devices", "texts"):
        if not isinstance(d.get(key), list):
            raise HTTPException(422, f"{key} 必须是列表")
        if len(d[key]) > 5000:
            raise HTTPException(422, "对象数量超限")
        ids = [x.get("id") for x in d[key] if isinstance(x, dict)]
        if (
            len(ids) != len(d[key])
            or any(not isinstance(x, str) or not x for x in ids)
            or len(set(ids)) != len(ids)
        ):
            raise HTTPException(422, f"{key} 对象 ID 缺失或重复")

    def numeric(v, low, high, label):
        if (
            not isinstance(v, (float, int))
            or isinstance(v, bool)
            or not math.isfinite(v)
            or not low <= v <= high
        ):
            raise HTTPException(422, label + " 数值超出范围")

    room_ids = {r["id"] for r in d["rooms"]}
    if "furniture" in d:
        rows = d["furniture"]
        if not isinstance(rows, list) or len(rows) > 2000:
            raise HTTPException(422, "家具必须是列表且不能超过2000件")
        ids = [f.get("id") for f in rows if isinstance(f, dict)]
        if len(ids) != len(rows) or any(not isinstance(i, str) or not i for i in ids) or len(set(ids)) != len(ids):
            raise HTTPException(422, "家具 ID 缺失或重复")
        from .dxf_lighting import FURN_H
        for f in rows:
            if f.get("kind") not in FURN_H:
                raise HTTPException(422, "家具类型无效")
            for axis in ("x", "y"):
                numeric(f.get(axis), -10000, 10000, "家具位置")
            for key in ("widthM", "depthM", "heightM"):
                numeric(f.get(key), .05, 20, "家具尺寸")
            numeric(f.get("rotation", 0), 0, 360, "家具朝向")
            numeric(f.get("floor", 1), 1, p["floors"], "家具楼层")
            if not isinstance(f.get("floor", 1), int):
                raise HTTPException(422, "家具楼层必须为整数")
            room = next((r for r in d["rooms"] if r["id"] == f.get("roomId")), None)
            if f.get("roomId") and not room:
                raise HTTPException(422, "家具所属空间不存在")
            if room and f.get("floor", 1) != room.get("floor", 1):
                raise HTTPException(422, "家具楼层与所属空间不一致")
            # 家具边界多边形（现场 2026-10-16）：口径与空间边界点一致，坏数据不许落库。
            if f.get("points"):
                pts = f["points"]
                if not isinstance(pts, list) or len(pts) < 3:
                    raise HTTPException(422, "家具边界至少需要三个点")
                for v in pts:
                    if not isinstance(v, dict):
                        raise HTTPException(422, "家具边界点无效")
                    for axis2 in ("x", "y"):
                        numeric(v.get(axis2), -10000, 10000, "家具边界点")
    for key in ("rooms", "fixtures", "walls", "openings"):
        for obj in d[key]:
            for axis in ("x", "y"):
                numeric(obj.get(axis), -10000, 10000, axis)
            numeric(obj.get("floor", 1), 1, p["floors"], "楼层")
            if not isinstance(obj.get("floor", 1), int):
                raise HTTPException(422, "楼层必须为整数")
    for r in d["rooms"]:
        for k in ("width", "height"):
            numeric(r.get(k), 1, 10000, k)
        numeric(r.get("area", 0), 0, 1000000, "面积")
        numeric(r.get("heightM", 2.8), 0.1, 100, "层高")
        if "originalHeightM" in r:
            numeric(r["originalHeightM"], .5, 20, "原始层高")
            if r.get("heightM", 3) > r["originalHeightM"]:
                raise HTTPException(422, "完成面层高不能高于原始层高")
        if not r.get("name"):
            raise HTTPException(422, "房间名称不能为空")
        if r.get("points"):
            if len(r["points"]) < 3:
                raise HTTPException(422, "房间至少需要三个边界点")
            for v in r["points"]:
                for k in ("x", "y"):
                    numeric(v.get(k), -10000, 10000, "边界点")
    codes = set()
    for f in d["fixtures"]:
        if not f.get("code") or f["code"] in codes:
            raise HTTPException(422, "灯具编号为空或重复")
        codes.add(f["code"])
        # 删除 / 重画空间时保留灯具，显式空串表示暂未归属；非空的悬空引用仍然拒绝。
        if f.get("roomId") != "":
            if f.get("roomId") not in room_ids:
                raise HTTPException(422, "灯具必须属于有效房间")
            room = next(r for r in d["rooms"] if r["id"] == f["roomId"])
            if f.get("floor", 1) != room.get("floor", 1):
                raise HTTPException(422, "灯具楼层必须与所属房间一致")
        for k, lo, hi in [
            ("power", 0, 10000),
            ("price", 0, 10000000),
            ("brightnessMax", 0, 100),
            ("cctMin", 1000, 20000),
            ("cctMax", 1000, 20000),
            ("installHeight", 0, 100),
        ]:
            numeric(f.get(k), lo, hi, k)
        if f["cctMin"] > f["cctMax"]:
            raise HTTPException(
                422,
                "灯具 %s 的最低色温 %sK 高于最高色温 %sK"
                % (f.get("code", "?"), f["cctMin"], f["cctMax"]),
            )
        if f.get("type") == "灯带":
            numeric(f.get("length"), 0.01, 10000, "灯带长度")
            path = f.get("stripPath", [])
            if path:
                if not isinstance(path, list) or len(path) < 2:
                    raise HTTPException(422, "灯带必须至少包含两个线形路径点")
                for point in path:
                    for axis in ("x", "y"):
                        numeric(point.get(axis), -10000, 10000, "灯带路径点")
            if not f.get("powerSupply") or not f.get("controller"):
                raise HTTPException(422, "每段灯带必须填写独立电源和控制关系")
    fixtures = {f["id"]: f for f in d["fixtures"]}
    for w in d["walls"]:
        for k in ("x2", "y2"):
            numeric(w.get(k), -10000, 10000, "墙体端点")
    for opening in d["openings"]:
        if "edgeIndex" not in opening:
            continue
        from .space_geometry import room_points
        room = next((r for r in d["rooms"] if r["id"] == opening.get("roomId")), None)
        if not room or not isinstance(opening["edgeIndex"], int) or not 0 <= opening["edgeIndex"] < len(room_points(room)):
            raise HTTPException(422, "门窗须属于有效的空间边界")
        numeric(opening.get("start"), 0, 1, "洞口起点")
        numeric(opening.get("end"), 0, 1, "洞口终点")
        if opening["end"] <= opening["start"]:
            raise HTTPException(422, "洞口必须有有效宽度")
        numeric(opening.get("sillHeight", 0), 0, room.get("heightM", 3), "窗台高度")
        numeric(opening.get("heightM"), .1, room.get("heightM", 3), "洞口高度")
        if opening.get("sillHeight", 0) + opening["heightM"] > room.get("heightM", 3) + 1e-6:
            raise HTTPException(422, "门窗洞口不能超出完成面层高")
    for s in d["scenes"]:
        if not s.get("name"):
            raise HTTPException(422, "场景名称不能为空")
        numeric(s.get("fade", 0), 0, 3600, "渐变时间")
        if not isinstance(s.get("states", {}), dict):
            raise HTTPException(422, "场景状态格式不正确")
        for fid, st in s.get("states", {}).items():
            if fid not in fixtures:
                raise HTTPException(422, "场景引用了不存在的灯具")
            f = fixtures[fid]
            try:
                numeric(st.get("brightness"), 0, f.get("brightnessMax", 100), "亮度")
                numeric(st.get("cct"), f["cctMin"], f["cctMax"], "色温")
            except HTTPException as exc:
                detail = exc.detail if isinstance(exc.detail, str) else "数值超出范围"
                code = f.get("code", "?")
                name = s.get("name", "")
                lo, hi = sorted((f["cctMin"], f["cctMax"]))
                if detail.startswith("色温"):
                    detail = "灯具 %s 在情景「%s」里的色温 %sK 超出该灯具允许范围 %s-%sK" % (
                        code, name, st.get("cct"), lo, hi)
                elif detail.startswith("亮度"):
                    detail = "灯具 %s 在情景「%s」里的亮度 %s%% 超出该灯具上限 %s%%" % (
                        code, name, st.get("brightness"), f.get("brightnessMax", 100))
                else:
                    detail = "灯具 %s 在情景「%s」：%s" % (code, name, detail)
                raise HTTPException(422, detail)
            if not isinstance(st.get("on"), bool):
                raise HTTPException(422, "开关必须为布尔值")


@asynccontextmanager
async def lifespan(app):
    init_db()
    yield


app = FastAPI(
    title="GUANGLV 光律 · 灯光设计工作台",
    version=APP_VERSION,
    lifespan=lifespan,
)


@app.middleware("http")
async def _cache_headers(request, call_next):
    """缓存策略——踩过：设计师看到「三维引擎加载失败 / 白屏」，其实是**旧壳指向已删的 bundle**。

    · `/assets/*` 文件名带内容哈希 ⇒ 可以长缓存；
    · 其它一切（SPA 外壳 index.html、`/lighting3d-engine/*` 这种不带哈希的脚本）⇒ 每次校验，
      否则重建之后旧壳还会去要已经删掉的 `index-<旧hash>.js`，页面直接打不开。
    """
    resp = await call_next(request)
    path = request.url.path
    if path.startswith("/assets/"):
        resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    elif not path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-cache, must-revalidate"
    return resp


_exception_logger = logging.getLogger("uvicorn.error")  # stderr is redirected to data/service.log by the launcher.


@app.middleware("http")
async def _access_guard(request, call_next):
    """会话认证 + 高危接口（删项目/删文件/切版本/同步产品库/替换清空识别/历史恢复）只对局域网开放，外网须带管理口令。

    来源地址同时放进 CLIENT_IP，event() 落库时一起记下。判断规则见 backend/access.py。
    """
    peer = request.client.host if request.client else ""
    ip, lan = access.resolve(peer, request.headers)
    token = access.CLIENT_IP.set(ip)
    try:
        path = request.url.path
        # 单机版没有账号体系，一律按本机用户处理。
        request.state.user = LOCAL_USER

        # 原有高危接口检查
        if access.is_high_risk(request.method, request.url.path) and not lan and not access.token_ok(request.headers):
            _record_rejection(request, 403, access.DENIED_DETAIL)
            _record_denied_event(request, ip)
            return JSONResponse({"detail": access.DENIED_DETAIL, "code": "admin_required"}, status_code=403)
        return await call_next(request)
    finally:
        access.CLIENT_IP.reset(token)


def _is_outsourcer_forbidden(method: str, path: str) -> bool:
    """L1 白名单：协作账号禁止访问的路由。"""
    # GET /api/knowledge/channels - 统筹改进 2
    if method == "GET" and path == "/api/knowledge/channels":
        return True
    # POST /{pid}/reviews - 统筹改进 3：只允许 layout/lighting，禁止 pricing/delivery
    if method == "POST" and re.match(r"^/api/projects/[^/]+/reviews$", path):
        # 这里只能标记路径需要检查，实际 body 检查在路由内部做（因为中间件拿不到解析后的 body）
        # 所以这里返回 False，让请求进入路由，在路由内部再判断 review_type
        return False
    # GET /{pid}/scene - 统筹改进 4
    if method == "GET" and re.match(r"^/api/projects/[^/]+/scene$", path):
        return True
    # GET /api/projects - 协作账号只能看分配给自己的项目，这里不拦，在路由内部 L2 过滤
    # POST /api/projects - 协作账号不能创建项目
    if method == "POST" and path == "/api/projects":
        return True
    # DELETE /api/projects/{pid} - 协作账号不能删项目
    if method == "DELETE" and re.match(r"^/api/projects/[^/]+$", path):
        return True
    return False


def _record_denied_event(request: Request, ip: str) -> None:
    # 项目内的高危操作被拦下时，在该项目日志里留一条，方便事后追查。
    m = re.match(r"^/api/projects/([^/]+)", request.url.path)
    if not m:
        return
    try:
        with connect() as c:
            if c.execute("SELECT 1 FROM projects WHERE id=?", (m.group(1),)).fetchone():
                event(c, {"id": m.group(1)}, "拦截高危操作", f"{request.method} {request.url.path}（非局域网且无管理口令）")
    except Exception:
        _exception_logger.exception("record denied event failed")


def _record_rejection(request: Request, status: int, detail: object) -> None:
    # Log only the path (not its query string), and never serialize validation input.
    text = str(detail)
    if re.search(r"token|password|passwd|secret|authorization|口令|密码|密钥", text, re.I):
        text = "[redacted]"
    _exception_logger.warning(
        "request_rejected %s",
        json.dumps({
            "method": request.method,
            "path": request.url.path,
            "status": status,
            "detail": text,
            "client.host": request.client.host if request.client else None,
        }, ensure_ascii=False),
    )


@app.exception_handler(HTTPException)
async def _log_http_exception(request: Request, exc: HTTPException):
    _record_rejection(request, exc.status_code, exc.detail)
    return await http_exception_handler(request, exc)


@app.exception_handler(RequestValidationError)
async def _log_validation_exception(request: Request, exc: RequestValidationError):
    # Pydantic's errors() also contains "input"; log only location and error type.
    detail = [{"loc": error.get("loc"), "type": error.get("type")} for error in exc.errors()]
    _record_rejection(request, 422, detail)
    return await request_validation_exception_handler(request, exc)


# ==================== 认证路由 ====================


# 任务截止时间按北京时间口径：精确到分钟；留空=分配时刻+24小时
_DUE_TZ = timezone(timedelta(hours=8))


def _normalize_due_at(due_at: str) -> str:
    now = datetime.now(_DUE_TZ).replace(tzinfo=None)
    due_at = (due_at or "").strip()
    if not due_at:
        return (now + timedelta(hours=24)).strftime("%Y-%m-%dT%H:%M")
    m = re.fullmatch(r"(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?", due_at)
    try:
        if not m:
            raise ValueError
        if m.group(2):
            due = datetime.strptime(f"{m.group(1)}T{m.group(2)}", "%Y-%m-%dT%H:%M")
            due_at = due.strftime("%Y-%m-%dT%H:%M")
        else:
            due = datetime.strptime(m.group(1), "%Y-%m-%d").replace(hour=23, minute=59)
    except ValueError:
        raise HTTPException(422, "截止时间使用 YYYY-MM-DDTHH:MM（或旧格式 YYYY-MM-DD）")
    if due < now:
        raise HTTPException(422, "截止时间不能早于当前时间")
    return due_at


def _task_row(pid):
    with connect() as c:
        return c.execute("SELECT doc FROM task_flows WHERE project_id=?", (pid,)).fetchone()


# ==================== L2/L3 权限辅助函数 ====================


def _require_project_access(request: Request, pid: str, c: sqlite3.Cursor) -> dict:
    """L2: 检查协作账号是否被分配了该项目。管理员无限制。404 表示无权限或不存在。"""
    user = request.state.user
    if user["role"] != auth.ROLE_ADMIN:
        if not c.execute("SELECT 1 FROM assignments WHERE project_id=? AND user_id=?", (pid, user["id"])).fetchone():
            raise HTTPException(status_code=404, detail="项目不存在")
    return user


def _check_project_assignment(user: dict, pid: str, c: sqlite3.Cursor) -> bool:
    """L2: 检查协作账号是否被分配了该项目。管理员无限制。"""
    if user["role"] == auth.ROLE_ADMIN:
        return True
    return bool(c.execute("SELECT 1 FROM assignments WHERE project_id=? AND user_id=?", (pid, user["id"])).fetchone())


def _filter_project_sensitive_fields(project: dict, user: dict) -> dict:
    """L3: 过滤项目敏感字段。协作账号看不到客户身份与价格。"""
    if user["role"] == auth.ROLE_ADMIN:
        return project
    # 协作账号禁看字段：customerName, customerPhone, customerAddress, customerChannel, totalPrice
    filtered = copy.deepcopy(project)
    for field in ["customerName", "customerPhone", "customerAddress", "customerChannel", "totalPrice"]:
        if field in filtered:
            del filtered[field]
    return filtered


def _validate_outsourcer_write(user: dict, data: dict) -> None:
    """写入拦截：协作账号提交禁止字段时返回 422。"""
    if user["role"] == auth.ROLE_ADMIN:
        return
    forbidden = {"customerName", "customerPhone", "customerAddress", "customerChannel", "totalPrice"}
    submitted = set(data.keys()) & forbidden
    if submitted:
        raise HTTPException(status_code=422, detail=f"协作账号不能提交字段: {', '.join(submitted)}")


@app.get("/api/health")
def health():
    return dict(
        ok=True,
        version=APP_VERSION,
        storage="SQLite",
        recognitionProvider=os.getenv("RECOGNITION_PROVIDER", "local"),
        imageProvider=os.getenv("IMAGE_PROVIDER", "local"),
        effectRenderProvider=os.getenv("EFFECT_RENDER_PROVIDER", "disabled"),
        effectRenderConfigured=bool(os.getenv("EFFECT_RENDER_URL")),
        planVisionProvider=os.getenv("PLAN_VISION_PROVIDER", "disabled"),
        planVisionConfigured=semantic_plan_configured(),
        authentication="single-user",
        knowledgeBase={"root": "", "available": False, "syncedAt": None},
    )


# ==================== 检查更新 ====================

# 发布仓库；换成你自己的 fork 时改这里或设 UPDATE_REPO 环境变量。
UPDATE_REPO = os.getenv("UPDATE_REPO", "twbzpngd58-beep/guanglv-workbench").strip()
UPDATE_WEB = f"https://github.com/{UPDATE_REPO}"


def version_key(value: str) -> tuple:
    """把 1.3.10 折成可比较的元组；非数字段落按 0 处理。"""
    parts = re.findall(r"\d+", (value or "").strip().lstrip("vV"))
    return tuple(int(p) for p in parts[:4]) or (0,)


def _github_json(path: str):
    """读 GitHub 公开接口。仓库是公开的，不需要 token。"""
    request = UrlRequest(
        f"https://api.github.com/repos/{UPDATE_REPO}{path}",
        headers={"User-Agent": f"guanglv-workbench/{APP_VERSION}", "Accept": "application/vnd.github+json"},
    )
    with urlopen(request, timeout=8) as resp:
        return json.loads(resp.read().decode("utf-8", "replace"))


def _latest_tag() -> str:
    """取仓库里最大的版本号 tag；没打过 tag 时读 main 分支的 VERSION 文件。"""
    try:
        tags = _github_json("/tags")
        names = [str(t.get("name") or "") for t in tags if isinstance(t, dict)]
        names = [n for n in names if version_key(n) > (0,)]
        if names:
            return max(names, key=version_key).lstrip("vV")
    except (HTTPError, URLError, OSError, ValueError):
        pass
    payload = _github_json("/contents/VERSION")
    raw = base64.b64decode(payload.get("content") or "").decode("utf-8", "replace")
    return raw.strip().lstrip("vV")


@app.get("/api/update/check")
def update_check():
    """问 GitHub 上有没有比本机更新的发行版。

    顺序：latest release → 版本 tag → main 分支的 VERSION 文件。
    网络不通不是错误状态：把原因放进 error 字段，界面照常能用。
    """
    current = APP_VERSION
    out = {
        "current": current,
        "latest": "",
        "hasUpdate": False,
        "url": f"{UPDATE_WEB}/releases",
        "notes": "",
        "publishedAt": "",
        "source": "",
        "checkedAt": now(),
        "repo": UPDATE_REPO,
        "error": "",
    }
    if not UPDATE_REPO:
        out["error"] = "未配置更新源（UPDATE_REPO）"
        return out
    try:
        release = _github_json("/releases/latest")
        out.update(
            latest=str(release.get("tag_name") or "").strip().lstrip("vV"),
            notes=(release.get("body") or "")[:2000],
            publishedAt=release.get("published_at") or "",
            url=release.get("html_url") or out["url"],
            source="release",
        )
    except HTTPError as exc:
        if exc.code != 404:
            out["error"] = f"GitHub 返回 {exc.code}"
            return out
        try:
            out.update(latest=_latest_tag(), source="tags")
        except (HTTPError, URLError, OSError, ValueError) as err:
            out["error"] = f"读不到线上版本：{err}"
            return out
    except (URLError, OSError, ValueError, KeyError) as exc:
        out["error"] = f"连不上 GitHub：{exc}"
        return out
    if out["latest"]:
        out["hasUpdate"] = version_key(out["latest"]) > version_key(current)
    return out


DIST_INDEX = ROOT / "frontend" / "dist" / "index.html"


def current_build() -> dict:
    """Fingerprint of the served frontend bundle.

    Open pages poll this so a workbench update reloads itself instead of asking
    the designer to refresh by hand.
    """
    try:
        markup = DIST_INDEX.read_text(encoding="utf-8")
    except OSError:
        return {"buildId": "dev", "asset": ""}
    match = re.search(r"/assets/([A-Za-z0-9._-]+\.js)", markup)
    asset = match.group(1) if match else ""
    stamp = hashlib.sha1(markup.encode("utf-8")).hexdigest()[:12]
    return {"buildId": stamp, "asset": asset}


@app.get("/api/build")
def build_info():
    """Served bundle identity; the SPA compares it with its own to auto-update."""
    return {**current_build(), "version": APP_VERSION}


@app.get("/api/activity")
def activity_stub(limit: int = 20):
    """兼容旧前端：工作台动态属于已删除的经营线，这里只回空列表。

    1.0 的 dist 里还留着这次请求，没有它就整页弹「接口不存在」。
    制图器版没有动态流，恒返回 []。
    """
    return []


@app.get("/api/projects")
def projects(request: Request, q: str = "", status: str = ""):
    user = request.state.user
    with connect() as c:
        ps = [coop.ensure(json.loads(r["doc"])) for r in c.execute("SELECT doc FROM projects")]
        # L2: 协作账号只能看分配给自己的项目
        if user["role"] == auth.ROLE_OUTSOURCER:
            assigned_pids = {r["project_id"] for r in c.execute("SELECT project_id FROM assignments WHERE user_id=?", (user["id"],))}
            ps = [p for p in ps if p["id"] in assigned_pids]
    # L3: 过滤敏感字段
    ps = [_filter_project_sensitive_fields(p, user) for p in ps]
    return sorted(
        [
            p
            for p in ps
            if (
                not q
                or q.lower()
                in " ".join(
                    str(p.get(k, "")) for k in ("name", "code", "client", "city")
                ).lower()
            )
            and (not status or p["status"] == status)
        ],
        key=lambda p: p["updatedAt"],
        reverse=True,
    )


@app.post("/api/projects", status_code=201)
def create(info: ProjectInput):
    data=info.model_dump()
    data["channelId"]=""; data["channelNameSnapshot"]=""; data["channelContactSnapshot"]=""
    if not data.get("client"):
        data["client"] = data.get("endCustomerName", "")
    if int(data.get("basements") or 0) >= int(data.get("floors") or 1):
        raise HTTPException(422, "地下层数必须小于楼层数量：至少保留一层地上层")
    p = make_project(data)
    with connect() as c:
        save_new(c, p, "创建项目", f"关系类型：{p['relationshipType']}；{p['firstOrder']['reason']}")
    return p


@app.patch("/api/projects/{pid}/smart")
def update_smart(pid: str, payload: dict = Body(default={})):
    """设置智能方案：无线（飞利浦）/ KNX 总线 / 不做智能。
    不做智能＝灯具按回路开闭，情景页按回路控制（默认缓亮缓灭 1 秒）。"""
    with connect() as c:
        c.execute("BEGIN IMMEDIATE")
        p = get(c, pid)
        editable(p)
        smart = str(payload.get("smart", "")).strip()
        if smart not in ("无线", "KNX", "无"):
            raise HTTPException(422, "智能方案只能是 无线 / KNX / 无")
        if p.get("smart") == smart:
            return p
        p["smart"] = smart
        commit(c, p, "调整智能方案", f"智能方案：{smart}", {"lighting": [f"智能方案改为 {smart}（设备与控制方式变化）"], "pricing": [f"智能方案改为 {smart}（设备型号与数量变化）"]})
    return p


@app.patch("/api/projects/{pid}/levels")
def update_levels(pid: str, payload: dict = Body(default={})):
    """调整项目层数（地上/地下）。

    地下室不是负数：加地下层时已有内容整体上移，标签保持不变（原来的一层仍是 1F），
    新增的地下室在最底下，记作 B1。减少地下层时，如果那几层还有房间/灯具/图纸就不允许。
    """
    with connect() as c:
        c.execute("BEGIN IMMEDIATE")
        p = get(c, pid)
        editable(p)
        cur_floors = max(1, int(p.get("floors") or 1))
        cur_basements = safe_basements(p.get("basements", 0), cur_floors)
        try:
            new_floors = int(payload.get("floors", cur_floors))
        except (TypeError, ValueError):
            raise HTTPException(422, "楼层数量无效")
        try:
            new_basements = int(payload.get("basements", cur_basements))
        except (TypeError, ValueError):
            raise HTTPException(422, "地下层数无效")
        if not 1 <= new_floors <= 200:
            raise HTTPException(422, "楼层数量需在 1-200 之间")
        if new_basements < 0:
            raise HTTPException(422, "地下层数不能为负")
        if new_basements > new_floors - 1:
            raise HTTPException(422, "地下层数必须小于楼层数量：至少保留一层地上层")
        if new_floors == cur_floors and new_basements == cur_basements:
            return p
        delta = new_basements - cur_basements
        used = present_floors(p)
        after = sorted({n + delta for n in used})
        if any(n < 1 for n in after):
            raise HTTPException(
                422,
                f"要减掉的地下层里还有内容（图纸/空间/灯具），请先把它们挪到别的楼层",
            )
        if after and after[-1] > new_floors:
            raise HTTPException(
                422,
                f"楼层数量不能小于已有内容所在层（{floor_label(after[-1], new_basements)}），请先调整这些内容",
            )
        moved = shift_project_floors(p, delta) if delta else 0
        p["floors"] = new_floors
        p["basements"] = new_basements
        commit(
            c,
            p,
            "调整楼层设置",
            f"地上 {above_floors(new_floors, new_basements)} 层 · 地下 {new_basements} 层"
            + (f"；{moved} 个对象随楼层整体上移 {delta} 层" if delta > 0 else "")
            + (f"；{moved} 个对象随楼层整体下移 {-delta} 层" if delta < 0 else ""),
            True,
        )
    return p


@app.post("/api/projects/import", status_code=201)
def import_project(payload: dict = Body(...)):
    original = payload.get("project")
    if payload.get("schemaVersion") != 1 or not isinstance(original, dict):
        raise HTTPException(422, "需要光律导出的 schemaVersion=1 JSON 项目文件")
    try:
        info = ProjectInput.model_validate(
            {k: v for k, v in original.items() if k in ProjectInput.model_fields}
        )
    except Exception:
        raise HTTPException(422, "项目基础信息格式不正确")
    p = make_project(info.model_dump())
    p["code"] = p["code"] + "-I" + uuid.uuid4().hex[:4].upper()
    p["design"] = original.get("design", empty_design())
    validate_design(p["design"], p)
    p["isDemo"] = bool(original.get("isDemo"))
    p["name"] += " · 导入"
    with connect() as c:
        save_new(c, p, "导入项目", "分配新编号；外部复核记录与文件路径不受信任，已重置")
    return p


@app.get("/api/projects/{pid}")
def detail(request: Request, pid: str):
    user = request.state.user
    with connect() as c:
        # L2: 检查协作账号是否有权限访问该项目
        if not _check_project_assignment(user, pid, c):
            raise HTTPException(status_code=404, detail="项目不存在")
        p = get(c, pid)
        # L3: 过滤敏感字段
        return _filter_project_sensitive_fields(p, user)


@app.delete("/api/projects/{pid}")
def delete(pid: str):
    with connect() as c:
        get(c, pid)
        c.execute("DELETE FROM projects WHERE id=?", (pid,))
    shutil.rmtree(UPLOADS / pid, ignore_errors=True)
    return {"ok": True}


@app.post("/api/projects/{pid}/duplicate")
def duplicate(pid: str):
    with connect() as c:
        original = get(c, pid)
        p = make_project(original)
        p["code"] = original["code"] + "-C" + uuid.uuid4().hex[:4].upper()
        p["name"] += " · 副本"
        p["design"] = copy.deepcopy(original["design"])
        # 副本不带原始附件（见下面的说明），所以底图 / 三维图纸的引用必须一并清掉：
        # 留着 baseFileId 会让副本一打开就去原项目取图 → 404「文件不存在」，界面白底。
        p["design"]["baseFileId"] = ""
        p["design"].pop("source3dHash", None)
        p["design"].pop("source3dGeneration", None)
        p["isDemo"] = original["isDemo"]
        save_new(c, p, "复制项目", "复制结构化设计、不复制原始附件与复核状态；底图与三维源文件需重新导入")
    return p


@app.post("/api/projects/{pid}/archive")
def archive(pid: str):
    with connect() as c:
        c.execute("BEGIN IMMEDIATE")
        p = get(c, pid)
        p["status"] = "已归档"
        p["frozen"] = True
        commit(c, p, "归档项目")
    return p


@app.put("/api/projects/{pid}/design")
def save_design(request: Request, pid: str, payload: DesignInput):
    user = request.state.user
    with connect() as c:
        # L2: 检查协作账号是否有权限访问该项目
        if not _check_project_assignment(user, pid, c):
            raise HTTPException(status_code=404, detail="项目不存在")
        c.execute("BEGIN IMMEDIATE")
        p = get(c, pid)
        editable(p)
        if payload.revision != p["revision"]:
            # The HTTPException handler records this 409 once, without changing its response.
            raise HTTPException(409, "项目已在其他窗口更新，请重新打开，避免覆盖修改")
        coop.assert_design_edit(p)
        validate_design(payload.design, p)
        # 面板键位随项目落库即对齐（每键短按/长按两条刻字，4 键＝4键8功能）。
        panels.normalize_panels(payload.design)
        p["design"] = payload.design
        commit(c, p, "保存设计", "结构化设计已保存；受影响的复核已失效", True)
    # L3: 过滤敏感字段
    return _filter_project_sensitive_fields(p, user)


@app.post("/api/projects/{pid}/fixtures/{fid}/ies")
async def upload_fixture_ies(pid: str, fid: str, file: UploadFile = File(...)):
    """Reserved IES (photometric) upload for one fixture.

    The file is stored and referenced on the fixture, but the light spot keeps
    using the theoretical half-beam-angle value until an IES parser is added.
    """
    name = Path((file.filename or "fixture.ies").replace(chr(92), "/")).name
    if not name.lower().endswith(".ies"):
        raise HTTPException(422, "只接受 .ies 光度文件")
    with connect() as c:
        c.execute("BEGIN IMMEDIATE")
        p = get(c, pid)
        editable(p)
        fixture = next((f for f in p["design"]["fixtures"] if f["id"] == fid), None)
        if not fixture:
            raise HTTPException(404, "灯具不存在")
        folder = UPLOADS / pid
        folder.mkdir(parents=True, exist_ok=True)
        stored = ident() + ".ies"
        target = folder / stored
        size = 0
        with target.open("wb") as out:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > 4 * 1024 * 1024:
                    raise HTTPException(413, "IES 文件过大")
                out.write(chunk)
        fixture["ies"] = {
            "file": stored,
            "name": name,
            "bytes": size,
            "uploadedAt": now(),
            "status": "reserved-not-parsed",
            "note": "已留存；未接入解析，光斑仍按半角光束角理论值计算",
        }
        commit(c, p, "上传 IES 光度文件", f"{fixture.get('code') or fixture['id']}：{name}")
    return p


@app.get("/api/projects/{pid}/events")
def events(pid: str):
    with connect() as c:
        get(c, pid)
        return [
            dict(r)
            for r in c.execute(
                "SELECT * FROM events WHERE project_id=? ORDER BY at DESC LIMIT 100",
                (pid,),
            )
        ]


@app.get("/api/projects/{pid}/versions")
def versions(pid: str):
    with connect() as c:
        get(c, pid)
        return [
            dict(r)
            for r in c.execute(
                "SELECT id,version,revision,created_at,note FROM versions WHERE project_id=? ORDER BY created_at DESC LIMIT 100",
                (pid,),
            )
        ]


@app.post("/api/projects/{pid}/versions")
def new_version(pid: str):
    with connect() as c:
        c.execute("BEGIN IMMEDIATE")
        p = get(c, pid)
        coop.assert_design_edit(p)
        p["version"] += 1
        p["frozen"] = False
        p["reviews"] = {}
        p.pop("invalidatedReviews", None)
        p["approved"] = False
        p["status"] = "设计中"
        commit(c, p, "新建设计版本", f"V{p['version']:02}")
    return p


@app.post("/api/projects/{pid}/versions/{vid}/restore")
def restore(pid: str, vid: str):
    with connect() as c:
        c.execute("BEGIN IMMEDIATE")
        p = get(c, pid)
        r = c.execute(
            "SELECT doc FROM versions WHERE id=? AND project_id=?", (vid, pid)
        ).fetchone()
        if not r:
            raise HTTPException(404, "历史版本不存在")
        coop.assert_design_edit(p)
        p["design"] = unpack_snapshot(r["doc"])["design"]
        p["version"] += 1
        p["frozen"] = False
        commit(c, p, "从历史创建新版本", "恢复设计，不恢复已删除的附件", "all")
    return p


@app.post("/api/projects/{pid}/reviews")
def review(request: Request, pid: str, payload: dict = Body(...)):
    user = request.state.user
    key = payload.get("key")
    reviewer = str(payload.get("reviewer", "")).strip()
    # 统筹改进 3：协作账号只能签 layout/lighting，禁止 pricing/delivery
    if user["role"] == auth.ROLE_OUTSOURCER and key in ("pricing", "delivery"):
        raise HTTPException(status_code=403, detail="协作账号无权签署报价与交付复核")
    if (
        key not in REVIEW_KEYS
        or not reviewer
        or payload.get("acknowledged") is not True
    ):
        raise HTTPException(422, "请选择复核项、填写复核人，并明确确认复核责任")
    with connect() as c:
        # L2: 检查协作账号是否有权限访问该项目
        if not _check_project_assignment(user, pid, c):
            raise HTTPException(status_code=404, detail="项目不存在")
        c.execute("BEGIN IMMEDIATE")
        p = get(c, pid)
        editable(p)
        if payload.get("revision") != p["revision"]:
            raise HTTPException(409, "版本已改变，请刷新后复核")
        coop.gate_check(p,key)
        if not p["design"]["rooms"]:
            raise HTTPException(422, "请先建立并校正房间")
        if key == "layout" and any(
            r.get("source") in ("simulation", "example", "image-analysis")
            for r in p["design"]["rooms"]
        ):
            raise HTTPException(
                422,
                "存在尚未人工确认的自动识别或示例区域，请逐项校正 / 确认后再复核空间",
            )
        if key == "lighting" and (
            not p["design"]["fixtures"]
            or any(not f.get("circuit") for f in p["design"]["fixtures"])
        ):
            raise HTTPException(422, "请先配置灯具及所属回路")
        if key == "scenes" and not p["design"]["scenes"]:
            raise HTTPException(422, "请先创建场景")
        if key == "pricing" and any(
            f.get("quote") and not f.get("priceVerified")
            for f in p["design"]["fixtures"]
        ):
            raise HTTPException(
                422, "存在模拟或待核实价格，请在灯具表逐项核实后再复核报价"
            )
        p["reviews"][key] = {
            "reviewer": reviewer,
            "at": now(),
            "revision": p["revision"],
        }
        (p.get("invalidatedReviews") or {}).pop(key, None)
        if not p.get("invalidatedReviews"):
            p.pop("invalidatedReviews", None)
        p["approved"] = all(k in p["reviews"] for k in REVIEW_KEYS) and not p["isDemo"]
        p["status"] = "已确认" if p["approved"] else "待复核"
        commit(c, p, "人工复核", key + " · " + reviewer)
    return p


@app.post("/api/projects/{pid}/freeze")
def freeze(pid: str):
    with connect() as c:
        c.execute("BEGIN IMMEDIATE")
        p = get(c, pid)
        if not p["approved"]:
            raise HTTPException(422, "只有非示例项目且全部人工复核通过后才能冻结")
        p["cooperation"]["designFreeze"] = p["cooperation"].get("designFreeze") or dict(actor="五道复核后归档冻结",at=now(),designHash=coop.design_hash(p),version=p["version"])
        p["frozen"] = True
        p["status"] = "已冻结"
        commit(c, p, "冻结版本")
    return p


# Limit CPU/memory pressure without blocking FastAPI's event loop during upload.
RECOGNITION_SLOTS = threading.Semaphore(2)

# --- 导入图纸的楼层归属 ------------------------------------------------------
# 图纸文件名通常已经写明楼层（「1F 平面图.png」「二层照明.dxf」「地下一层.pdf」）。
# 先按文件名判定，判不出来才回落到界面上选的楼层。
# 地下室用「地下层数」表达：内部楼层号 = 地下层数 + 1 - 地下室深度；
# 地上 n 层 = 地下层数 + n。项目里 floor 始终是 1..floors 的正整数。
_CN_DIGIT = {
    "零": 0, "〇": 0, "一": 1, "壹": 1, "二": 2, "两": 2, "贰": 2, "三": 3, "叁": 3,
    "四": 4, "肆": 4, "五": 5, "伍": 5, "六": 6, "陆": 6, "七": 7, "柒": 7,
    "八": 8, "捌": 8, "九": 9, "玖": 9, "十": 10, "拾": 10,
}
_CN_FLOOR_TOKEN = r"\d+|[零〇一壹二两贰三叁四肆五伍六陆七柒八捌九玖十拾]{1,3}"
_BASEMENT_RE = re.compile(
    r"地下|底下|负[一二三四五六七八九十0-9]|(?<![A-Z0-9])(?:BG|SB\d{1,2}|B\d{1,2})(?![0-9])"
    r"|(?<![A-Z0-9])-\s*\d{1,2}\s*(?:F|FL|FLOOR|层|樓|楼)"
)
_BASEMENT_DEPTH_CN = re.compile(r"(?:地下|底下|负)\s*([一二三四五六七八九十0-9]{1,2})?")
_BASEMENT_DEPTH_EN = re.compile(r"(?<![A-Z0-9])(?:SB|B)\s*(\d{1,2})(?![0-9])")
_BASEMENT_DEPTH_SIGN = re.compile(r"(?<![A-Z0-9])-\s*(\d{1,2})\s*(?:F|FL|FLOOR|层|樓|楼)")
_TOP_RE = re.compile(r"顶层|顶楼|屋顶|屋面|天台|阁楼|(?<![A-Z0-9])(?:RF|ROOF)(?![A-Z0-9])")
_GROUND_RE = re.compile(r"首层|底层|地面层|入户层|(?<![A-Z0-9])(?:GF|G)(?![A-Z0-9])")
_FLOOR_SUFFIX_RE = re.compile(
    r"(" + _CN_FLOOR_TOKEN + r")\s*(?:F|FL|FLOOR|层|樓|楼)(?!号)"
)
_FLOOR_PREFIX_RE = re.compile(
    r"(?<![A-Z0-9])(?:F|FL|FLOOR|L)\s*(" + _CN_FLOOR_TOKEN + r")(?![A-Z0-9])"
)


def _cn_number(text: str):
    """「二十」「十二」「三」这类中文序号转整数；认不出返回 None。"""
    if not text:
        return None
    head, ten, tail = re.sub(r"[拾]", "十", text).partition("十")
    if not ten:
        if all(ch in _CN_DIGIT for ch in text):
            return int("".join(str(_CN_DIGIT[ch]) for ch in text))
        return None
    tens = _cn_number(head) if head else 1
    ones = _cn_number(tail) if tail else 0
    if tens is None or ones is None:
        return None
    return tens * 10 + ones


def parse_floor_name(name: str) -> dict:
    """从图纸文件名里读出楼层线索：kind＝basement/above/top/ground/none。"""
    stem = re.sub(r"\.[A-Za-z0-9]{1,6}$", "", str(name or ""))
    s = unicodedata.normalize("NFKC", stem).upper().strip()
    if not s:
        return {"kind": "none"}
    if _BASEMENT_RE.search(s):
        return {"kind": "basement", "depth": _basement_depth(s)}
    m = _FLOOR_SUFFIX_RE.search(s) or _FLOOR_PREFIX_RE.search(s)
    if m:
        raw = m.group(1)
        number = int(raw) if raw.isdigit() else _cn_number(raw)
        if number and number > 0:
            return {"kind": "above", "number": number}
        return {"kind": "none"}
    if _TOP_RE.search(s):
        return {"kind": "top"}
    if _GROUND_RE.search(s):
        return {"kind": "ground"}
    return {"kind": "none"}


def _basement_depth(s: str) -> int:
    """地下几层：地下二层/B2/-2F → 2；只有「地下」没写深度按地下一层算。"""
    for pattern in (_BASEMENT_DEPTH_EN, _BASEMENT_DEPTH_SIGN, _BASEMENT_DEPTH_CN):
        m = pattern.search(s)
        if not m:
            continue
        raw = (m.group(1) or "").strip()
        if not raw:
            return 1
        depth = int(raw) if raw.isdigit() else _cn_number(raw)
        if depth and depth > 0:
            return min(int(depth), 20)
    return 1


def detect_floor_from_name(name: str, floors: int = 1, basements: int = 0):
    """按图纸文件名判断楼层，返回 (floor, note)。

    floor 是 1..floors 的整数（地下层是最小的几层，用 floor_label 显示成 B1）；
    None 表示判不出来，note 说明原因，界面据此提示设计师手动选择。
    """
    total = max(1, int(floors or 1))
    b = safe_basements(basements, total)
    ground = above_floors(total, b)
    info = parse_floor_name(name)
    kind = info.get("kind")
    if kind == "basement":
        depth = int(info.get("depth") or 1)
        if b <= 0:
            return None, "文件名是地下层，但本项目没有设置地下层（可在「图纸与底图 → 楼层设置」补上地下层数）"
        if depth > b:
            return None, f"文件名是地下 {depth} 层，超出本项目地下层数（共 {b} 层），请手动选择"
        floor = b + 1 - depth
        return floor, f"已按文件名识别为 {floor_label(floor, b)}"
    if kind == "above":
        number = int(info.get("number") or 1)
        if number > ground:
            return None, f"文件名是 {number}F，超出本项目地上层数（共 {ground} 层），请手动选择"
        floor = b + number
        return floor, f"已按文件名识别为 {floor_label(floor, b)}"
    if kind == "top":
        return total, f"文件名含顶层，已按 {floor_label(total, b)} 落层"
    if kind == "ground":
        return b + 1, f"文件名含首层/底层，已按 {floor_label(b + 1, b)} 落层"
    return None, ""


def _explicit_floor(name, index, picked) -> int | None:
    """这次上传里这个文件是否被显式指定了楼层（按顺序或按文件名）。"""
    stem = re.sub(r"\.[A-Za-z0-9]{1,6}$", "", str(name or ""))
    for key in (index, str(index), str(name or ""), stem):
        if key in picked:
            try:
                return int(picked[key])
            except (TypeError, ValueError):
                continue
    return None


def planned_level_growth(
    names: list[str],
    picked: dict,
    floors: int,
    basements: int,
    auto: bool = True,
) -> dict:
    """导入前按文件名推断这次上传需要的层数。

    图纸名写了地下层（地下一层 / B1 / -2F）而项目还没设地下层时，补齐地下层数；
    写了地上 nF 而项目地上层数不够时，也补上。补齐发生在落库前（同一事务），
    已有内容整体上移，标签不变，所以不会打乱已经画好的楼层。
    """
    total = max(1, int(floors or 1))
    b = safe_basements(basements, total)
    above = total - b
    result = {
        "floors": total,
        "basements": b,
        "deltaBasements": 0,
        "grownAbove": 0,
        "grown": [],
        "changed": False,
    }
    if not auto:
        return result
    want_b, want_above = b, above
    for index, name in enumerate(names):
        if _explicit_floor(name, index, picked) is not None:
            continue  # 显式指定了楼层的图纸不参与自动补层
        info = parse_floor_name(name)
        kind = info.get("kind")
        if kind == "basement":
            depth = int(info.get("depth") or 1)
            if depth > want_b:
                want_b = depth
                result["grown"].append(str(name))
        elif kind == "above":
            number = int(info.get("number") or 1)
            if number > want_above:
                want_above = number
                result["grown"].append(str(name))
    result["deltaBasements"] = want_b - b
    result["grownAbove"] = want_above - above
    result["basements"] = want_b
    result["floors"] = want_above + want_b
    result["changed"] = bool(result["deltaBasements"] or result["grownAbove"])
    return result


def apply_level_growth(project: dict, growth: dict) -> str:
    """把补出来的层数落到项目上（地下层补齐时已有内容整体上移，标签不变）。"""
    if not growth.get("changed"):
        return ""
    delta = int(growth.get("deltaBasements") or 0)
    moved = shift_project_floors(project, delta) if delta else 0
    project["floors"] = int(growth["floors"])
    project["basements"] = int(growth["basements"])
    parts = []
    if delta:
        parts.append(
            f"补上地下 {int(growth['basements'])} 层（{moved} 个已有对象整体上移 {delta} 层，标签不变）"
        )
    if growth.get("grownAbove"):
        parts.append(f"补上地上 {int(growth['grownAbove'])} 层")
    return "；".join(parts)


def _parse_floor_selection(raw) -> dict:
    """解析上传时随文件带来的楼层表：[1, null] 按顺序，或 {"2F.png": 2} 按文件名。"""
    if not raw:
        return {}
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except (TypeError, ValueError):
            return {}
    out: dict = {}
    if isinstance(raw, list):
        pairs = list(enumerate(raw))
    elif isinstance(raw, dict):
        pairs = list(raw.items())
    else:
        return {}
    for key, value in pairs:
        if value is None or value == "":
            continue
        out[key] = value
        if isinstance(key, str) and key.isdigit():
            out[int(key)] = value
    return out


def resolve_upload_floor(
    name: str,
    index: int,
    picked: dict,
    fallback,
    floors: int,
    basements: int = 0,
    auto: bool = True,
):
    """单个上传文件的楼层：显式指定 > 文件名识别 > 界面上选的楼层。"""
    total = max(1, int(floors or 1))
    b = safe_basements(basements, total)
    explicit = _explicit_floor(name, index, picked)
    if explicit is not None and 1 <= explicit <= total:
        return explicit, "manual", ""
    default = max(1, min(int(fallback or 1), total))
    if auto:
        detected, note = detect_floor_from_name(name, total, b)
        if detected:
            return detected, "filename", note
        if note:
            # 识别到了楼层但超出项目层数：保留手动选的楼层，并说明原因。
            return default, "default", note
    return default, "default", ""


def analyze_uploaded_file(path: Path, meta: dict) -> dict:
    """Always return a truthful per-file outcome. Failure never deletes an upload."""
    # "labels" = 只读图纸上的空间名称文字（默认）：不画边界、不做几何分割。
    mode = str(meta.get("recognitionMode") or "labels").strip().lower()
    floor = int(meta.get("floor") or 1)
    try:
        with RECOGNITION_SLOTS:
            # Explicit simulation is a test/demo contract and must not invoke a
            # live semantic provider merely because one is configured globally.
            if (
                meta["type"] != "DXF"
                and os.getenv("RECOGNITION_PROVIDER", "local") != "simulation"
                and semantic_plan_configured()
                and (mode == "labels" or should_use_semantic_vision(path, meta))
            ):
                try:
                    result = (
                        semantic_labels_from_external(path, meta, floor)
                        if mode == "labels"
                        else semantic_plan_from_external(path, meta)
                    )
                except Exception as e:
                    if mode == "labels":
                        # 只读文字模式不做几何兜底：宁可诚实报空，也不塞入无用的空间块。
                        result = dict(
                            provider=os.getenv("PLAN_VISION_PROVIDER", "hermes-deepseek"),
                            simulated=False,
                            confidence=None,
                            status="no-spaces",
                            rooms=[], walls=[], openings=[], texts=[],
                            semantic={"provider": "external-vision", "mode": "labels"},
                            unrecognized=["未读到空间名称文字"],
                            message="未读到空间名称文字：" + str(e)[:160] + "。请换更清晰的图纸，或在「底图与空间」手动新增空间。",
                        )
                    else:
                        # Semantic vision is best-effort and non-deterministic. A
                        # failed or empty vision response must never leave the import
                        # with zero usable spaces; fall back to deterministic local
                        # boundary analysis so the designer still gets a usable draft.
                        result = recognition_provider(
                            os.getenv("RECOGNITION_PROVIDER", "local")
                        ).recognize(path, meta)
                    result["semanticFallback"] = {
                        "from": "external-vision",
                        "reason": str(e)[:220],
                    }
                    result["message"] = (
                        result.get("message", "")
                        + f" 语义户型接口未完成（{str(e)[:160]}），已改用本地图像边界分析。"
                    )
            else:
                provider = DxfRecognitionProvider() if meta["type"] == "DXF" else recognition_provider(os.getenv("RECOGNITION_PROVIDER", "local"))
                result = provider.recognize(path, meta)
        result.setdefault("status", "draft" if result.get("rooms") else "no-spaces")
        for key in ("rooms", "walls", "openings", "texts"):
            result.setdefault(key, [])
            for obj in result[key]:
                obj["sourceFileId"] = meta["id"]
        result.setdefault("unresolvedRegions", [])
        # Semantic vision already returns one bounded outer polygon (3-16 points)
        # per space, so those drafts stay editable instead of being discarded for
        # being non-rectangular. The classical geometry path keeps its tighter
        # 8-point invariant.
        max_vertices = (
            16
            if result.get("semantic", {}).get("provider") == "external-vision"
            else 8
        )
        over_limit = [
            v for v in result["rooms"] if len(v.get("points", [])) > max_vertices
        ]
        for room in over_limit:
            result["unresolvedRegions"].append(
                dict(
                    name=room.get("name", "待划分空间"),
                    x=room.get("x", 0),
                    y=room.get("y", 0),
                    width=room.get("width", 0),
                    height=room.get("height", 0),
                    rawPoints=room["points"],
                    reason=f"自动空间超过{max_vertices}点，保留原始几何供人工划分，不自动导入房间",
                )
            )
        if over_limit:
            result["rooms"] = [
                v
                for v in result["rooms"]
                if len(v.get("points", [])) <= max_vertices
            ]
            result[
                "message"
            ] += f" 另有{len(over_limit)}个超过{max_vertices}点的区域已转为待人工划分。"
        result["maxRoomVertices"] = max_vertices
        result.setdefault("unrecognized", [])
    except Exception as e:
        result = dict(
            provider="recognition-unavailable",
            simulated=False,
            confidence=None,
            status="failed",
            rooms=[],
            walls=[],
            openings=[],
            texts=[],
            unrecognized=["空间边界未完成分析"],
            message="原文件已保存，但自动识别未完成：" + str(e)[:200],
        )
    result.setdefault("floor", floor)
    result.update(
        recognitionId=ident(), fileId=meta["id"], createdAt=now(), applied=False
    )
    return result


def save_file_recognition(meta: dict, result: dict):
    meta["recognition"] = result
    meta["confidence"] = result.get("confidence")
    meta["needsReview"] = True
    meta["status"] = (
        "识别未完成"
        if result.get("status") == "failed"
        else (
            "模拟草稿"
            if result.get("simulated")
            else (
                f"已识别 {len(result['rooms'])} 个空间 · 待校正"
                if result.get("rooms")
                else (
                    "基础线段已解析 · 需人工划分空间"
                    if result.get("walls")
                    else "未识别出空间 · 请人工绘制"
                )
            )
        )
    )


def apply_detection_to_design(project: dict, result: dict):
    coop.assert_design_edit(project)
    # A new AI pass replaces the former unconfirmed AI draft. It must never stack
    # over it: that was the source of the overlapping blocks in the workspace.
    draft=project["design"].get("spaceDefinition", {})
    target_floor=int(result.get("floor") or 1)
    def _same_floor(obj):
        try:
            return int(obj.get("floor") or 1) == target_floor
        except (TypeError, ValueError):
            return True
    if draft.get("status") != "confirmed":
        auto_sources={"semantic-vision", "image-analysis", "semantic-labels", "cad"}
        # 只替换同一楼层上的自动对象：别墅/复式逐层导入时不会把别的楼层清掉。
        project["design"]["rooms"]=[x for x in project["design"]["rooms"] if x.get("source") not in auto_sources or not _same_floor(x)]
        for key in ("walls", "openings", "texts"):
            project["design"][key]=[x for x in project["design"][key] if x.get("source") not in auto_sources or not _same_floor(x)]
    for key in ("rooms", "walls", "openings", "texts"):
        incoming=copy.deepcopy(result.get(key, []))
        for obj in incoming:
            obj.setdefault("floor", target_floor)
        project["design"][key].extend(incoming)
    # Every imported room candidate becomes an editable spatial draft immediately.
    # A drawing is never treated as a confirmed colour plan until a human confirms it.
    if result.get("rooms"):
        project["design"]["spaceDefinition"] = {
            "status": "draft",
            "fileId": result.get("fileId"),
            "recognitionId": result.get("recognitionId"),
            "createdAt": now(),
            "provider": result.get("semantic", {}).get("provider") or result.get("provider"),
        }
    result["applied"] = True
    for file in project["files"]:
        saved = file.get("recognition")
        if saved and saved.get("recognitionId") == result.get("recognitionId"):
            saved["applied"] = True
    if not project["design"].get("baseFileId"):
        project["design"]["baseFileId"] = result["fileId"]
    project["recognition"] = result


def is_empty_design(project: dict) -> bool:
    return not any(
        project["design"].get(k) for k in ("rooms", "walls", "openings", "fixtures")
    )


@app.post("/api/projects/{pid}/files")
async def upload(
    pid: str,
    files: list[UploadFile] = File(...),
    recognize: bool = Form(True),
    floor: int = Form(1),
    mode: str = Form("labels"),
    floors: str = Form(""),
    auto_floor: bool = Form(True),
):
    """导入图纸。

    楼层归属优先级：``floors`` 里按文件显式指定的楼层 > 文件名里的楼层
    （如「2F 平面图.png」「二层照明.dxf」，``auto_floor=false`` 可关闭）
    > 表单 ``floor``（界面上选的楼层）。
    """
    if len(files) > 20:
        raise HTTPException(422, "每批最多上传 20 个文件")
    with connect() as c:
        p0 = get(c, pid)
        editable(p0)
    names = [
        Path((f.filename or "file").replace("\\", "/")).name for f in files
    ]
    total_floors = max(1, int(p0.get("floors") or 1))
    total_basements = safe_basements(p0.get("basements", 0), total_floors)
    picked_floors = _parse_floor_selection(floors)
    # 图纸名写了地下层/更高的地上层时，先把层数补齐再落图：这样「-2F 平面图」这类
    # 图纸不会因为项目没设地下层而被塞到 1F。
    growth = planned_level_growth(
        names, picked_floors, total_floors, total_basements, auto_floor
    )
    total_floors = int(growth["floors"])
    total_basements = int(growth["basements"])
    dest = UPLOADS / pid
    dest.mkdir(parents=True, exist_ok=True)
    saved = []
    created = []
    try:
        for index, file in enumerate(files):
            name = names[index]
            ext = Path(name).suffix.lower()
            if ext not in [
                ".png",
                ".jpg",
                ".jpeg",
                ".webp",
                ".bmp",
                ".tif",
                ".tiff",
                ".pdf",
                ".dxf",
                ".svg",
            ]:
                raise HTTPException(
                    422, "仅支持 PNG/JPG/WebP/BMP/TIFF/PDF/DXF/SVG；DWG 请先转换为 DXF"
                )
            fid = ident()
            path = dest / (fid + ext)
            size = 0
            created.append(path)
            with path.open("wb") as out:
                while chunk := await file.read(1024 * 1024):
                    size += len(chunk)
                    if size > int(os.getenv("MAX_UPLOAD_MB", "80")) * 1024 * 1024:
                        raise HTTPException(413, "单个文件超出大小限制")
                    out.write(chunk)
            file_floor, file_floor_source, file_floor_note = resolve_upload_floor(
                name,
                index,
                picked_floors,
                floor,
                total_floors,
                total_basements,
                auto_floor,
            )
            if (
                file_floor_source == "filename"
                and name in growth["grown"]
                and growth["changed"]
            ):
                file_floor_note = (
                    file_floor_note
                    + "；已按文件名自动补齐层数，可在「图纸与底图 → 楼层设置」核对"
                )
            meta = dict(
                id=fid,
                name=name,
                type=ext[1:].upper(),
                size=size,
                uploadedAt=now(),
                status="待处理",
                confidence=None,
                needsReview=True,
                path=path.name,
                preview=None,
                pages=None,
                dimensions=None,
                # 每张图纸属于一个楼层；识别的空间落到这个楼层。
                # floorSource=filename 表示按文件名自动识别，界面会标出来并允许覆盖。
                floor=file_floor,
                floorSource=file_floor_source,
                floorNote=file_floor_note,
                recognitionMode=("labels" if str(mode).strip().lower() != "plan" else "plan"),
            )
            try:
                if ext in [".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"]:
                    with Image.open(path) as im:
                        im.verify()
                    with Image.open(path) as raw:
                        meta["frames"] = getattr(raw, "n_frames", 1)
                    im = raster_image(path, meta)
                    meta["dimensions"] = list(im.size)
                    im.thumbnail((1800, 1800))
                    preview = dest / (fid + "_preview.png")
                    created.append(preview)
                    im.save(preview)
                    meta["preview"] = preview.name
                elif ext == ".pdf":
                    import fitz

                    with fitz.open(path) as doc:
                        if doc.is_encrypted or not len(doc):
                            raise ValueError("加密或空 PDF")
                        meta["pages"] = len(doc)
                        preview = dest / (fid + "_preview.png")
                        created.append(preview)
                        raster_image(path, meta).save(preview)
                        meta["preview"] = preview.name
                elif ext == ".dxf":
                    import ezdxf

                    doc = ezdxf.readfile(path)
                    meta["layers"] = [x.dxf.name for x in doc.layers]
                    meta["status"] = "可解析基础几何"
                elif ext == ".svg":
                    import xml.etree.ElementTree as ET

                    text = path.read_text()
                    if "<!DOCTYPE" in text.upper() or "<!ENTITY" in text.upper():
                        raise ValueError("SVG 不允许 DTD")
                    root = ET.fromstring(text)
                    for el in root.iter():
                        if el.tag.split("}")[-1] in (
                            "script",
                            "foreignObject",
                            "image",
                            "use",
                            "style",
                            "animate",
                            "set",
                        ):
                            raise ValueError("仅支持不含脚本或外部资源的基础 SVG")
                        for k, v in el.attrib.items():
                            if (
                                k.lower().startswith("on")
                                or "href" in k.lower()
                                or "url(" in v.lower()
                            ):
                                raise ValueError("SVG 外部资源被禁用")
                    preview = dest / (fid + "_preview.png")
                    created.append(preview)
                    im = raster_image(path, meta)
                    meta["dimensions"] = list(im.size)
                    im.save(preview)
                    meta["preview"] = preview.name
            except Exception as e:
                raise HTTPException(422, f"{name} 无法读取：{str(e)[:140]}")
            if recognize:
                result = await run_in_threadpool(analyze_uploaded_file, path, meta)
                save_file_recognition(meta, result)
            else:
                # Recognition is switched off for this import: the drawing is
                # registered as the editable base image only. Spaces are framed
                # by hand on top of it instead of being guessed by a model.
                meta["status"] = "已上传 · 待框选空间"
            saved.append(meta)
        with connect() as c:
            c.execute("BEGIN IMMEDIATE")
            p = get(c, pid)
            editable(p)
            # 先把按文件名补出来的层数落下（含已有内容整体上移），再挂新图纸。
            growth_note = apply_level_growth(p, growth)
            p["files"].extend(saved)
            first_applied = None
            for meta in saved:
                if not recognize:
                    # The uploaded drawing becomes the canvas base image and
                    # space definition opens as a draft so the designer can
                    # frame regions by hand and confirm them.
                    if not p["design"].get("baseFileId") and meta.get("preview"):
                        p["design"]["baseFileId"] = meta["id"]
                    if not p["design"].get("spaceDefinition", {}).get("status"):
                        p["design"]["spaceDefinition"] = {
                            "status": "draft",
                            "fileId": meta["id"],
                            "createdAt": now(),
                            "reason": "导入底图后人工框选空间（未启用自动识别）",
                        }
                    continue
                result = meta["recognition"]
                p["recognition"] = result
                if (
                    is_empty_design(p)
                    and result.get("rooms")
                    and not result.get("simulated")
                    # Enter editable “space definition” immediately after import.
                    # Recognition output remains a draft; no colour-plan claim is made here.
                ):
                    apply_detection_to_design(p, result)
                    first_applied = first_applied or result
            if first_applied:
                p["recognition"] = first_applied
            commit(
                c,
                p,
                (
                    ("导入图纸并自动识别" if recognize else "导入图纸作为底图（待框选空间）")
                    + ("；" + growth_note if growth_note else "")
                ),
                "；".join(x["name"] + "：" + x["status"] for x in saved),
                {"layout": ["导入图纸 " + "、".join(x["name"] for x in saved)]},
                status="待人工确认",
            )
        return p
    except Exception:
        for path in created:
            path.unlink(missing_ok=True)
        raise


def _ensure_dxf_preview(pid: str, f: dict):
    """按需把 DXF 渲染成底图 PNG，并把结果记回项目（下次直接发图）。

    上传接口本来就只给 PNG/PDF/SVG 出预览图，DXF 一直没有——而「在 DXF 底图上画多边形改空间边界」
    必须有底图（实测 2026-10-14）。这里作为兜底：老项目、没预热过的项目取图时现渲一次。
    """
    from .dxf_preview import render_dxf_png, MAPPING_VERSION, apartment_bbox
    src = (UPLOADS / pid / str(f.get("path") or "")).resolve()
    base = (UPLOADS / pid).resolve()
    if not src.is_file() or not src.is_relative_to(base):
        return None
    name = f.get("preview") or f"{f['id']}_preview.png"
    out = base / name
    # previewBox＝这张底图覆盖的图纸原始坐标外接框。没有它，底图就摆不进设计坐标，
    # 空间边界和图纸就会错开（实测 2026-10-14「我怎么确认空间范围是否正确呢」）。
    meta = None
    from .lighting3d import load_store
    parsed = (load_store(pid) or {}).get("parsed")
    try:
        if not (out.is_file() and out.stat().st_mtime >= src.stat().st_mtime):
            meta = render_dxf_png(src, out, parsed=parsed)
        elif ((f.get("previewBox") or {}).get("mappingVersion") != MAPPING_VERSION
              or (f.get("previewBox") or {}).get("cropBox") != apartment_bbox(parsed)):
            meta = render_dxf_png(src, out, parsed=parsed)  # 老项目：图在但没记外接框，补算一次（图纸大时较慢，走后台线程调用）
    except Exception:
        return None
    try:
        with connect() as c:
            c.execute("BEGIN IMMEDIATE")
            p = get(c, pid)
            t = next((x for x in p["files"] if x["id"] == f["id"]), None)
            if t is not None and (t.get("preview") != name or (meta and t.get("previewBox") != meta)):
                t["preview"] = name
                if meta:
                    t["previewBox"] = meta
                c.execute("UPDATE projects SET doc=? WHERE id=?",
                          (json.dumps(p, ensure_ascii=False), pid))
    except Exception:
        pass
    return out


def ensure_project_dxf_preview(pid: str):
    """把项目里第一张 DXF 渲染成底图（给三维生成线程预热调用，省掉用户等待）。"""
    with connect() as c:
        p = get(c, pid)
    f = next((x for x in (p.get("files") or [])
              if str(x.get("type", "")).upper() == "DXF"
              or str(x.get("name", "")).lower().endswith(".dxf")), None)
    if f is not None:
        _ensure_dxf_preview(pid, f)


@app.get("/api/projects/{pid}/files/{fid}")
def get_file(pid: str, fid: str, preview: bool = False):
    with connect() as c:
        p = get(c, pid)
    f = next((f for f in p["files"] if f["id"] == fid), None)
    if not f:
        raise HTTPException(404, "文件不存在")
    if preview:
        name = f.get("preview")
        path = (UPLOADS / pid / name) if name else None
        if (path is None or not path.is_file()) and str(f.get("type", "")).upper() == "DXF":
            path = _ensure_dxf_preview(pid, f)
        if path is None or not path.is_file():
            raise HTTPException(404, "此文件暂无预览")
    else:
        path = UPLOADS / pid / str(f["path"])
        if not path.is_file():
            raise HTTPException(404, "磁盘文件不存在")
    return FileResponse(
        path,
        filename=None if preview else f["name"],
        headers={
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        },
    )


@app.delete("/api/projects/{pid}/files/{fid}")
def remove_file(pid: str, fid: str):
    with connect() as c:
        c.execute("BEGIN IMMEDIATE")
        p = get(c, pid)
        editable(p)
        f = next((x for x in p["files"] if x["id"] == fid), None)
        if not f:
            raise HTTPException(404, "文件不存在")
        p["files"] = [x for x in p["files"] if x["id"] != fid]
        commit(c, p, "删除图纸", f["name"], {"layout": [f"删除图纸 {f['name']}"]})
    for k in ("path", "preview"):
        if f.get(k):
            (UPLOADS / pid / f[k]).unlink(missing_ok=True)
    return p


@app.post("/api/projects/{pid}/files/{fid}/page")
def select_pdf_page(pid: str, fid: str, payload: dict = Body(default={})):
    """多页 PDF 选页：换成第 N 页作为预览/底图和后续识别来源（默认第 1 页，旧图纸不受影响）。
    已落库的空间不动；换页后图纸复核失效，需要时请在该页上重新分析。"""
    try:
        page = int(payload.get("page"))
    except (TypeError, ValueError):
        raise HTTPException(422, "页码无效")
    with connect() as c:
        p = get(c, pid)
        editable(p)
    f = next((x for x in p["files"] if x["id"] == fid), None)
    if not f:
        raise HTTPException(404, "文件不存在")
    if f.get("type") != "PDF" or not f.get("pages"):
        raise HTTPException(422, "只有 PDF 图纸可以选页")
    if not 1 <= page <= int(f["pages"]):
        raise HTTPException(422, f"页码超出范围（共 {f['pages']} 页）")
    if page == int(f.get("page") or 1):
        return p
    dest = UPLOADS / pid
    preview = dest / f"{fid}_preview.tmp.png"
    try:
        raster_image(dest / f["path"], {**f, "page": page}).save(preview, format="PNG")
    except Exception as exc:
        preview.unlink(missing_ok=True)
        raise HTTPException(422, f"第 {page} 页渲染失败：{exc}")
    with connect() as c:
        c.execute("BEGIN IMMEDIATE")
        p = get(c, pid)
        editable(p)
        target = next((x for x in p["files"] if x["id"] == fid), None)
        if not target:
            preview.unlink(missing_ok=True)
            raise HTTPException(409, "选页期间文件已被删除")
        preview.replace(dest / (target.get("preview") or f"{fid}_preview.png"))
        target["preview"] = target.get("preview") or f"{fid}_preview.png"
        target["page"] = page
        commit(c, p, "切换 PDF 页", f"{target['name']}：第 {page} 页 / 共 {target['pages']} 页",
               {"layout": [f"图纸 {target['name']} 改用第 {page} 页"]})
    return p


@app.patch("/api/projects/{pid}/files/{fid}")
def update_file(pid: str, fid: str, payload: dict = Body(default={})):
    """只改图纸元数据（目前用于所属楼层），不重新识别、不动别的图纸。"""
    if "floor" not in payload:
        raise HTTPException(422, "没有可更新的字段")
    try:
        new_floor = int(payload.get("floor"))
    except (TypeError, ValueError):
        raise HTTPException(422, "楼层号无效")
    with connect() as c:
        c.execute("BEGIN IMMEDIATE")
        p = get(c, pid)
        editable(p)
        if not 1 <= new_floor <= int(p.get("floors") or 1):
            raise HTTPException(422, "楼层超出本项目范围")
        f = next((x for x in p["files"] if x["id"] == fid), None)
        if not f:
            raise HTTPException(404, "文件不存在")
        old_floor = max(1, int(f.get("floor") or 1))
        if old_floor == new_floor:
            return p
        f["floor"] = new_floor
        f["floorSource"] = "manual"
        f["floorNote"] = ""
        moved = 0
        # 该图纸已经落库的空间连同灯具一起搬到新楼层，避免图纸与空间分层。
        moved_ids = set()
        for obj in p["design"]["rooms"]:
            if obj.get("sourceFileId") == fid and int(obj.get("floor") or old_floor) == old_floor:
                obj["floor"] = new_floor
                moved_ids.add(obj["id"])
                moved += 1
        for key in ("walls", "openings"):
            for obj in p["design"][key]:
                if obj.get("sourceFileId") == fid and int(obj.get("floor") or old_floor) == old_floor:
                    obj["floor"] = new_floor
        if moved_ids:
            for fixture in p["design"]["fixtures"]:
                if fixture.get("roomId") in moved_ids:
                    fixture["floor"] = new_floor
        # 还没追加的识别草稿跟着走，确认后才落到正确的楼层。
        for draft in [f.get("recognition"), p.get("recognition")]:
            if not isinstance(draft, dict) or draft.get("applied"):
                continue
            if draft.get("fileId") != fid:
                continue
            draft["floor"] = new_floor
            for key in ("rooms", "walls", "openings", "texts"):
                for obj in draft.get(key, []):
                    if int(obj.get("floor") or old_floor) == old_floor:
                        obj["floor"] = new_floor
        commit(
            c,
            p,
            "调整图纸所属楼层",
            f"{f['name']}：第 {old_floor} 层 → 第 {new_floor} 层"
            + (f"（同步移动 {moved} 个空间及其灯具）" if moved else ""),
            True,
        )
    return p


@app.post("/api/projects/{pid}/files/{fid}/recognize")
def recognize(pid: str, fid: str, payload: dict = Body(default={})):
    with connect() as c:
        p = get(c, pid)
        editable(p)
    f = next((x for x in p["files"] if x["id"] == fid), None)
    if not f:
        raise HTTPException(404, "文件不存在")
    # 重新识别时可以指定这张图纸的楼层与识别模式（labels＝只读文字）。
    if "floor" in payload or "mode" in payload:
        try:
            new_floor = int(payload.get("floor") or f.get("floor") or 1)
        except (TypeError, ValueError):
            raise HTTPException(422, "楼层号无效")
        if not 1 <= new_floor <= int(p.get("floors") or 1):
            raise HTTPException(422, "楼层超出本项目范围")
        new_mode = str(payload.get("mode") or f.get("recognitionMode") or "labels").strip().lower()
        if new_mode not in ("labels", "plan"):
            raise HTTPException(422, "识别模式只能是 labels（只读文字）或 plan（户型边界）")
        with connect() as c:
            c.execute("BEGIN IMMEDIATE")
            p2 = get(c, pid)
            editable(p2)
            target = next((x for x in p2["files"] if x["id"] == fid), None)
            if not target:
                raise HTTPException(404, "文件不存在")
            target["floor"] = new_floor
            target["recognitionMode"] = new_mode
            commit(
                c, p2, "设置图纸楼层与识别模式",
                f"第 {new_floor} 层 · {'只读文字' if new_mode == 'labels' else '户型边界'}",
                True,
            )
        with connect() as c:
            p = get(c, pid)
        f = next((x for x in p["files"] if x["id"] == fid), None)
    start_revision = p["revision"]
    if "exclusions" in payload:
        if payload.get("revision") != start_revision:
            raise HTTPException(409, "项目已更新，请刷新后再保存家具排除区")
        if f["type"] == "DXF":
            raise HTTPException(422, "家具排除区仅支持图像/PDF/SVG，不修改CAD原始几何")
        boxes = payload["exclusions"]
        if not isinstance(boxes, list) or len(boxes) > 40:
            raise HTTPException(422, "家具排除区必须为列表且不超过40个")
        for box in boxes:
            if not isinstance(box, dict) or any(
                not isinstance(box.get(k), (int, float))
                or isinstance(box.get(k), bool)
                or not math.isfinite(box[k])
                for k in ("x", "y", "width", "height")
            ):
                raise HTTPException(422, "排除区坐标无效")
            if not (
                0 <= box["x"] < 800
                and 0 <= box["y"] < 660
                and 1 <= box["width"] <= 800 - box["x"]
                and 1 <= box["height"] <= 660 - box["y"]
            ):
                raise HTTPException(422, "排除区超出画布或太小")
        f["recognitionOptions"] = {"exclusions": copy.deepcopy(boxes)}
    result = analyze_uploaded_file(UPLOADS / pid / f["path"], f)
    with connect() as c:
        c.execute("BEGIN IMMEDIATE")
        p = get(c, pid)
        editable(p)
        target = next((x for x in p["files"] if x["id"] == fid), None)
        if not target:
            raise HTTPException(409, "识别期间文件已被删除")
        if "exclusions" in payload and p["revision"] != start_revision:
            raise HTTPException(409, "分析期间项目已更新，本次排除区未保存，请刷新重试")
        if "exclusions" in payload:
            target["recognitionOptions"] = f["recognitionOptions"]
        save_file_recognition(target, result)
        p["recognition"] = result
        if (
            is_empty_design(p)
            and result.get("rooms")
            and not result.get("simulated")
            and result.get("semantic", {}).get("provider") == "external-vision"
        ):
            apply_detection_to_design(p, result)
        commit(c, p, "重新分析空间", result["message"], {"layout": [f"重新分析图纸 {target['name']}"]}, status="待人工确认")
    return p


def validate_reviewed_spaces(d) -> int:
    """Both space review and final confirmation validate the same geometry."""
    rooms = d.get("rooms", [])
    if not rooms:
        raise HTTPException(422, "请先绘制或导入至少一个空间")
    if any(not str(r.get("name") or "").strip() for r in rooms):
        raise HTTPException(422, "所有空间均需填写名称后再确认")
    for floor in {r.get("floor", 1) for r in rooms}:
        overlaps = polygon_overlap_violations([r for r in rooms if r.get("floor", 1) == floor])
        if overlaps:
            hint = ""
            if any(r.get("source") == "cad" or r.get("semanticSource") == "local-geometry-suggestion" for r in rooms):
                hint = "。若是导入图纸自动落下的「闭合区域」草稿，先点「清除旧版错误彩平」清掉它们，再用图纸底图手绘或去三维生成空间"
            raise HTTPException(422, "存在重叠空间，不能确认：" + "；".join(overlaps[:3]) + hint)
    return len(rooms)


# 首次导入 DXF 时 ezdxf 基础解析写进来的线段 / 文字（source="cad"）是**铺满画布的另一套缩放**，
# 和确认后的空间（米 × 26）不在一个坐标系。现场 2026-10-17 的 text 项目：底图上叠了两套大小不一的
# 户型，没法布灯。空间确认后墙以空间边界生成的为准，这层旧线一律清掉（文字一并清：乱码也在里面）。
STALE_DRAWING_SOURCES = {"cad"}


def drop_stale_drawing_geometry(d: dict) -> int:
    removed = 0
    for key in ("walls", "texts"):
        rows = d.get(key) or []
        # 识别写入的文字没有 source，只带 sourceFileId（来自图纸）——一并算旧解析层；手写标注没有 sourceFileId。
        keep = [x for x in rows if x.get("source") not in STALE_DRAWING_SOURCES
                and not (key == "texts" and not x.get("source") and x.get("sourceFileId"))]
        removed += len(rows) - len(keep)
        d[key] = keep
    return removed


def confirm_space_now(p, reviewer=None) -> int:
    """Finalize reviewed spaces and openings, including legacy confirmation callers."""
    d = p["design"]
    if (d.get("spaceDefinition") or {}).get("status") == "confirmed":
        raise HTTPException(422, "空间已确认")
    count = validate_reviewed_spaces(d)
    drop_stale_drawing_geometry(d)
    rooms = d["rooms"]
    for room in rooms:
        room["needsReview"] = False
        room["semanticConfidence"] = "confirmed"
    d["spaceDefinition"] = {
        **(d.get("spaceDefinition") or {}),
        "status": "confirmed",
        "confirmedAt": now(),
        "confirmedBy": str(reviewer or "设计师").strip()[:100],
        "workflowStep": "canvas",
        "roomsConfirmedAt": (d.get("spaceDefinition") or {}).get("roomsConfirmedAt") or now(),
        "openingsConfirmedAt": now(),
    }
    d["colorPlan"] = {
        "status": "generated", "generatedAt": now(),
        "source": "confirmed-space-definition",
    }
    d["planMasked"] = False
    return count


@app.post("/api/projects/{pid}/space-definition/confirm")
def confirm_space_definition(pid: str, payload: dict = Body(default={})):
    """Confirm reviewed rooms without losing their original recognition provenance."""
    with connect() as c:
        c.execute("BEGIN IMMEDIATE")
        p = get(c, pid)
        editable(p)
        if payload.get("revision") != p["revision"]:
            raise HTTPException(409, "项目已更新，请刷新后再确认空间")
        if payload.get("stage") == "rooms":
            n = validate_reviewed_spaces(p["design"])
            editing_floor = payload.get("floor", 1)
            if isinstance(editing_floor, bool) or not isinstance(editing_floor, int) or not 1 <= editing_floor <= p["floors"]:
                raise HTTPException(422, "编辑楼层无效")
            p["design"]["spaceDefinition"] = {
                **(p["design"].get("spaceDefinition") or {}),
                "status": "previewing", "workflowStep": "openings",
                "roomsConfirmedAt": now(), "openingsConfirmedAt": "",
                "editingFloor": editing_floor,
            }
            commit(c, p, "确认空间范围", f"已核对 {n} 个空间，下一步绘制门窗", True)
            return p
        n = confirm_space_now(p, payload.get("reviewer"))
        commit(c, p, "确认空间", f"人工确认 {n} 个空间", {"layout": ["空间已经人工确认"]}, status="设计中")
    return p


@app.post("/api/projects/{pid}/space-definition/discard-ai-draft")
def discard_ai_space_draft(pid: str, payload: dict = Body(default={})): 
    """Remove unusable automatic room blocks while preserving human work."""
    with connect() as c:
        c.execute("BEGIN IMMEDIATE")
        p=get(c,pid); editable(p)
        if payload.get("revision") != p["revision"]:
            raise HTTPException(409,"项目已更新，请刷新后再处理")
        d=p["design"]
        auto_sources={"semantic-vision","image-analysis"}
        removed=[r for r in d["rooms"] if r.get("source") in auto_sources]
        d["rooms"]=[r for r in d["rooms"] if r.get("source") not in auto_sources]
        for key in ("walls","openings","texts"):
            d[key]=[x for x in d[key] if x.get("source") not in auto_sources]
        d["spaceDefinition"]={"status":"draft","createdAt":now(),"reason":"已退回，等待重新识别或人工绘制"}
        p["renders"]=[r for r in p["renders"] if r.get("kind") not in {"formal-colour-plan","space-plan-draft"}]
        if p.get("recognition"): p["recognition"]["applied"]=False
        for f in p["files"]:
            if f.get("recognition"): f["recognition"]["applied"]=False
        commit(c,p,"清除错误 AI 空间草稿",f"已移除 {len(removed)} 个自动空间，保留人工绘制和灯具数据",{"layout":["清除自动识别的空间草稿"]},status="待人工确认")
    return p


@app.post("/api/projects/{pid}/recognition/clear")
def clear_recognition(pid: str, payload: dict = Body(default={})):
    """Drop stored recognition drafts without touching the designer's own work.

    Automatic recognition is off by default now, so leftovers from an earlier
    pass can be discarded on demand. Rooms, walls, openings, fixtures, scenes
    and cooperation data are never altered; a base-image pointer that outlived
    a deleted upload is re-pointed so the drawing still shows underneath.
    """
    with connect() as c:
        c.execute("BEGIN IMMEDIATE")
        p = get(c, pid)
        editable(p)
        if payload.get("revision") not in (None, p["revision"]):
            raise HTTPException(409, "项目已更新，请刷新后再处理")
        cleared = 0
        drafts = 0
        if p.get("recognition"):
            drafts += len(p["recognition"].get("rooms", []))
            cleared += 1
            p["recognition"] = None
        for f in p["files"]:
            if f.get("recognition"):
                drafts += len(f["recognition"].get("rooms", []))
                cleared += 1
                f.pop("recognition", None)
                f["status"] = "已上传 · 待框选空间" if f.get("preview") else "已上传"
        healed = ""
        ids = {f["id"] for f in p["files"]}
        if p["design"].get("baseFileId") not in ids:
            fallback = next((f["id"] for f in reversed(p["files"]) if f.get("preview")), None)
            if fallback:
                p["design"]["baseFileId"] = fallback
                healed = "；底图指向已重命到仍在的图纸"
        commit(
            c,
            p,
            "清除识别草稿",
            f"已清除 {cleared} 份识别草稿（{drafts} 个自动空间候选），人工对象未改动" + healed,
            True,
        )
    return p


@app.post("/api/projects/{pid}/recognition/apply")
def apply_recognition(pid: str, payload: dict = Body(default={})):
    with connect() as c:
        c.execute("BEGIN IMMEDIATE")
        p = get(c, pid)
        editable(p)
        fid = payload.get("fileId")
        if fid:
            file = next((x for x in p["files"] if x["id"] == fid), None)
            if not file:
                raise HTTPException(404, "文件不存在")
            r = file.get("recognition")
        else:
            r = p.get("recognition")
        if not r or r.get("applied"):
            raise HTTPException(422, "没有可追加的草稿，或该草稿已经追加")
        if any(len(v.get("points", [])) > 8 for v in r.get("rooms", [])):
            raise HTTPException(422, "旧草稿存在超过8点的空间，请重新识别")
        if r.get("replacements"):
            raise HTTPException(
                422, "草稿已部分用于替换，请继续逐空间替换，不能整份追加造成重叠"
            )
        if not any(r.get(k) for k in ("rooms", "walls", "openings", "texts")):
            raise HTTPException(
                422, "没有识别出可编辑对象，请人工绘制区域或更换清晰图纸"
            )
        if not any(x["id"] == r.get("fileId") for x in p["files"]):
            raise HTTPException(422, "原文件已删除，不能再追加该识别结果")
        apply_detection_to_design(p, r)
        commit(
            c, p, "追加识别草稿", "保留现有设计；请校正重叠区域、空间名称与尺寸", True
        )
    return p


@app.post("/api/projects/{pid}/recognition/reset-auto-plan")
def reset_auto_plan(pid: str):
    with connect() as c:
        c.execute("BEGIN IMMEDIATE")
        p = get(c, pid); editable(p)
        bad = [r["id"] for r in p["design"]["rooms"] if r.get("semanticSource") == "local-geometry-suggestion"]
        if not bad:
            raise HTTPException(422, "当前项目没有可清除的旧版自动彩平")
        if any(f.get("roomId") in bad for f in p["design"]["fixtures"]):
            raise HTTPException(422, "旧版自动彩平已有关联灯具，请逐空间手动确认，不能自动清除")
        p["design"]["rooms"] = [r for r in p["design"]["rooms"] if r["id"] not in bad]
        p["design"]["walls"] = [w for w in p["design"]["walls"] if w.get("source") != "image-analysis"]
        p["design"]["openings"] = [o for o in p["design"]["openings"] if o.get("source") != "image-analysis"]
        p["design"]["texts"] = [t for t in p["design"]["texts"] if t.get("source") != "image-analysis"]
        p["design"]["recognition"] = None
        commit(c, p, "清除旧版自动彩平", "已移除轮廓猜测生成的彩色碎片；等待语义户型接口或人工确认", True)
    return p


@app.post("/api/projects/{pid}/recognition/replace")
def replace_recognition_room(pid: str, payload: dict = Body(...)):
    """Explicit, revision-checked geometry replacement; keep identities and relations."""
    with connect() as c:
        c.execute("BEGIN IMMEDIATE")
        p = get(c, pid)
        editable(p)
        if payload.get("revision") != p["revision"]:
            raise HTTPException(409, "项目已变更，请刷新前后对比后再确认替换")
        if payload.get("acknowledged") is not True:
            raise HTTPException(422, "请确认已查看前后对比，替换后需要重新校核")
        file = next((f for f in p["files"] if f["id"] == payload.get("fileId")), None)
        r = file.get("recognition") if file else None
        if not r or r.get("recognitionId") != payload.get("recognitionId"):
            raise HTTPException(409, "识别草稿已更新或删除，请重新查看结果")
        candidate = next(
            (v for v in r["rooms"] if v["id"] == payload.get("candidateId")), None
        )
        room = next(
            (v for v in p["design"]["rooms"] if v["id"] == payload.get("roomId")), None
        )
        if not candidate or not room:
            raise HTTPException(422, "请选择有效的候选空间和需要替换的画布房间")
        if len(candidate.get("points", [])) > 8:
            raise HTTPException(422, "候选空间超过8点，请重新识别后再替换")
        if r.get("simulated") or not candidate.get("points"):
            raise HTTPException(422, "只允许使用真实图像边界替换")
        if any(v["candidateId"] == candidate["id"] for v in r.get("replacements", [])):
            raise HTTPException(
                422, "该候选空间已替换，不能重复使用；如需调整请重新识别"
            )
        coop.assert_design_edit(p)
        previous = copy.deepcopy(room)
        for key in (
            "x",
            "y",
            "width",
            "height",
            "points",
            "rawPoints",
            "boundaryRegularization",
            "regularizationStats",
            "pixelArea",
        ):
            if key in candidate:
                room[key] = copy.deepcopy(candidate[key])
        room.update(
            source="image-analysis",
            sourceFileId=file["id"],
            needsReview=True,
            confidence=None,
            geometryUpdatedAt=now(),
        )
        # Full pre-edit state is already in snapshot history; retain provenance too.
        room["previousBoundary"] = {
            k: previous.get(k)
            for k in ("x", "y", "width", "height", "points", "source")
        }
        validate_design(p["design"], p)
        r.setdefault("replacements", []).append(
            dict(
                candidateId=candidate["id"],
                roomId=room["id"],
                roomName=room["name"],
                at=now(),
            )
        )
        p["recognition"] = r
        commit(
            c,
            p,
            "确认替换空间边界",
            f"{room['name']}：仅替换轮廓，保留房间 ID、名称、楼层、面积及灯具关联；边界与灯位需重新校核",
            True,
        )
    return p


@app.post("/api/projects/{pid}/effect-renders")
def generate_effect_render(pid: str, payload: dict = Body(default={})):
    """Call a configured real-render API using a small, documented interchange contract.

    Request sent to EFFECT_RENDER_URL: project, scene, camera, floor and optional
    sourceImageBase64. The provider must return image bytes or JSON imageBase64.
    """
    provider = os.getenv("EFFECT_RENDER_PROVIDER", "disabled")
    url = os.getenv("EFFECT_RENDER_URL", "").strip()
    if provider == "disabled" or not url:
        raise HTTPException(409, "效果图接口尚未配置。请设置 EFFECT_RENDER_PROVIDER 与 EFFECT_RENDER_URL；本地二维示意不会冒充效果图。")
    with connect() as c:
        p = get(c, pid)
    floor = payload.get("floor", 1)
    scene_id = payload.get("sceneId")
    if not isinstance(floor, int) or not 1 <= floor <= p["floors"]:
        raise HTTPException(422, "请选择有效楼层")
    scene = next((v for v in p["design"]["scenes"] if v["id"] == scene_id), None) if scene_id else None
    if scene_id and not scene:
        raise HTTPException(422, "场景不存在")
    source_id = payload.get("sourceFileId") or p["design"].get("baseFileId")
    source = next((v for v in p["files"] if v["id"] == source_id and v.get("preview")), None)
    body = {
        "project": {"id": p["id"], "code": p["code"], "name": p["name"], "rooms": p["design"]["rooms"], "fixtures": p["design"]["fixtures"]},
        "scene": scene, "floor": floor, "camera": p["design"].get("camera", {}),
        "sourceImageName": source.get("name") if source else None,
    }
    if source:
        raw = (UPLOADS / pid / source["preview"]).read_bytes()
        body["sourceImageBase64"] = base64.b64encode(raw).decode("ascii")
    headers = {"Content-Type": "application/json"}
    if os.getenv("EFFECT_RENDER_TOKEN"):
        headers["Authorization"] = "Bearer " + os.getenv("EFFECT_RENDER_TOKEN", "")
    try:
        req = UrlRequest(url, data=json.dumps(body, ensure_ascii=False).encode("utf-8"), headers=headers, method="POST")
        with urlopen(req, timeout=90) as remote:
            content_type = remote.headers.get_content_type()
            raw = remote.read()
        if content_type.startswith("image/"):
            image_bytes = raw
        else:
            response = json.loads(raw.decode("utf-8"))
            encoded = response.get("imageBase64") or response.get("image_base64")
            if not encoded:
                raise ValueError("接口响应缺少 imageBase64，或未直接返回图片")
            image_bytes = base64.b64decode(encoded.split(",")[-1])
        image = Image.open(BytesIO(image_bytes)); image.load()
    except (HTTPError, URLError, TimeoutError, ValueError, OSError) as e:
        raise HTTPException(422, "效果图接口未完成：" + str(e)[:240])
    rid = ident(); folder = UPLOADS / pid; folder.mkdir(parents=True, exist_ok=True)
    image.convert("RGB").save(folder / (rid + ".png"))
    result = dict(id=rid, createdAt=now(), version=p["version"], revision=p["revision"], name=(scene or {}).get("name", "效果图") + f" · {floor}F", floor=floor, provider=provider, simulated=False, kind="effect-render", message="由已配置的外部效果图接口返回；仍需人工审阅材质、灯位和场景表现。")
    with connect() as c:
        c.execute("BEGIN IMMEDIATE"); current = get(c, pid); current["renders"].append(result); commit(c, current, "生成效果图", result["message"])
    return current


@app.post("/api/projects/{pid}/renders")
def generate(pid: str, payload: dict = Body(default={})):
    with connect() as c:
        p = get(c, pid)
    scene = payload.get("sceneId")
    floor = payload.get("floor", 1)
    if not isinstance(floor, int) or not 1 <= floor <= p["floors"]:
        raise HTTPException(422, "请选择有效楼层")
    if scene and not any(s["id"] == scene for s in p["design"]["scenes"]):
        raise HTTPException(422, "场景不存在")
    if not p["design"]["rooms"]:
        raise HTTPException(422, "请先建立房间")
    try:
        artifact = image_provider(os.getenv("IMAGE_PROVIDER", "local")).generate(
            p, scene, floor
        )
        result = dict(artifact.metadata)
        if not isinstance(result.get("simulated"), bool) or not result.get("provider"):
            raise ValueError("Image Provider 必须声明 provider 与 simulated 来源信息")
        image = Image.open(BytesIO(artifact.content))
        image.load()
    except Exception as e:
        raise HTTPException(422, "图像生成未完成：" + str(e)[:200])
    rid = ident()
    folder = UPLOADS / pid
    folder.mkdir(parents=True, exist_ok=True)
    image.convert("RGB").save(folder / (rid + ".png"))
    result.update(
        id=rid,
        createdAt=now(),
        version=p["version"],
        revision=p["revision"],
        name=next(
            (s["name"] for s in p["design"]["scenes"] if s["id"] == scene), "彩平图"
        )
        + f" · {floor}F",
        floor=floor,
    )
    with connect() as c:
        c.execute("BEGIN IMMEDIATE")
        p = get(c, pid)
        p["renders"].append(result)
        commit(c, p, "生成本地示意图", result["message"])
    return p


@app.get("/api/projects/{pid}/renders/{rid}")
def render_file(pid: str, rid: str):
    with connect() as c:
        p = get(c, pid)
    if not any(r["id"] == rid for r in p["renders"]):
        raise HTTPException(404, "示意图不存在")
    return FileResponse(UPLOADS / pid / (rid + ".png"), media_type="image/png")


@app.get("/api/projects/{pid}/export/{fmt}")
def export(pid: str, fmt: str, floor: int | None = None):
    with connect() as c:
        p = get(c, pid)
    if floor is not None and not 1 <= floor <= p["floors"]:
        raise HTTPException(422, "请选择有效楼层")
    # R5 两档：施工包、厂家包（订货单 S9a 接入）有问题就拦，422 正文即提示原文；业主 HTML、图片放行带提示。
    gate, issues = circuit_rules.export_gate(p, fmt)
    if gate == "block":
        raise HTTPException(422, circuit_rules.block_message(issues))
    try:
        content, media, name = export_bytes(p, fmt, floor)
    except ValueError as e:
        raise HTTPException(422, str(e))
    with connect() as c:
        c.execute("BEGIN IMMEDIATE")
        current = get(c, pid)
        event(
            c,
            current,
            "导出资料",
            name + " · " + ("已复核设计数据" if p["approved"] else "草稿"),
        )
    return Response(
        content,
        media_type=media,
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{quote(name)}",
            "X-Document-Status": "reviewed-design" if p["approved"] else "draft",
            "X-Business-Status": "NOT_RELEASED",
            # 提示档放行时带上问题原文（UTF-8 百分号编码，前端 decodeURIComponent）。
            **({"X-Export-Warnings": quote(circuit_rules.TEXT["issueSep"].join(issues))} if gate == "warn" else {}),
        },
    )




@app.get("/api/projects/{pid}/scene")
def scene_page(pid: str):
    """智能场景交互页：手机可直接打开（inline，不触发下载）。"""
    with connect() as c:
        p = get(c, pid)
    return Response(scene_html(p), media_type="text/html; charset=utf-8")


@app.get("/api/qrcode")
def qr_image(text: str = ""):
    import qrcode as qrlib
    img = qrlib.make(text or " ", box_size=6, border=2)
    buf = BytesIO()
    img.save(buf, format="PNG")
    return Response(buf.getvalue(), media_type="image/png")

@app.get("/api/scene-templates")
def scene_templates():
    return knowledge_index().get("sceneTemplates", [])


@app.get("/api/scene-package")
def scene_package_api():
    """灯具编号原则 + 场景包全文（含每个场景的空间×职能×位置规则与触发/退出）。"""
    package = knowledge_index().get("scenePackage", {})
    return package or {"id": "", "scenes": [], "roleCodes": [], "principle": ""}


@app.get("/api/products")
def products(category: str = "", brand: str = "", q: str = "", scheme: str = "",
             source: str = "", limit: int = 0):
    """灯具与设备库：读工作台自己的产品库（随源码分发的产品数据）。

    兼容老字段（id/category/type/name/model/brand/power/price/cctMin/cctMax/control/
    protocol/dimmable/tunable/priceVerified/notes/sourcePath），另加
    scheme（方案类型）/unit/warranty/cutout/cct/angle/priceSource/source。
    """
    if limit:
        limit = max(1, min(int(limit), 2000))
    items = PL.list_products(DB, category=category, brand=brand, q=q, scheme=scheme,
                             source=source, limit=limit)
    if items:
        return items
    # 产品库还没灌 → 退回本地索引快照，别让页面空着
    items = knowledge_index().get("products", [])
    return [x for x in items if not category or x.get("category") == category]


class BaselineInput(BaseModel):
    revision: int
    evidence: dict[str, Any] = Field(default_factory=dict)
    submitter: str = Field(default="", max_length=100)
    decision: str = Field(default="submitted", pattern=r"^(submitted|approved|returned|conditional)$")
    reviewNote: str = Field(default="", max_length=5000)


# 三维灯光模块（工作台内嵌的三维空间 + /api/lighting3d/*）——必须排在下面的 SPA 兜底路由之前
from . import lighting3d as lighting3d_mod  # noqa: E402
lighting3d_mod.register(app)


DIST = ROOT / "frontend" / "dist"
if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/{full_path:path}")
    def spa(full_path: str):
        if full_path.startswith("api/"):
            raise HTTPException(404, "接口不存在")
        # dist 里的真实文件直接给（favicon、三张联系二维码、robots 这类），
        # 其余路径才落到 SPA 外壳。必须限定在 DIST 之内，防目录穿越。
        if full_path:
            target = (DIST / full_path).resolve()
            if target.is_file() and (target == DIST or DIST in target.parents):
                return FileResponse(target)
        # SPA 外壳曾被浏览器缓存住（看起来像「改了没生效」）：
        # 于是新构建（hash 变了的 assets）根本不会被取——这里明确不许缓存 index.html。
        return FileResponse(DIST / "index.html", headers={
            "Cache-Control": "no-cache, no-store, must-revalidate", "Pragma": "no-cache"})
