"""光斑遮挡（与 `frontend/src/lightOcclusion.ts` 同一套口径）。

现场 2026-10-17：「光斑不能穿过墙体、门、家具表面」。三维画布、平面画布已经按这个口径裁剪，
但**后端出图的两条路径还没有**：
  - `exports.render_plan()` 的「灯光分布示意」——原来每盏灯画一个整圆再整体高斯模糊，
    光斑直接铺过墙、铺到户型外面（现场看到的就是这张图）；
  - `scene_html_template.html` 交付页里每盏灯一个 `<circle>`，同样整圆。

这里把口径收成一份实现：从灯位向四周打射线，碰到下面这些就停——
  1. 灯所在空间的边界（**闭口多边形**，所以门洞那一段同样挡光：现场明确说过门也不能穿）；
  2. 本层落地墙段（`bottomM > 0` 的是门洞过梁/高窗，不挡地面光）；
  3. 高家具（≥ 1.8 m：到顶柜、衣柜）的轮廓；矮家具（床、茶几）不挡，光落在它的顶面上。

没有空间边界时退到空间外接框（房间一定有 x/y/width/height），保证光斑永远有边界可依；
设计里连空间都没有的多层/无边界项目才返回 None（调用方按整圆画）。
"""

from __future__ import annotations

import math

# 设计坐标 = 米 × 26（与 lighting3d / SceneModel3D 同一套）
UNITS_PER_M = 26.0
# 到这个高度（米）的家具当墙处理
OCCLUDING_FURNITURE_M = 1.8
# 射线数（与前端一致）
RAYS = 96


def _num(v, default=0.0):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    return f if math.isfinite(f) else default


def floor_of(design, item):
    f = item.get("floor")
    if f not in (None, ""):
        return int(_num(f, 1)) or 1
    rooms = design.get("rooms") or []
    own = next((r for r in rooms if r.get("id") == item.get("roomId")), None)
    return int(_num((own or {}).get("floor"), 1)) or 1


def room_boundary(room):
    """空间边界多边形（设计坐标）。没有顶点时退到外接框，保证有边界可依。"""
    if not room:
        return None
    pts = []
    for p in room.get("points") or []:
        if not isinstance(p, dict):
            continue
        x, y = p.get("x"), p.get("y")
        if x is None or y is None:
            continue
        pts.append((_num(x), _num(y)))
    if len(pts) > 3 and abs(pts[0][0] - pts[-1][0]) < 1e-6 and abs(pts[0][1] - pts[-1][1]) < 1e-6:
        pts.pop()
    if len(pts) >= 3:
        return pts
    x, y = _num(room.get("x")), _num(room.get("y"))
    w, h = _num(room.get("width")), _num(room.get("height"))
    if w > 0 and h > 0:
        return [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]
    return None


def point_in_polygon(poly, x, y):
    if not poly or len(poly) < 3:
        return False
    inside = False
    n = len(poly)
    for i in range(n):
        ax, ay = poly[i]
        bx, by = poly[i - 1]
        if (ay > y) != (by > y) and x < (bx - ax) * (y - ay) / ((by - ay) or 1e-12) + ax:
            inside = not inside
    return inside


def room_at(design, item):
    """灯所在的空间：先认 roomId（且点确实在里面），否则按位置找本层哪个空间包住它。"""
    rooms = [r for r in (design.get("rooms") or []) if r.get("id")]
    x, y = _num(item.get("x")), _num(item.get("y"))
    floor = floor_of(design, item)
    own = next((r for r in rooms if r.get("id") == item.get("roomId")), None)
    if own and room_boundary(own) and point_in_polygon(room_boundary(own), x, y):
        return own
    hit = next(
        (
            r
            for r in rooms
            if int(_num(r.get("floor"), 1)) == floor
            and room_boundary(r)
            and point_in_polygon(room_boundary(r), x, y)
        ),
        None,
    )
    return hit or own


def _furniture_outline(item):
    """家具轮廓（设计坐标）：画过轮廓的用轮廓，否则用外接框。"""
    pts = item.get("points")
    if isinstance(pts, list) and len(pts) >= 3 and all(isinstance(p, dict) for p in pts):
        out = [(_num(p.get("x")), _num(p.get("y"))) for p in pts]
        if len(out) >= 3:
            return out
    x, y = _num(item.get("x")), _num(item.get("y"))
    # widthM / depthM 是米（整宽/整深），设计坐标 = 米 × 26，所以半宽 = 米 × 13
    hw = _num(item.get("widthM")) * UNITS_PER_M / 2
    hd = _num(item.get("depthM")) * UNITS_PER_M / 2
    if hw <= 0 or hd <= 0:
        return None
    ang = math.radians(_num(item.get("rotation")))
    ca, sa = math.cos(ang), math.sin(ang)
    return [
        (x + u * ca - v * sa, y + u * sa + v * ca)
        for u, v in ((-hw, -hd), (hw, -hd), (hw, hd), (-hw, hd))
    ]


def occluders(design, item):
    """挡光的线段：本层落地墙 + 高家具轮廓。空间边界由调用方单独加（见 pool_polygon）。"""
    segs = []
    floor = floor_of(design, item)
    for w in design.get("walls") or []:
        if w.get("floor") not in (None, "") and int(_num(w.get("floor"), floor)) != floor:
            continue
        if _num(w.get("bottomM")) > 0:          # 门洞过梁 / 高窗：不挡地面光
            continue
        try:
            x1, y1 = _num(w["x"]), _num(w["y"])
            x2, y2 = _num(w["x2"]), _num(w["y2"])
        except (KeyError, TypeError):
            continue
        if math.hypot(x2 - x1, y2 - y1) < 0.5:
            continue
        segs.append((x1, y1, x2, y2))
    x, y = _num(item.get("x")), _num(item.get("y"))
    for f in design.get("furniture") or []:
        if f.get("hidden"):
            continue
        if f.get("floor") not in (None, "") and int(_num(f.get("floor"), floor)) != floor:
            continue
        if _num(f.get("heightM")) < OCCLUDING_FURNITURE_M:
            continue
        poly = _furniture_outline(f)
        if not poly or point_in_polygon(poly, x, y):     # 灯就在这件柜子里时不算它挡
            continue
        for i in range(len(poly)):
            a, b = poly[i], poly[(i + 1) % len(poly)]
            segs.append((a[0], a[1], b[0], b[1]))
    return segs


def _ray_hit(ox, oy, dx, dy, segs, limit):
    best = limit
    for x1, y1, x2, y2 in segs:
        sx, sy = x2 - x1, y2 - y1
        den = dx * sy - dy * sx
        if abs(den) < 1e-12:
            continue
        ax, ay = x1 - ox, y1 - oy
        t = (ax * sy - ay * sx) / den           # 沿射线
        u = (ax * dy - ay * dx) / den           # 沿墙段
        if 1e-9 < t < best and -1e-9 <= u <= 1 + 1e-9:
            best = t
    return best


def pool_polygon(design, item, radius, rays=RAYS, include_room=True):
    """以灯位为原点、半径 radius（设计单位）内看得见的范围（相对坐标）。

    返回 `[(0,0), 一圈边界点...]`，与前端 `lightPoolPolygon` 同形；没有可用几何时返回 None。
    """
    radius = _num(radius)
    if radius <= 0:
        return None
    ox, oy = _num(item.get("x")), _num(item.get("y"))
    segs = list(occluders(design, item))
    if include_room:
        room = room_at(design, item)
        poly = room_boundary(room)
        if poly:
            # 空间边界是闭口多边形：门洞那一段同样挡光，光斑不会从门口漏到走廊。
            for i in range(len(poly)):
                a, b = poly[i], poly[(i + 1) % len(poly)]
                segs.append((a[0], a[1], b[0], b[1]))
    if not segs:
        return None
    out = [(0.0, 0.0)]
    for i in range(rays):
        ang = 2 * math.pi * i / rays
        dx, dy = math.cos(ang), math.sin(ang)
        r = _ray_hit(ox, oy, dx, dy, segs, radius)
        out.append((dx * r, dy * r))
    return out


def pool_polygon_abs(design, item, radius, **kw):
    """同上，但返回绝对设计坐标（给后端出图用）。"""
    poly = pool_polygon(design, item, radius, **kw)
    if not poly:
        return None
    ox, oy = _num(item.get("x")), _num(item.get("y"))
    return [(x + ox, y + oy) for x, y in poly]


def shrink_pool(poly, margin):
    """把裁剪好的光斑多边形沿各自方向往回收 margin（设计单位）。

    径向收缩而不是做多边形内偏——**不会自交**，且物理含义就是「光斑在墙内侧留出的余量」，
    免得高斯模糊/柔边把光晕又抹到墙外面去（现场 2026-10-17：光斑不能穿过墙体）。
    """
    if not poly or margin <= 0:
        return poly or []
    out = [poly[0]]
    for x, y in poly[1:]:
        d = math.hypot(x, y)
        if d <= margin:
            out.append((x * 0.5, y * 0.5))
            continue
        k = (d - margin) / d
        out.append((x * k, y * k))
    return out
