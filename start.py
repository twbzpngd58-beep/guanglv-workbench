#!/usr/bin/env python3
"""Cross-platform, local-first bootstrap. Bundled frontend means Node is optional."""
import argparse, os, shutil, subprocess, sys, venv
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if sys.version_info < (3, 11):
    sys.exit("需要 Python 3.11 或更高版本（建议 3.12）。当前版本：%s.%s" % sys.version_info[:2])

os.chdir(ROOT)
parser = argparse.ArgumentParser(description="启动光律 灯光设计工作台")
parser.add_argument(
    "--host", default=None, help="默认 127.0.0.1；仅可信 LAN 使用 0.0.0.0"
)
parser.add_argument("--port", type=int, default=None)
parser.add_argument(
    "--rebuild", action="store_true", help="重新构建 React 前端（需要 Node.js 22+）"
)
args = parser.parse_args()
if not (ROOT / ".env").exists():
    shutil.copy(ROOT / ".env.example", ROOT / ".env")
settings = {}
for line in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
    if "=" in line and not line.strip().startswith("#"):
        key, value = line.split("=", 1)
        settings[key.strip()] = value.strip().strip("\"'")
for key, value in settings.items():
    os.environ.setdefault(key, value)
folder = ROOT / ".venv"
py = folder / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
if py.exists():
    check_venv = subprocess.run(
        [str(py), "-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)"],
        capture_output=True,
    )
    if check_venv.returncode:
        stale = folder.with_name(".venv-python-too-old")
        if stale.exists():
            shutil.rmtree(stale, ignore_errors=True)
        shutil.move(str(folder), str(stale))
        print("现有 .venv 的 Python 版本过低，已重命名为 .venv-python-too-old，正在重建…", flush=True)
if not py.exists():
    print("创建 Python 虚拟环境…", flush=True)
    venv.create(folder, with_pip=True)
check = subprocess.run(
    [
        str(py),
        "-c",
        "import fastapi,uvicorn,multipart,PIL,reportlab,openpyxl,docx,fitz,ezdxf,dotenv,cv2,shapely,edge_tts,qrcode",
    ],
    capture_output=True,
)
if check.returncode:
    print("安装本地运行依赖（首次启动需要网络下载）…", flush=True)
    subprocess.run(
        [
            str(py),
            "-m",
            "pip",
            "install",
            "-r",
            (
                "requirements.lock.txt"
                if (ROOT / "requirements.lock.txt").exists()
                else "requirements.txt"
            ),
        ],
        check=True,
    )
if args.rebuild or not (ROOT / "frontend/dist/index.html").exists():
    local_node = ROOT / ".tools/bin"
    if (local_node / "node").exists():
        os.environ["PATH"] = str(local_node) + os.pathsep + os.environ["PATH"]
    npm = shutil.which("npm.cmd" if os.name == "nt" else "npm")
    if not npm:
        sys.exit(
            "需要重新构建前端，但没找到 npm。请安装 Node.js 22+ 后重试；"
            "或者直接用发行包（自带 frontend/dist，不用 Node）。"
        )
    # node_modules 已存在就直接构建，省掉每次几 MB 的重复下载（2026-10-20）
    if not (ROOT / "frontend" / "node_modules").is_dir():
        print("首次构建：安装前端依赖（需要联网，约 1–3 分钟）…", flush=True)
        subprocess.run(
            [npm, "ci"], cwd=ROOT / "frontend", check=True, shell=os.name == "nt"
        )
    print("构建前端…", flush=True)
    subprocess.run(
        [npm, "run", "build"], cwd=ROOT / "frontend", check=True, shell=os.name == "nt"
    )
host = args.host or os.getenv("HOST", "127.0.0.1")
port = args.port or int(os.getenv("PORT", "8000"))

# 首次启动前先把初始密码写进 data/.initial-admin-password（应用启动时会优先读它），
# 这样终端能直接把密码打出来，不至于卡在登录页（2026-10-20）。
import secrets
secret = ROOT / "data/.initial-admin-password"
first_run = not secret.exists()
if first_run:
    secret.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(secret, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, "w") as stream:
        stream.write(secrets.token_urlsafe(24) + "\n")
password = secret.read_text(encoding="utf-8").strip() if secret.exists() else ""
if first_run:
    hint = (
        f"\n首次登录：账号 admin　密码 {password}\n"
        "（登录后会被要求改密；密码同时写在 data/.initial-admin-password）\n"
    )
else:
    hint = "\n账号 admin：用你设定的密码登录（忘了就删掉 data/ 重来）\n"
shown = "127.0.0.1" if host in ("0.0.0.0", "::") else host
print(
    f"\n光律 正在启动： http://{shown}:{port}\n{hint}"
    "示例图纸：samples/sample-plan.dxf —— 新建项目后直接上传，能跑通整条流程\n"
    "停止服务：Ctrl+C\n",
    flush=True,
)
try:
    subprocess.run(
        [
            str(py),
            "-m",
            "uvicorn",
            "backend.app:app",
            "--host",
            host,
            "--port",
            str(port),
        ],
        check=True,
    )
except KeyboardInterrupt:
    pass
except subprocess.CalledProcessError as e:
    sys.exit(e.returncode)
