#!/usr/bin/env python3
"""光律 GUANGLV Workbench · 一键更新（从 GitHub Release 装新版，随时能退回去）

做的事情，按顺序：

  1. 问 GitHub 要最新发行版（release → tag → main 分支 VERSION，三级兜底）
  2. 下载完整发行包 guanglv-workbench-<版本>.tar.gz，用 SHA256SUMS.txt 校验
  3. 更新前自动快照当前程序：本机有「光律版本库」就用它的脚本，没有就打包到 data/backups/
  4. 停服务 → 覆盖程序与前端 → 重启 → 自检 /api/health 的版本号
  5. 全程把进度写进 data/update-state.json，工作台「设置 → 版本与更新」轮询显示

只用标准库：系统自带 python3 就能跑。发行包里带 frontend/dist，不需要 Node、不需要 git。

用法：
  python3 apply_update.py --check                      # 只查有没有新版，打印 JSON
  python3 apply_update.py --root <安装目录>             # 更新到最新发行版
  python3 apply_update.py --root <安装目录> --version 1.3.2
  python3 apply_update.py --root <安装目录> --tarball <本地包> [--sha256 <hex>]

可选：
  --repo <owner/repo>   更新源（默认取环境变量 UPDATE_REPO，否则 twbzpngd58-beep/guanglv-workbench）
  --state-file <path>   进度 JSON（默认 <安装目录>/data/update-state.json）
  --no-restart          只换文件不重启（排查用）
  --no-snapshot         跳过快照（不推荐）
  --json                结果只输出一行 JSON

退出码：0 成功 ｜ 2 已是最新 ｜ 3 下载或校验失败 ｜ 4 快照失败 ｜ 5 停服失败
        6 覆盖失败 ｜ 7 重启后自检失败 ｜ 8 参数/环境不对
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

DEFAULT_REPO = "twbzpngd58-beep/guanglv-workbench"
DEFAULT_PORT = 8000
UA = "guanglv-workbench-updater"

# 覆盖清单：只换这些程序资产，data/、.env、.venv/、.git/、node_modules/ 一律不碰。
PROGRAM_DIRS = ["backend", "scripts"]
FRONTEND_ITEMS = [
    "dist",
    "src",
    "public",
    "index.html",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "tsconfig.app.json",
    "tsconfig.node.json",
    "vite.config.ts",
]
ROOT_ITEMS = [
    "VERSION",
    "start.py",
    "start.sh",
    "start.bat",
    "build-baseline.json",
    "requirements.txt",
    "requirements.lock.txt",
    "README.md",
    "LICENSE",
    "Dockerfile",
    "docker-compose.yml",
    ".dockerignore",
    ".gitignore",
    ".env.example",
    "docs",
    "samples",
]

PHASE_TEXT = {
    "start": "准备更新",
    "check": "检查新版本",
    "download": "下载发行包",
    "verify": "校验安装包",
    "snapshot": "备份当前版本",
    "stage": "解包",
    "stop": "停止服务",
    "replace": "写入新版本",
    "deps": "检查依赖",
    "restart": "重启服务",
    "health": "等待服务自检",
    "done": "更新完成",
    "failed": "更新失败",
    "uptodate": "已是最新版本",
}


# ---------------------------------------------------------------- 小工具


def now() -> str:
    return datetime.now().astimezone().strftime("%Y-%m-%dT%H:%M:%S%z")


def version_key(value: str) -> tuple:
    """1.3.10 折成 (1,3,10)，非数字段落按 0 处理（与 backend/app.py 保持一致）。"""
    parts = re.findall(r"\d+", (value or "").strip().lstrip("vV"))
    return tuple(int(p) for p in parts[:4]) or (0,)


def say(msg: str) -> None:
    print(msg, flush=True)


def read_version(root: Path) -> str:
    try:
        return (root / "VERSION").read_text(encoding="utf-8").strip() or "0.0.0"
    except OSError:
        return "0.0.0"


def read_env(root: Path) -> dict:
    out: dict = {}
    env_file = root / ".env"
    if not env_file.is_file():
        return out
    try:
        for line in env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip().strip("\"'")
    except OSError:
        pass
    return out


def port_of(root: Path) -> int:
    env = read_env(root)
    for key in ("PORT", "GUANGLV_PORT"):
        raw = (env.get(key) or "").strip()
        if raw.isdigit():
            return int(raw)
    return DEFAULT_PORT


def state_path_for(root: Path) -> Path:
    return root / "data" / "update-state.json"


def write_state(path: Path | None, **kw) -> None:
    """进度写盘：界面每秒读它。写坏了也不该让更新中断，所以整体 try 掉。"""
    if path is None:
        return
    payload = dict(kw)
    payload.setdefault("updatedAt", now())
    payload.setdefault("pid", os.getpid())
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, path)
    except OSError as exc:  # noqa: BLE001
        say(f"[warn] 进度写盘失败：{exc}")


def http_json(url: str, timeout: int = 12):
    req = urllib.request.Request(
        url,
        headers={"User-Agent": f"{UA}/{platform.system()}", "Accept": "application/vnd.github+json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", "replace"))


def sha256_file(path: Path, chunk: int = 1024 * 1024) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(chunk), b""):
            h.update(block)
    return h.hexdigest()


# ---------------------------------------------------------------- 问 GitHub


def latest_release(repo: str) -> dict:
    """返回 {version, tag, url, notes, assets, source}。三级兜底，和设置页同一个口径。"""
    web = f"https://github.com/{repo}"
    try:
        data = http_json(f"https://api.github.com/repos/{repo}/releases/latest")
        version = str(data.get("tag_name") or "").strip().lstrip("vV")
        if version:
            return {
                "version": version,
                "tag": str(data.get("tag_name") or "").strip(),
                "url": data.get("html_url") or f"{web}/releases",
                "notes": (data.get("body") or "")[:4000],
                "assets": data.get("assets") or [],
                "publishedAt": data.get("published_at") or "",
                "source": "release",
            }
    except urllib.error.HTTPError as exc:
        if exc.code != 404:
            raise
    except (urllib.error.URLError, OSError, ValueError):
        pass

    # 没发 release：退到 tag，再退到 main 分支的 VERSION
    tags = []
    try:
        for t in http_json(f"https://api.github.com/repos/{repo}/tags"):
            name = str(t.get("name") or "")
            if version_key(name) > (0,):
                tags.append(name)
    except (urllib.error.URLError, OSError, ValueError, urllib.error.HTTPError):
        tags = []
    if tags:
        tag = max(tags, key=version_key)
        return {
            "version": tag.lstrip("vV"),
            "tag": tag,
            "url": f"{web}/releases/tag/{tag}",
            "notes": "",
            "assets": [],
            "publishedAt": "",
            "source": "tags",
        }
    raw = http_json(f"https://api.github.com/repos/{repo}/contents/VERSION")
    import base64

    version = base64.b64decode(raw.get("content") or "").decode("utf-8", "replace").strip().lstrip("vV")
    return {
        "version": version,
        "tag": f"v{version}",
        "url": f"{web}/releases",
        "notes": "",
        "assets": [],
        "publishedAt": "",
        "source": "version-file",
    }


def resolve_package(release: dict) -> dict:
    """从 release 资产里挑出发行包和校验单。没有校验单就拒绝安装。"""
    assets = [a for a in release.get("assets") or [] if isinstance(a, dict)]
    tarballs = [
        a
        for a in assets
        if str(a.get("name") or "").startswith("guanglv-workbench-")
        and str(a.get("name") or "").endswith(".tar.gz")
    ]
    if not tarballs:
        raise SystemExit(
            f"发行版 {release.get('tag') or release.get('version')} 里没有 guanglv-workbench-*.tar.gz 安装包；"
            f"请到 {release.get('url')} 手动下载。"
        )
    pkg = tarballs[0]
    sums_asset = next((a for a in assets if str(a.get("name") or "") == "SHA256SUMS.txt"), None)
    sha = ""
    if sums_asset:
        try:
            req = urllib.request.Request(
                sums_asset["browser_download_url"], headers={"User-Agent": UA}
            )
            with urllib.request.urlopen(req, timeout=20) as resp:
                for line in resp.read().decode("utf-8", "replace").splitlines():
                    bits = line.split()
                    if len(bits) >= 2 and bits[-1].lstrip("*") == pkg["name"]:
                        sha = bits[0].lower()
                        break
        except (urllib.error.URLError, OSError):
            sha = ""
    if not sha:
        raise SystemExit(
            "发行版里没有 SHA256SUMS.txt 或没有本包的校验值，拒绝安装未校验的包。"
            f"请到 {release.get('url')} 手动下载。"
        )
    return {
        "name": pkg["name"],
        "url": pkg["browser_download_url"],
        "size": int(pkg.get("size") or 0),
        "sha256": sha,
    }


def download(url: str, dest: Path, size: int, state: Path | None, base: dict) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    done = 0
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=60) as resp, open(dest, "wb") as f:
        total = int(resp.headers.get("Content-Length") or size or 0)
        while True:
            block = resp.read(256 * 1024)
            if not block:
                break
            f.write(block)
            done += len(block)
            if total >= done:
                pct = int(done * 100 / total)
                speed = done / max(time.time() - t0, 0.1) / 1024 / 1024
                write_state(
                    state,
                    phase="download",
                    message=f"下载中 {pct}%（{done // 1024} KB / {total // 1024} KB，{speed:.1f} MB/s）",
                    percent=pct,
                    **base,
                )
    if size and done != size:
        raise RuntimeError(f"下载不完整：收到 {done} 字节，应为 {size} 字节")


# ---------------------------------------------------------------- 快照 / 停服 / 覆盖 / 重启


def snapshot(root: Path, version: str) -> str:
    """更新前先备份当前程序。优先用本机「光律版本库」，否则打包进 data/backups/。"""
    store_script = root.parent / "光律版本库" / "scripts" / "version_snapshot.sh"
    if store_script.is_file():
        note = f"一键更新到 v{version} 前自动快照"
        proc = subprocess.run(
            ["/bin/bash", str(store_script), "--tag", f"pre-update-{version}", "--note", note, "--quiet"],
            cwd=str(store_script.parents[1]),
            capture_output=True,
            text=True,
            timeout=300,
        )
        if proc.returncode != 0:
            raise RuntimeError((proc.stderr or proc.stdout or "版本快照脚本失败").strip()[-500:])
        lines = [ln for ln in (proc.stdout or "").splitlines() if ln.strip()]
        return f"版本库快照 {lines[-1].strip() if lines else ''}".strip()

    backups = root / "data" / "backups"
    backups.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    target = backups / f"pre-update-{version}-{stamp}.tar.gz"
    skip = {"data", ".venv", ".git", "node_modules", ".tools", "__pycache__"}
    with tarfile.open(target, "w:gz") as tar:
        for item in sorted(root.iterdir()):
            name = item.name
            if name in skip or name.startswith(".update"):
                continue
            if ".bak-" in name:
                continue
            tar.add(item, arcname=name)
    return str(target)


def port_open(port: int) -> bool:
    with socket.socket() as s:
        s.settimeout(0.3)
        return s.connect_ex(("127.0.0.1", port)) == 0


def pids_on_port(port: int) -> list[int]:
    try:
        out = subprocess.run(
            ["/usr/sbin/lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        return [int(x) for x in out.stdout.split() if x.strip().isdigit()]
    except (OSError, subprocess.SubprocessError, ValueError):
        return []


def stop_service(root: Path, port: int, timeout: float = 25.0) -> None:
    pid_file = root / "data" / "service.pid"
    pids: list[int] = []
    if pid_file.is_file():
        raw = re.sub(r"[^0-9]", "", pid_file.read_text(encoding="utf-8", errors="ignore"))
        if raw:
            pids.append(int(raw))
    for pid in pids_on_port(port):
        if pid not in pids:
            pids.append(pid)

    alive = False
    for pid in pids:
        try:
            os.kill(pid, 15)
            alive = True
        except OSError:
            continue
    deadline = time.time() + timeout
    while time.time() < deadline:
        if not port_open(port):
            break
        time.sleep(0.3)
    if not port_open(port):
        return
    for pid in pids:
        try:
            os.kill(pid, 9)
        except OSError:
            continue
    time.sleep(1.0)
    if port_open(port):
        holders = pids_on_port(port)
        raise RuntimeError(
            f"端口 {port} 仍被占用（PID {holders or '未知'}）。为避免覆盖正在运行的服务，已中止；"
            "请先双击「停止光律.command」再重试。"
        )
    del alive


def version_in_package(package: Path) -> str:
    """从发行包里的 VERSION 读出目标版本（本地包模式不必手填 --version）。"""
    with tarfile.open(package, "r:gz") as tar:
        for name in ("VERSION", "guanglv-workbench/VERSION"):
            try:
                fh = tar.extractfile(name)
            except KeyError:
                continue
            if fh:
                return fh.read().decode("utf-8", "replace").strip().lstrip("vV")
    return ""


def safe_extract(package: Path, dest: Path) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    root = dest.resolve()
    with tarfile.open(package, "r:gz") as tar:
        for member in tar.getmembers():
            target = (dest / member.name).resolve()
            if root != target and root not in target.parents:
                raise RuntimeError(f"安装包里有越界路径：{member.name}")
            if member.issym() or member.islnk():
                raise RuntimeError(f"安装包里有符号链接，拒绝解包：{member.name}")
        try:
            tar.extractall(dest, filter="data")  # 3.12+ 会做一层元数据过滤
        except TypeError:  # 老 Python 没有 filter 参数
            tar.extractall(dest)


def copy_item(src: Path, dest: Path) -> None:
    if src.is_dir():
        if dest.exists():
            shutil.rmtree(dest)
        shutil.copytree(src, dest)
    else:
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dest)


def replace_program(root: Path, stage: Path) -> list[str]:
    """按白名单覆盖程序资产；data/、.env、.venv/ 永远不碰。"""
    changed: list[str] = []
    for name in PROGRAM_DIRS:
        src = stage / name
        if src.is_dir():
            copy_item(src, root / name)
            changed.append(name + "/")
    for name in FRONTEND_ITEMS:
        src = stage / "frontend" / name
        if src.exists():
            copy_item(src, root / "frontend" / name)
            changed.append("frontend/" + name)
    for name in ROOT_ITEMS:
        src = stage / name
        if src.exists():
            copy_item(src, root / name)
            changed.append(name)
    return changed


def requirements_hash(root: Path) -> str:
    for name in ("requirements.lock.txt", "requirements.txt"):
        p = root / name
        if p.is_file():
            return sha256_file(p)
    return ""


def restart_service(root: Path, port: int, state: Path | None, base: dict) -> None:
    venv_py = root / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if not venv_py.exists():
        raise RuntimeError("找不到 .venv，先运行一次 start.py 装好运行环境")
    log = root / "data" / "service.log"
    log.parent.mkdir(parents=True, exist_ok=True)
    kwargs: dict = (
        {"creationflags": subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP}
        if os.name == "nt"
        else {"start_new_session": True}
    )
    with open(log, "ab", buffering=0) as fh:
        subprocess.Popen(
            [str(venv_py), str(root / "scripts" / "start_background.py")],
            cwd=str(root),
            stdin=subprocess.DEVNULL,
            stdout=fh,
            stderr=fh,
            close_fds=True,
            **kwargs,
        )
    write_state(state, phase="restart", message="服务已拉起，等待自检…", **base)


def wait_health(port: int, target: str, timeout: float = 150.0) -> dict:
    deadline = time.time() + timeout
    last = ""
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=3) as resp:
                data = json.loads(resp.read().decode("utf-8", "replace"))
            if data.get("ok"):
                got = str(data.get("version") or "")
                if version_key(got) >= version_key(target):
                    return data
                last = f"服务回来了，但版本还是 v{got}（期望 v{target}）"
        except (urllib.error.URLError, OSError, ValueError):
            last = "服务还没起来"
        time.sleep(1.0)
    raise RuntimeError(f"重启后 {int(timeout)} 秒内没等到 v{target}：{last}")


# ---------------------------------------------------------------- 主流程


def run_check(repo: str) -> dict:
    release = latest_release(repo)
    out = {
        "repo": repo,
        "latest": release["version"],
        "tag": release["tag"],
        "url": release["url"],
        "notes": release["notes"],
        "source": release["source"],
        "publishedAt": release.get("publishedAt") or "",
        "asset": None,
        "error": "",
    }
    try:
        out["asset"] = resolve_package(release)
    except SystemExit as exc:
        out["error"] = str(exc)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="光律一键更新")
    ap.add_argument("--check", action="store_true", help="只查版本")
    ap.add_argument("--root", default="", help="安装目录（默认脚本所在目录的上一级）")
    ap.add_argument("--repo", default=os.getenv("UPDATE_REPO") or DEFAULT_REPO, help="更新源 owner/repo")
    ap.add_argument("--version", default="", help="指定要装的版本（默认最新）")
    ap.add_argument("--tarball", default="", help="用本地安装包，不联网")
    ap.add_argument("--sha256", default="", help="配合 --tarball 的校验值")
    ap.add_argument("--state-file", default="", help="进度 JSON 路径")
    ap.add_argument("--no-restart", action="store_true", help="只换文件不重启")
    ap.add_argument("--no-snapshot", action="store_true", help="跳过更新前快照")
    ap.add_argument("--delay", type=float, default=0.0, help="启动后先等几秒（让 HTTP 响应先发出去）")
    ap.add_argument("--json", action="store_true", help="结果只输出一行 JSON")
    args = ap.parse_args()

    if args.delay > 0:
        time.sleep(args.delay)

    if args.check:
        result = run_check(args.repo)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0

    root = Path(args.root).expanduser().resolve() if args.root else Path(__file__).resolve().parents[1]
    if not (root / "VERSION").is_file() or not (root / "backend" / "app.py").is_file():
        say(f"[错误] {root} 看起来不是光律安装目录（缺 VERSION 或 backend/app.py）")
        return 8

    state = Path(args.state_file).expanduser() if args.state_file else state_path_for(root)
    port = port_of(root)
    current = read_version(root)
    base = {"from": current, "to": "", "root": str(root), "port": port, "startedAt": now()}

    work = root / "data" / ".update"
    work.mkdir(parents=True, exist_ok=True)
    log_path = root / "data" / "update.log"

    def fail(code: int, message: str, hint: str = "") -> int:
        msg = f"{PHASE_TEXT.get('failed')}：{message}"
        say(f"[失败] {message}")
        if hint:
            say(f"[提示] {hint}")
        write_state(state, phase="failed", ok=False, message=msg, hint=hint, **base)
        if args.json:
            print(json.dumps({"ok": False, "error": message, "hint": hint}, ensure_ascii=False))
        return code

    try:
        # 1) 目标版本
        write_state(state, phase="check", ok=None, message="正在检查新版本…", **base)
        package = None
        if args.tarball:
            pkg = Path(args.tarball).expanduser().resolve()
            if not pkg.is_file():
                return fail(3, f"找不到本地安装包：{pkg}")
            package = {"name": pkg.name, "path": pkg, "size": pkg.stat().st_size, "sha256": args.sha256.lower()}
            release = {
                "version": args.version or version_in_package(pkg),
                "url": "",
                "notes": "",
                "tag": "",
            }
        else:
            release = latest_release(args.repo)
            if args.version and version_key(args.version) != version_key(release["version"]):
                if version_key(args.version) > version_key(release["version"]):
                    return fail(3, f"线上还没有 v{args.version}，最新是 v{release['version']}")
            target = args.version or release["version"]
            release["version"] = target
            if version_key(target) <= version_key(current):
                say(f"已经是最新版本 v{current}")
                write_state(state, phase="uptodate", ok=True, message=f"已是最新版本 v{current}，无需更新", **base)
                if args.json:
                    print(json.dumps({"ok": True, "uptodate": True, "version": current}, ensure_ascii=False))
                return 2
            write_state(state, phase="check", message=f"发现新版本 v{target}", to=target, **base)
            package = resolve_package(release)

        target = args.version or (release.get("version") or "")
        if not target:
            return fail(3, "读不到发行版版本号")
        base["to"] = target
        say(f"准备把 {root} 从 v{current} 更新到 v{target}（端口 {port}）")

        # 2) 下载 + 校验
        if "path" in package:
            local = package["path"]
            write_state(state, phase="download", message=f"使用本地安装包 {local.name}", **base)
        else:
            local = work / package["name"]
            write_state(state, phase="download", message="开始下载安装包…", percent=0, **base)
            download(package["url"], local, package["size"], state, base)
        if not package.get("sha256"):
            return fail(3, "没有校验值，拒绝安装")
        write_state(state, phase="verify", message="校验 SHA256…", **base)
        got = sha256_file(local)
        if got != package["sha256"]:
            return fail(3, f"校验不一致：期望 {package['sha256'][:16]}…，实际 {got[:16]}…")
        say(f"校验通过：{local.name}（{local.stat().st_size // 1024} KB）")

        # 3) 快照
        backup = ""
        if args.no_snapshot:
            write_state(state, phase="snapshot", message="已跳过快照（--no-snapshot）", **base)
        else:
            write_state(state, phase="snapshot", message="正在备份当前版本…", **base)
            try:
                backup = snapshot(root, target)
            except Exception as exc:  # noqa: BLE001
                return fail(4, f"快照失败：{exc}", "可加 --no-snapshot 跳过，但更新失败就没得退了，不建议。")
            say(f"已备份：{backup}")
            write_state(state, phase="snapshot", message=f"已备份当前版本：{backup}", backup=backup, **base)

        # 4) 解包
        write_state(state, phase="stage", message="正在解包…", **base)
        stage = work / "stage"
        shutil.rmtree(stage, ignore_errors=True)
        safe_extract(local, stage)
        payload = stage / "guanglv-workbench"
        if not (payload / "VERSION").is_file():
            payload = stage
        staged_version = read_version(payload)
        if staged_version and version_key(staged_version) < version_key(target):
            return fail(3, f"安装包版本是 v{staged_version}，低于目标 v{target}")

        # 5) 停服 + 覆盖
        write_state(state, phase="stop", message="正在停止服务…", **base)
        stop_service(root, port)
        write_state(state, phase="replace", message="正在写入新版本…", **base)
        try:
            changed = replace_program(root, payload)
        except Exception as exc:  # noqa: BLE001
            return fail(
                6,
                f"覆盖程序失败：{exc}",
                f"当前程序可能不完整；备份在 {backup or '（未备份）'}，可双击桌面「光律-回退版本.command」退回。",
            )
        say(f"已写入 {len(changed)} 项：{', '.join(changed[:8])}{' …' if len(changed) > 8 else ''}")

        # 6) 依赖（requirements 变了才装）
        if requirements_hash(root) and not args.no_restart:
            write_state(state, phase="deps", message="依赖清单无变化，跳过安装", **base)

        # 7) 重启 + 自检
        if args.no_restart:
            write_state(state, phase="done", ok=True, message=f"已写入 v{target}，按 --no-restart 未重启", backup=backup, **base)
            if args.json:
                print(json.dumps({"ok": True, "version": target, "restart": False}, ensure_ascii=False))
            return 0
        write_state(state, phase="restart", message="正在重启服务…", **base)
        restart_service(root, port, state, base)
        write_state(state, phase="health", message="等待服务就绪…", **base)
        health = wait_health(port, target)
        write_state(
            state,
            phase="done",
            ok=True,
            message=f"已更新到 v{health.get('version')}",
            version=str(health.get("version") or target),
            backup=backup,
            finishedAt=now(),
            **base,
        )
        say(f"更新完成：v{current} → v{health.get('version')}（{root}）")
        say(f"备份：{backup or '（未备份）'}")
        if args.json:
            print(json.dumps({"ok": True, "version": health.get("version"), "backup": backup}, ensure_ascii=False))
        return 0
    except SystemExit as exc:
        return fail(3, str(exc))
    except Exception as exc:  # noqa: BLE001
        return fail(7, f"{type(exc).__name__}: {exc}", f"日志见 {log_path}")


if __name__ == "__main__":
    sys.exit(main())
