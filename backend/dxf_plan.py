"""0 图层（无语义图层）平面 DXF 的几何反推：墙 → 空间 → 门窗。

现场图纸常常整张画在 layer 0，没有 WALL/DOOR/FURN 这类语义图层名，
原来的 ezdxf-basic 只把每条线当墙、每个闭合框当一个「闭合区域」，
结果就是用户看到的「只有一个框架 + 部分家具」。本模块按画法反推语义：

  双线平行对（厚 60-400）＝墙（间距＝墙厚，只配最近的一条，砖缝/踏步不连环配）
  同轴墙段之间的间隙 / 带端头帽的墙端间隙＝门洞
  贴外墙的深 150-950、长 >2000 的闭合带 + X 对角线＝窗带（樘数＝对角线/2）
  由墙围成的连通空白格＝空间；格内的文字＝空间名
  无名零星小块（≤2.5㎡）＝家具/洁具闭环，并进隔壁空间；无名窄长条＝走廊/过道，无名大开间＝开放区

口径与 skills/dxf-survey 保持一致。只在图纸没有语义图层时启用；
多层图纸维持原有行为，不受这里影响。
"""

from __future__ import annotations

import bisect
import math
import re
from collections import defaultdict

TOL = 1.5              # 坐标吸附容差（图纸单位）
WALL_T = (60, 400)     # 墙厚范围
BAND_T = (150, 950)    # 窗带进深
MIN_WALL_LEN = 250     # 短于此的线段不当墙（门扇、标注线）
MIN_ROOM_SIDE = 300    # 空间最小边长（小于此的是家具缝、瓷砖格）
DOOR_GAP = (150, 4000)  # 门洞宽度范围
CORNER_GAP = 1200       # 墙端头到相邻垂直墙的最大补合距离（只补门洞那么宽的缝）
ROOM_MAX_VERTICES = 16  # 空间轮廓顶点上限，与 app.py 识别导入那道闸同口径
# 8 点是给图像边界分析留的（那种轮廓容易碎），0 图层是格子真轮廓：
# 主卫那种绕着马桶间拐弯的房间天生 12 点，卡 8 点就只能退回内接矩形，
# 浴缸那半边直接从图纸上消失（实测 14.87㎡ 报成 8.44㎡）。语义视觉那条路本来就放到 16。

# 家具/洁具闭环与无名空间的口径（2026-11-03 用户拍板：家具洁具轮廓不算房间，
# 但走廊、过道、开放区这些没有中文标注的空间也要认出来）
ABSORB_MAX_AREA = 2_500_000   # 无名小块 ≤2.5㎡ 视为家具/洁具闭环，并进隔壁大空间
CORRIDOR_MIN_LEN = 2000       # 走廊/过道：长边下限
CORRIDOR_MAX_WIDE = 2200      # 走廊/过道：短边（净宽）上限
CORRIDOR_RATIO = 2.2          # 走廊/过道：长宽比下限
OPEN_AREA_MIN = 4_000_000     # 无名开间 ≥4㎡ 且不像走廊 → 开放区
CORRIDOR_NAME = "走廊/过道"
OPEN_AREA_NAME = "开放区（未标注）"
UNNAMED_NAME = "未命名空间（待核）"


def _orient(p, q):
    if abs(p[1] - q[1]) <= TOL:
        return "H"
    if abs(p[0] - q[0]) <= TOL:
        return "V"
    return "D"


def _pair_rows(lines, tmin, tmax, min_len, nearest_only=True):
    """双线配对：同向平行线、间距在 tmin-tmax、投影重叠 ≥60% → 一条中心线段。
    nearest_only=True 时（墙）只认最近的一条平行线，避免标定线、瓷砖缝连环配成多堵墙。"""
    segs = []
    for ori, key in (("H", lambda p: p[1]), ("V", lambda p: p[0])):
        groups = defaultdict(list)
        for a, b in lines:
            if _orient(a, b) != ori:
                continue
            length = abs(a[0] - b[0]) if ori == "H" else abs(a[1] - b[1])
            if length < min_len:
                continue
            lo, hi = sorted((a[0], b[0])) if ori == "H" else sorted((a[1], b[1]))
            groups[round(key(a), 1)].append((lo, hi))
        ks = sorted(groups)
        for i, ka in enumerate(ks):
            for kb in ks[i + 1:]:
                t = kb - ka
                if t > tmax:
                    break
                if t < tmin:
                    if nearest_only:
                        break
                    continue
                hit = 0
                for a0, a1 in groups[ka]:
                    for b0, b1 in groups[kb]:
                        o0, o1 = max(a0, b0), min(a1, b1)
                        if o1 - o0 >= 0.6 * min(a1 - a0, b1 - b0):
                            segs.append({"ori": ori, "axis": (ka + kb) / 2, "t": t,
                                         "s": min(a0, b0), "e": max(a1, b1),
                                         "ov0": o0, "ov1": o1})
                            hit += 1
                # 配上了就收手：砖缝/踏步那类等距平行线（间距 65-70）若继续往外配，
                # 一条线会被 70/140/205/275 连环配成四堵墙，实测 0图层 的楼梯间因此
                # 多出 3 道隔断、把空间切成 12 块碎片。
                if hit and nearest_only:
                    break
    return segs


def pair_walls(lines):
    return _pair_rows(lines, WALL_T[0], WALL_T[1], MIN_WALL_LEN)


def paired_bands(lines, bb):
    """双线 + X 对角线画法的窗带（贴外墙、进深 150-950、长 >2000）。
    很多图纸的窗带是 4 条 LINE 围的，不是闭合多段线，polygon 判读抓不到。"""
    x0, y0, x1, y1 = bb
    diags, seen = [], set()
    for a, b in lines:
        if _orient(a, b) != "D":
            continue
        k = tuple(sorted(((round(a[0], 1), round(a[1], 1)), (round(b[0], 1), round(b[1], 1)))))
        if k in seen:
            continue
        seen.add(k)
        diags.append((min(a[0], b[0]), max(a[0], b[0]), min(a[1], b[1]), max(a[1], b[1])))
    out = []
    for s in _pair_rows(lines, BAND_T[0], BAND_T[1], 2000, nearest_only=False):
        # 用两条线的重叠段当窗带长度：取并集会把整面外墙串成一条窗带
        lo, hi = (s["ov0"], s["ov1"])
        # 贴外墙看的是「进深方向」落在外框哪条边附近，不是长边的端点
        edge_lo, edge_hi = (y0, y1) if s["ori"] == "H" else (x0, x1)
        near = min(abs(s["axis"] - edge_lo), abs(s["axis"] - edge_hi))
        if near > 400:
            continue
        if s["ori"] == "H":
            n = sum(1 for d0, d1, e0, e1 in diags
                    if lo - 50 <= d0 and d1 <= hi + 50
                    and s["axis"] - s["t"] <= (e0 + e1) / 2 <= s["axis"] + s["t"])
        else:
            n = sum(1 for d0, d1, e0, e1 in diags
                    if lo - 50 <= e0 and e1 <= hi + 50
                    and s["axis"] - s["t"] <= (d0 + d1) / 2 <= s["axis"] + s["t"])
        if n < 2:
            continue
        out.append({"kind": "窗带", "bays": n // 2, "ori": s["ori"], "axis": s["axis"],
                    "from": lo, "to": hi, "width": hi - lo})
    return out


def merge_walls(segs):
    """同轴同厚的共线墙段合并。"""
    out = []
    for s in sorted(segs, key=lambda v: (v["ori"], round(v["axis"]), round(v["t"]), v["s"])):
        for o in out:
            if (o["ori"] == s["ori"] and abs(o["axis"] - s["axis"]) <= 30
                    and abs(o["t"] - s["t"]) <= 30 and o["e"] >= s["s"] - 200):
                o["e"] = max(o["e"], s["e"])
                break
        else:
            out.append(dict(s))
    return out


def cap_lines(lines, walls):
    """门洞端头帽：长度≈墙厚、垂直贴在墙端、居中于墙轴的短线。"""
    caps = []
    for a, b in lines:
        ori = _orient(a, b)
        if ori == "D":
            continue
        ln = math.dist(a, b)
        if not (40 <= ln <= 650):
            continue
        axis = (a[1] + b[1]) / 2 if ori == "H" else (a[0] + b[0]) / 2
        mid = (a[0] + b[0]) / 2 if ori == "H" else (a[1] + b[1]) / 2
        caps.append({"ori": ori, "axis": axis, "mid": mid, "len": ln})
    return caps


def find_openings(walls, lines):
    """门洞：① 同轴墙段之间的间隙；② 带端头帽的墙端到最近垂直墙轴的间隙。"""
    caps = cap_lines(lines, walls)
    out = []
    by = defaultdict(list)
    for s in walls:
        by[(s["ori"], round(s["axis"] / 30), round(s["t"] / 30))].append(s)
    axes = defaultdict(list)
    for s in walls:
        axes[s["ori"]].append(s["axis"])
    for grp in by.values():
        grp.sort(key=lambda s: s["s"])
        for a, b in zip(grp, grp[1:]):
            g = b["s"] - a["e"]
            if DOOR_GAP[0] < g < DOOR_GAP[1]:
                out.append({"kind": "门洞", "ori": grp[0]["ori"], "axis": grp[0]["axis"],
                            "from": a["e"], "to": b["s"], "width": g})
        for s in grp:
            for end, direction in ((s["s"], -1), (s["e"], 1)):
                capped = any(c["ori"] != s["ori"] and abs(c["axis"] - end) <= 60
                             and WALL_T[0] * 0.6 <= c["len"] <= s["t"] * 1.6
                             and abs(c["mid"] - s["axis"]) <= s["t"] for c in caps)
                if not capped:
                    continue
                perp = [a for a in (axes["V"] if s["ori"] == "H" else axes["H"])
                        if 300 < (a - end) * direction < 4000]
                if not perp:
                    continue
                other = min(perp, key=lambda a: abs(a - end))
                out.append({"kind": "门洞", "ori": s["ori"], "axis": s["axis"],
                            "from": min(end, other), "to": max(end, other),
                            "width": abs(other - end)})
    seen, uniq = set(), []
    for o in out:
        k = (o["ori"], round(o["axis"]), round(o["from"]), round(o["to"]))
        if k in seen:
            continue
        seen.add(k)
        uniq.append(o)
    return uniq


def window_bands(polygons, lines, bb):
    """窗带：贴外墙、进深 150-950、长边 >2000 的闭合带 + 内部 X 对角线（按端点去重）。"""
    x0, y0, x1, y1 = bb
    diags, seen = [], set()
    for a, b in lines:
        if _orient(a, b) != "D":
            continue
        k = tuple(sorted(((round(a[0], 1), round(a[1], 1)), (round(b[0], 1), round(b[1], 1)))))
        if k in seen:
            continue
        seen.add(k)
        diags.append((min(a[0], b[0]), max(a[0], b[0]), min(a[1], b[1]), max(a[1], b[1])))
    bands = []
    for pts in polygons:
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        rx0, ry0, rx1, ry1 = min(xs), min(ys), max(xs), max(ys)
        w, h = rx1 - rx0, ry1 - ry0
        deep, long_ = (h, w) if w > h else (w, h)
        if not (BAND_T[0] <= deep <= BAND_T[1] and long_ > 2000):
            continue
        near_h = min(abs(ry0 - y0), abs(ry1 - y1), abs(ry0 - y1), abs(ry1 - y0)) < 400
        near_v = min(abs(rx0 - x0), abs(rx1 - x0), abs(rx0 - x1), abs(rx1 - x1)) < 400
        if not ((near_h and w > h) or (near_v and h > w)):
            continue
        n = sum(1 for dx0, dx1, dy0, dy1 in diags
                if rx0 - 50 <= dx0 and dx1 <= rx1 + 50 and ry0 - 50 <= dy0 and dy1 <= ry1 + 50)
        if n < 2:
            continue
        bands.append({"kind": "窗带", "bays": n // 2, "ori": "H" if w > h else "V",
                      "axis": (ry0 + ry1) / 2 if w > h else (rx0 + rx1) / 2,
                      "from": rx0 if w > h else ry0, "to": rx1 if w > h else ry1})
    return bands


def bridge_gaps(walls, max_gap=4000, corner_gap=0):
    """把墙线补成「围合隔断」，供空间格判使用：
    ① 同轴墙段之间的门洞缺口补平——门口并不把两个空间连成一个空间；
    ② 墙端头补到最近的垂直墙轴上（gap ≤ corner_gap）——墙画到洞口就停笔，
       不补就会让整层从洞口串成一个大空间。只用于隔断，不改原始墙段。
    """
    by = defaultdict(list)
    for w in walls:
        by[(w["ori"], round(w["axis"] / 30))].append(dict(w))
    out = []
    for grp in by.values():
        grp.sort(key=lambda w: w["s"])
        cur = grp[0]
        cur["t"] = max(w["t"] for w in grp)
        for nxt in grp[1:]:
            if nxt["s"] - cur["e"] <= max_gap:
                cur["e"] = max(cur["e"], nxt["e"])
                cur["t"] = max(cur["t"], nxt["t"])
            else:
                out.append(cur)
                cur = dict(nxt)
                cur["t"] = max(w["t"] for w in grp)
        out.append(cur)
    if corner_gap <= 0:
        return out
    for w in out:
        perp = [p for p in out
                if p["ori"] != w["ori"]
                and p["s"] - p["t"] <= w["axis"] <= p["e"] + p["t"]]
        for attr, direction in (("s", -1), ("e", 1)):
            cands = [p["axis"] for p in perp
                     if 0 < (p["axis"] - w[attr]) * direction <= corner_gap]
            if cands:
                nearest = min(cands, key=lambda a: abs(a - w[attr]))
                w[attr] = min(w[attr], nearest) if direction < 0 else max(w[attr], nearest)
    return out


def grid_spaces(walls, texts):
    """墙线做网格 → 连通空白格＝空间；格内文字＝空间名。"""
    barriers = bridge_gaps(walls, corner_gap=CORNER_GAP)
    xs = sorted({round(s["s"], 1) for s in barriers if s["ori"] == "H"} |
                {round(s["e"], 1) for s in barriers if s["ori"] == "H"} |
                {round(s["axis"], 1) for s in barriers if s["ori"] == "V"})
    ys = sorted({round(s["s"], 1) for s in barriers if s["ori"] == "V"} |
                {round(s["e"], 1) for s in barriers if s["ori"] == "V"} |
                {round(s["axis"], 1) for s in barriers if s["ori"] == "H"})
    if len(xs) < 3 or len(ys) < 3 or len(xs) * len(ys) > 400_000:
        return []
    cx = {v: i for i, v in enumerate(xs)}
    cy = {v: i for i, v in enumerate(ys)}
    ncol, nrow = len(xs) - 1, len(ys) - 1
    # 右邻隔断：竖墙落在 x=vx[i] 上、覆盖 vy[j]..vy[j+1]
    block_r = [[False] * nrow for _ in range(ncol)]
    block_d = [[False] * ncol for _ in range(nrow)]
    for s in barriers:
        if s["ori"] == "V":
            i = cx.get(round(s["axis"], 1))
            if i is None or i == 0:
                continue
            for j in range(nrow):
                if ys[j] >= s["s"] - TOL and ys[j + 1] <= s["e"] + TOL:
                    block_r[i - 1][j] = True
        else:
            j = cy.get(round(s["axis"], 1))
            if j is None or j == 0:
                continue
            for i in range(ncol):
                if xs[i] >= s["s"] - TOL and xs[i + 1] <= s["e"] + TOL:
                    block_d[j - 1][i] = True
    seen = [[False] * nrow for _ in range(ncol)]
    comps = []
    for si in range(ncol):
        for sj in range(nrow):
            if seen[si][sj]:
                continue
            stack, cells = [(si, sj)], []
            seen[si][sj] = True
            while stack:
                i, j = stack.pop()
                cells.append((i, j))
                for ni, nj, blocked in (
                    (i + 1, j, block_r[i][j]), (i - 1, j, block_r[i - 1][j]),
                    (i, j + 1, block_d[j][i]), (i, j - 1, block_d[j - 1][i]),
                ):
                    if blocked or ni < 0 or nj < 0 or ni >= ncol or nj >= nrow or seen[ni][nj]:
                        continue
                    seen[ni][nj] = True
                    stack.append((ni, nj))
            comps.append(cells)
    gx0, gy0, gx1, gy1 = xs[0], ys[0], xs[-1], ys[-1]
    cand = []
    for cells in comps:
        # 含网格角格 (0,0) 的连通块是墙外空白，不是房间
        if any(i == 0 and j == 0 for i, j in cells):
            continue
        # 最大内接矩形只用来定 x/y/w/h（房间门槛、洞口挂接、去重比的是它），
        # 轮廓另走真实格子边界，见下面的 region_poly。
        cellset = set(cells)
        ci0, cj0, ci1, cj1 = max_rect(cells, ncol, nrow)
        x0, x1 = xs[ci0], xs[ci1 + 1]
        y0, y1 = ys[cj0], ys[cj1 + 1]
        if x1 - x0 < MIN_ROOM_SIDE or y1 - y0 < MIN_ROOM_SIDE:
            continue
        if x0 <= gx0 + TOL and y0 <= gy0 + TOL and x1 >= gx1 - TOL and y1 >= gy1 - TOL:
            continue
        # 标注归属按连通块的真实格子判定（最大内接矩形可能切掉标签所在的角）
        inside = [t for t in texts if (cell_of(xs, t[0]), cell_of(ys, t[1])) in cellset]
        # 空间名只认 2 字以上的中文标注；「上/下」这类箭头方向字、英文副标题不算名字
        named = [str(t[2]).strip() for t in inside
                 if len(str(t[2]).strip()) >= 2 and re.search(r"[\u4e00-\u9fff]", str(t[2]))]
        name = "、".join(dict.fromkeys(named))[:40]
        # 没标注、又是窄条（短边小于窗带进深上限）的连通块＝窗带腔、墙缝、瓷砖格，不是空间
        if not name and min(x1 - x0, y1 - y0) < BAND_T[1]:
            continue
        cand.append({"cells": cellset, "name": name, "labels": [t[2] for t in inside]})

    # 家具、洁具那类闭合轮廓画在房间里，隔断配对后会把房间切成碎片：
    # 无名的零星小块并进隔壁最大的空间（床头柜并进卧室），没隔壁可并的直接丢。
    cand = absorb_slivers(cand, xs, ys)

    # 补凹角时不能把隔壁空间吃掉：先记下每个格子属于哪个空间。
    # 实测 0图层 的主卫（12 点 14.87㎡）最浅的两个缺口正好是马桶间那一格（1.11㎡），
    # 不设这道闸，补完角的轮廓会盖住马桶间，画布上两个空间叠在一起、确认空间直接判重叠。
    owner = {}
    for idx, c in enumerate(cand):
        for cell in c["cells"]:
            owner[cell] = idx
    xi = {v: i for i, v in enumerate(xs)}
    yi = {v: i for i, v in enumerate(ys)}

    def notch_free_of_others(idx, rect):
        nx0, nx1, ny0, ny1 = rect
        ia, ib = xi.get(round(nx0, 1)), xi.get(round(nx1, 1))
        ja, jb = yi.get(round(ny0, 1)), yi.get(round(ny1, 1))
        if None in (ia, ib, ja, jb):
            return False
        for i in range(min(ia, ib), max(ia, ib)):
            for j in range(min(ja, jb), max(ja, jb)):
                if owner.get((i, j), idx) != idx:
                    return False
        return True

    rooms = []
    for idx, c in enumerate(cand):
        cells = sorted(c["cells"])
        ci0, cj0, ci1, cj1 = max_rect(cells, ncol, nrow)
        x0, x1 = xs[ci0], xs[ci1 + 1]
        y0, y1 = ys[cj0], ys[cj1 + 1]
        area = cells_area(cells, xs, ys)
        # 没有中文标注不等于不是空间：走廊/过道/开放区照样认出来，名字按形状给。
        name = c["name"] or space_kind(x1 - x0, y1 - y0, area)
        # L 形/回字形连通块：轮廓走真实格子边界，面积按轮廓算。
        # 以前只取「最大内接矩形」当轮廓，格子的连通面积照旧报出来，
        # 于是画布上客厅餐厅只剩餐厅那一块（实测 0图层2：面积 62.55㎡、轮廓只有 46.52㎡）。
        # 顶点超过 ROOM_MAX_VERTICES 时先把凹角补平（补最浅的那个），补不下来才退回内接矩形
        # ——识别导入那道闸（app.py 8 点）会把超点房间踢成「待人工划分」，宁可边界粗一点，
        # 也不能让房间整个消失。实测 0图层 的主卫 12 点 14.87㎡：直接退矩形只剩 8.44㎡，
        # 浴缸那一半从图纸上消失；补两个凹角能保住 8 点内的真实轮廓。
        poly = region_poly(cells, xs, ys)
        if len(poly) < 4:
            poly = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
        elif len(poly) > ROOM_MAX_VERTICES:
            poly = simplify_orthogonal(
                poly, ROOM_MAX_VERTICES,
                lambda r: notch_free_of_others(idx, r),
            )
        if len(poly) > ROOM_MAX_VERTICES:
            poly = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
        rooms.append({"name": name, "x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0,
                      "points": poly, "areaMm2": round(abs(ring_area(poly)), 1),
                      "labels": c["labels"], "nameFromText": bool(c["name"])})
    return dedupe_rooms(rooms)


def cells_area(cells, xs, ys):
    """连通格的真实面积（mm²）。"""
    return sum((xs[i + 1] - xs[i]) * (ys[j + 1] - ys[j]) for i, j in cells)


def cells_touch(a, b):
    """两块连通格是否隔着一道隔断相邻（有一对四邻格互相落在对方里）。"""
    for i, j in a:
        if (i + 1, j) in b or (i - 1, j) in b or (i, j + 1) in b or (i, j - 1) in b:
            return True
    return False


def absorb_slivers(cand, xs, ys):
    """无名零星小块并进相邻大空间；没有相邻空间的直接丢掉。"""
    for k in sorted(range(len(cand)), key=lambda n: cells_area(cand[n]["cells"], xs, ys)):
        c = cand[k]
        if not c or c["name"] or cells_area(c["cells"], xs, ys) > ABSORB_MAX_AREA:
            continue
        best, best_area = None, cells_area(c["cells"], xs, ys)
        for m, other in enumerate(cand):
            if m == k or not other:
                continue
            a = cells_area(other["cells"], xs, ys)
            if a > best_area and cells_touch(c["cells"], other["cells"]):
                best, best_area = m, a
        if best is None:
            cand[k] = None
        else:
            cand[best]["cells"] |= c["cells"]
            cand[k] = None
    return [c for c in cand if c]


def space_kind(w, h, area):
    """无名空间的类型：窄长条＝走廊/过道，够大的开间＝开放区，其余标成待核命名。"""
    short, long_ = (w, h) if w < h else (h, w)
    if (long_ >= CORRIDOR_MIN_LEN and short <= CORRIDOR_MAX_WIDE
            and long_ / max(short, 1) >= CORRIDOR_RATIO):
        return CORRIDOR_NAME
    if area >= OPEN_AREA_MIN:
        return OPEN_AREA_NAME
    return UNNAMED_NAME


def ring_area(pts):
    """有符号面积（y 轴向上时逆时针为正）。"""
    return sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(pts, pts[1:] + pts[:1])) / 2


def region_poly(cells, xs, ys):
    """连通格 → 真实外轮廓（逆时针、左下角起、去共线）。回字形的内洞不算轮廓。

    相邻两格共用的边一正一反互相抵消，剩下的边必然首尾相接成闭合圈；
    圈不闭合说明格子不连通或坐标异常，此时返回空让调用方退回矩形，不硬凑。
    边的账按「两端点的规范键」记，不按起点记 —— 起点记会被同一点的另两条边覆盖，
    实测 0图层2 的客厅餐厅因此漏掉 18 条边、轮廓走不闭合。
    """
    edge = {}
    for i, j in cells:
        c = [(xs[i], ys[j]), (xs[i + 1], ys[j]), (xs[i + 1], ys[j + 1]), (xs[i], ys[j + 1])]
        for k in range(4):
            a, b = c[k], c[(k + 1) % 4]
            key = (a, b) if a <= b else (b, a)
            if key in edge:
                del edge[key]
            else:
                edge[key] = (a, b)
    if not edge:
        return []
    nxt = defaultdict(list)
    for a, b in edge.values():
        nxt[a].append(b)
    loops = []
    while edge:
        first = next(iter(edge.values()))[0]
        loop, cur = [first], first
        while True:
            if not nxt[cur]:
                return []
            targets = nxt[cur]
            b = targets.pop()
            del edge[(cur, b) if cur <= b else (b, cur)]
            if b == first:
                break
            loop.append(b)
            cur = b
        loops.append(loop)
    poly = max(loops, key=lambda l: abs(ring_area(l)))
    if ring_area(poly) < 0:
        poly.reverse()
    head = min(range(len(poly)), key=lambda k: (poly[k][1], poly[k][0]))
    poly = poly[head:] + poly[:head]
    out = []
    for k, p in enumerate(poly):
        a, b = poly[k - 1], poly[(k + 1) % len(poly)]
        if abs((p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0])) > 1e-6:
            out.append(p)
    return out if len(out) >= 3 else []


def _reflex(poly, k):
    """逆时针正交轮廓里，cross<0 的那个角就是凹角（往里咬了一块）。"""
    n = len(poly)
    a, r, b = poly[k - 1], poly[k], poly[(k + 1) % n]
    return (r[0] - a[0]) * (b[1] - r[1]) - (r[1] - a[1]) * (b[0] - r[0]) < 0


def simplify_orthogonal(poly, max_vertices, notch_ok=None):
    """正交轮廓超点：每次补掉「最浅的一个缺口」，直到不超过 max_vertices。

    补一次轮廓少 2 个顶点、面积多出那块缺口，先补最浅的，失真最小。
    缺口有两种：绕隔壁空间拐出来的（两个相邻凹角，如主卫绕马桶间），
    以及单个凹角的台阶（L 形的内角）。两种都试。
    只认「补完面积正好增加缺口大小、顶点确实少 2 个」的候选——
    U 形/回字形补下去会让轮廓自交（那块缺口本来就属于房间），面积账对不上，自动被刷掉。
    notch_ok(缺口外接框) 用来禁止吃掉隔壁已认出来的空间（格子归属由调用方判断）。
    """
    poly = list(poly)
    while len(poly) > max_vertices:
        base = abs(ring_area(poly))
        n = len(poly)
        best = None

        def offer(gap, rect, trimmed):
            nonlocal best
            if len(trimmed) > len(poly) - 2:
                return
            if abs(abs(ring_area(trimmed)) - (base + gap)) > max(1.0, base * 1e-6):
                return
            if notch_ok is not None and not notch_ok(rect):
                return
            if best is None or gap < best[0]:
                best = (gap, trimmed)

        for k in range(n):
            a, r, b = poly[k - 1], poly[k], poly[(k + 1) % n]
            if not _reflex(poly, k):
                continue
            # 单凹角台阶：把 r 顶到对角的 c 上，两侧边并成直线
            if a[0] != b[0] and a[1] != b[1]:
                c = (a[0], b[1])
                if c == r:
                    c = (b[0], a[1])
                if c != r and c not in poly:
                    rect = (min(a[0], b[0], r[0], c[0]), min(a[1], b[1], r[1], c[1]),
                            max(a[0], b[0], r[0], c[0]), max(a[1], b[1], r[1], c[1]))
                    gap = (rect[2] - rect[0]) * (rect[3] - rect[1])
                    offer(gap, rect, _drop_collinear(poly[:k] + [c] + poly[k + 1:]))
            # 双凹角缺口：隔壁空间占的方洞，两个凹角一起删掉，p→q 直接连成一条边
            r2 = poly[(k + 1) % n]
            p, q = poly[k - 1], poly[(k + 2) % n]
            if _reflex(poly, (k + 1) % n) and (p[0] == q[0] or p[1] == q[1]):
                pts = (p, r, r2, q)
                rect = (min(v[0] for v in pts), min(v[1] for v in pts),
                        max(v[0] for v in pts), max(v[1] for v in pts))
                gap = (rect[2] - rect[0]) * (rect[3] - rect[1])
                trimmed = [poly[i] for i in range(n) if i not in (k, (k + 1) % n)]
                offer(gap, rect, _drop_collinear(trimmed))
        if best is None:
            break
        poly = best[1]
    return poly


def _drop_collinear(poly):
    """去掉共线的中间点（补角后相邻两边会并成一条直线）。"""
    n = len(poly)
    out = []
    for k, p in enumerate(poly):
        a, b = poly[k - 1], poly[(k + 1) % n]
        if abs((p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0])) > 1e-6:
            out.append(p)
    return out


def rects_poly(rects):
    """轴对齐矩形集合（[x0,y0,x1,y1]）→ 并集外轮廓；单个矩形就是四个角。"""
    if not rects:
        return []
    xs = sorted({round(v[i], 3) for v in rects for i in (0, 2)})
    ys = sorted({round(v[i], 3) for v in rects for i in (1, 3)})
    if len(xs) < 2 or len(ys) < 2:
        return []
    cells = []
    for j in range(len(ys) - 1):
        for i in range(len(xs) - 1):
            cx, cz = (xs[i] + xs[i + 1]) / 2, (ys[j] + ys[j + 1]) / 2
            if any(r[0] <= cx <= r[2] and r[1] <= cz <= r[3] for r in rects):
                cells.append((i, j))
    return region_poly(cells, xs, ys) if cells else []


def cell_of(vals, v):
    """坐标落在哪一格（越界返回 -1，保证不进任何房间）。"""
    i = bisect.bisect_right(vals, v - TOL) - 1
    return i if 0 <= i <= len(vals) - 2 else -1


def max_rect(cells, ncol, nrow):
    """连通块里的最大内接矩形（按格子数），返回 (i0, j0, i1, j1) 闭区间。"""
    own = set(cells)
    height = [0] * ncol
    best = (0, 0, 0, 0, -1)
    for j in range(nrow):
        for i in range(ncol):
            height[i] = height[i] + 1 if (i, j) in own else 0
        stack = []
        for i in range(ncol + 1):
            h = height[i] if i < ncol else 0
            start = i
            while stack and stack[-1][0] >= h:
                ph, ps = stack.pop()
                width = i - ps
                if ph * width > best[4]:
                    top = j - ph + 1
                    best = (ps, top, i - 1, j, ph * width)
                start = ps
            stack.append((h, start))
    return best[:4]


def dedupe_rooms(rooms):
    """互相包含或几乎重合的矩形只留大的那个。"""
    keep = []
    for r in sorted(rooms, key=lambda v: -v["areaMm2"]):
        for k in keep:
            ox = min(r["x"] + r["w"], k["x"] + k["w"]) - max(r["x"], k["x"])
            oy = min(r["y"] + r["h"], k["y"] + k["h"]) - max(r["y"], k["y"])
            if ox <= 1 or oy <= 1:
                continue
            if ox * oy >= 0.8 * r["w"] * r["h"]:
                break
        else:
            keep.append(r)
    return keep


def triple_windows(lines, bb):
    """三线窗：外墙轴线附近 3 条平行长线（≥600）、总跨度 60-300 的窗画法。"""
    x0, y0, x1, y1 = bb
    out = []
    for ori in ("H", "V"):
        rows = {}
        for a, b in lines:
            if _orient(a, b) != ori:
                continue
            lo, hi = sorted((a[0], b[0])) if ori == "H" else sorted((a[1], b[1]))
            k = round(a[1] if ori == "H" else a[0])
            prev = rows.get(k)
            if prev is None or hi - lo > prev[1] - prev[0]:
                rows[k] = (lo, hi)
        ks = sorted(rows)
        for i in range(len(ks) - 2):
            span = ks[i + 2] - ks[i]
            if not (60 <= span <= 300):
                continue
            if min(rows[ks[i]][1] - rows[ks[i]][0], rows[ks[i + 1]][1] - rows[ks[i + 1]][0],
                   rows[ks[i + 2]][1] - rows[ks[i + 2]][0]) < 600:
                continue
            on_ext = (ori == "H" and (min(abs(ks[i] - y0), abs(ks[i] - y1)) < 500)) or \
                     (ori == "V" and (min(abs(ks[i] - x0), abs(ks[i] - x1)) < 500))
            if not on_ext:
                continue
            lo, hi = rows[ks[i + 1]]
            out.append({"kind": "三线窗", "ori": ori, "axis": (ks[i] + ks[i + 2]) / 2,
                        "from": lo, "to": hi, "width": hi - lo})
    return out


def merge_openings(raw):
    """同一洞口的两种判读（同轴间隙 / 端头帽到垂直墙）合并成一条，取较宽的那次。"""
    out = []
    win = lambda o: o["kind"] in ("窗带", "三线窗")
    # 门洞取较宽的一次；窗按判读来源优先（闭合多段线的窗带比双线配对更准，排在前）
    ordered = sorted((o for o in raw if not win(o)), key=lambda v: -(v["to"] - v["from"]))
    ordered += [o for o in raw if win(o)]
    for o in ordered:
        fam = "窗" if win(o) else "门"
        for m in out:
            mfam = "窗" if win(m) else "门"
            if mfam != fam or m["ori"] != o["ori"]:
                continue
            # 同一个窗常被窗带/三线窗两种画法各判一次，轴线相差在一个窗带进深内算同一个
            if abs(m["axis"] - o["axis"]) > (BAND_T[1] if fam == "窗" else 400):
                continue
            ov = min(m["to"], o["to"]) - max(m["from"], o["from"])
            if ov > 0.3 * min(m["to"] - m["from"], o["to"] - o["from"]):
                break
        else:
            out.append(o)
    return out


def edge_of(rect, ori, axis, lo, hi):
    """把一段洞口挂到最近空间的边界上：返回 (edgeIndex, start, end)。
    洞口跨两个空间时按各自边界裁剪，只要重叠 ≥30% 就各挂一段。"""
    x0, y0, x1, y1 = rect["x"], rect["y"], rect["x"] + rect["w"], rect["y"] + rect["h"]
    span = hi - lo
    if span <= 0:
        return None
    edges = ((0, y0, x0, x1, True), (2, y1, x0, x1, False)) if ori == "H" \
        else ((1, x1, y0, y1, True), (3, x0, y0, y1, False))
    for idx, edge_at, e0, e1, fwd in edges:
        if abs(axis - edge_at) > max(120, span * 0.1):
            continue
        a0, a1 = max(lo, e0), min(hi, e1)
        if a1 - a0 < 0.3 * span:
            continue
        if fwd:
            return idx, max(0.0, (a0 - e0) / (e1 - e0)), min(1.0, (a1 - e0) / (e1 - e0))
        return idx, max(0.0, (e1 - a1) / (e1 - e0)), min(1.0, (e1 - a0) / (e1 - e0))
    return None


def mount_on_poly(rect, edge, a, b):
    """矩形边上的洞口区间 → 真实轮廓上的 (edgeIndex, start, end)。

    空间是不规则形时，外接矩形的那条边未必是房间真边界（切掉的那一角根本没有墙），
    所以把区间换算成图纸坐标再找轮廓上与之共线的那条边；轮廓上没有就返回 None（洞口丢弃）。
    矩形房间逐点等价于老口径：四条边的顺序、方向都没变。
    """
    x0, y0, x1, y1 = rect["x"], rect["y"], rect["x"] + rect["w"], rect["y"] + rect["h"]
    ref = ((x0, y0), (x1, y0), (x1, y1), (x0, y1))
    u, v = ref[edge % 4], ref[(edge + 1) % 4]
    pts = rect.get("points") or []
    if len(pts) < 3:
        return None
    q = [(u[0] + (v[0] - u[0]) * t, u[1] + (v[1] - u[1]) * t) for t in (a, b)]
    span = math.dist(u, v) * (b - a)
    for i, (p, s) in enumerate(zip(pts, pts[1:] + pts[:1])):
        dx, dy = s[0] - p[0], s[1] - p[1]
        length = math.hypot(dx, dy)
        if length < 1e-6:
            continue
        if any(abs((t[0] - p[0]) * dy - (t[1] - p[1]) * dx) / length > max(2.0, span * .05)
               for t in q):
            continue
        ts = [((t[0] - p[0]) * dx + (t[1] - p[1]) * dy) / (length * length) for t in q]
        lo, hi = min(ts), max(ts)
        if (hi - lo) * length < 0.3 * span:
            continue
        return i, max(0.0, lo), min(1.0, hi)
    return None


def attach_openings(rooms, raw):
    """洞口挂到相邻空间边界：洞的两侧各挂一次（门连两个空间），挂不上的丢弃。"""
    out = []
    for o in raw:
        picked = {}
        for r in rooms:
            e = edge_of(r, o["ori"], o["axis"], o["from"], o["to"])
            if not e:
                continue
            m = mount_on_poly(r, *e)
            if not m:
                continue
            idx, a, b = m
            if b - a < 0.02:
                continue
            across = (r["y"] + r["h"] / 2) if o["ori"] == "H" else (r["x"] + r["w"] / 2)
            side = 0 if abs(across - o["axis"]) < 1 else (1 if across > o["axis"] else -1)
            if side not in picked:
                picked[side] = (r, idx, a, b)
        for r, idx, a, b in list(picked.values())[:2]:
            out.append({**o, "room": r, "edgeIndex": idx, "start": a, "end": b})
    return out
