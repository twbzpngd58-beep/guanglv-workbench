#!/usr/bin/env python3
"""验收：0 图层（无语义图层名）平面 DXF 在工作台里解析出的空间/门窗。

对 8000 端口的工作台走真实导入链路（建临时项目 → 上传图纸并自动识别 → 核对落库的
design 对象 → 删除临时项目），逐条 PASS/FAIL，全过退出码 0。
用法：python3 scripts/accept_layer0.py [图纸路径...]（默认桌面两份 0 图层测试图）
"""
import os
import sys
import json
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
    with urllib.request.urlopen(req, timeout=120) as r:
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
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.loads(r.read().decode())


def near(vals, target, tol):
    return any(abs(v - target) <= tol for v in vals)


files = sys.argv[1:] or DEFAULT_FILES
for f in files:
    name = os.path.basename(f)
    pid = call("POST", "/api/projects", {
        "name": f"验收-0图层解析-临时-{name[:6]}", "type": "平层", "area": 120, "mode": "2D", "smart": "KNX",
    })["id"]
    print("\n==== " + name + f"  (临时项目 {pid})")
    try:
        upload(pid, f, "acceptlayer0")
        proj = call("GET", f"/api/projects/{pid}")
    finally:
        call("DELETE", f"/api/projects/{pid}")
    print(f"  临时项目 {pid} 已删除")
    rec = (proj.get("recognition") or {})
    design = proj.get("design") or {}
    rooms = [r for r in design.get("rooms", []) if str(r.get("floor") or 1) == "1"]
    opens = [o for o in design.get("openings", []) if str(o.get("floor") or 1) == "1"]
    print("  provider:", rec.get("provider"), "|", (rec.get("message") or "")[:90])
    print("  空间:", [(r["name"], round(r.get("widthMm") or 0)) for r in rooms])
    print("  门窗:", [(o["kind"], o.get("widthMm"), o.get("bays")) for o in opens])
    check(f"{name} 走 0 图层几何反推", rec.get("provider") == "ezdxf-layer0-geometry", rec.get("provider"))
    check(f"{name} 空间不止一个外框", len(rooms) >= 4, f"n={len(rooms)}")
    check(f"{name} 空间对象契约（真实轮廓 4-8 点/含 needsReview）",
          all(4 <= len(r.get("points") or []) <= 8 and r.get("needsReview") for r in rooms),
          str([(r["name"], len(r.get("points") or [])) for r in rooms][:6]))
    pts_by_id = {r["id"]: r.get("points") or [] for r in rooms}
    check(f"{name} 洞口挂在所属房间的真实边界上",
          all(o.get("roomId") in pts_by_id and isinstance(o.get("edgeIndex"), int)
              and 0 <= o["edgeIndex"] < len(pts_by_id[o["roomId"]]) for o in opens),
          str([(o.get("edgeIndex"), len(pts_by_id.get(o.get("roomId")) or [])) for o in opens][:6]))
    check(f"{name} 识别到门洞", sum(1 for o in opens if o["kind"] == "门") >= 2,
          str([o.get("widthMm") for o in opens if o["kind"] == "门"]))
    check(f"{name} 识别到窗", any(o["kind"] == "窗" for o in opens))
    labels = {r["name"] for r in rooms}
    if name.startswith("工作台测试文件"):
        check("样本一 厨房/玄关/储藏间命名到位",
              {"厨房", "玄关", "储藏间"} <= labels, str(sorted(labels)))
        check("样本一 餐厅与客厅按开放一体合并命名",
              any("餐厅" in n and "客厅" in n for n in labels), str(sorted(labels)))
        widths = [o.get("widthMm") or 0 for o in opens if o["kind"] == "门"]
        check("样本一 门洞宽≈945/953/3057",
              all(near(widths, t, 90) for t in (945, 3057)), str(sorted(widths)))
        check("样本一 北窗带 5 樘",
              any(o["kind"] == "窗" and o.get("bays") == 5 for o in opens))
        th = {round(w.get("thicknessMm") or 0) for w in design.get("walls", [])}
        check("样本一 墙厚含 100 与 110", 100 in th and 110 in th, str(sorted(th)))
    if name.startswith("无灯测试"):
        check("样本二 淋浴间命名到位", any(n.startswith("淋浴间") for n in labels), str(sorted(labels)))
        check("样本二 马桶间命名到位", any("马桶间" in n for n in labels), str(sorted(labels)))

n = sum(1 for ok in RESULTS if ok)
print(f"\n{n}/{len(RESULTS)} 通过")
sys.exit(0 if n == len(RESULTS) else 1)
