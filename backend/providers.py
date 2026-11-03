"""Offline providers; never represent mock geometry as actual recognition."""

from typing import Protocol
from pathlib import Path
from dataclasses import dataclass
from io import BytesIO
import uuid


def uid():
    return uuid.uuid4().hex[:12]


def decode_dxf_text(raw: str) -> str:
    """R12 中文图纸常用 GBK 码页；按 latin-1 读进来的中文是乱码，这里还原。"""
    s = str(raw or "")
    if any("\x80" <= ch <= "\xff" for ch in s):
        try:
            return s.encode("latin-1").decode("gbk")
        except (UnicodeEncodeError, UnicodeDecodeError):
            return s
    return s


class RecognitionProvider(Protocol):
    def recognize(self, path: Path, metadata: dict) -> dict: ...


@dataclass
class ImageArtifact:
    content: bytes
    metadata: dict


class ImageProvider(Protocol):
    def generate(
        self, project: dict, scene_id: str | None = None, floor: int = 1
    ) -> ImageArtifact: ...


class SimulationRecognitionProvider:
    def recognize(self, path: Path, metadata: dict) -> dict:
        # Fixed sample, intentionally independent of input; disclosed to the user.
        return {
            "provider": "local-simulation",
            "simulated": True,
            "confidence": None,
            "message": "本地模拟模式：以下为固定示例区域，未识别原图。请根据图纸人工绘制和校正；门窗、尺寸与楼层关系未自动识别。",
            "rooms": [
                dict(
                    id=uid(),
                    name=name,
                    type=name,
                    x=x,
                    y=y,
                    width=w,
                    height=h,
                    floor=1,
                    area=area,
                    heightM=2.8,
                    color=color,
                    source="simulation",
                    confidence=None,
                    notes="模拟占位，需人工校正",
                )
                for name, x, y, w, h, area, color in [
                    ("客厅", 90, 80, 330, 300, 32, "#e9e6dc"),
                    ("主卧", 420, 80, 220, 220, 21, "#dbe5dd"),
                    ("厨房", 420, 300, 220, 180, 12, "#e8e0d4"),
                ]
            ],
            "walls": [],
            "openings": [],
            "texts": [],
            "unrecognized": ["墙体、门窗、楼梯", "实际房间边界及尺寸", "楼层关系"],
        }


class DxfRecognitionProvider:
    def recognize(self, path: Path, metadata: dict) -> dict:
        import ezdxf

        doc = ezdxf.readfile(path)
        lines, texts, polygons = [], [], []
        unsupported = set()
        layers = set()
        for entity in doc.modelspace():
            t = entity.dxftype()
            layer = entity.dxf.layer
            layers.add(str(layer or ""))
            if t == "LINE":
                a, b = entity.dxf.start, entity.dxf.end
                lines.append((a.x, a.y, b.x, b.y, layer))
            elif t in ("LWPOLYLINE", "POLYLINE"):
                pts = (
                    [(float(p[0]), float(p[1])) for p in entity.get_points()]
                    if t == "LWPOLYLINE"
                    else [(v.dxf.location.x, v.dxf.location.y) for v in entity.vertices]
                )
                closed = entity.closed if t == "LWPOLYLINE" else entity.is_closed
                for a, b in zip(pts, pts[1:] + ([pts[0]] if closed and pts else [])):
                    lines.append((*a, *b, layer))
                if closed and len(pts) >= 3:
                    polygons.append((pts, layer))
            elif t in ("TEXT", "MTEXT"):
                p = entity.dxf.insert
                texts.append(
                    (
                        p.x,
                        p.y,
                        decode_dxf_text(entity.dxf.text if t == "TEXT" else entity.plain_text()),
                        layer,
                    )
                )
            else:
                unsupported.add(t)
        coords = (
            [(a, b) for a, b, c, d, l in lines]
            + [(c, d) for a, b, c, d, l in lines]
            + [(x, y) for x, y, _, _ in texts]
        )
        if not coords:
            raise ValueError("DXF 中没有可解析的基础线段、多段线或文字")
        minx, miny = min(x for x, y in coords), min(y for x, y in coords)
        maxx, maxy = max(x for x, y in coords), max(y for x, y in coords)
        scale = min(720 / max(maxx - minx, 1), 480 / max(maxy - miny, 1))

        def xy(x, y):
            return (
                round(60 + (x - minx) * scale, 2),
                round(50 + (maxy - y) * scale, 2),
            )

        # 无语义图层的图纸（整张画在 0 层）：按画法反推墙/空间/门窗，
        # 否则现场拿到的就是「一个外框 + 一堆家具当房间」。
        semantic_layers = {
            l.strip() for l in layers
            if l.strip() and l.strip().upper() not in {"0", "DEFPOINTS"}
        }
        if not semantic_layers:
            fallback = ""
            try:
                return self.recognize_layer0(
                    lines, texts, polygons, unsupported, xy,
                    (minx, miny, maxx, maxy), metadata,
                )
            except Exception as exc:  # 反推失败不能把整次导入打死：回落基础解析并如实说明
                fallback = f"0 图层几何反推失败（{type(exc).__name__}: {exc}），已回落到基础线段解析。"
        else:
            fallback = ""

        walls = [
            dict(
                id=uid(),
                x=xy(a, b)[0],
                y=xy(a, b)[1],
                x2=xy(c, d)[0],
                y2=xy(c, d)[1],
                layer=l,
                source="cad",
                floor=1,
            )
            for a, b, c, d, l in lines[:3000]
        ]
        rooms = []
        for i, (pts, layer) in enumerate(polygons[:100]):
            pp = [xy(x, y) for x, y in pts]
            xs = [p[0] for p in pp]
            ys = [p[1] for p in pp]
            rooms.append(
                dict(
                    id=uid(),
                    name=f"闭合区域 {i+1}",
                    type="其他空间",
                    x=min(xs),
                    y=min(ys),
                    width=max(xs) - min(xs),
                    height=max(ys) - min(ys),
                    points=[{"x": x, "y": y} for x, y in pp],
                    area=0,
                    heightM=2.8,
                    floor=1,
                    color="#e6e8df",
                    source="cad",
                    # 自动几何推测（不是人工确认的空间）：标 needsReview，顶部流程条才不会
                    # 谎报「已确认 N/N」；同时让「清除旧版错误彩平」按钮认得它们。
                    needsReview=True,
                    semanticSource="local-geometry-suggestion",
                    semanticConfidence="low",
                    layer=layer,
                    notes="CAD 闭合区域，不代表已确认房间；面积需按比例人工核定",
                )
            )
        return dict(
            provider="ezdxf-basic",
            simulated=False,
            confidence=None,
            message=(fallback + " " if fallback else "")
            + "已读取 CAD 基础几何与图层；不包含语义识别，比例、房间名称与墙体归属需人工核定。",
            walls=walls,
            rooms=rooms,
            openings=[],
            texts=[
                dict(id=uid(), x=xy(x, y)[0], y=xy(x, y)[1], text=t, layer=l)
                for x, y, t, l in texts[:500]
            ],
            unrecognized=list(unsupported) + ["门窗语义", "尺寸比例", "楼层关系"],
        )

    SPACE_TYPES = (
        ("客厅", ("客厅", "起居", "大堂")),
        ("卧室", ("主卧", "次卧", "卧室", "客房")),
        ("餐厅", ("餐厅", "餐区")),
        ("厨房", ("厨房", "中厨", "西厨")),
        ("卫生间", ("淋浴", "马桶", "卫生", "洗手", "浴")),
        ("玄关", ("玄关", "门厅")),
        ("过道", ("过道", "走廊", "通道", "门厅过道")),
        ("储藏间", ("储藏", "杂物", "储物")),
        ("书房", ("书房", "工作室", "办公")),
        ("阳台", ("阳台", "露台")),
        ("洗衣房", ("洗衣", "家政")),
    )

    def space_type_of(self, name: str) -> str:
        n = str(name or "")
        for t, keys in self.SPACE_TYPES:
            if any(k in n for k in keys):
                return t
        return "其他空间"

    def recognize_layer0(self, lines, texts, polygons, unsupported, xy, bb, metadata) -> dict:
        """0 图层图纸：按画法反推墙、空间与门窗（口径见 dxf_plan 模块头注释）。"""
        from .dxf_plan import (
            attach_openings,
            find_openings,
            grid_spaces,
            merge_openings,
            merge_walls,
            pair_walls,
            paired_bands,
            triple_windows,
            window_bands,
        )

        seg_lines = [((a, b), (c, d)) for a, b, c, d, _ in lines]
        walls = merge_walls(pair_walls(seg_lines))
        if not walls:
            raise ValueError("没有成对的平行墙线，无法反推墙体")
        rooms_raw = grid_spaces(walls, [(x, y, t) for x, y, t, _ in texts])
        if not rooms_raw:
            raise ValueError("墙线没有围合出可判定的空间")
        rooms_raw.sort(key=lambda r: -(r["w"] * r["h"]))
        rooms_raw = rooms_raw[:40]
        room_ids = [uid() for _ in rooms_raw]
        room_index = {id(r): i for i, r in enumerate(rooms_raw)}
        attached = attach_openings(
            rooms_raw,
            merge_openings(
                find_openings(walls, seg_lines)
                + window_bands([p for p, _ in polygons], seg_lines, bb)
                + paired_bands(seg_lines, bb)
                + triple_windows(seg_lines, bb)
            ),
        )
        rooms = []
        for i, r in enumerate(rooms_raw):
            pts = [{"x": xy(*p)[0], "y": xy(*p)[1]} for p in r["points"]]
            xs = [p["x"] for p in pts]
            ys = [p["y"] for p in pts]
            name = r["name"] or f"未标注空间 {i + 1}"
            rooms.append(
                dict(
                    id=room_ids[i],
                    name=name,
                    type=self.space_type_of(name),
                    x=min(xs),
                    y=min(ys),
                    width=max(xs) - min(xs),
                    height=max(ys) - min(ys),
                    points=pts,
                    area=0,
                    heightM=2.8,
                    floor=1,
                    color="#e6e8df",
                    source="cad",
                    needsReview=True,
                    semanticSource="cad-layer0-geometry",
                    semanticConfidence="medium",
                    layer="0",
                    widthMm=round(r["w"], 1),
                    heightMm=round(r["h"], 1),
                    labels=r["labels"],
                    notes="0 图层图纸按墙线围合反推的空间轮廓；名称取自图内文字，"
                          "面积与边界需按比例人工核定",
                )
            )
        openings = []
        for o in attached:
            kind = "窗" if o["kind"] in ("窗带", "三线窗") else "门"
            openings.append(
                dict(
                    id=uid(),
                    roomId=room_ids[room_index[id(o["room"])]],
                    edgeIndex=o["edgeIndex"],
                    start=round(max(0.0, o["start"]), 4),
                    end=round(min(1.0, o["end"]), 4),
                    kind=kind,
                    heightM=1.5 if kind == "窗" else 2.1,
                    sillHeight=0.9 if kind == "窗" else 0.0,
                    source="cad",
                    floor=1,
                    widthMm=round(o["to"] - o["from"], 1),
                    bays=o.get("bays"),
                    notes=f"0 图层图纸按画法判读的{kind}洞"
                          + (f"（窗带 {o['bays']} 樘）" if o.get("bays") else "")
                          + "；有无门扇、实际洞口尺寸需现场核对",
                )
            )
        wall_out = [
            dict(
                id=uid(),
                x=xy(w["s"] if w["ori"] == "H" else w["axis"],
                     w["axis"] if w["ori"] == "H" else w["s"])[0],
                y=xy(w["s"] if w["ori"] == "H" else w["axis"],
                     w["axis"] if w["ori"] == "H" else w["s"])[1],
                x2=xy(w["e"] if w["ori"] == "H" else w["axis"],
                      w["axis"] if w["ori"] == "H" else w["e"])[0],
                y2=xy(w["e"] if w["ori"] == "H" else w["axis"],
                      w["axis"] if w["ori"] == "H" else w["e"])[1],
                layer="0",
                source="cad",
                floor=1,
                thicknessMm=round(w["t"], 1),
            )
            for w in walls[:3000]
        ]
        # 命名口径要分开数：图内文字命名 = 有标签；走廊/开放区/待核 = 只按几何形状推断，
        # 混成一个数会在界面上谎报「N 个用了图内文字命名」，人工就没法判断还要核几个。
        labeled = sum(1 for r in rooms_raw if r.get("nameFromText"))
        guessed = len(rooms) - labeled
        return dict(
            provider="ezdxf-layer0-geometry",
            simulated=False,
            confidence=None,
            message=(
                f"这张图纸整张画在 0 图层、没有语义图层名，已按画法反推："
                f"{len(wall_out)} 段墙（墙厚按双线图间距推得）、{len(rooms)} 个空间"
                f"（{labeled} 个用了图内文字命名"
                + (f"、{guessed} 个按形状推断为走廊 / 开放区，名称需人工核定" if guessed else "")
                + f"）、{len(openings)} 处门窗洞口。"
                "家具与洁具的闭合轮廓没有当成空间；比例、名称与洞口需人工核定后才能确认空间。"
            ),
            walls=wall_out,
            rooms=rooms,
            openings=openings,
            texts=[
                dict(id=uid(), x=xy(x, y)[0], y=xy(x, y)[1], text=t, layer=l)
                for x, y, t, l in texts[:500]
            ],
            unrecognized=list(unsupported)
            + ["家具/洁具轮廓（未建为对象）", "尺寸比例", "楼层关系"],
        )


class LocalImageProvider:
    def generate(
        self, project: dict, scene_id: str | None = None, floor: int = 1
    ) -> ImageArtifact:
        from .exports import render_plan

        buf = BytesIO()
        render_plan(project, scene_id, floor=floor).save(buf, format="PNG")
        return ImageArtifact(
            buf.getvalue(),
            {
                "provider": "local-schematic",
                "simulated": True,
                "kind": "lighting-schematic",
                "message": "本地灯光分布示意图：非 AI 实景、非照度模拟，不可作为施工或照度验收依据。",
                "scene_id": scene_id,
                "floor": floor,
            },
        )


def recognition_provider(name="local") -> RecognitionProvider:
    if name == "simulation":
        return SimulationRecognitionProvider()
    if name in ("local", "local-boundary-analysis"):
        from .recognition import ImageAnalysisProvider

        return ImageAnalysisProvider()
    raise ValueError(
        "未安装此识别 Provider，请使用 local 或在 providers.py 注册真实适配器"
    )


def image_provider(name="local") -> ImageProvider:
    if name != "local":
        raise ValueError("未安装此图像 Provider，请使用 local 或注册真实适配器")
    return LocalImageProvider()
