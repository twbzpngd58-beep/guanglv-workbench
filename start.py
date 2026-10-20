#!/usr/bin/env python3
"""Cross-platform, local-first bootstrap. Bundled frontend means Node is optional."""
import argparse, os, shutil, subprocess, sys, venv
from pathlib import Path

ROOT = Path(__file__).resolve().parent
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
if not py.exists():
    print("创建 Python 虚拟环境…", flush=True)
    venv.create(folder, with_pip=True)
check = subprocess.run(
    [
        str(py),
        "-c",
        "import fastapi,uvicorn,multipart,PIL,reportlab,openpyxl,docx,fitz,ezdxf,dotenv,cv2,shapely,edge_tts",
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
        sys.exit("请安装 Node.js 22+ 后重试，或使用包含 frontend/dist 的完整发行包。")
    print("安装并构建 React 前端…", flush=True)
    subprocess.run(
        [npm, "ci"], cwd=ROOT / "frontend", check=True, shell=os.name == "nt"
    )
    subprocess.run(
        [npm, "run", "build"], cwd=ROOT / "frontend", check=True, shell=os.name == "nt"
    )
host = args.host or os.getenv("HOST", "127.0.0.1")
port = args.port or int(os.getenv("PORT", "8000"))
shown = "127.0.0.1" if host in ("0.0.0.0", "::") else host
print(
    f"\n光律 正在启动： http://{shown}:{port}\n"
    "本机单用户，无需登录。示例图纸在 samples/sample-plan.dxf。\n"
    "停止服务：按 Ctrl+C\n",
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
