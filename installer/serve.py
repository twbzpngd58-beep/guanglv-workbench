#!/usr/bin/env python3
"""安装包启动器：程序目录只读，数据落在用户目录，重复启动复用已在运行的服务。"""

import argparse
import json
import os
import socket
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[1]
VERSION = (APP_DIR / "VERSION").read_text(encoding="utf-8").strip()
IS_WIN = os.name == "nt"


def data_dir() -> Path:
    given = os.getenv("GUANGLV_DATA_DIR") or os.getenv("DATA_DIR")
    if given:
        return Path(given).expanduser().resolve()
    if IS_WIN:
        base = Path(os.getenv("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local"))
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path.home() / ".local" / "share"
    return base / "guanglv-workbench"


def attach_console_logger(data: Path) -> None:
    """双击启动时没有终端，日志必须落盘，否则用户只会看到「打不开」。"""
    log_dir = data / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / "app.log"
    try:
        if log_path.exists() and log_path.stat().st_size > 2_000_000:
            log_path.replace(log_dir / "app.prev.log")
    except OSError:
        pass
    handle = open(log_path, "a", encoding="utf-8")

    class Mirror:
        def __init__(self, orig):
            self.orig = orig

        def write(self, text):
            try:
                handle.write(text)
                handle.flush()
            except Exception:
                pass
            if self.orig is not None:
                try:
                    self.orig.write(text)
                    self.orig.flush()
                except Exception:
                    pass
            return len(text)

        def flush(self):
            if self.orig is not None:
                try:
                    self.orig.flush()
                except Exception:
                    pass

        def isatty(self):
            return False

    sys.stdout = Mirror(sys.stdout)
    sys.stderr = Mirror(sys.stderr)
    handle.write(f"\n===== v{VERSION} 启动 pid={os.getpid()} =====\n")
    handle.flush()


def http_json(url: str, timeout: float):
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def build_info(url: str):
    try:
        info = http_json(f"{url}/api/build", 0.8)
    except Exception:
        return None
    return info if isinstance(info, dict) else None


def alive_url(data: Path):
    """上一次启动留下的地址如果还在跑同一个版本，就直接复用，不再开第二个服务。"""
    meta = data / "instance.json"
    if not meta.exists():
        return None
    try:
        url = (json.loads(meta.read_text(encoding="utf-8")) or {}).get("url", "")
    except Exception:
        return None
    if not url:
        return None
    info = build_info(url)
    return url if info and info.get("version") == VERSION else None


def free_port(preferred: int) -> int:
    for port in [preferred] + list(range(preferred + 1, preferred + 21)):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            try:
                probe.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise SystemExit(f"{preferred}~{preferred + 20} 端口都被占用，无法启动光律。")


def wait_ready(url: str, timeout: float):
    deadline = time.time() + timeout
    while time.time() < deadline:
        info = build_info(url)
        if info and info.get("version") == VERSION:
            return info
        time.sleep(0.2)
    return None


def start_server(port: int):
    import uvicorn

    config = uvicorn.Config("backend.app:app", host="127.0.0.1", port=port, log_level="info")
    return uvicorn.Server(config)


def main() -> int:
    parser = argparse.ArgumentParser(description="光律制图器（安装包版）")
    parser.add_argument("--port", type=int, default=0, help="默认 8000，被占用时顺延")
    parser.add_argument("--no-browser", action="store_true", help="只起服务，不打开浏览器")
    parser.add_argument("--smoke", action="store_true", help="自检：起服务、验证接口后退出")
    args = parser.parse_args()

    data = data_dir()
    data.mkdir(parents=True, exist_ok=True)
    os.environ["DATA_DIR"] = str(data)
    os.chdir(APP_DIR)
    sys.path.insert(0, str(APP_DIR))
    attach_console_logger(data)

    preferred = args.port or int(os.getenv("GUANGLV_PORT") or os.getenv("PORT") or "8000")
    port = free_port(preferred)
    url = f"http://127.0.0.1:{port}"
    print(f"[光律] 程序目录 {APP_DIR}", flush=True)
    print(f"[光律] 数据目录 {data}", flush=True)

    if args.smoke:
        server = start_server(port)

        def check():
            info = wait_ready(url, 30)
            if not info:
                print("[光律] 自检失败：/api/build 在 30 秒内没有就绪", flush=True)
                os._exit(1)
            html = urllib.request.urlopen(f"{url}/", timeout=5).read().decode("utf-8", "ignore")
            health = http_json(f"{url}/api/health", 5)
            asset = f"/assets/{info.get('asset', '')}"
            ok = asset in html and health.get("ok") is True and health.get("version") == VERSION
            print(
                f"[光律] 自检{'通过' if ok else '失败'} version={info.get('version')} "
                f"buildId={info.get('buildId')} asset={info.get('asset')} 首页引用资源={asset}",
                flush=True,
            )
            os._exit(0 if ok else 1)

        threading.Thread(target=check, daemon=True).start()
        server.run()
        print("[光律] 自检失败：服务提前退出", flush=True)
        return 1

    existing = alive_url(data)
    if existing:
        print(f"[光律] 已有服务在跑，直接打开 {existing}", flush=True)
        if not args.no_browser:
            webbrowser.open(existing)
        return 0

    server = start_server(port)
    meta = data / "instance.json"
    meta.write_text(
        json.dumps({"url": url, "pid": os.getpid(), "version": VERSION, "at": int(time.time())}, ensure_ascii=False),
        encoding="utf-8",
    )

    def open_when_ready():
        info = wait_ready(url, 40)
        if info and not args.no_browser:
            print(f"[光律] 就绪，打开浏览器 {url}", flush=True)
            webbrowser.open(url)
        elif not info:
            print("[光律] 40 秒内服务没有就绪，浏览器没有打开，请看日志", flush=True)

    threading.Thread(target=open_when_ready, daemon=True).start()
    try:
        server.run()
    finally:
        try:
            if meta.exists() and (json.loads(meta.read_text(encoding="utf-8")) or {}).get("pid") == os.getpid():
                meta.unlink()
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
