from pathlib import Path
import hashlib
from io import BytesIO
import json, zipfile, re, os, base64, math, copy
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageChops
from openpyxl import Workbook
from openpyxl.styles import PatternFill
from docx import Document
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.lib.utils import ImageReader

from .floors import floor_label
from . import panels as panel_rules
from . import circuit_rules
from . import light_occlusion as LO


def _verify_3d_source(p):
    """Refuse exports from a converted design after a source drawing changes."""
    design = p.get("design") or {}
    digest = design.get("source3dHash")
    if p.get("mode") != "3D" or not digest:
        return
    store = Path(os.getenv("DATA_DIR", str(Path(__file__).resolve().parents[1] / "data"))) / "lighting3d"
    source = store / (p["id"] + ".source.dxf")
    if not source.is_file() or hashlib.sha256(source.read_bytes()).hexdigest() != digest:
        raise ValueError("三维原始图纸已变更，请在三维页重新同步灯位再导出")
    st = _read_json(store / (p["id"] + ".json"))
    if st.get("uploaded_at", "") != design.get("source3dGeneration", ""):
        raise ValueError("三维图纸已重新解析，请在三维页重新同步灯位再导出")


def finished_dxf(p):
    """Build a design DXF; overlay on the original when traceable CAD is present."""
    from . import dxf_lighting as dl
    import ezdxf
    store = Path(os.getenv("DATA_DIR", str(Path(__file__).resolve().parents[1] / "data"))) / "lighting3d"
    source = store / (p["id"] + ".source.dxf")
    _verify_3d_source(p)
    original = source.is_file()
    info = _read_json(store / (p["id"] + ".json")) if original else {}
    doc = ezdxf.readfile(source) if original else ezdxf.new("R2010")
    # 老 CAD 源可能是 R12（AC1009）；LWPOLYLINE 要求 R2000+。
    # 只在导出副本上升级 DXF 版本，不改源文件。
    if str(doc.dxfversion) < "AC1015":
        doc.dxfversion = "AC1027"
    transform = (info.get("parsed") or {}).get("source") or {}
    if original and not all(key in transform for key in ("source_unit", "source_scale", "source_base_xy", "source_y_flip")):
        # Historical stores: derive the exact same subject bbox and padding
        # as the parser, instead of assuming the CAD origin is zero.
        bbox, _ = dl.locate_subject(dl.collect(doc))
        if not bbox:
            raise ValueError("无法标定原始 DXF 坐标")
        transform = {"source_unit": "mm", "source_scale": 0.001,
                     "source_base_xy": [bbox[0] - 1000, bbox[3] + 1000],
                     "source_y_flip": True, "lamp_layer": "GUANGLV_修改灯位"}
    if not original:
        # No CAD geometry in a raster-only project. Coordinates stay in design
        # canvas units and DXF units are explicitly unspecified, not guessed mm.
        doc.header["$INSUNITS"] = 0
        transform = {"source_scale": 1, "source_base_xy": [0, 0],
                     "source_y_flip": False}
    scale = transform["source_scale"]
    if not isinstance(scale, (int, float)) or not scale:
        raise ValueError("原图比例无效")
    bx, by = transform["source_base_xy"]
    layer = transform.get("lamp_layer") or "GUANGLV_修改灯位"
    def ensure_layer(name, color):
        if name not in doc.layers:
            doc.layers.new(name, dxfattribs={"color": color})
    ensure_layer(layer, 1)
    ensure_layer("GUANGLV_智能面板", 4)
    ensure_layer("GUANGLV_传感器", 3)
    ensure_layer("GUANGLV_其他设备", 5)
    model = doc.modelspace()
    def location(x, y):
        return (float(x) / 26 / scale + bx,
                by + (-1 if transform["source_y_flip"] else 1) * float(y) / 26 / scale)
    if not original:
        ensure_layer("GUANGLV_空间轮廓", 8)
        ensure_layer("GUANGLV_墙体", 7)
        ensure_layer("GUANGLV_图纸说明", 2)
        design = p.get("design") or {}
        for r in design.get("rooms", []):
            points = r.get("points") or []
            if len(points) < 3 and float(r.get("width") or 0) > 2 and float(r.get("height") or 0) > 2:
                x, y = float(r["x"]), float(r["y"])
                w, h = float(r["width"]), float(r["height"])
                points = [{"x": x, "y": y}, {"x": x+w, "y": y},
                          {"x": x+w, "y": y+h}, {"x": x, "y": y+h}]
            if len(points) >= 3:
                coords = [location(v["x"], v["y"]) for v in points]
                model.add_lwpolyline(coords, close=True, dxfattribs={"layer": "GUANGLV_空间轮廓"})
                model.add_text(str(r.get("name") or ""), dxfattribs={
                    "layer": "GUANGLV_空间轮廓", "height": 7,
                    "insert": location(r.get("x", 0), r.get("y", 0))})
        for w in design.get("walls", []):
            model.add_line(location(w["x"], w["y"]), location(w["x2"], w["y2"]),
                           dxfattribs={"layer": "GUANGLV_墙体"})
        model.add_text("NO SOURCE CAD: canvas coordinates only; verify scale and walls before construction",
                       dxfattribs={"layer": "GUANGLV_图纸说明", "height": 10, "insert": (0, -20)})
    for f in p.get("design", {}).get("fixtures", []):
        x, y = location(f["x"], f["y"])
        radius = 100 if original else 6
        model.add_circle((x, y), radius, dxfattribs={"layer": layer})
        model.add_text(str(f["code"]), dxfattribs={"layer": layer, "height": 180 if original else 6,
                                                   "insert": (x + radius + 2, y + radius + 2)})
        if f.get("stripPath"):
            model.add_lwpolyline([location(v["x"],v["y"]) for v in f["stripPath"]],
                                 dxfattribs={"layer":layer})
    from .space_geometry import design_geometry
    geometry = design_geometry(p)
    ensure_layer("GUANGLV_门窗", 4)
    for opening in geometry["openings"]:
        model.add_line(location(opening["x0"]*26,opening["z0"]*26),
                       location(opening["x1"]*26,opening["z1"]*26),
                       dxfattribs={"layer":"GUANGLV_门窗"})
    if original and p.get("design", {}).get("rooms"):
        ensure_layer("GUANGLV_空间轮廓", 8)
        ensure_layer("GUANGLV_墙体", 7)
        for room in geometry["rooms"]:
            model.add_lwpolyline([location(x*26,y*26) for x,y in room["poly"]],
                                 close=True,dxfattribs={"layer":"GUANGLV_空间轮廓"})
        for wall in geometry["walls"]:
            if wall["bottomM"] > 0: continue
            model.add_line(location(wall["x0"]*26,wall["z0"]*26),
                           location(wall["x1"]*26,wall["z1"]*26),dxfattribs={"layer":"GUANGLV_墙体"})
    ensure_layer("GUANGLV_家具", 8)
    for item in p.get("design", {}).get("furniture", []):
        angle = math.radians(item.get("rotation", 0))
        w, depth = item["widthM"]*13, item["depthM"]*13
        corners = [location(item["x"]+x*math.cos(angle)-y*math.sin(angle),
                            item["y"]+x*math.sin(angle)+y*math.cos(angle))
                   for x, y in [(-w,-depth),(w,-depth),(w,depth),(-w,depth)]]
        model.add_lwpolyline(corners, close=True, dxfattribs={"layer": "GUANGLV_家具"})
        model.add_text(item["kind"], dxfattribs={"layer": "GUANGLV_家具", "height": 120 if original else .12,
                                                "insert": location(item["x"], item["y"])})
    for device in p.get("design", {}).get("devices", []):
        x, y = location(device.get("x", 0), device.get("y", 0))
        kind = device.get("type")
        device_layer = ("GUANGLV_智能面板" if kind == "面板" else
                        "GUANGLV_传感器" if kind == "传感器" else "GUANGLV_其他设备")
        size = 100 if original else 6
        if kind == "面板":
            model.add_lwpolyline([(x-size, y-size), (x+size, y-size),
                                  (x+size, y+size), (x-size, y+size)],
                                 close=True, dxfattribs={"layer": device_layer})
        else:
            model.add_circle((x, y), size, dxfattribs={"layer": device_layer})
        model.add_text(str(device.get("code") or device.get("name") or kind or "设备"),
                       dxfattribs={"layer": device_layer, "height": 180 if original else 6,
                                   "insert": (x + size + 2, y)})
    from tempfile import NamedTemporaryFile
    with NamedTemporaryFile(suffix=".dxf") as tmp:
        doc.saveas(tmp.name)
        return Path(tmp.name).read_bytes()

# 空间库 / 位置库（前端同一份 JSON，编号对照表从它读，读不到只跳过该 sheet，不影响导出）
CODE_LIBRARY_FILE = Path(__file__).resolve().parents[1] / "frontend" / "src" / "data" / "code-library.json"
SCENE_PACKAGE_FILE = Path(__file__).resolve().parents[1] / "frontend" / "src" / "data" / "scene-package.json"


def _read_json(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}

FONT = next(
    (
        str(p)
        for p in (
            ([Path(os.environ["FONT_PATH"])] if os.getenv("FONT_PATH") else [])
            + [
                Path(__file__).resolve().parent / "fonts" / "GuanglvPlanSans.ttf",
                Path("/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf"),
                Path("C:/Windows/Fonts/msyh.ttc"),
                Path("/System/Library/Fonts/PingFang.ttc"),
            ]
        )
        if p.exists()
    ),
    None,
)


def font(size):
    return ImageFont.truetype(FONT, size) if FONT else ImageFont.load_default(size=size)


def label(p):
    if p.get("isDemo"):
        return "草稿 · 示例数据 · 不可施工 / 不可正式报价"
    if p.get("approved"):
        return "已人工复核 · 仅内部设计资料 · NOT_RELEASED · 非正式施工图/报价"
    return "草稿 · NOT_RELEASED · 未经五道复核 · 不可施工 / 不可正式报价"


# 光斑画在墙内侧留出的余量（画布像素）——光晕柔边不能再抹到墙外面去
POOL_EDGE_INSET_PX = 4


def _pixel_design(d, floor, pt):
    """把本层设计几何换算到画布像素坐标，喂给光斑裁剪器（`light_occlusion`）。

    裁剪器只认「points 多边形」，所以这里把墙 / 空间 / 家具都预先变成像素多边形：
    图纸坐标是各向异性缩放的（x×1.7、y×1.65），只有先换算再打射线，光斑才和画出来的墙对齐。
    """
    def px(x, y):
        return pt(x, y)

    rooms = []
    for r in d.get("rooms") or []:
        if r.get("source") == "fixture-code":
            continue
        row = {"id": r.get("id"), "floor": r.get("floor", 1)}
        pts = r.get("points") or []
        if len(pts) >= 3:
            row["points"] = [{"x": px(v["x"], v["y"])[0], "y": px(v["x"], v["y"])[1]} for v in pts]
        else:
            x0, y0 = px(r.get("x", 0), r.get("y", 0))
            x1, y1 = px(r.get("x", 0) + r.get("width", 0), r.get("y", 0) + r.get("height", 0))
            row["x"], row["y"] = x0, y0
            row["width"], row["height"] = x1 - x0, y1 - y0
        rooms.append(row)

    walls = []
    for w in d.get("walls") or []:
        try:
            a = px(w["x"], w["y"])
            b = px(w["x2"], w["y2"])
        except (KeyError, TypeError):
            continue
        walls.append({
            "floor": w.get("floor", 1), "bottomM": w.get("bottomM"),
            "x": a[0], "y": a[1], "x2": b[0], "y2": b[1],
        })

    furniture = []
    for f in d.get("furniture") or []:
        if f.get("hidden"):
            continue
        pts = f.get("points") or []
        row = {"floor": f.get("floor", 1), "heightM": f.get("heightM")}
        if len(pts) >= 3:
            row["points"] = [{"x": px(v["x"], v["y"])[0], "y": px(v["x"], v["y"])[1]} for v in pts]
        else:
            hw = (f.get("widthM") or 0) * 13
            hd = (f.get("depthM") or 0) * 13
            if hw <= 0 or hd <= 0:
                continue
            ang = math.radians(f.get("rotation", 0) or 0)
            ca, sa = math.cos(ang), math.sin(ang)
            row["points"] = [
                {"x": px(f.get("x", 0) + u * ca - v * sa, f.get("y", 0) + u * sa + v * ca)[0],
                 "y": px(f.get("x", 0) + u * ca - v * sa, f.get("y", 0) + u * sa + v * ca)[1]}
                for u, v in ((-hw, -hd), (hw, -hd), (hw, hd), (-hw, hd))
            ]
        furniture.append(row)
    return {"rooms": rooms, "walls": walls, "furniture": furniture}


_POOL_TILES = {}


def _pool_tile(rad, rgb, alpha):
    """一块柔光光斑贴图：中心最亮、向外渐隐。"""
    key = (int(rad), rgb, alpha)
    tile = _POOL_TILES.get(key)
    if tile is not None:
        return tile
    size = max(2, int(rad * 2) + 2)
    grad = Image.radial_gradient("L").resize((size, size))          # 0 中心 → 255 边缘
    tile = Image.new("RGBA", (size, size), (*rgb, 0))
    tile.putalpha(grad.point(lambda v: int((255 - v) * alpha / 255)))
    _POOL_TILES[key] = tile
    return tile


def _paste_pool(glow, x, y, rad, rgb, alpha, poly):
    """把一盏灯的光斑贴到光晕层：有裁剪多边形就只铺在里面（并往内收一圈），没有才画整圆。"""
    tile = _pool_tile(rad, rgb, alpha)
    size = tile.size[0]
    left, top = int(x - size / 2), int(y - size / 2)
    mask = tile.getchannel("A")
    if poly and len(poly) >= 4:
        shrink = LO.shrink_pool(poly, POOL_EDGE_INSET_PX)
        pm = Image.new("L", (size, size), 0)
        ImageDraw.Draw(pm).polygon(
            [(left + px + size / 2, top + py + size / 2) for px, py in shrink[1:]], fill=255
        )
        mask = ImageChops.multiply(mask, pm)
    glow.paste(Image.new("RGB", (size, size), rgb), (left, top), mask)


def render_plan(p, scene_id=None, floor=None):
    d = p["design"]
    night = bool(scene_id)
    floor = floor or min((r.get("floor", 1) for r in d["rooms"]), default=1)
    im = Image.new("RGB", (1600, 1300), "#182822" if night else "#fafbf8")
    draw = ImageDraw.Draw(im)
    sx, sy = 1.7, 1.65

    def pt(x, y):
        return (int(x * sx + 60), int(y * sy + 95))

    scene = next((s for s in d["scenes"] if s["id"] == scene_id), {})
    rooms = [r for r in d["rooms"] if floor is None or r.get("floor", 1) == floor]
    room_ids = {r["id"] for r in rooms}
    for r in rooms:
        if r.get("source") == "fixture-code":
            # 按灯具编号建立的空间没有边界，只用于归组与表格。
            continue
        a = pt(r["x"], r["y"])
        b = pt(r["x"] + r["width"], r["y"] + r["height"])
        fill = "#35483e" if night else r.get("color", "#e2e6df")
        if r.get("points"):
            draw.polygon(
                [pt(v["x"], v["y"]) for v in r["points"]],
                fill=fill,
                outline="#718374",
                width=5,
            )
        else:
            draw.rectangle([a, b], fill=fill, outline="#657467", width=5)
        draw.text(
            pt(r["x"] + 10, r["y"] + 10),
            r["name"],
            font=font(22),
            fill="#edf3e9" if night else "#435347",
        )
        draw.text(
            pt(r["x"] + 10, r["y"] + 30),
            f"{r.get('area',0)} m² · {floor_label(r.get('floor', 1), p.get('basements', 0))}",
            font=font(15),
            fill="#81917f",
        )
    for w in d.get("walls", []):
        if floor is None or w.get("floor", 1) == floor:
            draw.line(
                [pt(w["x"], w["y"]), pt(w["x2"], w["y2"])], fill="#506357", width=7
            )
    for o in d.get("openings", []):
        if floor is not None and o.get("floor", 1) != floor:
            continue
        a = pt(o["x"], o["y"])
        length = o.get("width", 50)
        ang = math.radians(o.get("rotation", 0))
        b = pt(o["x"] + length * math.cos(ang), o["y"] + length * math.sin(ang))
        draw.line([a, b], fill="#b98447" if o["type"] == "门" else "#6aabb7", width=6)
    for t in d.get("texts", []):
        draw.text(pt(t["x"], t["y"]), t["text"], font=font(14), fill="#81917f")
    for item in d.get("furniture", []):
        if item.get("floor", 1) != floor:
            continue
        angle = math.radians(item.get("rotation", 0))
        w, depth = item["widthM"]*13, item["depthM"]*13
        corners = [pt(item["x"]+x*math.cos(angle)-y*math.sin(angle),
                      item["y"]+x*math.sin(angle)+y*math.cos(angle))
                   for x, y in [(-w,-depth),(w,-depth),(w,depth),(-w,depth)]]
        draw.polygon(corners, fill="#b99c78" if night else "#d9c9af", outline="#896d4c", width=2)
        draw.text(pt(item["x"]-w/2, item["y"]), item["kind"], font=font(12), fill="#594f43")
    if night:
        # 灯光分布示意：每盏亮灯一块柔光光斑，**按空间边界 + 墙 + 高柜裁剪**
        # （现场 2026-10-17：「光斑不能穿过墙体、门、家具表面」）。
        # 原来是一个整圆再整体高斯模糊 —— 光斑铺过墙、铺到户型外面，是现场看到的那张图。
        px_design = _pixel_design(d, floor, pt)
        glow = Image.new("RGBA", im.size, (0, 0, 0, 0))
        for f in d["fixtures"]:
            if floor is not None and f.get("floor", 1) != floor:
                continue
            if f.get("type") == "灯带":
                continue                      # 灯带没有地面光斑
            st = scene.get("states", {}).get(
                f["id"], {"on": False, "brightness": 0, "cct": 3000}
            )
            if not st.get("on"):
                continue
            x, y = pt(f["x"], f["y"])
            rad = 25 + st.get("brightness", 50) * 0.6
            rgb = (255, 190, 92) if st.get("cct", 3000) < 4000 else (207, 225, 255)
            alpha = min(255, int(st.get("brightness", 50) * 1.5))
            _paste_pool(
                glow, x, y, rad, rgb, alpha,
                LO.pool_polygon(
                    px_design,
                    {"x": x, "y": y, "floor": f.get("floor", 1), "roomId": f.get("roomId")},
                    rad,
                ),
            )
        im = Image.alpha_composite(im.convert("RGBA"), glow).convert("RGB")
        draw = ImageDraw.Draw(im)
    for f in d["fixtures"]:
        if floor is not None and f.get("floor", 1) != floor:
            continue
        x, y = pt(f["x"], f["y"])
        if f.get("type") == "灯带":
            path = f.get("stripPath") or [{"x": f["x"], "y": f["y"]}, {"x": f["x"] + max(30, f.get("length", 1) * 26), "y": f["y"]}]
            draw.line([pt(v["x"], v["y"]) for v in path], fill="#e8b969", width=8, joint="curve")
            draw.text((x + 12, y - 10), f["code"] + f" · {f.get('length', 0):g}m", font=font(12), fill="#c1c7b6" if night else "#777e69")
        else:
            draw.ellipse((x - 7, y - 7, x + 7, y + 7), fill="#e8b969", outline="#9b773d", width=2)
            draw.text((x + 12, y - 10), f["code"], font=font(12), fill="#c1c7b6" if night else "#777e69")
    title = (
        p["name"]
        + f" · {floor_label(floor, p.get('basements', 0))}"
        + (" · " + scene.get("name", "灯光示意") if night else " · 彩色平面图")
    )
    draw.text((60, 28), title, font=font(32), fill="#e4eadb" if night else "#314d40")
    draw.text((60, 1220), label(p), font=font(21), fill="#bb874b")
    draw.text(
        (60, 1260),
        f"{p['code']} / V{p['version']:02} · "
        + (
            "灯光分布示意，非实景与照度模拟"
            if night
            else "单位：画布坐标（非施工尺寸） · 多楼层请分别校核"
        ),
        font=font(16),
        fill="#87947f",
    )
    return im


def is_light(f):
    """注：窗帘存放在 fixtures 里但不是灯，不进灯具清单 / 回路 / 参数表，改列入「智能设备」。"""
    return f.get("type") != "窗帘"


def lights(p):
    return [f for f in p["design"]["fixtures"] if is_light(f)]


def fixture_watts(f):
    """灯带 power 是 W/m，按 length 折算；其它灯具 power 就是单灯功率。"""
    w = float(f.get("power") or 0)
    if f.get("type") == "灯带":
        length = float(f.get("length") or 0)
        if length > 0:
            w *= length
    return round(w, 1)


def cct_reason(f):
    """「原因」列：待核灯标「色温待核」；偏离单色 3000K 的写设计师原因（未填标出）。"""
    if not is_light(f):
        return ""
    if f.get("cctPending"):
        return "色温待核"
    mode = f.get("colorMode") or ("单色" if f.get("tunable") is False else "双色")
    cct = f.get("cct", f.get("cctMin"))
    if mode == "单色" and cct == 3000:
        return ""
    return (f.get("cctReason") or "").strip() or "偏离 3000K 单色·原因未填"


def rows(p, include_price=True):
    room_names = {r["id"]: r["name"] for r in p["design"]["rooms"]}
    return [
        [f.get(k, "") for k in ("code", "name", "model", "brand", "type")]
        + [
            (f.get("group") or "").strip(),
            room_names.get(f.get("roomId"), "未分配"),
            f.get("position", ""),
            floor_label(f.get("floor", 1), p.get("basements", 0)),
            f.get("circuit", ""),
            fixture_watts(f),
            f.get("price", 0) if include_price else 0,
            (
                ("已核实" if f.get("priceVerified") else "模拟/待核实")
                if include_price
                else "不含价（交付版）"
            ),
            f.get("length", 0),
            f.get("powerSupply", ""),
            f.get("controller", ""),
            cct_reason(f),
        ]
        for f in lights(p)
    ]


# 地址口径（智能工程师定）：总线协议必须编址；硬接线/模拟调光靠「模块＋通道」定位；
# 无线协议地址在配网时由网关分配，设计阶段不编数。DALI/KNX 及其它一律要填地址。
WIRED_CONTROLS = ("开关控制", "0–10V", "0-10V", "PWM")
WIRELESS_CONTROLS = ("Zigbee", "Wi-Fi", "蓝牙 Mesh")
KNOWN_CONTROLS = ("DALI", "KNX") + WIRED_CONTROLS + WIRELESS_CONTROLS


def _join(values):
    return "、".join(dict.fromkeys(v for v in values if v))


def circuit_row(p, key, members):
    """回路表一行：回路｜灯具数量｜总功率｜所属空间｜调光方式｜模块/网关｜通道｜地址｜缺项。"""
    design = p["design"]
    room_names = {r["id"]: r["name"] for r in design.get("rooms", [])}
    devices = [d for d in design.get("devices", []) if d.get("type") in ("网关", "控制器")]

    def module_name(ref):
        for d in devices:
            if ref in (d.get("model"), d.get("code"), d.get("id")):
                return " ".join(x for x in (d.get("name"), d.get("model")) if x) or ref
        return ref

    ctrls = list(dict.fromkeys((f.get("control") or "").strip() for f in members))
    missing = []
    space = _join(room_names.get(f.get("roomId"), "") for f in members)
    if key == "未分配" or any(f.get("roomId") not in room_names for f in members):
        missing.append("所属空间")
    control = _join(ctrls)
    if "" in ctrls:
        missing.append("调光方式")
    if len([c for c in ctrls if c]) > 1:
        missing.append("调光方式不一致")
    if any(c and c not in KNOWN_CONTROLS for c in ctrls):
        # 统筹兜底：不在 8 种里的老写法地址按必填处理（走下面 else 分支），不因认不出而漏标。
        missing.append("调光方式未识别")
    module = _join(module_name((f.get("controller") or "").strip()) for f in members)
    if not module:
        missing.append("模块/网关")
    channel = _join((f.get("channel") or "").strip() for f in members)
    if any(not (f.get("channel") or "").strip() for f in members):
        missing.append("通道")
    if len(ctrls) == 1 and ctrls[0] in WIRED_CONTROLS:
        address = "—"
    elif len(ctrls) == 1 and ctrls[0] in WIRELESS_CONTROLS:
        address = "调试时分配"
    else:
        address = _join((f.get("address") or "").strip() for f in members)
        if any(not (f.get("address") or "").strip() for f in members):
            missing.append("地址")
    # 超出 D3 默认上限、无线跨空间，接在缺项文字后面。
    missing += circuit_rules.flags(members, room_names, circuit_rules.circuit_key({"circuit": key}))
    return [key, len(members), round(sum(fixture_watts(f) for f in members), 1),
            space, control, module, channel, address, "、".join(missing)]

def spreadsheet(p, include_price=True):
    wb = Workbook()
    ws = wb.active
    ws.title = "灯具与报价基础"
    ws.append([label(p)])
    ws.append(
        [
            "编号",
            "名称",
            "型号",
            "品牌",
            "类型",
            "灯组",
            "房间",
            "位置",
            "楼层",
            "回路",
            "功率 W",
            "参考单价",
            "价格状态",
            "灯带长度 m",
            "电源",
            "控制器",
            "原因",
        ]
    )
    for row in rows(p, include_price):
        ws.append(
            [
                (
                    "'" + v
                    if isinstance(v, str) and v.startswith(("=", "+", "-", "@"))
                    else v
                )
                for v in row
            ]
        )
    void_rooms = [r for r in p["design"].get("rooms", []) if r.get("isVoid")]
    if void_rooms:
        ws.append([])
        ws.append(
            [
                f"挑空（贯通）空间 {len(void_rooms)} 个：挑空区不计使用面积；"
                "挑空灯具按贯通总高记安装高度（挑空灯具在贯通到的其它楼层按同一情景显示）。"
            ]
        )
    pending = [f for f in p["design"]["fixtures"] if f.get("cctPending")]
    if pending:
        room_names = {r["id"]: r["name"] for r in p["design"]["rooms"]}
        ws_p = wb.create_sheet("待核色温")
        ws_p.append([label(p)])
        ws_p.append([f"色温待核 {len(pending)} 盏：导入 / 知识库未给色温，图纸暂按 3000K 占位，请按实物确认"])
        ws_p.append(["编号", "名称", "型号", "房间", "楼层", "回路"])
        for f in pending:
            ws_p.append([
                f.get("code", ""), f.get("name", ""), f.get("model", ""),
                room_names.get(f.get("roomId"), "未分配"),
                floor_label(f.get("floor", 1), p.get("basements", 0)), f.get("circuit", ""),
            ])
    circuit = wb.create_sheet("回路表")
    circuit.append(
        ["回路", "灯具数量", "总功率 W", "所属空间", "调光方式", "模块/网关", "通道", "地址", "缺项",
         "注意：需电气设计人员校核线径及负载"]
    )
    circuits = {}
    for f in lights(p):
        circuits.setdefault(f.get("circuit") or "未分配", []).append(f)
    red = PatternFill("solid", fgColor="FFC7CE")
    for key, members in circuits.items():
        row = circuit_row(p, key, members)
        circuit.append(row)
        if row[8]:
            for cell in circuit[circuit.max_row]:
                cell.fill = red
    overview = wb.create_sheet("场景清单")
    overview.append(["场景", "编号", "空间", "自动化层级", "优先级", "触发方式", "渐变秒", "退出机制"])
    for s_ in p["design"]["scenes"]:
        overview.append([
            s_.get("name", ""),
            s_.get("templateCode", ""),
            s_.get("space", ""),
            s_.get("level", ""),
            s_.get("priority", ""),
            s_.get("trigger", "手动"),
            s_.get("fade", 1),
            s_.get("exit", ""),
        ])
    scenes = wb.create_sheet("场景表")
    scenes.append(["场景", "触发", "渐变秒", "灯具编号", "开关", "亮度 %", "色温 K"])
    codes = {f["id"]: f["code"] for f in p["design"]["fixtures"]}
    curtain_ids = {f["id"] for f in p["design"]["fixtures"] if f.get("type") == "窗帘"}
    for s in p["design"]["scenes"]:
        for fid, st in s.get("states", {}).items():
            # 窗帘不接入场景联动：场景表不列窗帘。
            if fid in curtain_ids:
                continue
            scenes.append(
                [
                    s["name"],
                    s.get("trigger", "手动"),
                    s.get("fade", 1),
                    codes.get(fid, fid),
                    "开" if st.get("on") else "关",
                    st.get("brightness", 0),
                    st.get("cct", 3000),
                ]
            )
    quotes = wb.create_sheet("报价基础汇总")
    quotes.append([label(p)])
    if not include_price:
        quotes.append(["交付版：不含价（零售价不进业主/施工交付物）"])
    quotes.append(
        ["灯具编号", "纳入报价", "计价数量", "单位", "单价", "参考小计", "价格状态"]
    )
    total = 0
    for f in p["design"]["fixtures"]:
        qty = f.get("length", 1) if f.get("type") == "灯带" else 1
        price = f.get("price", 0) if include_price else 0
        subtotal = round(qty * price, 2) if f.get("quote") else 0
        total += subtotal
        quotes.append(
            [
                f["code"],
                "是" if f.get("quote") else "否",
                qty,
                "米" if f.get("type") == "灯带" else "盏",
                price,
                subtotal,
                (
                    ("已核实" if f.get("priceVerified") else "模拟/待核实")
                    if include_price
                    else "不含价（交付版）"
                ),
            ]
        )
    quotes.append(["参考合计（非正式报价）", "", "", "", "", round(total, 2)])
    quotes.append(["不含人工、安装、税费、运费、独立电源及智能设备；需人工核定范围。"])
    room_names = {r["id"]: r["name"] for r in p["design"]["rooms"]}
    strips = wb.create_sheet("灯带与电源交付")
    strips.append(["灯带编号", "空间", "长度 m", "独立电源", "控制器 / 通道", "功率 W（按长度）", "备注"])
    total_strip_length = 0
    total_strip_watts = 0
    for f in p["design"]["fixtures"]:
        if f.get("type") == "灯带":
            length = f.get("length", 0)
            total_strip_length += length
            total_strip_watts += fixture_watts(f)
            strips.append([f.get("code", ""), room_names.get(f.get("roomId"), "未分配"), length, f.get("powerSupply", ""), f.get("controller", ""), fixture_watts(f), f.get("notes", "")])
    strips.append(["灯带总长度", "", round(total_strip_length, 2), "", "", round(total_strip_watts, 1), "交付前须核对电源容量、压降与驱动兼容性"])
    devices = wb.create_sheet("智能设备")
    devices.append(["编号", "名称", "类型", "型号", "所属空间", "位置", "协议", "地址", "按键数", "按键刻字（短按刻字 / 长按仅功能）", "备注"])
    for dev in p["design"].get("devices", []):
        is_panel = dev.get("type") == "面板"
        key_n = int(dev.get("keys") or 0) if is_panel else 0
        engraving = " · ".join(panel_key_texts(dev, key_n)) if key_n else ""
        devices.append(
            [
                dev.get("code", ""),
                dev.get("name", ""),
                dev.get("type", ""),
                dev.get("model", ""),
                room_names.get(dev.get("roomId"), "未分配"),
                dev.get("position", ""),
                dev.get("protocol", ""),
                dev.get("address", ""),
                key_n if is_panel else "",
                engraving,
                dev.get("notes", ""),
            ]
        )
    # 注：窗帘按外挂设备列在设备之后，不带色温、不计功率。
    for f in p["design"]["fixtures"]:
        if is_light(f):
            continue
        devices.append(
            [
                f.get("code", ""),
                f.get("name", ""),
                f.get("type", ""),
                f.get("model", ""),
                room_names.get(f.get("roomId"), "未分配"),
                f.get("position", ""),
                f.get("protocol", ""),
                f.get("address", ""),
                "",
                "",
                f.get("notes", ""),
            ]
        )
    # 外挂联动：场景里的窗帘 / 布撤防动作（如 00.1 全开 → 窗帘打开、传感器撤防），交集成商配置。
    linkage = wb.create_sheet("外挂联动")
    linkage.append(["场景", "编号", "空间", "外挂设备", "动作"])
    for s_ in p["design"].get("scenes", []):
        for a in s_.get("automationActions") or []:
            linkage.append([
                s_.get("name", ""),
                s_.get("templateCode", ""),
                # 00.1 全开 / 00.2 全关归「全屋」（D1 口径），其余用场景自身 space。
                "全屋" if s_.get("templateCode") in ("00.1", "00.2") else s_.get("space", ""),
                a.get("deviceType", ""),
                a.get("action", ""),
            ])
    # 面板刻字清单：4 键＝世聪「4键8功能」，每键两行（短按 / 长按）；一个物理键只刻一次（短按），
    # 长按只写功能、不刻字。刻字口径（全图标 / 全文字 2 字 / 屏显免雕刻）见 backend/panels.py。
    scenes_by_id = {s_.get("id"): s_.get("name", "") for s_ in p["design"].get("scenes", [])}
    engrave = wb.create_sheet("面板刻字")
    engrave.append(["面板编号", "面板名称", "所属空间", "按键数", "键位", "操作", "刻字（丝印文字）", "绑定情景", "备注"])
    for dev in p["design"].get("devices", []):
        if dev.get("type") != "面板":
            continue
        key_n = int(dev.get("keys") or 0)
        labels = list(dev.get("keyLabels") or [])
        sc = list(dev.get("keyScenes") or [])
        long_labels = list(dev.get("keyLongLabels") or [])
        long_sc = list(dev.get("keyLongScenes") or [])
        head_note = "；".join(
            x for x in (
                "刻字方式：" + panel_rules.mode_label(dev),
                "；".join(("第%d键：%s" % (k + 1, m)) if k >= 0 else m for k, m in panel_rules.label_issues(dev)),
                dev.get("notes", ""),
            ) if x
        )
        for i in range(key_n):
            for press, scs in (("短按", sc), ("长按", long_sc)):
                text = panel_rules.engrave_text(dev, i, long=(press == "长按"))
                if press == "长按" and not text:
                    lab = str(long_labels[i]).strip() if i < len(long_labels) and long_labels[i] else ""
                    text = "（长按不刻字）" + (" 功能：%s" % lab if lab else "")
                engrave.append(
                    [
                        dev.get("code", ""),
                        dev.get("name", ""),
                        room_names.get(dev.get("roomId"), "未分配"),
                        key_n,
                        i + 1,
                        press,
                        text,
                        scenes_by_id.get(scs[i] if i < len(scs) else "", ""),
                        head_note if (i == 0 and press == "短按") else "",
                    ]
                )
    params = wb.create_sheet("灯具安装参数")
    params.append(
        [
            "编号",
            "灯组",
            "光源类型",
            "X",
            "Y",
            "安装高度 m",
            "最大亮度 %",
            "最低色温 K",
            "最高色温 K",
            "控制方式",
            "支持调光",
            "支持色温调节",
        ]
    )
    for f in lights(p):
        params.append(
            [
                f.get("code", ""),
                (f.get("group") or "").strip(),
                # 旧数据没有 colorMode：能调色温＝双色，不能＝单色。
                f.get("colorMode")
                or ("单色" if f.get("tunable") is False else "双色"),
            ]
            + [
                f.get(k, "")
                for k in [
                    "x",
                    "y",
                    "installHeight",
                    "brightnessMax",
                    "cctMin",
                    "cctMax",
                    "control",
                    "dimmable",
                    "tunable",
                ]
            ]
        )
    # 编号规则：编号 = 空间码 + 位置码 + 职能码 + 序号；把全量对照表交给人工核号。
    library = _read_json(CODE_LIBRARY_FILE)
    if library.get("spaces"):
        codes_ws = wb.create_sheet("编号规则")
        codes_ws.append([label(p)])
        codes_ws.append(
            [
                "编号 = 空间码（小写，1-3 位）+ 位置码（小写，1 位）+ 职能码（大写，可省略）+ 序号（1-3 位）",
                library.get("rule", ""),
            ]
        )
        codes_ws.append(["分区", "空间码", "空间名", "适用户型", "主要功能"])
        for item in library.get("spaces", []):
            codes_ws.append(
                [
                    item.get("group", ""),
                    item.get("code", ""),
                    item.get("name", ""),
                    "、".join(item.get("houses", [])),
                    item.get("note", ""),
                ]
            )
        codes_ws.append([])
        codes_ws.append(["老编号通用位置（26 位，含义固定；也作为老图纸的兜底）", "位置码", "位置名", "默认职能", "说明"])
        for item in library.get("positions", []):
            codes_ws.append(
                [
                    item.get("group", ""),
                    item.get("code", ""),
                    item.get("name", ""),
                    item.get("defaultRole", ""),
                    item.get("note", ""),
                ]
            )
        # 位置按空间取表：每个空间有自己的家具/功能位，布灯与设备的位置下拉就是这张表。
        palettes = library.get("positionPalettes", {})
        space_palette = library.get("spacePalette", {})
        if space_palette:
            codes_ws.append([])
            codes_ws.append(["位置按空间取表：每个空间的家具 / 功能位", "", "", "", "", "", ""])
            codes_ws.append(
                ["空间分区", "空间码", "空间名", "位置表", "位置码", "位置名", "默认职能（说明）"]
            )
            space_meta = {sp.get("code"): sp for sp in library.get("spaces", [])}
            for sc, pid in space_palette.items():
                pal = palettes.get(pid) or {}
                meta = space_meta.get(sc, {})
                for item in pal.get("positions", []):
                    codes_ws.append(
                        [
                            meta.get("group", ""),
                            sc,
                            meta.get("name", ""),
                            pal.get("name", ""),
                            item.get("code", ""),
                            item.get("name", ""),
                            f'{item.get("defaultRole", "")} {item.get("note", "")}'.strip(),
                        ]
                    )
        codes_ws.append([])
        codes_ws.append(["职能码", "职能名", "说明"])
        for role in _read_json(SCENE_PACKAGE_FILE).get("roleCodes", []):
            codes_ws.append([role.get("code", ""), role.get("name", ""), role.get("note", "")])
    review = wb.create_sheet("人工复核")
    review.append(["项目", "复核人", "复核时间", "对应修订"])
    for k, v in p.get("reviews", {}).items():
        review.append(
            [k, v.get("reviewer", ""), v.get("at", ""), v.get("revision", "")]
        )
    # Prevent formula injection across all user-controlled cells, not only fixture table.
    for sheet in wb:
        sheet.freeze_panes = "A3"
        for row in sheet:
            for cell in row:
                if isinstance(cell.value, str) and cell.value.startswith(
                    ("=", "+", "-", "@")
                ):
                    cell.value = "'" + cell.value
        for col in sheet.columns:
            sheet.column_dimensions[col[0].column_letter].width = 22
    b = BytesIO()
    wb.save(b)
    return b.getvalue()


def word(p):
    d = Document()
    d.add_heading(p["name"] + " · 灯光设计说明", 0)
    d.add_paragraph(label(p))
    d.add_paragraph(
        f"项目编号：{p['code']} | 版本：V{p['version']:02} | 客户：{p.get('client','')} | 地址：{p.get('address','')}"
    )
    d.add_heading("设计范围", 1)
    d.add_paragraph(
        p.get("notes") or "空间照明、灯具布置、智能场景配置及报价基础数据。"
    )
    d.add_heading("空间清单", 1)
    for r in p["design"]["rooms"]:
        d.add_paragraph(
            f"{r['name']} · {floor_label(r.get('floor', 1), p.get('basements', 0))} · {r.get('area',0)} m² · 层高 {r.get('heightM',2.8)} m · 来源 {r.get('source','manual')}"
        )
    d.add_heading("智能场景", 1)
    for s in p["design"]["scenes"]:
        d.add_paragraph(
            f"{s['name']}：{s.get('description','')}，{s.get('trigger','手动')}，渐变 {s.get('fade',0)} 秒。"
        )
    strips = [f for f in p["design"]["fixtures"] if f.get("type") == "灯带"]
    d.add_heading("灯带与电源交付", 1)
    d.add_paragraph(f"灯带总长度：{sum(f.get('length', 0) for f in strips):.2f} m。")
    for f in strips:
        d.add_paragraph(f"{f.get('code','')} · {f.get('length',0)} m · 电源 {f.get('powerSupply','未填写')} · 控制 {f.get('controller','未填写')}")
    d.add_heading("交付限制", 1)
    d.add_paragraph(
        "图示不是正式施工图。未经核实的价格为参考数据。回路负载、驱动兼容性、线径及消防规范须由专业人员现场核验；本系统不连接真实灯具、不提供照度计算。"
    )
    b = BytesIO()
    d.save(b)
    return b.getvalue()


def uploaded_plan_image(p):
    """The uploaded 彩平底图 for this project, if any.

    The workbench no longer draws its own colour plan, so the delivery PDF shows
    the drawing the designer uploaded. Prefers the raster preview (readable for
    PDF/SVG uploads too) and never a generated plan.
    """
    design = p.get("design", {})
    files = p.get("files") or []
    target = next((f for f in files if f.get("id") == design.get("baseFileId")), None)
    if target is None:
        target = next((f for f in files if f.get("preview")), None)
    if not target:
        return None
    name = target.get("preview") or target.get("path")
    if not name or not p.get("id"):
        return None
    root = Path(os.getenv("DATA_DIR", str(Path(__file__).resolve().parent.parent / "data"))).resolve()
    path = root / "uploads" / "projects" / p["id"] / name
    return path if path.is_file() else None


def plain_plan(p, floor=None):
    """A monochrome placement sheet; no invented colour-plan geometry or scale."""
    d = p.get("design") or {}
    floor = floor if floor is not None else min(
        (int(r.get("floor") or 1) for r in d.get("rooms", [])), default=1)
    canvas_im = Image.new("RGB", (1640, 1380), "white")
    draw = ImageDraw.Draw(canvas_im)
    scale, ox, oy = 1.68, 130, 106
    from .space_geometry import design_geometry
    geometry = design_geometry(p)
    geometry["rooms"] = [r for r in geometry["rooms"] if r["floor"] == floor]
    geometry["walls"] = [w for w in geometry["walls"] if w["floor"] == floor]
    geometry["openings"] = [o for o in geometry["openings"] if o["floor"] == floor]
    points = [(x*26,y*26) for r in geometry["rooms"] for x,y in r["poly"]]
    for key in ("fixtures", "devices", "furniture"):
        for item in d.get(key, []):
            if item.get("floor",1) != floor: continue
            points.append((float(item.get("x") or 0),float(item.get("y") or 0)))
            if key == "furniture":
                radius=math.hypot(item["widthM"],item["depthM"])*13
                points.extend([(item["x"]-radius,item["y"]-radius),(item["x"]+radius,item["y"]+radius)])
    if points and any(x<0 or y<0 or x>820 or y>690 for x,y in points):
        x0,y0 = min(x for x,y in points)-20,min(y for x,y in points)-20
        x1,y1 = max(x for x,y in points)+20,max(y for x,y in points)+20
        scale = min(1370/max(1,x1-x0),1130/max(1,y1-y0),8)
        ox,oy = 130-x0*scale+(1370-(x1-x0)*scale)/2,106-y0*scale+(1130-(y1-y0)*scale)/2
    pt = lambda x, y: (int(ox + float(x) * scale), int(oy + float(y) * scale))
    files = p.get("files") or []
    base_id = d.get("baseFileId")
    own = next((f for f in files if f.get("preview") and int(f.get("floor") or 1) == floor), None)
    # Only old projects without assigned floor may reuse the base-file image.
    if own is None and not any(f.get("floor") for f in files):
        own = next((f for f in files if f.get("id") == base_id and f.get("preview")), None)
    if own and p.get("id"):
        root = Path(os.getenv("DATA_DIR", str(Path(__file__).resolve().parents[1] / "data"))).resolve()
        preview = root / "uploads" / "projects" / p["id"] / str(own["preview"])
        if preview.is_file():
            with Image.open(preview) as source:
                base = source.convert("L").convert("RGB")
                rect = None
                if own.get("type") == "DXF" and own.get("previewBox"):
                    store = Path(os.getenv("DATA_DIR", str(Path(__file__).resolve().parents[1] / "data"))) / "lighting3d"
                    source = (_read_json(store/(p["id"]+".json")).get("parsed") or {}).get("source") or {}
                    box = own["previewBox"]
                    if source.get("source_base_xy") and source.get("source_scale") and box.get("pixelScale"):
                        unit=26*source["source_scale"];pixel=unit/box["pixelScale"];bx,by=source["source_base_xy"]
                        rect=((box["minX"]-bx)*unit-box.get("margin",0)*pixel,
                              (by-box["maxY"])*unit-box.get("margin",0)*pixel,
                              box["width"]*pixel,box["height"]*pixel)
                if rect:
                    size=(max(1,round(rect[2]*scale)),max(1,round(rect[3]*scale)))
                    if max(size) <= 12000:
                        base=base.resize(size);base=Image.blend(base,Image.new("RGB",size,"white"),.12)
                        canvas_im.paste(base,pt(rect[0],rect[1]))
                else:
                    base.thumbnail((int(820 * 1.68), int(690 * 1.68)))
                    base = Image.blend(base, Image.new("RGB", base.size, "white"), .12)
                    canvas_im.paste(base, (130 + (int(820 * 1.68)-base.width)//2,
                                          106 + (int(690 * 1.68)-base.height)//2))
            draw = ImageDraw.Draw(canvas_im)
    # A DXF project has no raster preview. Reuse only its persisted, actually
    # parsed wall/door/window coordinates, never generate fictitious outlines.
    model = {}
    if not own and not geometry["rooms"] and p.get("id") and floor == 1:
        store = Path(os.getenv("DATA_DIR", str(Path(__file__).resolve().parents[1] / "data"))) / "lighting3d"
        model = _read_json(store / (p["id"] + ".json"))
        if not (store / (p["id"] + ".source.dxf")).is_file():
            model = {}
        parsed = model.get("parsed") or {}
        for wall in parsed.get("walls") or []:
            draw.line([pt(float(wall["x0"]) * 26, float(wall["z0"]) * 26),
                       pt(float(wall["x1"]) * 26, float(wall["z1"]) * 26)],
                      fill="#222222", width=3)
        for kind, color in (("doors", "#444444"), ("windows", "#888888")):
            for edge in parsed.get(kind) or []:
                if all(k in edge for k in ("x0", "z0", "x1", "z1")):
                    draw.line([pt(float(edge["x0"]) * 26, float(edge["z0"]) * 26),
                               pt(float(edge["x1"]) * 26, float(edge["z1"]) * 26)],
                              fill=color, width=2)
    rooms = [r for r in d.get("rooms", []) if int(r.get("floor") or 1) == floor
             and float(r.get("width") or 0) > 2 and float(r.get("height") or 0) > 2]
    for r in rooms:
        points = r.get("points") or []
        if len(points) >= 3:
            coords = [pt(v["x"], v["y"]) for v in points]
        else:
            x, y, w, h = (float(r.get(k) or 0) for k in ("x", "y", "width", "height"))
            coords = [pt(x, y), pt(x+w, y), pt(x+w, y+h), pt(x, y+h)]
        draw.line(coords + [coords[0]], fill="#242424", width=3)
        draw.text(pt(r.get("x", 0), r.get("y", 0)), str(r.get("name") or "空间"),
                  fill="#191919", font=font(18))
    for w in d.get("walls", []):
        if int(w.get("floor") or 1) == floor and w.get("source") != "space-boundary":
            draw.line([pt(w["x"], w["y"]), pt(w["x2"], w["y2"])], fill="#171717", width=5)
    for opening in geometry["openings"]:
        a,b=pt(opening["x0"]*26,opening["z0"]*26),pt(opening["x1"]*26,opening["z1"]*26)
        draw.line([a,b],fill="white",width=9)
        if opening["type"] == "窗":
            draw.line([a,b],fill="#5d98a9",width=3)
        else:
            dx,dy=b[0]-a[0],b[1]-a[1]
            draw.line([a,(a[0]-dy*.7,a[1]+dx*.7)],fill="#967443",width=2)
    for item in d.get("furniture", []):
        if item.get("floor",1) != floor: continue
        angle=math.radians(item.get("rotation",0));w,depth=item["widthM"]*13,item["depthM"]*13
        corners=[pt(item["x"]+x*math.cos(angle)-y*math.sin(angle),
                    item["y"]+x*math.sin(angle)+y*math.cos(angle))
                 for x,y in [(-w,-depth),(w,-depth),(w,depth),(-w,depth)]]
        draw.polygon(corners,fill="#e7e1d6",outline="#806e54",width=2)
        draw.text(pt(item["x"]-w*.5,item["y"]),item["kind"],fill="#5c513f",font=font(12))
    for f in d.get("fixtures", []):
        if int(f.get("floor") or 1) != floor: continue
        x, y = pt(f.get("x", 0), f.get("y", 0))
        if f.get("stripPath"):
            draw.line([pt(v["x"],v["y"]) for v in f["stripPath"]],fill="#a17725",width=4,joint="curve")
        draw.ellipse((x-7, y-7, x+7, y+7), fill="white", outline="#000000", width=3)
        draw.text((x+9, y-14), str(f.get("code") or "灯"), fill="#080808", font=font(14))
    if model and not d.get("fixtures"):
        for f in model.get("lights") or (model.get("parsed") or {}).get("lamps") or []:
            x, y = pt(float(f.get("x") or 0) * 26, float(f.get("z") or 0) * 26)
            draw.ellipse((x-7, y-7, x+7, y+7), fill="white", outline="#000000", width=3)
            draw.text((x+9, y-14), str(f.get("code") or "灯位"), fill="#080808", font=font(14))
    for dev in d.get("devices", []):
        if int(dev.get("floor") or 1) != floor: continue
        x, y = pt(dev.get("x", 0), dev.get("y", 0))
        draw.rectangle((x-7, y-7, x+7, y+7), fill="white", outline="#111111", width=3)
        draw.text((x+9, y-14), str(dev.get("code") or dev.get("name") or dev.get("type") or "设备"),
                  fill="#111111", font=font(14))
    if not own and not model and not rooms and not d.get("walls"):
        draw.text((ox, 300), "无可用原图或空间轮廓；此图仅展示已保存设备位置",
                  fill="#555555", font=font(25))
    draw.text((40, 24), f"{p['name']} · {floor_label(floor, p.get('basements', 0))} · 平面布置图",
              fill="#171717", font=font(29))
    draw.text((40, 1305), label(p), fill="#404040", font=font(20))
    draw.text((40, 1340), "原图/已解析墙线参考 + 已布置灯具/设备；边界及比例须人工核验，不可直接施工",
              fill="#555555", font=font(16))
    return canvas_im


def plain_plan_bytes(p, fmt, floor=None):
    im = plain_plan(p, floor)
    out = BytesIO()
    im.save(out, format="PNG" if fmt == "png" else "JPEG", quality=92)
    return out.getvalue()


def pdf(p, include_price=True):
    b = BytesIO()
    c = canvas.Canvas(b, pagesize=(842, 720))
    pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
    floors = sorted(set(r.get("floor", 1) for r in p["design"]["rooms"]) |
                    set(f.get("floor", 1) for f in p.get("files", []))) or [1]
    for floor in floors:
        c.setFont("STSong-Light", 16)
        c.drawString(
            30,
            690,
            f"{p['name']} / {floor_label(floor, p.get('basements', 0))}",
        )
        c.drawImage(ImageReader(plain_plan(p, floor)), 20, 66, width=802,
                    height=602, preserveAspectRatio=True, anchor="c")
        c.setFont("STSong-Light", 11)
        c.drawString(30, 40, label(p) + ("" if include_price else " · 不含价交付版"))
        c.showPage()
    c.setFont("STSong-Light", 16)
    c.drawString(30, 685, "灯具清单与回路 · " + label(p))
    y = 650
    c.setFont("STSong-Light", 10)
    for r in rows(p, include_price):
        c.drawString(
            30,
            y,
            " | ".join(
                str(x)
                for x in [
                    # 编号｜名称｜空间｜楼层｜回路｜功率 W｜单价 元（对应 rows() 列下标）
                    r[0],
                    r[1],
                    r[6],
                    r[8],
                    r[9],
                    str(r[10]) + "W",
                    str(r[11]) + " 元"
                    + ("（未核实）" if r[12] == "模拟/待核实" else ""),
                ]
            ),
        )
        y -= 20
        if y < 50:
            c.showPage()
            c.setFont("STSong-Light", 10)
            y = 680
    c.save()
    return b.getvalue()


def _plan_data_uri(file_meta, project_id):
    """把某张图纸的预览图变成 data URI（业主版 HTML 完全自包含，离线可用）。"""
    name = (file_meta or {}).get("preview") or (file_meta or {}).get("path")
    if not name or not project_id:
        return ""
    root = Path(os.getenv("DATA_DIR", str(Path(__file__).resolve().parent.parent / "data"))).resolve()
    path = root / "uploads" / "projects" / project_id / name
    if not path.is_file():
        return ""
    suffix = path.suffix.lower()
    mime = "image/jpeg" if suffix in (".jpg", ".jpeg") else ("image/webp" if suffix == ".webp" else "image/png")
    return "data:" + mime + ";base64," + base64.b64encode(path.read_bytes()).decode("ascii")


def scene_floor_plans(p, fixtures):
    """按楼层组装：每层的底图 + 该层灯具。业主版 HTML 可切层查看。

    相同的底图只内嵌一次（多楼层共用一张图时不会把文件撑大）。
    """
    files = p.get("files") or []
    design = p.get("design", {})
    base_file = next((f for f in files if f.get("id") == design.get("baseFileId")), None)
    floors = sorted({int(f.get("floor") or 1) for f in fixtures}) or [1]
    basements = int(p.get("basements", 0) or 0)
    room_by_id = {r.get("id"): r for r in design.get("rooms", [])}

    def void_floors(room):
        """挑空（贯通）覆盖的楼层：自身楼层 + 向上贯通的层。"""
        base = int(room.get("floor") or 1)
        n = max(1, min(6, int(room.get("voidLevels") or 2)))
        return [base + i for i in range(n)]
    images = {}
    plans = []
    for n in floors:
        meta = next(
            (f for f in files if f.get("preview") and int(f.get("floor") or 1) == n),
            None,
        )
        if meta is None:
            meta = base_file if (base_file or {}).get("preview") else next(
                (f for f in files if f.get("preview")), None
            )
        image_id = ""
        if meta and meta.get("id"):
            image_id = meta["id"]
            if image_id not in images:
                uri = _plan_data_uri(meta, p.get("id"))
                if uri:
                    images[image_id] = uri
                else:
                    image_id = ""
        # 每层带上裁剪几何（②空间边界 + ③墙体）：业主页的探测范围要和工作台一致，
        # 否则工作台上按墙裁过、业主页却又画成整圆穿墙。
        # 挑空灯具：归在别的楼层、但挑空通到本层 → 本层淡显一份，业主切层不会以为灯丢了
        ghosts = []
        for f in fixtures:
            if int(f.get("floor") or 1) == n:
                continue
            room = room_by_id.get(f.get("roomId"))
            if not room or not room.get("isVoid"):
                continue
            if n not in void_floors(room):
                continue
            ghosts.append(
                {
                    **f,
                    "voidFrom": floor_label(int(f.get("floor") or 1), basements),
                    "voidRoom": room.get("name") or "挑空",
                }
            )
        ghost_floors = sorted({g["voidFrom"] for g in ghosts})
        plans.append(
            {
                "floor": n,
                "label": floor_label(n, basements),
                "imageId": image_id,
                "fixtures": [f for f in fixtures if int(f.get("floor") or 1) == n],
                "ghosts": ghosts,
                "voidNote": (
                    f"本层挑空处另有 {len(ghosts)} 盏灯（{'、'.join(ghost_floors)}，随情景同步）"
                    if ghosts
                    else ""
                ),
                "geometry": {
                    "walls": [
                        {
                            "x": w.get("x"),
                            "y": w.get("y"),
                            "x2": w.get("x2"),
                            "y2": w.get("y2"),
                        }
                        for w in design.get("walls", [])
                        if w.get("floor") is None or int(w.get("floor") or 1) == n
                    ],
                    "rooms": [
                        {
                            "id": r.get("id"),
                            "name": r.get("name", ""),
                            "points": r.get("points") or [],
                            "x": r.get("x"),
                            "y": r.get("y"),
                            "width": r.get("width"),
                            "height": r.get("height"),
                            "isVoid": bool(r.get("isVoid")),
                            "voidLevels": int(r.get("voidLevels") or 2),
                            "heightM": r.get("heightM"),
                        }
                        for r in design.get("rooms", [])
                        if int(r.get("floor") or 1) == n
                    ],
                },
            }
        )
    return {"plans": plans, "images": images}


def scene_html(p):
    """自包含的智能场景交互 HTML：只有底图 + 发光灯具 + 场景切换，其余内容一律不显示。"""
    _verify_3d_source(p)
    design = p.get("design", {})
    room_names = {r["id"]: r.get("name", "") for r in design.get("rooms", [])}
    fixtures = [
        {
            "id": f["id"],
            "type": f.get("type"),
            "code": f.get("code", ""),
            "name": f.get("name", ""),
            "group": (f.get("group") or "").strip(),
            "space": f.get("space") or room_names.get(f.get("roomId"), ""),
            # 挑空（贯通）判定要用空间：带上 roomId，才能认出「这盏灯在挑空区里」
            "roomId": f.get("roomId"),
            "floor": f.get("floor", 1),
            "colorHex": f.get("colorHex") or "",
            "colored": bool(f.get("colored")) or f.get("colorMode") == "彩色",
            "x": f.get("x"),
            "y": f.get("y"),
            "spotScale": f.get("spotScale", 1),
            "spotRatio": f.get("spotRatio", 1),
            "stripPath": f.get("stripPath") or [],
            "length": f.get("length", 1),
            "stripRotation": f.get("stripRotation", 0),
            "stripCast": f.get("stripCast"),
        }
        for f in design.get("fixtures", [])
    ]
    # 注：交付清单拆「灯具」与「外挂设备」（窗帘 + 智能设备，不计价）。
    deliverables = [
        {"code": f.get("code", ""), "name": f.get("name") or f.get("type") or "灯具",
         "model": f.get("model") or "", "room": f.get("space") or room_names.get(f.get("roomId"), ""),
         "circuit": (f.get("circuit") or "未归属") if is_light(f) else "—",
         "kind": "灯具" if is_light(f) else "外挂设备"}
        for f in design.get("fixtures", [])
    ]
    deliverables.extend({
        "code": dev.get("code", ""), "name": dev.get("name") or dev.get("type") or "设备",
        "model": " · ".join(str(dev.get(k) or "") for k in ("brand", "series", "model")).strip(" · "),
        "room": room_names.get(dev.get("roomId"), ""),
        "circuit": dev.get("address") or "—",
        "kind": "外挂设备"}
        for dev in design.get("devices", []))
    light_count = sum(1 for f in design.get("fixtures", []) if is_light(f))
    scenes = [
        {
            "id": s.get("id"),
            "name": s.get("name"),
            "fade": s.get("fade", 1),
            "trigger": s.get("trigger") or "手动",
            "priority": s.get("priority") or "",
            "level": s.get("level") or "",
            "exit": s.get("exit") or "",
            "description": s.get("description") or "",
            "states": s.get("states", {}),
        }
        for s in design.get("scenes", [])
    ]
    floor_of_room = {r["id"]: int(r.get("floor") or 1) for r in design.get("rooms", [])}
    panels = []
    for dev in design.get("devices", []):
        if dev.get("type") != "面板":
            continue
        key_n = int(dev.get("keys") or 0)
        labels = list(dev.get("keyLabels") or [])
        key_scenes = list(dev.get("keyScenes") or [])
        long_labels = list(dev.get("keyLongLabels") or [])
        long_scenes = list(dev.get("keyLongScenes") or [])
        panels.append(
            {
                "id": dev.get("id"),
                "code": dev.get("code", ""),
                "name": dev.get("name", ""),
                "brand": dev.get("brand", ""),
                "series": dev.get("series", ""),
                "model": dev.get("model", ""),
                "space": room_names.get(dev.get("roomId"), ""),
                "position": dev.get("position", ""),
                "x": dev.get("x"),
                "y": dev.get("y"),
                "keys": int(dev.get("keys") or 0),
                "keyLabels": list(dev.get("keyLabels") or []),
                "engraveMode": dev.get("engraveMode") or "text",
                "floor": int(dev.get("floor") or floor_of_room.get(dev.get("roomId")) or 1),
                "keys": [
                    {
                        "label": str(labels[i]) if i < len(labels) else "",
                        "scene": key_scenes[i] if i < len(key_scenes) else "",
                        "longLabel": str(long_labels[i]) if i < len(long_labels) else "",
                        "longScene": long_scenes[i] if i < len(long_scenes) else "",
                    }
                    for i in range(key_n)
                ],
            }
        )
    curtain_ids = {f.get("id") for f in design.get("fixtures", []) if f.get("type") == "窗帘"}
    sensors = []
    for dev in design.get("devices", []):
        if dev.get("type") != "传感器":
            continue
        sensors.append(
            {
                "id": dev.get("id"),
                "code": dev.get("code", ""),
                "name": dev.get("name", ""),
                "space": room_names.get(dev.get("roomId"), ""),
                "roomId": dev.get("roomId"),
                "floor": int(dev.get("floor") or floor_of_room.get(dev.get("roomId")) or 1),
                "x": dev.get("x"),
                "y": dev.get("y"),
                "range": float(dev.get("range")) if dev.get("range") is not None else 80.0,
                # 手动调整过的探测范围（相对传感器坐标的多边形）；空 = 用整圆/扇形 (+几何裁剪)
                "coveragePoints": dev.get("coveragePoints") or [],
                # 视场角/朝向：360°+0° ＝ 整圆（与改造前的纯距离判定一致）；设了就是扇形，防穿墙。
                "fov": float(dev.get("fov")) if dev.get("fov") is not None else 360.0,
                "heading": float(dev.get("heading")) if dev.get("heading") is not None else 0.0,
                "delay": float(dev.get("offDelaySeconds") or 0),
                "brightness": dev.get("sensorBrightness", 100),
                "cct": dev.get("sensorCct", 4000),
                "lights": [fid for fid in (dev.get("linkedLights") or []) if fid not in curtain_ids],
            }
        )
    # 设备层：面板 / 网关 / 控制器 / 温控器 等设备标记（业主页可整层开关，避免与灯具重叠看不清）。
    devices_payload = [
        {
            "id": dev.get("id"),
            "code": dev.get("code", ""),
            "name": dev.get("name", ""),
            "brand": dev.get("brand", ""),
            "series": dev.get("series", ""),
            "model": dev.get("model", ""),
            "type": dev.get("type", ""),
            "space": room_names.get(dev.get("roomId"), ""),
            "position": dev.get("position", ""),
            "keys": int(dev.get("keys") or 0),
            "x": dev.get("x"),
            "y": dev.get("y"),
            "floor": int(dev.get("floor") or floor_of_room.get(dev.get("roomId")) or 1),
        }
        for dev in design.get("devices", [])
    ]
    plans_payload = scene_floor_plans(p, fixtures)
    tpl_path = Path(__file__).resolve().parent / "scene_html_template.html"
    tpl = tpl_path.read_text(encoding="utf-8") if tpl_path.is_file() else "<!DOCTYPE html><html><body>模板缺失</body></html>"
    data_json = json.dumps(
        {
            "title": p.get("name", "智能场景"),
            "code": p.get("code", ""),
            "projectFloors": p.get("floors", 1),
            "projectBasements": p.get("basements", 0),
            "fixtureCount": light_count,
            "deliverables": deliverables,
            "plans": plans_payload["plans"],
            "images": plans_payload["images"],
            "scenes": scenes,
            "panels": panels,
            "sensors": sensors,
            "devices": devices_payload,
            "deliveryNote": (
                "本项目有 "
                + str(len([r for r in design.get("rooms", []) if r.get("isVoid")]))
                + " 个挑空（贯通）空间："
                "挑空区不计使用面积；挑空灯具按贯通总高记安装高度，"
                "并在贯通到的其它楼层按同一情景显示。"
                if any(r.get("isVoid") for r in design.get("rooms", []))
                else ""
            ),
        },
        ensure_ascii=False,
    )
    return tpl.replace("@@DATA@@", data_json).replace("@@BASE@@", "").encode("utf-8")


def _esc(s):
    return str(s if s is not None else "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


_LOCKS = {1: 1, 2: 2, 4: 2, 6: 3, 12: 4}
_PANEL_CSS = """
* { box-sizing: border-box; }
body { margin: 0; padding: 28px 32px 60px; background: #fafbf8; color: #2c3730;
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; }
header h1 { font-size: 22px; margin: 0 0 6px; }
header .note { font-size: 12px; color: #77857a; margin: 0 0 20px; }
.panel { border: 1px solid #dbe2d8; border-radius: 14px; padding: 16px 18px 20px; margin: 0 0 18px;
  background: #fff; page-break-inside: avoid; }
.phead { display: flex; align-items: baseline; gap: 10px; margin-bottom: 12px; }
.phead b { font-size: 15px; letter-spacing: .04em; }
.phead span { font-size: 12px; color: #77857a; }
.keygrid { display: grid; gap: 8px; max-width: 460px; }
.keygrid.fourkeys { grid-template-columns: repeat(2, minmax(0, 1fr)); max-width: 520px; }
.bigkey { border: 1px solid #8d9988; border-radius: 12px; padding: 8px; background: #fbfcfa; }
.bigkey-label { font-size: 10px; color: #77857a; margin-bottom: 6px; }
.bigkey-cells { display: grid; gap: 6px; }
.keyblock { border: 1px solid #cfd8cd; border-radius: 10px; padding: 6px 7px 7px; background: #f7faf5; }
.keyno { font-size: 10px; color: #77857a; margin-bottom: 4px; }
.cell { display: flex; align-items: baseline; gap: 6px; padding: 4px 0;
  border-top: 1px dashed #e2e8df; }
.cell:first-of-type { border-top: 0; }
.cell .press { flex: 0 0 auto; font-size: 10px; color: #3d6280; background: #eef3f7;
  border-radius: 5px; padding: 1px 5px; }
.cell .lab { font-size: 15px; font-weight: 700; letter-spacing: .06em; }
.cell .sc { font-size: 10px; color: #8d9988; margin-left: auto; }
h2 { font-size: 16px; margin: 26px 0 10px; }
table { border-collapse: collapse; width: 100%; font-size: 12px; }
th, td { border: 1px solid #dbe2d8; padding: 6px 8px; text-align: left; }
th { background: #eef2ec; }
.empty { color: #77857a; font-size: 13px; }
footer { margin-top: 24px; font-size: 11px; color: #8d9988; }
.issue { color: #b03a2e; font-size: 12px; margin: 6px 0 0; }
"""


def panel_key_texts(dev, key_n):
    """每键摘要（短按刻字 / 长按功能，长按不刻字），供 Excel「智能设备」页用。"""
    long_labels = list(dev.get("keyLongLabels") or [])
    out = []
    for i in range(key_n):
        short = panel_rules.engrave_text(dev, i)
        long_ = str(long_labels[i]).strip() if i < len(long_labels) and long_labels[i] else ""
        if not short and not long_:
            continue
        out.append("%d短按 %s / %d长按 %s" % (i + 1, short or "—", i + 1, long_ or "—"))
    return out


def panel_engraving_html(p):
    """面板刻字排版图：给面板厂家的可打印清单（按真实键位排布 + 逐键刻字表）。"""
    design = p.get("design", {})
    room_names = {r["id"]: r.get("name", "") for r in design.get("rooms", [])}
    scenes_by_id = {s_.get("id"): s_.get("name", "") for s_ in design.get("scenes", [])}
    panels = [dev for dev in design.get("devices", []) if dev.get("type") == "面板"]
    cards = []
    list_rows = []
    for dev in panels:
        key_n = int(dev.get("keys") or 0)
        labels = list(dev.get("keyLabels") or [])
        key_scenes = list(dev.get("keyScenes") or [])
        long_labels = list(dev.get("keyLongLabels") or [])
        long_scenes = list(dev.get("keyLongScenes") or [])
        cols = _LOCKS.get(key_n, 2)
        # 4 键＝世聪「4键8功能」：每键只刻一次（短按），长按只做功能、不刻字。
        presses = (("短按", labels, key_scenes), ("长按", long_labels, long_scenes))

        def _text(press, labs, i):
            text = panel_rules.engrave_text(dev, i, long=(press == "长按"))
            if press == "长按" and not text:
                lab = str(labs[i]).strip() if i < len(labs) and labs[i] else ""
                return "（长按不刻字）" + (" 功能：%s" % lab if lab else "")
            return text

        for i in range(key_n):
            for press, labs, scs in presses:
                list_rows.append(
                    "<tr><td>%s</td><td>%s</td><td>%s</td><td>%d</td><td>%d</td><td>%s</td><td>%s</td><td>%s</td></tr>"
                    % (
                        _esc(dev.get("code", "")),
                        _esc(dev.get("name", "")),
                        _esc(room_names.get(dev.get("roomId"), "未分配")),
                        key_n,
                        i + 1,
                        _esc(press),
                        _esc(_text(press, labs, i)),
                        _esc(scenes_by_id.get(scs[i] if i < len(scs) else "", "")),
                    )
                )

        def _key_block(i):
            rows = []
            for press, labs, scs in presses:
                lab = panel_rules.engrave_text(dev, i, long=(press == "长按"))
                if not lab:
                    if press == "短按":
                        lab = "（未刻字）"
                    else:
                        lab = "长按 · " + (str(labs[i]) if i < len(labs) and labs[i] else "—") + "（不刻字）"
                sec = scenes_by_id.get(scs[i] if i < len(scs) else "", "")
                rows.append(
                    '<div class="cell"><span class="press">%s</span>'
                    '<span class="lab">%s</span><span class="sc">%s</span></div>'
                    % (_esc(press), _esc(lab), _esc(sec))
                )
            return (
                '<div class="keyblock"><div class="keyno">第 %d 键</div>%s</div>'
                % (i + 1, "".join(rows))
            )

        if key_n == 4:
            # 4 键面板实际是 2 个大按键，每个大按键上 2 个小按键（4键8功能）。
            inner = "".join(
                '<div class="bigkey"><div class="bigkey-label">大按键 %d</div>'
                '<div class="bigkey-cells">%s</div></div>'
                % (gi + 1, "".join(_key_block(i) for i in grp))
                for gi, grp in enumerate(((0, 1), (2, 3)))
            )
            grid_html = '<div class="keygrid fourkeys">%s</div>' % inner
        else:
            grid_html = '<div class="keygrid" style="grid-template-columns: repeat(%d, 1fr)">%s</div>' % (
                cols,
                "".join(_key_block(i) for i in range(key_n)),
            )
        cards.append(
            '<section class="panel"><div class="phead"><b>%s</b>'
            '<span>%s · %s · %s · %s · %s · %d 键（%d 功能）· %s</span></div>%s%s</section>'
            % (
                _esc(dev.get("code", "")),
                _esc(dev.get("name", "")),
                _esc(room_names.get(dev.get("roomId"), "未分配")),
                _esc(dev.get("brand") or "品牌待选"),
                _esc(dev.get("series") or "系列待选"),
                _esc(dev.get("model") or "型号待选"),
                key_n,
                key_n * 2,
                _esc(panel_rules.mode_label(dev)),
                grid_html,
                "".join(
                    '<p class="issue">%s</p>' % _esc(("第 %d 键：%s" % (k + 1, m)) if k >= 0 else m)
                    for k, m in panel_rules.label_issues(dev)
                ),
            )
        )
    body = "".join(cards) if cards else (
        '<p class="empty">本项目还没有放置面板：请在工作台给面板设置按键数与刻字后重新导出。</p>'
    )
    html = (
        '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        "<title>" + _esc(p.get("name", "项目")) + " · 面板刻字排版图</title>"
        "<style>" + _PANEL_CSS + "</style></head><body>"
        "<header><h1>" + _esc(p.get("name", "项目")) + " · 面板刻字排版图</h1>"
        '<p class="note">' + _esc(label(p)) + " · 交付面板厂家前请人工核对刻字文字与键位。</p></header>"
        + body
        + "<h2>逐键刻字清单</h2>"
        "<table><thead><tr><th>面板编号</th><th>面板名称</th><th>所属空间</th><th>按键数</th>"
        "<th>键位</th><th>操作</th><th>刻字（丝印文字）</th><th>绑定情景</th></tr></thead><tbody>"
        + "".join(list_rows)
        + "</tbody></table>"
        "<footer>打印说明：键位为示意，并非厂家真实外观；应以产品样册和实物核对型号、尺寸、刻字。4 键＝4 个物理键 × 短按/长按（4键8功能）；每键只刻一次（短按），长按仅功能不刻字。刻字口径：一块板全图标（厂家图标库）或全文字（镂空限 2 字），屏显型号免雕刻。</footer>"
        "</body></html>"
    )
    return html.encode("utf-8")


# C9 交付对象开关（2026-10-23 老板拍板：取消「零售价不得进业主交付物」红线）。
#   internal = 内部版，保留参考单价/小计/合计（Excel 内部版口径）；
#   owner    = 给业主：保留零售价（金额与价格状态照常显示），文件名 _业主版；
#   site     = 给施工：不含价，金额字段一律 0，价格状态「不含价（交付版）」，文件名 _施工版。
# 注：旧口径（owner 也去价）已于 2026-10-23 老板拍板作废，未改回请以本注释为准。
EXPORT_AUDIENCES = {"internal": "", "owner": "_业主版", "site": "_施工版"}


def _without_prices(p):
    """不含价交付版 JSON：金额字段清零（仅 site 施工版使用，保留结构）。"""
    data = copy.deepcopy(p)
    design = data.get("design") or {}
    for key in ("fixtures", "devices", "furniture"):
        for item in design.get(key) or []:
            if isinstance(item, dict) and "price" in item:
                item["price"] = 0
    for item in data.get("files") or []:
        if isinstance(item, dict) and "price" in item:
            item["price"] = 0
    return data


def export_bytes(p, fmt, floor=None, audience="internal"):
    # 2026-10-23 老板拍板：只有 site（给施工）去价；owner（给业主）与 internal 都保留零售价。
    include_price = audience != "site"
    suffix = EXPORT_AUDIENCES.get(audience, "")
    stem = (
        re.sub(r"[^\w\-]", "_", p["code"]) + f"_V{p['version']:02}_R{p['revision']:03}"
    )
    if fmt == "json":
        project = p if include_price else _without_prices(p)
        return (
            json.dumps(
                {"schemaVersion": 1, "project": project}, ensure_ascii=False, indent=2
            ).encode(),
            "application/json",
            stem + suffix + ".json",
        )
    if fmt in ("png", "jpg"):
        level = floor if floor is not None else 1
        return (plain_plan_bytes(p, fmt, level),
                "image/png" if fmt == "png" else "image/jpeg",
                stem + f"_{floor_label(level, p.get('basements', 0))}_平面布置图{suffix}.{fmt}")
    if fmt == "dxf":
        return finished_dxf(p), "application/dxf", stem + "_成品图" + suffix + ".dxf"
    if fmt == "xlsx":
        return (
            spreadsheet(p, include_price),
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            stem + suffix + ".xlsx",
        )
    if fmt == "docx":
        return (
            word(p),
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            stem + suffix + ".docx",
        )
    if fmt == "pdf":
        return pdf(p, include_price), "application/pdf", stem + suffix + ".pdf"
    if fmt == "html":
        # 业主版：文件名直接写清项目与用途，方便转发与归档。
        pretty = re.sub(r"[^\w\u4e00-\u9fff\-]", "_", p.get("name", "项目"))[:24].strip("_") or "项目"
        return (
            scene_html(p),
            "text/html; charset=utf-8",
            f"{pretty}_灯光情景演示_V{p['version']:02}{suffix}.html",
        )
    if fmt == "panels":
        pretty = re.sub(r"[^\w\u4e00-\u9fff\-]", "_", p.get("name", "项目"))[:24].strip("_") or "项目"
        return (
            panel_engraving_html(p),
            "text/html; charset=utf-8",
            f"{pretty}_面板刻字排版图_V{p['version']:02}{suffix}.html",
        )
    if fmt == "zip":
        b = BytesIO()
        with zipfile.ZipFile(b, "w", zipfile.ZIP_DEFLATED) as z:
            for f in ("json", "xlsx", "docx", "pdf", "html", "panels", "dxf"):
                try:
                    content, _, name = export_bytes(p, f, None, audience)
                except ValueError:
                    if f == "dxf":
                        continue  # Legacy 2D projects have no source DXF.
                    raise
                z.writestr(name, content)
            for level in range(1, int(p.get("floors") or 1) + 1):
                content, _, name = export_bytes(p, "png", level, audience)
                z.writestr(name, content)
            z.writestr(
                "交付说明.txt",
                label(p)
                + ("\n交付对象：业主/施工（不含价）版；单价、小计、合计已清零。" if not include_price else "")
                + "\n项目包不包含原始上传文件，仅包含结构化设计与生成资料。无真实 AI 实景、无照度验算，不可直接施工。",
            )
        return b.getvalue(), "application/zip", stem + suffix + ".zip"
    raise ValueError("不支持此导出格式")
