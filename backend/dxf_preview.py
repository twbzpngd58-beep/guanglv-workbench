"""DXF modelspace preview: ezdxf CAD decomposition, exact world-to-pixel mapping.

No network/external images. Blocks/annotations are interpreted by ezdxf, not
hand-exploded or shifted. Unsupported entities are reported, never called complete.
"""
from __future__ import annotations

import math
from collections import Counter
from pathlib import Path

MAX_PX = 1800
MARGIN = 24
MAX_ENTITIES = 60000
MAPPING_VERSION = 3


def apartment_bbox(parsed: dict | None) -> dict | None:
    """Convert local apartment geometry back to WCS; ignore global parsed bbox.

    Rooms anchor the crop. Nearby structural walls/openings/furniture extend it;
    remote objects cannot enlarge it. One metre around it retains outer dimensions.
    Without rooms there is no reliable apartment selection: use full modelspace.
    """
    parsed = parsed or {}
    source = parsed.get("source") or {}
    base = source.get("source_base_xy") or []
    scale = float(source.get("source_scale") or 0)
    if len(base) != 2 or scale <= 0:
        return None
    boxes = [r["bbox"] for r in parsed.get("rooms", []) if len(r.get("bbox", [])) == 4]
    boxes = [b for b in boxes if all(math.isfinite(float(v)) for v in b)]
    if not boxes:
        return None
    # Largest room anchors the current cluster rather than trusting stray room labels.
    seed = max(boxes, key=lambda b: (b[2]-b[0])*(b[3]-b[1]))
    chosen = [seed]
    def near(b, a, pad=2.0):
        return b[0] <= a[2]+pad and b[2] >= a[0]-pad and b[1] <= a[3]+pad and b[3] >= a[1]-pad
    def union(bs):
        return [min(b[0] for b in bs), min(b[1] for b in bs), max(b[2] for b in bs), max(b[3] for b in bs)]
    remaining = [b for b in boxes if b is not seed]
    while remaining:
        a = union(chosen)
        found = [b for b in remaining if near(b, a)]
        if not found:
            break
        chosen.extend(found)
        remaining = [b for b in remaining if b not in found]
    anchor = union(chosen)
    candidates = []
    for w in parsed.get("struct_walls") or parsed.get("walls", []):
        candidates.append([min(w["x0"], w["x1"]), min(w["z0"], w["z1"]), max(w["x0"], w["x1"]), max(w["z0"], w["z1"])])
    for key in ("windows", "doors", "furniture"):
        candidates.extend(v["bbox"] for v in parsed.get(key, []) if len(v.get("bbox", [])) == 4)
    # Both corners must be local: a long stray segment crossing the crop isn't an anchor.
    chosen.extend(b for b in candidates if all(math.isfinite(float(v)) for v in b)
                  and b[0] >= anchor[0]-2 and b[1] >= anchor[1]-2
                  and b[2] <= anchor[2]+2 and b[3] <= anchor[3]+2)
    x0, z0, x1, z1 = union(chosen)
    x0 -= 1; z0 -= 1; x1 += 1; z1 += 1
    ys = [base[1] + (-z if source.get("source_y_flip", True) else z)/scale for z in (z0,z1)]
    return {"minX": base[0]+x0/scale, "maxX": base[0]+x1/scale,
            "minY": min(ys), "maxY": max(ys)}


def _read_document(src):
    """R12 exports often omit codepage; recognize explicit Chinese style names.

    Do not reinterpret declared encodings or arbitrary Latin text as GBK.
    """
    import ezdxf
    doc = ezdxf.readfile(str(src))
    if not doc.header.get("$DWGCODEPAGE") and doc.encoding == "cp1252":
        for style in doc.styles:
            try:
                name = style.dxf.name.encode("cp1252").decode("gbk")
            except (UnicodeEncodeError, UnicodeDecodeError):
                continue
            if "中文" in name or "标注" in name:
                doc = ezdxf.readfile(str(src), encoding="gbk")
                break
    # CJK styles cannot use ezdxf's Latin-only SHX fallback. 优先用随仓库分发的字体，
    # 这样 Windows / macOS 上也能画出中文（不再依赖系统里装没装 Droid）。
    cjk_font = next(
        (
            candidate
            for candidate in (
                Path(__file__).resolve().parent / "fonts" / "GuanglvPlanSans.ttf",
                Path("/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf"),
                Path("C:/Windows/Fonts/msyh.ttc"),
                Path("/System/Library/Fonts/PingFang.ttc"),
            )
            if candidate.is_file()
        ),
        None,
    )
    if cjk_font is not None:
        from ezdxf.fonts import fonts
        if not fonts.font_manager.has_font(cjk_font.name):
            fonts.font_manager.scan_folder(cjk_font.parent)
        styles = set()
        for entity in doc.entitydb.values():
            if entity.dxftype() in ("TEXT", "MTEXT", "ATTRIB", "ATTDEF"):
                text = entity.dxf.get("text", "")
                if any("\u4e00" <= c <= "\u9fff" for c in text):
                    styles.add(entity.dxf.get("style", "Standard"))
        for name in styles:
            if name in doc.styles:
                doc.styles.get(name).dxf.font = str(cjk_font)
    return doc


def _record(src):
    import ezdxf
    from ezdxf.addons.drawing import Frontend, RenderContext
    from ezdxf.addons.drawing.recorder import Recorder
    from ezdxf.addons.drawing.config import Configuration, ColorPolicy, BackgroundPolicy, ImagePolicy

    doc = _read_document(src)
    if len(doc.modelspace()) > MAX_ENTITIES:
        raise ValueError("DXF exceeds preview entity budget; not silently truncated")
    recorder = Recorder()
    skipped = Counter()
    class ReportingFrontend(Frontend):
        def skip_entity(self, entity, msg):
            skipped[f"{entity.dxftype()}: {msg}"] += 1
    config = Configuration(color_policy=ColorPolicy.BLACK,
                           background_policy=BackgroundPolicy.WHITE,
                           image_policy=ImagePolicy.IGNORE, hatching_timeout=10)
    frontend = ReportingFrontend(RenderContext(doc), recorder, config=config)
    frontend.draw_layout(doc.modelspace(), finalize=True)
    return recorder.player(), config, dict(skipped), dict(Counter(e.dxftype() for e in doc.modelspace()))


def drawable_bbox(src: Path | str, parsed: dict | None = None) -> dict:
    crop = apartment_bbox(parsed)
    if crop:
        return crop
    player, _, _, _ = _record(src)
    box = player.bbox()
    if not box.has_data:
        raise ValueError("图纸里没有可画的几何")
    return {"minX": box.extmin.x, "minY": box.extmin.y,
            "maxX": box.extmax.x, "maxY": box.extmax.y}


def render_dxf_png(src: Path | str, out: Path | str, max_px: int = MAX_PX,
                   *, parsed: dict | None = None) -> dict:
    """Record full nested CAD content, clip apartment, rasterize at exact 72 dpi.

    ezdxf covers nested INSERT/MINSERT, bulges/OCS, splines, text/attributes,
    cached DIMENSION geometry, SOLID/TRACE and HATCH (including holes).
    Missing fonts may substitute; missing dimension blocks/proxies are not invented.
    """
    from ezdxf.math import Matrix44
    from ezdxf.addons.drawing import layout
    from ezdxf.addons.drawing.pymupdf import PyMuPdfRenderBackend
    from PIL import Image
    import io

    if max_px <= MARGIN*2:
        raise ValueError("max_px must exceed twice the margin")
    player, config, skipped, counts = _record(src)
    crop = apartment_bbox(parsed)
    box = player.bbox()
    if not box.has_data:
        raise ValueError("图纸里没有可画的几何")
    bounds = crop or {"minX": box.extmin.x, "minY": box.extmin.y,
                      "maxX": box.extmax.x, "maxY": box.extmax.y}
    x0,y0,x1,y1 = (bounds[k] for k in ("minX","minY","maxX","maxY"))
    w,h = max(1e-6,x1-x0), max(1e-6,y1-y0)
    scale = (max_px-MARGIN*2)/max(w,h)
    iw,ih = max(64,math.ceil(w*scale)+MARGIN*2), max(64,math.ceil(h*scale)+MARGIN*2)
    # Crop before translating/scaling: remote objects are truly absent, not merely tiny.
    player.crop_rect((x0,y0),(x1,y1),distance=0.25/scale)
    player.transform(Matrix44.chain(Matrix44.translate(-x0,-y1,0),
                                    Matrix44.scale(scale,-scale,1),
                                    Matrix44.translate(MARGIN,MARGIN,0)))
    # Direct replay avoids backend auto-fit/centering/rounding changing the transform.
    class PixelPage(layout.Page):
        # layout.Page rounds millimetres to 0.1mm; bypass that for pixel-exact output.
        @property
        def width_in_mm(self):
            return (self.width+1e-7)*25.4/72
        @property
        def height_in_mm(self):
            return (self.height+1e-7)*25.4/72
    page = PixelPage(iw,ih,units=layout.Units.pt)
    backend = PyMuPdfRenderBackend(page,layout.Settings(output_coordinate_space=max(iw,ih), output_layers=False))
    backend.configure(config)
    player.replay(backend)
    image = Image.open(io.BytesIO(backend.get_pixmap(dpi=72,alpha=False).tobytes("png"))).convert("RGB")
    if image.size != (iw,ih):
        raise ValueError(f"Unexpected raster size {image.size}, expected {(iw,ih)}")
    out = Path(out)
    out.parent.mkdir(parents=True,exist_ok=True)
    image.save(out,format="PNG",optimize=True)
    backend.doc.close()
    return {**bounds,"width":iw,"height":ih,"pixelScale":scale,"margin":MARGIN,
            "mappingVersion":MAPPING_VERSION,"renderer":"ezdxf-pymupdf",
            "cropMode":"apartment" if crop else "modelspace", "cropBox":crop,
            "entityCounts":counts,"skippedEntities":skipped}
