#!/usr/bin/env python3
"""验收：0 图层图纸走**用户实际走的那条路**（上传 → 生成三维 → 空间预览 → 确认空间）后落库的结果。

为什么要单独一个脚本：`accept_layer0.py` 只测了上传识别接口（POST /projects/{pid}/files），
那条路一直是好的；用户在界面上看到的是「只有一个框架 + 部分家具」，因为三维预览
（/api/lighting3d/{pid}/preview-to-design）会把 design.rooms 覆盖成三维解析出来的那套空间。
两条路必须一起验，只过一条不算过。

对 8000 端口的工作台走真实链路，逐条 PASS/FAIL，全过退出码 0。
用法：python3 scripts/accept_layer0_ui.py [图纸路径...]（默认桌面两份 0 图层测试图）
"""
import os
import sys
import json
import time
import urllib.error
import urllib.request

BASE = os.environ.get("GUANGLV_BASE", "http://127.0.0.1:8000")
DEFAULT_FILES = [
    os.path.expanduser("~/Desktop/工作台测试文件0图层.dxf"),
    os.path.expanduser("~/Desktop/无灯测试0图层.dxf"),
]
RESULTS = []


def call(method, path, payload=None):
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        # 验收脚本要把失败原因原样说出来（422 的 detail 就是现场看到的那句话），不能堆栈糊一脸
        return {"__err": e.code, "__body": e.read().decode()[:300]}


def post_form(pid, field, value):
    body = (f'--acpl0ui\r\nContent-Disposition: form-data; name="{field}"\r\n\r\n{value}\r\n'
            f'--acpl0ui--\r\n').encode()
    req = urllib.request.Request(f"{BASE}/api/lighting3d/{pid}/generate", data=body, method="POST",
                                 headers={"Content-Type": "multipart/form-data; boundary=acpl0ui"})
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.loads(r.read().decode())


def check(name, cond, detail=""):
    RESULTS.append(bool(cond))
    print(("PASS " if cond else "FAIL ") + name + (f" → {detail}" if detail else ""))


def upload(pid, path, boundary):
    with open(path, "rb") as fh:
        raw = fh.read()
    head = f'--{boundary}\r\nContent-Disposition: form-data; name="recognize"\r\n\r\ntrue\r\n'
    head += (f'--{boundary}\r\nContent-Disposition: form-data; name="files"; '
             f'filename="{os.path.basename(path)}"\r\nContent-Type: application/octet-stream\r\n\r\n')
    data = (head.encode() + raw + f'\r\n--{boundary}--\r\n'.encode())
    req = urllib.request.Request(
        f"{BASE}/api/projects/{pid}/files", data=data, method="POST",
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.loads(r.read().decode())


def wait_job(pid, limit=600):
    deadline = time.time() + limit
    while time.time() < deadline:
        j = call("GET", f"/api/lighting3d/{pid}/job")
        if j.get("state") in ("done", "error"):
            return j
        time.sleep(2)
    return {"state": "timeout"}


files = sys.argv[1:] or DEFAULT_FILES
for f in files:
    name = os.path.basename(f)
    pid = call("POST", "/api/projects", {
        "name": f"验收-0图层三维链路-临时-{name[:6]}", "type": "平层", "area": 120,
        "mode": "2D", "smart": "无",
    })["id"]
    print("\n==== " + name + f"  (临时项目 {pid})")
    try:
        up = upload(pid, f, "acpl0ui")
        proj = call("GET", f"/api/projects/{pid}")
        rec = proj.get("recognition") or {}
        rec_rooms = [r for r in (rec.get("rooms") or []) if str(r.get("floor") or 1) == "1"]
        rec_openings = [o for o in (rec.get("openings") or []) if str(o.get("floor") or 1) == "1"]
        dxf_file = next((x for x in (proj.get("files") or [])
                         if str(x.get("name", "")).lower().endswith(".dxf")), None)
        check(f"{name} 图纸已入库", bool(dxf_file), (dxf_file or {}).get("name", "无"))
        check(f"{name} 识别走 0 图层几何反推", rec.get("provider") == "ezdxf-layer0-geometry",
              str(rec.get("provider")))

        post_form(pid, "file_id", dxf_file["id"])
        job = wait_job(pid)
        check(f"{name} 三维生成完成", job.get("state") == "done", f"{job.get('state')} {job.get('error') or ''}"[:90])

        st = call("GET", f"/api/lighting3d/{pid}")
        parsed_rooms = st.get("rooms") or []
        check(f"{name} 三维解析出的空间不止一个外框", len(parsed_rooms) >= 4,
              f"n={len(parsed_rooms)} " + str([(r.get('name'), round(r.get('area') or 0, 1)) for r in parsed_rooms][:6]))
        check(f"{name} 三维与识别两条路空间口径一致",
              len(parsed_rooms) >= 2 and abs(len(parsed_rooms) - len(rec_rooms)) <= 2,
              f"三维 {len(parsed_rooms)} / 识别 {len(rec_rooms)}")

        p2d = call("POST", f"/api/lighting3d/{pid}/preview-to-design")
        check(f"{name} 空间预览这一步走得通（不报 422）", "__err" not in p2d,
              str(p2d.get("__body") or p2d.get("rooms")))
        proj = call("GET", f"/api/projects/{pid}")
        design = proj.get("design") or {}
        rooms = [r for r in design.get("rooms", []) if str(r.get("floor") or 1) == "1"]
        check(f"{name} 空间预览把每个空间都落进设计", len(rooms) >= 4,
              f"n={len(rooms)} 接口返回 {p2d.get('rooms')}")
        check(f"{name} 门窗挂接跟着搬到新空间（没被静默丢掉）",
              len(design.get("openings") or []) == len(rec_openings) and not p2d.get("lostOpenings"),
              f"设计 {len(design.get('openings') or [])} / 识别 {len(rec_openings)} 丢掉 {p2d.get('lostOpenings')}")
        check(f"{name} 墙线进设计（三维不是只有外框）", len(design.get("walls") or []) >= 8,
              f"n={len(design.get('walls') or [])}")
        areas = sorted((float(r.get("area") or 0) for r in rooms), reverse=True)
        total = sum(areas) or 1
        check(f"{name} 没有「一间吃掉全屋」的假空间",
              len(rooms) >= 4 and areas[0] / total < 0.6,
              f"最大一间占 {round(areas[0] / total * 100)}% " + str([round(a, 1) for a in areas[:5]]))
        check(f"{name} 空间对象契约（真实轮廓 4-8 点 + 名称）",
              all(4 <= len(r.get("points") or []) <= 8 and r.get("name") for r in rooms),
              str([(r["name"], len(r.get("points") or [])) for r in rooms][:6]))

        def _ring(pts):
            n = len(pts)
            return abs(sum(pts[i][0] * pts[(i + 1) % n][1] - pts[(i + 1) % n][0] * pts[i][1]
                           for i in range(n))) / 2.0

        def _m(pts):
            return _ring([(p["x"] / 26.0, p["y"] / 26.0) for p in pts])
        # 轮廓面积 == 报出来的面积：踩过的坑是轮廓取内接矩形、面积取连通格总数，
        # 「餐厅、客厅」报 62.55㎡ 画布上只有 46.52㎡（2026-10-27 0图层2）。
        mismatch = [f'{r.get("name")}:{_m(r["points"]):.2f}/{r.get("area")}'
                    for r in rooms if len(r.get("points") or []) >= 3
                    and abs(_m(r["points"]) - float(r.get("area") or 0))
                    > 0.02 * max(float(r.get("area") or 1), 1e-6)]
        check(f"{name} 每间房的轮廓面积 == 报出来的面积", not mismatch, str(mismatch[:4]))

        by_id = {r["id"]: r for r in rooms}

        def on_edge(o):
            r = by_id.get(o.get("roomId"))
            pts = (r or {}).get("points") or []
            return bool(pts) and isinstance(o.get("edgeIndex"), int) and 0 <= o["edgeIndex"] < len(pts)
        check(f"{name} 洞口挂在所属房间的真实边界上", all(on_edge(o) for o in design.get("openings") or []),
              str([(o.get("edgeIndex"), len((by_id.get(o.get("roomId")) or {}).get("points") or []))
                   for o in design.get("openings") or []][:6]))

        conf = call("POST", f"/api/lighting3d/{pid}/confirm")
        check(f"{name} 确认空间这一步走得通（不报 422）", "__err" not in conf,
              str(conf.get("__body") or conf.get("rooms")))
        proj = call("GET", f"/api/projects/{pid}")
        design = proj.get("design") or {}
        rooms2 = [r for r in design.get("rooms", []) if str(r.get("floor") or 1) == "1"]
        status = (design.get("spaceDefinition") or {}).get("status")
        check(f"{name} 确认空间后仍是多空间（没塌回一个框）", len(rooms2) >= 4,
              f"n={len(rooms2)} 确认接口返回 {conf.get('rooms')}")
        check(f"{name} 确认状态已冻结", status == "confirmed", str(status))
        print("  门窗：", [(o["kind"], o.get("widthMm")) for o in design.get("openings", [])][:8],
              "| 墙：", len(design.get("walls", [])))
    finally:
        call("DELETE", f"/api/projects/{pid}")
    print(f"  临时项目 {pid} 已删除")

    labels = {r["name"] for r in rooms2}
    if name.startswith("工作台测试文件"):
        check("样本一 厨房/玄关/储藏间命名到位",
              {"厨房", "玄关", "储藏间"} <= labels, str(sorted(labels)))
        check("样本一 餐厅与客厅按开放一体合并命名",
              any("餐厅" in n and "客厅" in n for n in labels), str(sorted(labels)))
    if name.startswith("无灯测试"):
        check("样本二 淋浴间命名到位", any(n.startswith("淋浴间") for n in labels), str(sorted(labels)))

n = sum(1 for ok in RESULTS if ok)
print(f"\n{n}/{len(RESULTS)} 通过")
sys.exit(0 if n == len(RESULTS) else 1)
