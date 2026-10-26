"""把工作台的数据模型翻译成「优邑珺和」三维场景的 `__SCENE__` 结构。

口径（为什么是这么做的）：

- 渲染内核不是我们写的。`backend/scene3d/app.js` 是「优邑珺和-可执行灯光场景.html」
  里那段渲染引擎原样搬过来的，一个字符都没改；它启动时只读一个全局 `window.__SCENE__`。
- 所以接入工作台的正确做法不是"照着它的参数调我们的渲染器"，而是**把工作台的项目数据
  翻译成它认的那份 JSON**，剩下的交给它。参数、配光、灯带、昼夜、加减速全都不用我们操心。
- 单位：它的坐标是米（原文件由同一套 dxf_lighting 出，shoelace(room[0].poly)=2.06 对上
  图上 2.1㎡，可证）。我们 `_engine_view()` 输出的也是米，直通，不再除以 26。

灯的类型（筒灯/天花灯/吊线灯/壁灯）在它的内核里是一张写死的表，决定光束角、流明和色温：
    筒灯 24°/800lm / #FFF0DD    天花灯 36°/1000lm
    吊线灯 60°/1200lm           壁灯 45°/500lm
我们的灯只带 `half`（半角，度），所以按半角就近归到它那四档，而不是另造一套。
"""

from __future__ import annotations

import math
from statistics import median

# 内核写死的四档灯（beam 是**全角**，度）——用来把我们的 half 归位
_KIND_BY_BEAM = [
    ("筒灯", 24.0),
    ("天花灯", 36.0),
    ("壁灯", 45.0),
    ("吊线灯", 60.0),
]

DEFAULT_LIGHT_R = 0.09        # 灯具外径（米），它用来画天花板上的小圆点 + 灯体
DEFAULT_THICKNESS = 0.12


def _half_mount(light: dict, ceiling: float) -> tuple[float, float]:
    """灯的半角（度）与安装高度（米）；缺数据时半角 0、高度按层高。"""
    half = light.get("half")
    try:
        half = float(half) if half not in (None, "") else 0.0
    except (TypeError, ValueError):
        half = 0.0
    mount = light.get("mount")
    try:
        mount = float(mount) if mount not in (None, "") else ceiling
    except (TypeError, ValueError):
        mount = ceiling
    return half, mount


def _kind_of(light: dict, ceiling: float) -> str:
    """我们的灯 → 它的四档灯。有半角按半角，没半角按安装高度推。"""
    half, mount = _half_mount(light, ceiling)
    # 吊下来的才是吊线灯（60° 大光锥）。贴顶的灯只能落在筒灯/天花灯两档：
    # 数据里的半角有 25°/30° 这种超宽值，硬按角度归到「壁灯 45°」会把贴顶筒灯
    # 画成一大团白球——不是它渲染错了，是归类错了。
    hanging = ceiling - mount > 0.45
    if not hanging:
        return "筒灯" if (half <= 0 or half * 2.0 <= 28) else "天花灯"
    return "吊线灯"


def _quad(x0: float, z0: float, x1: float, z1: float, half_t: float) -> list[list[float]] | None:
    """一段墙中心线 → 一条有厚度的四边形（墙的实际占地）。"""
    dx, dz = x1 - x0, z1 - z0
    length = math.hypot(dx, dz)
    if length < 1e-6:
        return None
    nx, nz = -dz / length * half_t, dx / length * half_t
    return [
        [round(x0 + nx, 4), round(z0 + nz, 4)],
        [round(x1 + nx, 4), round(z1 + nz, 4)],
        [round(x1 - nx, 4), round(z1 - nz, 4)],
        [round(x0 - nx, 4), round(z0 - nz, 4)],
    ]


def _area(poly: list[list[float]]) -> float:
    if len(poly) < 3:
        return 0.0
    s = 0.0
    for i in range(len(poly) - 1):
        s += poly[i][0] * poly[i + 1][1] - poly[i + 1][0] * poly[i][1]
    s += poly[-1][0] * poly[0][1] - poly[0][0] * poly[-1][1]
    return abs(s) / 2.0


def _point_in_poly(x: float, z: float, poly: list[list[float]]) -> bool:
    """射线法。灯的 xy 落在房间轮廓里，就算这盏灯是这个房间的。"""
    inside = False
    n = len(poly)
    if n < 3:
        return False
    j = n - 1
    for i in range(n):
        xi, yi = poly[i][0], poly[i][1]
        xj, yj = poly[j][0], poly[j][1]
        if ((yi > z) != (yj > z)) and (x < (xj - xi) * (z - yi) / ((yj - yi) or 1e-12) + xi):
            inside = not inside
        j = i
    return inside


def _room_of(x: float, z: float, rooms: list[dict]) -> str:
    for r in rooms:
        if _point_in_poly(x, z, r["poly"]):
            return r["name"]
    return ""


def _centroid(poly: list[list[float]]) -> tuple[float, float]:
    if not poly:
        return 0.0, 0.0
    if len(poly) < 3:
        xs = [p[0] for p in poly]
        ys = [p[1] for p in poly]
        return sum(xs) / len(xs), sum(ys) / len(ys)
    a = cx = cy = 0.0
    # 多边形是闭合的：最后一点到第一点这条边不能漏（2026-10-23 修）。
    # 漏掉它时，电梯厅/玄关/公卫/儿童房/次卧的“质心”会落到房间外，标签就贴到隔壁去了。
    for i in range(len(poly)):
        x0, y0 = poly[i]
        x1, y1 = poly[(i + 1) % len(poly)]
        cross = x0 * y1 - x1 * y0
        a += cross
        cx += (x0 + x1) * cross
        cy += (y0 + y1) * cross
    if abs(a) < 1e-9:
        xs = [p[0] for p in poly]
        ys = [p[1] for p in poly]
        return sum(xs) / len(xs), sum(ys) / len(ys)
    a *= 0.5
    return round(cx / (6 * a), 3), round(cy / (6 * a), 3)



def _label_anchor(poly: list[list[float]]) -> tuple[float, float]:
    """空间名标签的落点：优先面积质心；质心落在多边形外时，退化到扫描线最宽区间中点。

    2026-10-23：`_centroid` 漏了闭合边，5 个房间的标签被贴到房间外；这里再兜一层，
    以后遇到 L 形/凹形房间也不会把名字标到隔壁。
    """
    cx, cy = _centroid(poly)
    if _point_in_poly(cx, cy, poly):
        return cx, cy
    if len(poly) < 3:
        return cx, cy
    ys = [pt[1] for pt in poly]
    y = min(max(cy, min(ys) + 0.001), max(ys) - 0.001)
    xs: list[float] = []
    n = len(poly)
    for i in range(n):
        x0, y0 = poly[i]
        x1, y1 = poly[(i + 1) % n]
        if (y0 > y) != (y1 > y):
            xs.append(x0 + (y - y0) * (x1 - x0) / (y1 - y0))
    xs.sort()
    best = None
    for i in range(0, len(xs) - 1, 2):
        a, b = xs[i], xs[i + 1]
        if b > a and (best is None or (b - a) > (best[1] - best[0])):
            best = (a, b)
    if best:
        mx = (best[0] + best[1]) / 2
        if _point_in_poly(mx, y, poly):
            return round(mx, 3), round(y, 3)
    # 最后退到外接框中心（能落在里面的情况）
    minx, maxx = min(pt[0] for pt in poly), max(pt[0] for pt in poly)
    miny, maxy = min(pt[1] for pt in poly), max(pt[1] for pt in poly)
    mx, my = (minx + maxx) / 2, (miny + maxy) / 2
    if _point_in_poly(mx, my, poly):
        return round(mx, 3), round(my, 3)
    return cx, cy


def _ceil_lines(rooms: list[dict]) -> list[list[list[float]]]:
    """房间轮廓当吊顶线画（参考文件里那圈细蓝线）。

    优邑珺和的 ceil_lines 来自图纸的「吊顶蓝线」图层；我们的房间轮廓就是吊顶围合出来的，
    用它的边做同一件事：让人一眼看出空间边界在哪。
    """
    out: list[list[list[float]]] = []
    for r in rooms:
        poly = r.get("poly") or []
        for i in range(len(poly) - 1):
            out.append([poly[i], poly[i + 1]])
    return out


def build(view: dict, floor: int = 1) -> dict:
    """`_engine_view()` 的输出 → `__SCENE__`。

    `view` 就是 `/api/lighting3d/{pid}/data.json` 那份东西（已按层分了 floor 字段）。
    """
    ceiling = float(view.get("ceiling_net") or view.get("ceiling") or 2.8)
    walls_in = [w for w in view.get("walls") or [] if int(w.get("floor") or 1) == floor]
    rooms_in = [r for r in view.get("rooms") or [] if int(r.get("floor") or 1) == floor]

    thickness = median([float(w.get("t") or DEFAULT_THICKNESS) for w in walls_in]) if walls_in else DEFAULT_THICKNESS
    thickness = max(0.05, round(thickness, 3))
    if not walls_in:
        thickness = DEFAULT_THICKNESS

    # —— 墙：每段一条四边形，用各自的厚度（户内隔墙和承重墙不一样厚）——
    walls: list[dict] = []
    seen: set[tuple] = set()
    for w in walls_in:
        try:
            x0, z0 = float(w["x0"]), float(w["z0"])
            x1, z1 = float(w["x1"]), float(w["z1"])
        except (KeyError, TypeError, ValueError):
            continue
        t = float(w.get("t") or thickness)
        quad = _quad(x0, z0, x1, z1, max(t, 0.04) / 2.0)
        if not quad:
            continue
        key = (quad[0][0], quad[0][1], quad[2][0], quad[2][1])
        if key in seen or (key[2], key[3], key[0], key[1]) in seen:
            continue
        seen.add(key)
        walls.append({"outer": quad, "holes": []})

    # —— 地面：一个房间一块板 ——
    floor_slabs: list[dict] = []
    rooms: list[dict] = []
    total = 0.0
    for r in rooms_in:
        poly = [[round(float(p[0]), 4), round(float(p[1]), 4)] for p in (r.get("poly") or []) if len(p) >= 2]
        if len(poly) < 3:
            continue
        area = round(_area(poly), 2)
        cx, cy = _label_anchor(poly)
        total += area
        floor_slabs.append({"outer": poly, "holes": []})
        rooms.append({"poly": poly, "area_m2": area, "cx": cx, "cy": cy,
                      "name": r.get("name") or "未分区"})

    # —— 灯：它的光斑/光锥全部由 lights_meta 里的 kind 决定 ——
    circuits_by_id = {c.get("id"): c for c in (view.get("circuits") or [])}
    lights: list[list[float]] = []
    lights_meta: list[dict] = []
    counts: dict[str, int] = {}
    kinds: dict[str, int] = {}
    fixture_circuits: dict[str, str] = {}
    for light in view.get("lights") or []:
        if int(light.get("floor") or 1) != floor:
            continue
        try:
            x, z = float(light["x"]), float(light["z"])
        except (KeyError, TypeError, ValueError):
            continue
        kind = _kind_of(light, ceiling)
        half, mount = _half_mount(light, ceiling)
        circuit = circuits_by_id.get(light.get("c")) or {}
        # 回路名是给人看的、也是情景预置的匹配依据（会客=客厅餐厅全亮…），
        # 图纸里的回路常常只有一个 C01，所以按灯落在哪个房间来命名
        # 顺序不能反：图纸给的回路 room 常常等于回路编号（C01），
        # 先信几何（灯落在哪个房间），再退到回路上的房间名
        room = _room_of(x, z, rooms) or circuit.get("room") or "未分区"
        name = f"{room}·{kind}"
        r = round(DEFAULT_LIGHT_R, 3)
        lights.append([round(x, 4), round(z, 4), r])
        lights_meta.append({"x": round(x, 4), "y": round(z, 4), "r": r,
                            "room": room, "kind": kind, "circuit": name,
                            "half": round(half, 1), "mount": round(mount, 3)})
        # 工作台的灯具 id → 内核的回路名。前端切情景/拖回路时按这张表发亮度，
        # 三维才会跟着变（否则内核只按它自己的预置亮灯，跟设计没关系）。
        if light.get("id"):
            fixture_circuits[str(light["id"])] = name
        counts[name] = counts.get(name, 0) + 1
        kinds[kind] = kinds.get(kind, 0) + 1

    # 灯带：它的 strips 就是折线（按段画线），我们的 path 直通
    strips: list[list[list[float]]] = []
    for s in view.get("strips") or []:
        if int(s.get("floor") or 1) != floor:
            continue
        path = [[round(float(p[0]), 4), round(float(p[1]), 4)] for p in (s.get("path") or []) if len(p) >= 2]
        if len(path) >= 2:
            strips.append(path)

    # 门窗：{p1,p2,w,th,h,sill}
    doors: list[dict] = []
    windows: list[dict] = []
    for o in view.get("openings") or []:
        if int(o.get("floor") or 1) != floor:
            continue
        try:
            item = {
                "p1": [round(float(o["x0"]), 4), round(float(o["z0"]), 4)],
                "p2": [round(float(o["x1"]), 4), round(float(o["z1"]), 4)],
                "w": round(float(o.get("width") or 0.9), 3),
                "th": round(thickness, 3),
                "h": round(float(o.get("heightM") or 2.1), 3),
                "sill": round(float(o.get("sillHeight") or 0), 3),
            }
        except (KeyError, TypeError, ValueError):
            continue
        (windows if str(o.get("type") or "").startswith("窗") else doors).append(item)

    # 家具：内核（app.js）只画墙/地/灯，不画家具；外壳（shell.html）拿这份清单后用内核
    # 暴露的 three 工厂补一层体块，挂到 viewer.groups.furniture，让「图层 → 家具」开关生效。
    # 坐标口径与内核一致：x/z 为设计米坐标（= 设计坐标 / 26），外壳里 z 取负。
    furniture = []
    for f in view.get("furniture") or []:
        if int(f.get("floor") or 1) != floor:
            continue
        try:
            item = {
                "id": str(f.get("id") or ""),
                "kind": str(f.get("kind") or ""),
                "x": round(float(f["x"]), 4),
                "z": round(float(f["z"]), 4),
                "w": round(float(f.get("w") or 0.6), 3),
                "d": round(float(f.get("d") or 0.6), 3),
                "h": round(float(f.get("h") or 0.75), 3),
                "rot": round(float(f.get("rot") or 0), 2),
                "roomId": str(f.get("roomId") or ""),
            }
            pts = f.get("pts")
            if isinstance(pts, list) and len(pts) >= 3:
                item["pts"] = [[round(float(p[0]), 4), round(float(p[1]), 4)] for p in pts]
            furniture.append(item)
        except (KeyError, TypeError, ValueError, IndexError):
            continue

    return {
        "height_m": round(ceiling, 3),
        "thickness_m": round(thickness, 3),
        "walls": walls,
        "wall_segments": len(walls),
        "wall_layers": ["墙体"],
        "floor": floor_slabs,
        "rooms": rooms,
        "doors": doors,
        "windows": windows,
        "lights": lights,
        "lights_meta": lights_meta,
        "switches": [],
        "beams": [],
        "strips": strips,
        "furniture": furniture,
        "fixtures": [{"model": k, "count": v} for k, v in sorted(kinds.items(), key=lambda kv: -kv[1])],
        "light_types": [{"kind": k, "count": v} for k, v in sorted(kinds.items(), key=lambda kv: -kv[1])],
        "circuits": [{"name": k, "count": v} for k, v in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))],
        "fixture_circuits": fixture_circuits,
        "ceil_lines": _ceil_lines(rooms),
        "area_total_m2": round(total, 2),
        "source": view.get("name") or "",
        "geometry_source": view.get("geometry_source") or "",
    }
