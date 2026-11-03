#!/usr/bin/env python3
"""验收：三维预览 / 空间预览这一层里的「重新解析」入口（用户在界面上找不到重跑解析的地方）。

背景：解析器升级后老项目不会自己变新（GET /api/lighting3d/{pid} 的 parse_stale）。
带「重新体检」的那块在 Lighting3DView（三维模型工作台），而它的入口只在旧壳页头有，
v2 默认外壳里根本进不去——所以用户在三维预览界面看到的就是一片空白。这里验的是补完入口后：
过期提示出现在三维预览层，点一下真能按当前解析器重跑并刷新设计空间。

对 8000 端口 + 本机 Chrome（CDP 9333）走真实链路，逐条 PASS/FAIL，全过退出码 0。
用法：python3 scripts/accept_reparse_ui.py [图纸路径]（默认桌面 无灯测试0图层.dxf）
"""
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

BASE = os.environ.get("GUANGLV_BASE", "http://127.0.0.1:8000")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STORE = os.path.join(ROOT, "data", "lighting3d")
DEFAULT_FILE = os.path.expanduser("~/Desktop/无灯测试0图层.dxf")
OLD_VERSION = "2026-10-16.1"      # 上一版解析器号：拿它冒充「旧项目从没重跑过」
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
        return {"__err": e.code, "__body": e.read().decode()[:300]}


def check(name, cond, detail=""):
    RESULTS.append(bool(cond))
    print(("PASS " if cond else "FAIL ") + name + (f" → {detail}" if detail else ""))


def upload(pid, path, boundary):
    with open(path, "rb") as fh:
        raw = fh.read()
    head = f'--{boundary}\r\nContent-Disposition: form-data; name="recognize"\r\n\r\ntrue\r\n'
    head += (f'--{boundary}\r\nContent-Disposition: form-data; name="files"; '
             f'filename="{os.path.basename(path)}"\r\nContent-Type: application/octet-stream\r\n\r\n')
    req = urllib.request.Request(f"{BASE}/api/projects/{pid}/files",
                                 data=head.encode() + raw + f'\r\n--{boundary}--\r\n'.encode(),
                                 method="POST",
                                 headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.loads(r.read().decode())


def post_form(pid, field, value):
    body = (f'--arui\r\nContent-Disposition: form-data; name="{field}"\r\n\r\n{value}\r\n--arui--\r\n').encode()
    req = urllib.request.Request(f"{BASE}/api/lighting3d/{pid}/generate", data=body, method="POST",
                                 headers={"Content-Type": "multipart/form-data; boundary=arui"})
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


def node(mode, pid):
    out = subprocess.run(["node", "probe_reparse.mjs", mode, pid],
                         cwd=os.path.join(ROOT, "frontend"), capture_output=True, text=True, timeout=600)
    print(out.stdout.rstrip())
    if out.returncode != 0:
        print("探针退出码非 0：", out.stderr[-400:])
    # 子探针的 pageerror / 超时不能只打印：父验收也要记一条 FAIL，否则退出码照样 0
    check(f"探针 {mode} 退出码为 0", out.returncode == 0,
          f"rc={out.returncode} {(out.stderr or '')[-160:]}")
    return out.stdout


def blocks(text):
    """把探针打印的若干段 `--- 标题 ---` + JSON 解析成 {标题: dict}。"""
    dec = json.JSONDecoder()
    out = {}
    for part in text.split("--- ")[1:]:
        head, _, body = part.partition("\n")
        start = body.find("{")
        if start < 0:
            continue
        try:
            out[head.strip().strip("-").strip()] = dec.raw_decode(body[start:])[0]
        except json.JSONDecodeError:
            pass
    return out


path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_FILE
name = os.path.basename(path)
pid = call("POST", "/api/projects", {"name": f"验收-三维预览重新解析-临时", "type": "平层",
                                     "area": 120, "mode": "2D", "smart": "无"})["id"]
print(f"\n==== {name}  (临时项目 {pid})")
stale_written = False
try:
    upload(pid, path, "arui")
    proj = call("GET", f"/api/projects/{pid}")
    dxf = next((x for x in (proj.get("files") or []) if str(x.get("name", "")).lower().endswith(".dxf")), None)
    check(f"{name} 图纸已入库", bool(dxf), (dxf or {}).get("name", "无"))
    post_form(pid, "file_id", dxf["id"])
    job = wait_job(pid)
    check("三维生成完成", job.get("state") == "done", f"{job.get('state')} {(job.get('error') or '')[:70]}")

    st_path = os.path.join(STORE, f"{pid}.json")
    store = json.load(open(st_path, encoding="utf-8"))
    fresh_rooms = len((store.get("parsed") or {}).get("rooms") or [])
    fresh_version = (store.get("parsed") or {}).get("parser_version")
    # 冒充「这项目是上一版解析器跑的」：只改版本号这一个字段，几何原样留着。
    store["parsed"]["parser_version"] = OLD_VERSION
    json.dump(store, open(st_path, "w", encoding="utf-8"), ensure_ascii=False)
    stale_written = True
    s = call("GET", f"/api/lighting3d/{pid}")
    check("改成过期后接口报 parse_stale", s.get("parse_stale") is True,
          f"库内 {s.get('parsed_version')} / 当前 {s.get('parser_version')}")

    out = node("check", pid)
    check("三维预览层出现过期的横幅", '"barShown": true' in out, "读探针 JSON 第一段")
    check("横幅里点明是旧版解析器跑的", OLD_VERSION in out and "旧版解析器" in out, "")
    check("横幅上就有「重新解析」按钮（不用绕三维工作台）", '"btnLabel": "重新解析"' in out, "")

    print("\n--- 真点一次「重新解析」 ---")
    out2 = node("click", pid)
    check("点完之后横幅消失（parse_stale 已解除）", '"barShown": false' in out2, "读探针 JSON 第二段")

    proj = call("GET", f"/api/projects/{pid}")
    design = proj.get("design") or {}
    rooms = [r for r in design.get("rooms", []) if str(r.get("floor") or 1) == "1"]
    openings = [o for o in design.get("openings", []) if str(o.get("floor") or 1) == "1"]
    st = call("GET", f"/api/lighting3d/{pid}")
    check("重新解析真的按当前解析器跑过", st.get("parsed_version") == fresh_version and st.get("parse_stale") is False,
          f"库内版本回到 {st.get('parsed_version')}")
    check("设计空间按新解析刷新（不是假的一间）", len(rooms) >= 4,
          f"n={len(rooms)} 面积={[round(r.get('area') or 0, 1) for r in rooms][:6]}")
    check("门窗跟着搬到位（没有丢、没报 422）", len(openings) >= 10,
          f"门窗 {len(openings)} 个")
    check("确认空间这一步仍走得通", call("POST", f"/api/lighting3d/{pid}/confirm").get("rooms") is not None, "")

    # ===== 已确认（冻结）的项目：重新解析必须先问一句，点头才替换 =====
    print("\n--- 已确认项目点「重新解析」：先问一句 ---")
    proj = call("GET", f"/api/projects/{pid}")
    design = proj["design"]
    rooms1 = [r for r in design["rooms"] if str(r.get("floor") or 1) == "1"]
    r0, r1 = rooms1[0], rooms1[1]
    # 改个名，再看替换后名字是否回到图纸口径：证明「手工改的会丢」这句话是真的。
    renamed = [{**x, "name": "验收改名-替换后不该还在" if x["id"] == r0["id"] else x.get("name")}
               for x in design["rooms"]]
    fixtures = [
        {"id": "acpf-in", "code": "AC-1", "type": "筒灯", "name": "验收灯·挂得上", "circuit": "C1",
         "roomId": r0["id"], "x": r0["x"] + r0["width"] / 2, "y": r0["y"] + r0["height"] / 2,
         "floor": r0.get("floor", 1), "power": 8, "price": 100, "brightnessMax": 100,
         "cctMin": 2700, "cctMax": 4000, "installHeight": 2.4},
        {"id": "acpf-out", "code": "AC-2", "type": "筒灯", "name": "验收灯·在空间外", "circuit": "C1",
         "roomId": r1["id"], "x": r1["x"] + 6000, "y": r1["y"] + 6000,
         "floor": r1.get("floor", 1), "power": 8, "price": 100, "brightnessMax": 100,
         "cctMin": 2700, "cctMax": 4000, "installHeight": 2.4},
    ]
    furniture = [{"id": "acpf-f", "name": "验收沙发", "kind": "沙发", "roomId": r0["id"],
                  "x": r0["x"] + 2, "y": r0["y"] + 2, "floor": r0.get("floor", 1),
                  "widthM": 1.2, "depthM": 0.8, "heightM": 0.75, "rotation": 0}]
    saved = call("PUT", f"/api/projects/{pid}/design",
                 {"revision": proj["revision"], "design": {**design, "rooms": renamed,
                                                           "fixtures": fixtures, "furniture": furniture}})
    check("验收用的灯具/家具已挂到已确认空间上", saved.get("id") == pid, str(saved.get("__body"))[:160])

    frozen = call("POST", f"/api/lighting3d/{pid}/preview-to-design")
    now = call("GET", f"/api/projects/{pid}")["design"]
    check("不点头时 preview-to-design 不动已确认空间（冻结）",
          frozen.get("confirmed") is True and now["spaceDefinition"]["status"] == "confirmed"
          and any(r.get("name") == "验收改名-替换后不该还在" for r in now["rooms"]),
          f"{frozen.get('confirmed')} / {now['spaceDefinition']['status']}")

    out3 = blocks(node("ask", pid))
    ask = out3.get("弹出确认框") or {}
    check("已确认项目的三维预览层给「重新解析」，且先问一句",
          ask.get("shown") is True and "替换已确认空间" in str(ask.get("title")),
          str(ask.get("title"))[:40])
    check("确认框压在三维预览层之上（点得到，不是藏在后面）",
          ask.get("shown") is True and int(ask.get("zIndex") or 0) > int(ask.get("barZIndex") or 0),
          f"弹窗 {ask.get('zIndex')} / 预览层 {ask.get('barZIndex')}")
    cancel = out3.get("点了取消之后") or {}
    check("点取消＝什么都不改（仍是已确认、改名还在）",
          cancel.get("modalGone") is True and cancel.get("status") == "confirmed"
          and cancel.get("dangling") == 0, f"{cancel.get('status')} 悬空 {cancel.get('dangling')}")
    done = out3.get("点了确认执行之后") or {}
    check("点确认执行＝解除冻结并按图纸重落一套",
          done.get("status") == "previewing" and done.get("rooms") == fresh_rooms,
          f"{done.get('status')} 空间 {done.get('rooms')} 间（图纸 {fresh_rooms} 间）")
    check("替换后手工改的名字没了（「改名会丢」是真话）",
          "验收改名-替换后不该还在" not in str(done.get("names")), str(done.get("names")))
    check("替换后没有对象挂在老空间 id 上（灯具/设备/家具全部重挂）",
          done.get("dangling") == 0, f"悬空 {done.get('dangling')}")
    check("挂不上的灯具置成暂未归属，不是被静默删掉",
          done.get("fixtures") == 2 and done.get("unowned") >= 1,
          f"灯具 {done.get('fixtures')} 件，暂未归属 {done.get('unowned')} 件")
    check("替换后门窗仍在", (done.get("openings") or 0) >= 10, f"门窗 {done.get('openings')} 个")
    check("替换后再走一遍确认走得通", call("POST", f"/api/lighting3d/{pid}/confirm").get("rooms") is not None, "")
finally:
    call("DELETE", f"/api/projects/{pid}")
    for suffix in ("", ".job"):
        leftover = os.path.join(STORE, f"{pid}{suffix}.json")
        if os.path.isfile(leftover):
            os.remove(leftover)
    print(f"  临时项目 {pid} 与它的三维缓存已删除" + ("（含被我改成过期的那份缓存）" if stale_written else ""))

print(f"\n{sum(RESULTS)}/{len(RESULTS)} 通过")
sys.exit(0 if all(RESULTS) else 1)
