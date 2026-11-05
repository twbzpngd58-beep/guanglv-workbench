"""Polygon rooms are the source of structure; CAD parsing is only the initial draft."""
import math

UNITS = 26.0


def room_points(room):
    if room.get("source") in ("fixture-code", "semantic-labels"):
        return []
    pts = room.get("points") or []
    if len(pts) >= 3:
        pts = [(float(p["x"]), float(p["y"])) for p in pts]
    elif float(room.get("width") or 0) > 1 and float(room.get("height") or 0) > 1:
        x, y, w, h = (float(room.get(k) or 0) for k in ("x", "y", "width", "height"))
        pts = [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]
    else:
        return []
    if len(pts) > 3 and math.dist(pts[0], pts[-1]) < 1e-6:
        pts.pop()
    return pts


def polygon_area(pts):
    """多边形面积（设计单位²）。点数不足或退化多边形返回 0。"""
    pts = [(float(p[0]), float(p[1])) for p in (pts or [])]
    n = len(pts)
    if n < 3:
        return 0.0
    s = sum(pts[i][0] * pts[(i + 1) % n][1] - pts[(i + 1) % n][0] * pts[i][1] for i in range(n))
    return abs(s) / 2


def contains_point(room, x, y):
    """点是否落在空间的真实边界里（射线法）。与 frontend/src/spaceGeometry.ts 的 containsPoint 同一口径。

    压在边界线上算「在里面」：贴墙吸附的面板/门窗落点正好落在墙线上，射线法单独跑会把它判到房间外，
    于是二维认它、三维/导出认隔壁，两层归属又不一致了。
    """
    pts = room_points(room)
    if len(pts) < 3:
        return False
    inside = False
    n = len(pts)
    for i in range(n):
        ax, ay = pts[i]
        bx, by = pts[i - 1]
        dx, dy = bx - ax, by - ay
        length = math.hypot(dx, dy)
        if length > 0 and abs((x - ax) * dy - (y - ay) * dx) / length < 1e-6 and \
                min(ax, bx) - 1e-6 <= x <= max(ax, bx) + 1e-6 and \
                min(ay, by) - 1e-6 <= y <= max(ay, by) + 1e-6:
            return True
        if (ay > y) != (by > y) and x < (bx - ax) * (y - ay) / ((by - ay) or 1e-12) + ax:
            inside = not inside
    return inside


def interior_point(room):
    """空间内部一点：最宽那条扫描线的中点，不是外接框中心。

    L 形/C 形房间的外接框中心、外接框角点会掉进缺角里——那是隔壁的地盘。现场 2026-11-04 实测：
    5 个项目的 37 间有边界空间里，6 间的导出图房间名锚点落在房间外、1 盏灯按外接框归错了房间。
    与 frontend/src/spaceGeometry.ts 的 interiorPoint 同一算法，改动要一起改。
    """
    pts = room_points(room)
    if len(pts) < 3:
        return (float(room.get("x") or 0), float(room.get("y") or 0))
    rows = sorted({p[1] for p in pts})
    best = pts[0]
    best_width = -1.0
    n = len(pts)
    for i in range(1, len(rows)):
        y = (rows[i] + rows[i - 1]) / 2
        cuts = []
        for j, (ax, ay) in enumerate(pts):
            bx, by = pts[(j + 1) % n]
            if (ay > y) != (by > y):
                cuts.append(ax + (bx - ax) * (y - ay) / ((by - ay) or 1e-12))
        cuts.sort()
        for j in range(1, len(cuts), 2):
            width = cuts[j] - cuts[j - 1]
            if width > best_width:
                best_width = width
                best = ((cuts[j] + cuts[j - 1]) / 2, y)
    return best


def offset_inside(room, x, y, dy):
    """第二行标注的落点：往下错开 dy，薄凹形房放不下时往上，上下都不行就留在原点后。
    「内部点 +20」在 5 间真实房里错到了隔壁地上（现场 2026-11-04），房间名下面那行面积就写在别人家。
    与 frontend/src/spaceGeometry.ts 的 offsetInside 同一口径，改动要一起改。"""
    if contains_point(room, x, y + dy):
        return (x, y + dy)
    if contains_point(room, x, y - dy):
        return (x, y - dy)
    return (x, y)


def opening_geometry(design, opening):
    """洞口 → 画布/导出用的 x/y/width/rotation/type；挂不到边界时返回 None。

    手绘与图纸识别都只存「挂在哪条边界、占哪一段」（edgeIndex + start/end），坐标是从所属空间
    多边形现推的；自带 x/y 的老口径沿用。画布、导出、三维共用这一份算法，别再各写一套。
    """
    x, y, width = opening.get("x"), opening.get("y"), opening.get("width")
    kind = opening.get("type") or opening.get("kind") or "门"
    if x is not None and y is not None and width is not None:
        return {"x": float(x), "y": float(y), "width": float(width),
                "rotation": float(opening.get("rotation") or 0), "type": kind}
    edge = opening.get("edgeIndex")
    room = next((r for r in design.get("rooms") or [] if r.get("id") == opening.get("roomId")), None)
    pts = room_points(room or {})
    if not isinstance(edge, int) or isinstance(edge, bool) or not 0 <= edge < len(pts):
        return None
    a, b = pts[edge], pts[(edge + 1) % len(pts)]
    start, end = float(opening.get("start") or 0), float(opening.get("end") or 0)
    length = math.hypot(b[0] - a[0], b[1] - a[1])
    if not end > start or length <= 1e-6:
        return None
    return {"x": a[0] + (b[0] - a[0]) * start, "y": a[1] + (b[1] - a[1]) * start,
            "width": length * (end - start),
            "rotation": math.degrees(math.atan2(b[1] - a[1], b[0] - a[0])), "type": kind}


def materialize_openings(design):
    """把只挂了边界的洞口折算成坐标补进行里（就地改），返回 (补了几条, 挂不上的几条)。"""
    filled = orphan = 0
    for opening in design.get("openings") or []:
        if not isinstance(opening, dict):
            continue
        geo = opening_geometry(design, opening)
        if not geo:
            orphan += 1
            continue
        if opening.get("x") is None:
            filled += 1
        opening.update(geo)
    return filled, orphan


def design_geometry(project):
    design = project.get("design") or {}
    rooms, walls, openings = [], [], []
    all_points = []
    for room in design.get("rooms") or []:
        pts = room_points(room)
        if len(pts) < 3:
            continue
        poly = [[x / UNITS, y / UNITS] for x, y in pts]
        all_points.extend(poly)
        xs, zs = [p[0] for p in poly], [p[1] for p in poly]
        original = float(room.get("originalHeightM") or project.get("ceiling") or 3)
        h = float(room.get("heightM") or project.get("ceilingNet") or original)
        floor = room.get("floor") or 1
        rooms.append({"id": room["id"], "name": room.get("name") or "未命名空间", "floor": floor,
                      "poly": poly, "rects": [], "bbox": [min(xs), min(zs), max(xs), max(zs)],
                      "cx": (min(xs) + max(xs)) / 2, "cz": (min(zs) + max(zs)) / 2,
                      "area": abs(sum(a[0] * b[1] - b[0] * a[1]
                                      for a, b in zip(poly, poly[1:] + poly[:1]))) / 2,
                      "heightM": h, "originalHeightM": original})
        for index, (a, b) in enumerate(zip(poly, poly[1:] + poly[:1])):
            dx, dz = b[0] - a[0], b[1] - a[1]
            length = math.hypot(dx, dz)
            if length < 1e-6:
                continue
            cuts = []
            for opening in design.get("openings") or []:
                # 只要挂在边界上就开洞：2026-11-04 裁定图纸判读的（source=cad）也算。
                # 认错的门窗在「绘制门窗」那一步删掉，删了这里就自动补回实心墙。
                if "edgeIndex" not in opening:
                    continue
                owner = next((r for r in design.get("rooms") or [] if r["id"] == opening.get("roomId")), None)
                if not owner or (owner.get("floor") or 1) != floor:
                    continue
                owner_pts = room_points(owner)
                edge = opening["edgeIndex"]
                if not isinstance(edge, int) or not 0 <= edge < len(owner_pts):
                    continue
                u, v = owner_pts[edge], owner_pts[(edge + 1) % len(owner_pts)]
                ends = [[(u[0] + (v[0] - u[0]) * opening[k]) / UNITS,
                         (u[1] + (v[1] - u[1]) * opening[k]) / UNITS] for k in ("start", "end")]
                if any(abs((p[0] - a[0]) * dz - (p[1] - a[1]) * dx) / length > .01 / UNITS for p in ends):
                    continue
                ts = [((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / (length * length) for p in ends]
                cuts.append({**opening, "start": max(0, min(ts)), "end": min(1, max(ts))})
            cuts.sort(key=lambda o: o["start"])

            def segment(start, end, bottom=0, top=h, opening_id=""):
                if end - start < 1e-6 or top - bottom < 1e-6:
                    return
                walls.append({"x0": a[0] + dx * start, "z0": a[1] + dz * start,
                              "x1": a[0] + dx * end, "z1": a[1] + dz * end,
                              "heightM": top - bottom, "bottomM": bottom, "t": .12,
                              "roomId": room["id"], "floor": floor, "openingId": opening_id})
            cursor = 0
            for opening in cuts:
                start, end = max(0, float(opening.get("start", 0))), min(1, float(opening.get("end", 0)))
                if not end > start or start < cursor - 1e-6:
                    continue
                segment(cursor, start)
                sill = 0 if opening.get("type") == "门" else max(0, min(h, float(opening.get("sillHeight") or 0)))
                top = min(h, sill + float(opening.get("heightM") or 2.1))
                segment(start, end, 0, sill, opening["id"])
                segment(start, end, top, h, opening["id"])
                if opening["roomId"] == room["id"]:
                    openings.append({"id": opening["id"], "type": opening.get("type"), "roomId": room["id"],
                                 "x0": a[0] + dx * start, "z0": a[1] + dz * start,
                                 "x1": a[0] + dx * end, "z1": a[1] + dz * end,
                                 "width": length * (end - start), "heightM": top - sill,
                                     "sillHeight": sill, "floor": floor})
                cursor = end
            segment(cursor, 1)
    box = [min(p[0] for p in all_points), min(p[1] for p in all_points),
           max(p[0] for p in all_points), max(p[1] for p in all_points)] if all_points else [0, 0, 10, 10]
    return {"rooms": rooms, "walls": walls, "openings": openings, "bbox": box,
            "geometry_source": "design-spaces"}
