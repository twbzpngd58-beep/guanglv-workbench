#!/usr/bin/env python3
"""验收：房间轮廓必须就是房间本身——报多少㎡，画布上就占多少㎡。

踩过的坑（2026-10-27，0图层2 / 项目 0531b403094b440b）：空间识别写「餐厅、客厅」，
布灯画布上只剩餐厅那一块——解析把轮廓取成最大内接矩形（46.52㎡），面积却按连通格总数报（62.55㎡），
客厅那一头的 16㎡ 在二维里根本不存在，落在里面的灯具也就挂不上这间。

这里走真实链路（上传 → 三维生成 → preview-to-design → 重新解析替换 → 确认），逐条 PASS/FAIL：
  1. 每间设计房间的**轮廓鞋带面积 == 报出来的面积**（2% 以内）——同类房间全查，不止这一间
  2. 「餐厅、客厅」是凹形（顶点 ≥5、面积 >55㎡、轮廓明显小于外接框）
  3. 凹形里那头的灯具重新解析后仍挂在这间；外接框缺角里的灯具不挂（轮廓不是被压平的外接框）
  4. 确认空间这一步走得通（不报 422）
用法：python3 scripts/accept_room_poly.py [图纸路径]
      默认 data/lighting3d/0531b403094b440b.source.dxf（就是出问题那张）
临时项目跑完即删，data/ 不留残留。
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

BASE = os.environ.get("GUANGLV_BASE", "http://127.0.0.1:8000")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STORE = os.path.join(ROOT, "data", "lighting3d")
DEFAULT_FILE = os.path.join(ROOT, "data", "lighting3d", "0531b403094b440b.source.dxf")
TOL = 0.02
RESULTS = []
rec_projects = []


def call(method, path, payload=None):
    data, headers = None, {}
    if payload is not None:
        data = json.dumps(payload).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return {"__err": e.code, "__body": e.read().decode()[:300]}


def check(name, cond, detail=""):
    RESULTS.append(bool(cond))
    print(("PASS " if cond else "FAIL ") + name + (f" → {detail}" if detail else ""))


def upload(pid, path, boundary, recognize=False):
    raw = open(path, "rb").read()
    head = (f'--{boundary}\r\nContent-Disposition: form-data; name="recognize"\r\n\r\n'
            f'{"true" if recognize else "false"}\r\n')
    head += (f'--{boundary}\r\nContent-Disposition: form-data; name="files"; '
             f'filename="{os.path.basename(path)}"\r\nContent-Type: application/octet-stream\r\n\r\n')
    req = urllib.request.Request(f"{BASE}/api/projects/{pid}/files",
                                 data=head.encode() + raw + f'\r\n--{boundary}--\r\n'.encode(),
                                 method="POST",
                                 headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.loads(r.read().decode())


def generate(pid, file_id):
    body = (f'--arp\r\nContent-Disposition: form-data; name="file_id"\r\n\r\n{file_id}\r\n--arp--\r\n').encode()
    req = urllib.request.Request(f"{BASE}/api/lighting3d/{pid}/generate", data=body, method="POST",
                                 headers={"Content-Type": "multipart/form-data; boundary=arp"})
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.loads(r.read().decode())


def wait_job(pid, limit=420):
    deadline = time.time() + limit
    while time.time() < deadline:
        j = call("GET", f"/api/lighting3d/{pid}/job")
        if j.get("state") in ("done", "error"):
            return j
        time.sleep(2)
    return {"state": "timeout"}


def pts_m(room):
    """设计房间轮廓（图纸单位 26 = 1 米）→ 米。"""
    return [(float(p["x"]) / 26.0, float(p["y"]) / 26.0) for p in (room.get("points") or [])]


def ring(pts):
    n = len(pts)
    return abs(sum(pts[i][0] * pts[(i + 1) % n][1] - pts[(i + 1) % n][0] * pts[i][1]
                   for i in range(n))) / 2.0


def in_poly(poly, x, y):
    n = len(poly)
    hit = False
    for i in range(n):
        a, b = poly[i], poly[(i + 1) % n]
        if (a[1] > y) != (b[1] > y) and x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]:
            hit = not hit
    return hit


def far_inside(poly):
    """凹形里离质心最远的内部点（扇形三角剖分取重心，再验一次真在里面）。"""
    c = (sum(p[0] for p in poly) / len(poly), sum(p[1] for p in poly) / len(poly))
    best = None
    for k in range(1, len(poly) - 1):
        tri = [poly[0], poly[k], poly[k + 1]]
        p = (sum(q[0] for q in tri) / 3, sum(q[1] for q in tri) / 3)
        if not in_poly(poly, *p):
            continue
        d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2
        if best is None or d > best[0]:
            best = (d, p)
    return best[1] if best else None


def notch_outside(poly):
    """外接框的四角里挑一个落在房间外的点——老口径把轮廓压成外接框时，这种点会被误收进来。"""
    xs = [p[0] for p in poly]
    ys = [p[1] for p in poly]
    for cx, cy in ((min(xs), min(ys)), (max(xs), min(ys)), (max(xs), max(ys)), (min(xs), max(ys))):
        for t in (0.02, 0.06, 0.12):
            x = cx + (sum(xs) / len(xs) - cx) * t
            y = cy + (sum(ys) / len(ys) - cy) * t
            if not in_poly(poly, x, y):
                return (x, y)
    return None


path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_FILE
name = os.path.basename(path)
pid = call("POST", "/api/projects", {"name": "验收-房间轮廓-临时", "type": "平层",
                                     "area": 120, "mode": "2D", "smart": "无"})["id"]
print(f"\n==== {name}  (临时项目 {pid})")
try:
    upload(pid, path, "arp")
    proj = call("GET", f"/api/projects/{pid}")
    dxf = next((x for x in (proj.get("files") or []) if str(x.get("name", "")).lower().endswith(".dxf")), None)
    check("图纸已入库", bool(dxf), (dxf or {}).get("name", "无"))
    generate(pid, dxf["id"])
    job = wait_job(pid)
    check("三维生成完成", job.get("state") == "done", f"{job.get('state')} {(job.get('error') or '')[:70]}")
    st = call("GET", f"/api/lighting3d/{pid}")
    check("解析器是当前的（改了逻辑必须 +1，否则老项目不会重跑）",
          st.get("parse_stale") is False and st.get("parsed_version") == st.get("parser_version"),
          f"库内 {st.get('parsed_version')} / 当前 {st.get('parser_version')}")

    r0 = call("POST", f"/api/lighting3d/{pid}/preview-to-design")
    check("preview-to-design 落了图纸解析的空间", r0.get("rooms") and not r0.get("__err"),
          json.dumps(r0, ensure_ascii=False)[:120])
    proj = call("GET", f"/api/projects/{pid}")
    design = proj["design"]
    rooms = [r for r in design["rooms"] if str(r.get("floor") or 1) == "1"]
    check("每间房的轮廓面积 == 报出来的面积（同类房间全查）", all(
        len(pts_m(r)) >= 3 and abs(ring(pts_m(r)) - float(r.get("area") or 0))
        <= TOL * max(float(r.get("area") or 1), 1e-6) for r in rooms),
        " ".join(f'{r.get("name")}:{ring(pts_m(r)):.2f}/{r.get("area")}' for r in rooms))

    big = max(rooms, key=lambda r: float(r.get("area") or 0))
    bp = pts_m(big)
    box = (max(p[0] for p in bp) - min(p[0] for p in bp)) * (max(p[1] for p in bp) - min(p[1] for p in bp))
    check(f"最大那间「{big.get('name')}」是不规则轮廓而不是外接框",
          len(bp) >= 5 and float(big.get("area") or 0) > 55 and ring(bp) < 0.95 * box,
          f"顶点 {len(bp)} 面积 {big.get('area')}㎡ 外接框 {box:.2f}㎡")

    poly = pts_m(big)
    deep = far_inside(poly)
    out = notch_outside(poly)
    check("轮廓里找得到「深处点」和「框内房外点」", bool(deep) and bool(out),
          f"深处 {deep and (round(deep[0], 2), round(deep[1], 2))} 框角 {out and (round(out[0], 2), round(out[1], 2))}")

    # 空间识别那一条链路（用户最先在那页看到「餐厅、客厅」）：单独一个临时项目，只跑识别不动设计
    pid_rec = call("POST", "/api/projects", {"name": "验收-房间轮廓-识别临时", "type": "平层",
                                             "area": 120, "mode": "2D", "smart": "无"})["id"]
    rec_projects.append(pid_rec)
    upload(pid_rec, path, "arp-rec", recognize=True)
    files = call("GET", f"/api/projects/{pid_rec}").get("files") or []
    rec = next((f.get("recognition") or {} for f in reversed(files)
                if (f.get("recognition") or {}).get("rooms")), {})
    rec_rooms = rec.get("rooms") or []
    check("空间识别草稿同样给出真实轮廓（不是外接框/内接框）",
          any(len(r.get("points") or []) >= 5 for r in rec_rooms),
          f"{len(rec_rooms)} 间，顶点 {[len(r.get('points') or []) for r in rec_rooms][:6]}")

    # 深处那盏灯：老口径（轮廓＝内接矩形）落在房间外 → 挂不上；修好后必须还挂在这间。
    if deep and out:
        fixtures = []
        for i, (fx, fy) in enumerate((deep, out)):
            fixtures.append({"id": f"arp-f{i}", "code": f"ARP-{i + 1}", "type": "筒灯",
                             "name": f"验收灯·{'凹形深处' if i == 0 else '外接框缺角'}", "circuit": "C1",
                             "roomId": big["id"], "x": fx * 26, "y": fy * 26,
                             "floor": big.get("floor", 1), "power": 8, "price": 100,
                             "brightnessMax": 100, "cctMin": 2700, "cctMax": 4000, "installHeight": 2.4})
        saved = call("PUT", f"/api/projects/{pid}/design",
                     {"revision": proj["revision"], "design": {**design, "fixtures": fixtures}})
        check("两盏验收灯已挂上", saved.get("id") == pid, str(saved.get("__body"))[:150])

        re = call("POST", f"/api/lighting3d/{pid}/preview-to-design?reapply=1")
        check("重新解析替换整套空间（reapply）走得通", re.get("rooms") and not re.get("__err"),
              json.dumps(re, ensure_ascii=False)[:120])
        now = call("GET", f"/api/projects/{pid}")["design"]
        by_id = {f["id"]: f for f in now.get("fixtures") or []}
        deep_room = next((r for r in now["rooms"]
                          if r["id"] == by_id.get("arp-f0", {}).get("roomId")), None)
        check("凹形深处的灯重新解析后仍挂在这间（不是暂未归属）",
              by_id.get("arp-f0", {}).get("roomId") not in (None, "")
              and float((deep_room or {}).get("area") or 0) > 55,
              f'挂到 {(deep_room or {}).get("name") or "暂未归属"}')
        f1 = by_id.get("arp-f1", {})
        r1 = next((r for r in now["rooms"] if r["id"] == f1.get("roomId")), None)
        # 缺角那个位置在真实图纸里是隔壁「储藏间」的地盘：灯必须跟着落点走，不能留在客厅餐厅里。
        check("外接框缺角的灯没算进这间（轮廓没压成外接框，落点归到隔壁）",
              f1.get("roomId") != big["id"] and (r1 is None or in_poly(pts_m(r1), out[0], out[1])),
              f'缺角灯 → {r1 and r1.get("name") or "暂未归属"}')

    conf = call("POST", f"/api/lighting3d/{pid}/confirm")
    check("确认空间这一步走得通（不报 422）", conf.get("rooms") is not None and not conf.get("__err"),
          str(conf.get("rooms")) if not conf.get("__err") else str(conf.get("__body"))[:150])
finally:
    print("DELETE", call("DELETE", f"/api/projects/{pid}"))
    for extra in rec_projects:
        call("DELETE", f"/api/projects/{extra}")
    left = [f for f in os.listdir(STORE) if f.startswith(pid)]
    for f in left:                                # 删项目不清库（已知待办），这里手动收干净
        os.remove(os.path.join(STORE, f))
    left = [f for f in os.listdir(STORE) if f.startswith(pid)]
    import shutil
    ups = [os.path.join(ROOT, "data", "uploads", "projects", x) for x in [pid] + rec_projects]
    for up in ups:
        if os.path.isdir(up):
            shutil.rmtree(up)
    check("临时项目与三维库无残留", not left and not any(os.path.isdir(u) for u in ups),
          f"残留 {left}")

n = sum(RESULTS)
print(f"\n{n}/{len(RESULTS)} 通过")
raise SystemExit(0 if n == len(RESULTS) else 1)
