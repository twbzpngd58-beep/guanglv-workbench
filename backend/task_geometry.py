"""Exact task-space geometry, shared with the numbered workflow and approval bridge."""
import copy
import math
import uuid
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import split


def points(room):
    if len(room.get("points") or []) >= 3:
        return [(float(p["x"]), float(p["y"])) for p in room["points"]]
    x, y, w, h = (float(room[k]) for k in ("x", "y", "w", "h"))
    return [(x, y), (x+w, y), (x+w, y+h), (x, y+h)]


def shape(room):
    polygon = Polygon(points(room))
    if not polygon.is_valid or polygon.area <= 1e-8:
        raise ValueError("空间边界无效或交叉")
    return polygon


def fields(polygon):
    if polygon.geom_type != "Polygon" or polygon.interiors:
        raise ValueError("空间必须是单个无内洞的闭合多边形")
    x, y, right, bottom = polygon.bounds
    return {"x": x, "y": y, "w": right-x, "h": bottom-y,
            "points": [{"x": x, "y": y} for x, y in list(polygon.exterior.coords)[:-1]]}


def inside(room, x, y):
    return shape(room).buffer(1e-8).covers(Point(float(x), float(y)))


def units_per_m(room):
    area = float(room.get("area") or 0)
    return math.sqrt(shape(room).area/area) if area > 0 else 26


def transform_design(raw, action, room_id, other_id=""):
    """Return a new draft; the normal revision-checked save owns persistence."""
    design = copy.deepcopy(raw)
    rooms = design["rooms"]
    room = next((r for r in rooms if r["id"] == room_id), None)
    if not room:
        raise ValueError("请先选择空间")
    native = lambda r: {**r, "w": r["width"], "h": r["height"]}
    previous = {room_id}
    before = {r["id"]: native(r) for r in rooms}
    if action == "merge":
        other = next((r for r in rooms if r["id"] == other_id and r["id"] != room_id), None)
        if not other or other.get("floor", 1) != room.get("floor", 1):
            raise ValueError("请选择同一楼层的另一个空间")
        outline = merge_rooms(native(room), native(other))
        previous.add(other_id)
        room.update(outline, width=outline["w"], height=outline["h"], source="manual",
                    area=shape(outline).area/676)
        rooms.remove(other)
        changed = [room]
    elif action == "split":
        original = copy.deepcopy(room)
        changed = []
        for i, (outline, ratio) in enumerate(split_room(native(room))):
            item = {**original, **outline, "width": outline["w"], "height": outline["h"], "source": "manual",
                    "area": round(float(original.get("area", 0))*ratio, 2)}
            if i:
                item.update(id=uuid.uuid4().hex[:12], name=original["name"]+" 2", source="manual")
                rooms.append(item)
            else:
                room.update(item)
                item = room
            changed.append(item)
    else:
        raise ValueError("不支持的空间操作")
    for a in changed:
        if any(b["id"] not in {r["id"] for r in changed} and b.get("floor", 1) == a.get("floor", 1)
               and shape(native(a)).intersection(shape(native(b))).area > 1e-6 for b in rooms):
            raise ValueError("操作后空间会重叠，请先核对边界")
    for key in ("fixtures", "devices", "furniture"):
        for item in design.get(key, []):
            if item.get("roomId") in previous:
                target = next((r for r in changed if inside(native(r), item["x"], item["y"])), None)
                if not target and key != "furniture":
                    raise ValueError("空间外仍有关联灯具或设备，请先移走")
                item["roomId"] = target["id"] if target else ""
    openings = []
    for opening in design.get("openings", []):
        if opening.get("roomId") not in previous or "edgeIndex" not in opening:
            openings.append(opening)
            continue
        pts = points(before[opening["roomId"]])
        a, b = pts[opening["edgeIndex"]], pts[(opening["edgeIndex"]+1)%len(pts)]
        ends = [(a[0]+(b[0]-a[0])*opening[t], a[1]+(b[1]-a[1])*opening[t]) for t in ("start", "end")]
        for target in changed:
            outline = points(native(target))
            match = None
            for index, (a, b) in enumerate(zip(outline, outline[1:]+outline[:1])):
                dx, dy = b[0]-a[0], b[1]-a[1]
                length = math.hypot(dx, dy)
                if length < 1e-8 or any(abs((p[0]-a[0])*dy-(p[1]-a[1])*dx)/length > 1e-6 for p in ends):
                    continue
                ts = [((p[0]-a[0])*dx+(p[1]-a[1])*dy)/length**2 for p in ends]
                low, high = max(0, min(ts)), min(1, max(ts))
                if high-low <= 1e-6:
                    continue
                match = {**opening, "id": opening["id"] if not any(o["id"] == opening["id"] for o in openings) else uuid.uuid4().hex[:12],
                         "roomId": target["id"], "edgeIndex": index, "start": low, "end": high,
                         "x": a[0]+dx*low, "y": a[1]+dy*low, "width": length*(high-low),
                         "rotation": math.degrees(math.atan2(dy, dx))}
                break
            if match:
                openings.append(match)
    design["openings"] = openings
    design["walls"] = [w for w in design.get("walls", []) if w.get("source") != "space-boundary"]
    design["spaceDefinition"] = {**design.get("spaceDefinition", {}), "status": "previewing"}
    return design


def merge_rooms(first, second):
    a, b = shape(first), shape(second)
    if a.distance(b) > 1e-7 or (a.boundary.intersection(b.boundary).length < 1e-7 and a.intersection(b).area < 1e-7):
        raise ValueError("只能合并共边或相交的两个区域")
    return fields(a.union(b))


def split_room(room):
    p = shape(room)
    x, y, right, bottom = p.bounds
    if right-x >= bottom-y:
        middle = (x+right)/2
        cut = LineString([(middle, y-1), (middle, bottom+1)])
    else:
        middle = (y+bottom)/2
        cut = LineString([(x-1, middle), (right+1, middle)])
    parts = [g for g in split(p, cut).geoms if g.area > 1e-8]
    if len(parts) < 2:
        raise ValueError("这条分割线不能分开当前空间")
    return [(fields(g), g.area/p.area) for g in sorted(parts, key=lambda g: g.bounds)]


def design_scale(doc):
    return 26 if doc.get("fromDxf") else 1


def to_design(doc):
    scale = design_scale(doc)
    rooms = []
    for r in doc.get("rooms") or []:
        pts = points(r)
        rooms.append({
            "id": r["id"], "name": r["name"], "type": r["name"], "source": r.get("source", "cad-preview"),
            "floor": r.get("floor", 1), "x": r["x"]*scale, "y": r["y"]*scale,
            "width": r["w"]*scale, "height": r["h"]*scale, "area": r["area"],
            "heightM": r.get("heightM", 3), "originalHeightM": r.get("originalHeightM", 3),
            "points": [{"x": x*scale, "y": y*scale} for x, y in pts],
        })
    openings = [{**o, "x": o["x"]*scale, "y": o["y"]*scale, "width": o["width"]*scale}
                for o in doc.get("openings") or []]
    furniture = [{**f, "x": f["x"]*scale, "y": f["y"]*scale} for f in doc.get("furniture") or []]
    return {"rooms": rooms, "openings": openings, "furniture": furniture,
            "walls": [], "fixtures": [], "devices": [], "texts": [], "scenes": [],
            "spaceDefinition": {"status": "confirmed" if doc.get("confirmed") else "previewing"}}
