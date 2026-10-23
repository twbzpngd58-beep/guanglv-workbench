"""Offline providers; never represent mock geometry as actual recognition."""

from typing import Protocol
from pathlib import Path
from dataclasses import dataclass
from io import BytesIO
import uuid


def uid():
    return uuid.uuid4().hex[:12]


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
        for entity in doc.modelspace():
            t = entity.dxftype()
            layer = entity.dxf.layer
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
                        entity.dxf.text if t == "TEXT" else entity.plain_text(),
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
            message="已读取 CAD 基础几何与图层；不包含语义识别，比例、房间名称与墙体归属需人工核定。",
            walls=walls,
            rooms=rooms,
            openings=[],
            texts=[
                dict(id=uid(), x=xy(x, y)[0], y=xy(x, y)[1], text=t, layer=l)
                for x, y, t, l in texts[:500]
            ],
            unrecognized=list(unsupported) + ["门窗语义", "尺寸比例", "楼层关系"],
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
