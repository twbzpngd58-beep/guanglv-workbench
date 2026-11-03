"""房间「报的面积」与「画得出来的轮廓」必须是同一块地。

踩过的坑（2026-10-27 0图层2）：空间识别写「餐厅、客厅 62.55㎡」，布灯画布上只有餐厅那 46.52㎡。
原因是反推时轮廓取最大内接矩形、面积取连通格总数，两个口径不一致。
本脚本把所有能找到的样例图纸跑一遍两条链路（识别 / 三维解析），逐间核对：
  · 有轮廓的房间：轮廓鞋带面积 == 报出来的面积（差 2% 以内）
  · 没轮廓的房间：报的面积 == 外接矩形面积（它本来就是方的，压扁也不失真）
退出码非 0 = 还有房间被裁掉或凭空放大。
"""
from __future__ import annotations

import glob
import hashlib
import os
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(HERE, "backend"))
TOL = 0.02


def ring_area(pts):
    n = len(pts)
    return abs(sum(pts[i][0] * pts[(i + 1) % n][1] - pts[(i + 1) % n][0] * pts[i][1]
                   for i in range(n))) / 2.0


def check(chain, rooms):
    """rooms 每项：{name, area（㎡）, poly（[[x,y]...]）, bbox（[x0,y0,x1,y1]）}；返回问题列表。"""
    bad = []
    for r in rooms:
        area = float(r.get("area") or 0)
        poly = [(float(p[0]), float(p[1])) for p in (r.get("poly") or [])]
        label = f"{chain}/{r.get('name') or '未命名'}"
        if len(poly) >= 3:
            got = ring_area(poly)
            if area <= 0 or abs(got - area) / max(area, 1e-6) > TOL:
                bad.append(f"{label}: 轮廓 {got:.2f}㎡ ≠ 面积 {area:.2f}㎡（顶点 {len(poly)}）")
        else:
            b = r.get("bbox") or []
            box = (float(b[2]) - float(b[0])) * (float(b[3]) - float(b[1])) if len(b) == 4 else 0.0
            if area <= 0 or abs(box - area) / max(area, 1e-6) > TOL:
                bad.append(f"{label}: 没有轮廓，面积 {area:.2f}㎡ ≠ 包框 {box:.2f}㎡")
    return bad


def recognition_chain(dxf_lighting, path):
    """识别链路：0 图层按墙线反推的空间（dxf_plan.grid_spaces），图纸毫米 → 米。"""
    import ezdxf
    data = dxf_lighting.collect(ezdxf.readfile(path))
    geo = dxf_lighting.layer0_geometry(data)
    if not geo:
        return []
    out = []
    for r in geo["rooms"]:
        q = [[p[0] / 1000.0, p[1] / 1000.0] for p in r["points"]]
        out.append({"name": r["name"] or "未命名", "area": r["areaMm2"] / 1e6, "poly": q,
                    "bbox": [min(p[0] for p in q), min(p[1] for p in q),
                             max(p[0] for p in q), max(p[1] for p in q)]})
    return out


def main():
    seen, files = set(), []
    for p in (sorted(glob.glob(os.path.join(HERE, "data/lighting3d/*.source.dxf")))
              + sorted(glob.glob(os.path.join(HERE, "data/uploads/projects/*/*.dxf")))
              + sorted(glob.glob(os.path.join(HERE, "samples/*.dxf")))):
        if not os.path.isfile(p):
            continue
        h = hashlib.sha256(open(p, "rb").read()).hexdigest()
        if h not in seen:
            seen.add(h)
            files.append(p)
    if not files:
        print("没找到任何图纸样例")
        return 1

    import dxf_lighting as dl
    fails, total = [], 0
    for p in files:
        short = os.path.basename(p)
        try:
            rooms = dl.parse(p).get("rooms") or []
        except Exception as exc:                      # 解析本身失败的图纸不在本脚本口径内
            print(f"跳过 {short}（解析失败：{exc}）")
            continue
        try:
            rec = recognition_chain(dl, p)
        except Exception as exc:
            rec = []
            print(f"   识别链路没跑通：{exc}")
        total += len(rooms) + len(rec)
        got = (check("三维", [{"name": r.get("name"), "area": r.get("area"),
                               "poly": r.get("poly"), "bbox": r.get("bbox")} for r in rooms])
               + check("识别", rec))
        print(f"{short}: 三维 {len(rooms)} 间 / 识别 {len(rec)} 间 → " + ("PASS" if not got else "FAIL"))
        fails += got
    for f in fails:
        print("   ", f)
    print(f"\n共 {len(files)} 张图、{total} 个房间，面积与轮廓不一致 {len(fails)} 处")
    return 1 if fails else 0


if __name__ == "__main__":
    raise SystemExit(main())
