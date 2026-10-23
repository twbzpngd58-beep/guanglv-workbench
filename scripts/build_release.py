#!/usr/bin/env python3
"""光律 GUANGLV Workbench · 打发行包（维护者用）

产物落在 dist-release/：

  guanglv-workbench-<版本>.tar.gz   程序资产：backend / frontend(src+已构建 dist) / scripts /
                                    start.* / VERSION / requirements / README / docs / samples
                                    —— 不含 data/、.env、.venv/、node_modules/、*.bak-*
  SHA256SUMS.txt                    上面那个包的 sha256，一键更新脚本靠它校验
  apply_update.py                   一键更新 helper（老用户 .command 会下载它）
  光律-更新.command                  给 1.3.1 及更早版本的用户：双击升级

用法：
  python3 scripts/build_release.py            # 打包当前工作区
  python3 scripts/build_release.py --out /tmp/rel
"""
from __future__ import annotations

import argparse
import fnmatch
import hashlib
import os
import shutil
import stat
import tarfile
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NAME = "guanglv-workbench"

# 进发行包的程序资产（白名单：不在列表里的东西永远不会被打进去）
INCLUDE = [
    "backend",
    "frontend/src",
    "frontend/dist",
    "frontend/public",
    "frontend/index.html",
    "frontend/package.json",
    "frontend/package-lock.json",
    "frontend/tsconfig.json",
    "frontend/vite.config.ts",
    "scripts",
    "start.py",
    "start.sh",
    "start.bat",
    "VERSION",
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
    "TEST_REPORT.md",
]

# 永远不进包的东西（运行时数据、密钥、虚拟环境、备份、缓存）
# 注意：只排除「根目录下的 data/」，frontend/src/data、backend/local_data 是随源码分发的资料，不能误伤。
EXCLUDE_DIRS = {".venv", ".git", "node_modules", "__pycache__", ".tools", ".pytest_cache"}
EXCLUDE_GLOBS = [
    "*.pyc",
    "*.bak-*",
    "*.bak",
    ".DS_Store",
    "test-results",
    "playwright-report",
    "tsconfig.tsbuildinfo",
]

UPDATE_COMMAND = r"""#!/bin/bash
# 光律 GUANGLV Workbench · 一键更新（给 1.3.1 及更早版本的用户）
#
# 双击运行：自动找安装目录 → 下载新版 → SHA256 校验 → 备份当前版本
#            → 停服务 → 覆盖程序 → 重启 → 自检。
# data/（项目与附件）和 .env 不会被改动。
#
# 如果被 macOS 拦住（“无法打开，因为无法验证开发者”）：
#   右键点本文件 → 打开；或者在终端里执行：
#   xattr -d com.apple.quarantine "$(dirname "$0")/光律-更新.command"
set -u

REPO="${GUANGLV_REPO:-__REPO__}"
TAG="${GUANGLV_TAG:-__TAG__}"
HERE="$(cd "$(dirname "$0")" && pwd)"

say() { printf '%s\n' "$*"; }
die() { say ""; say "[失败] $*"; say ""; read -r -p "按回车关闭…" _; exit 1; }

say "=============================================="
say " 光律 一键更新  →  $TAG"
say "=============================================="
say ""

command -v curl >/dev/null 2>&1 || die "找不到 curl，无法下载更新包。"
command -v python3 >/dev/null 2>&1 || die "找不到 python3（macOS 装 Command Line Tools 就带）。"

# ---------- 1. 找安装目录 ----------
shopt -s nullglob
CANDIDATES=()
if [ -f "$HERE/VERSION" ] && [ -d "$HERE/backend" ]; then
  CANDIDATES+=("$HERE")                      # 脚本被放进安装目录
fi
for d in "$HOME/Desktop"/*/guanglv-workbench* "$HOME/Desktop"/guanglv-workbench* \
         "$HOME/Downloads"/*/guanglv-workbench* "$HOME/Downloads"/guanglv-workbench*; do
  if [ -d "$d" ] && [ -f "$d/VERSION" ] && [ -d "$d/backend" ]; then
    CANDIDATES+=("$d")
  fi
done

# 去重
UNIQ=()
for c in "${CANDIDATES[@]:-}"; do
  [ -n "$c" ] || continue
  seen=0
  for u in "${UNIQ[@]:-}"; do [ "$u" = "$c" ] && seen=1; done
  [ "$seen" = "1" ] || UNIQ+=("$c")
done

if [ "${#UNIQ[@]}" = "1" ]; then
  DIR="${UNIQ[0]}"
  say "找到安装目录：$DIR"
else
  if [ "${#UNIQ[@]}" -gt 1 ]; then
    say "找到多个光律安装目录："
    i=0
    for u in "${UNIQ[@]}"; do i=$((i+1)); say "  $i) $u"; done
    say ""
  fi
  say "请把光律安装目录（里面有 VERSION、backend、frontend 的那个文件夹）拖进来，然后回车："
  read -r -p "安装目录： " DIR
  DIR="${DIR%\"}"; DIR="${DIR#\"}"
  DIR="${DIR% }"
  DIR="${DIR/#\~/$HOME}"
fi

[ -d "$DIR" ] || die "目录不存在：$DIR"
[ -f "$DIR/VERSION" ] || die "这个目录里没有 VERSION，可能不是光律安装目录：$DIR"
[ -d "$DIR/backend" ] || die "这个目录里没有 backend/，可能不是光律安装目录：$DIR"

CUR="$(tr -d '[:space:]' < "$DIR/VERSION")"
say ""
say "安装目录：$DIR"
say "当前版本：v$CUR  →  目标版本：$TAG"
say ""

read -r -p "开始更新？会重启服务，页面短暂断开。[Y/n] " ANS
case "${ANS:-Y}" in
  [nN]*) say "已取消。"; read -r -p "按回车关闭…" _; exit 0 ;;
esac

# ---------- 2. 下载 helper ----------
TMP="$(mktemp -d 2>/dev/null || mktemp -d -t guanglv)"
trap 'rm -rf "$TMP"' EXIT
HELPER_URL="https://github.com/$REPO/releases/download/$TAG/apply_update.py"
say ""
say "下载更新助手：$HELPER_URL"
say "(网络受限时可先 export GUANGLV_PROXY=http://127.0.0.1:7897 再双击本脚本)"

# 优先用 python3 下载：macOS 上它能自动读系统代理，而 curl 只认环境变量。
# 国内网络下这一步最容易卡住，所以两条路都留。
download_helper() {
  python3 - "$1" "$2" <<'PYEOF'
import sys, urllib.request
url, dest = sys.argv[1], sys.argv[2]
req = urllib.request.Request(url, headers={"User-Agent": "guanglv-update"})
with urllib.request.urlopen(req, timeout=60) as r, open(dest, "wb") as f:
    f.write(r.read())
PYEOF
}
GOT=0
if download_helper "$HELPER_URL" "$TMP/apply_update.py" && [ -s "$TMP/apply_update.py" ]; then
  GOT=1
else
  say "python 下载失败，改用 curl 重试…"
  CURL_PROXY=""
  if [ -n "${GUANGLV_PROXY:-}" ]; then CURL_PROXY="-x $GUANGLV_PROXY"; fi
  if curl -fL --retry 3 --connect-timeout 15 -m 180 $CURL_PROXY "$HELPER_URL" -o "$TMP/apply_update.py" && [ -s "$TMP/apply_update.py" ]; then
    GOT=1
  fi
fi
[ "$GOT" = "1" ] || die "下载更新助手失败。请检查网络，或到 https://github.com/$REPO/releases 手动下载发行包解压覆盖。"

# ---------- 3. 交给 helper：下载/校验/备份/覆盖/重启 ----------
say ""
say "开始更新（会自动备份当前版本，详见终端输出）…"
say ""
python3 "$TMP/apply_update.py" --root "$DIR" --version "${TAG#v}" --repo "$REPO"
CODE=$?

say ""
if [ "$CODE" = "0" ]; then
  say "更新完成。若浏览器页面还是旧的，刷新一次即可。"
elif [ "$CODE" = "2" ]; then
  say "已经是最新版本，不需要更新。"
else
  say "[失败] 退出码 ${CODE}。日志：${DIR}/data/update.log"
  say "安装目录和项目数据都没有被破坏；如需退回旧版，可在安装目录跑："
  say "  python3 scripts/apply_update.py --check     # 看线上版本"
  say "  或者直接用更新前的备份（脚本会在 versions/ 或 data/backups/ 里留下）。"
fi
say ""
read -r -p "按回车关闭…" _
exit "$CODE"
"""


def excluded(rel: Path) -> bool:
    parts = rel.parts
    if parts and parts[0] == "data":  # 运行时数据只在根目录
        return True
    if any(p in EXCLUDE_DIRS for p in parts):
        return True
    name = rel.name
    return any(fnmatch.fnmatch(name, pat) for pat in EXCLUDE_GLOBS)


def collect() -> list[Path]:
    files: list[Path] = []
    for item in INCLUDE:
        path = ROOT / item
        if not path.exists():
            continue
        if path.is_dir():
            for p in sorted(path.rglob("*")):
                if p.is_file():
                    rel = p.relative_to(ROOT)
                    if not excluded(rel):
                        files.append(p)
        elif not excluded(Path(item)):
            files.append(path)
    return files


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser(description="光律发行包打包")
    ap.add_argument("--out", default=str(ROOT / "dist-release"), help="输出目录")
    args = ap.parse_args()

    version = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
    tag = f"v{version}"
    out = Path(args.out).expanduser().resolve()
    out.mkdir(parents=True, exist_ok=True)
    package = out / f"{NAME}-{version}.tar.gz"

    files = collect()
    if not any(p.name == "index.html" and p.parent.name == "dist" for p in files):
        raise SystemExit("frontend/dist 里没有 index.html，先在 frontend/ 里跑 npm run build")

    with tarfile.open(package, "w:gz") as tar:
        for path in files:
            rel = path.relative_to(ROOT)
            info = tar.gettarinfo(str(path), arcname=f"{NAME}/{rel.as_posix()}")
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            info.mode = 0o755 if path.suffix in (".sh", ".command") or path.name == "start.py" else 0o644
            with open(path, "rb") as fh:
                tar.addfile(info, fh)

    missing = [
        rel
        for rel in ("backend/app.py", "frontend/dist/index.html", "VERSION", "scripts/apply_update.py")
        if not any(p.relative_to(ROOT).as_posix() == rel for p in files)
    ]
    if not any("frontend/src/data" in p.relative_to(ROOT).as_posix() for p in files):
        missing.append("frontend/src/data/")
    if missing:
        raise SystemExit(f"发行包缺关键文件：{', '.join(missing)}")

    digest = sha256(package)
    sums = out / "SHA256SUMS.txt"
    sums.write_text(f"{digest}  {package.name}\n", encoding="utf-8")

    helper = out / "apply_update.py"
    shutil.copy2(ROOT / "scripts" / "apply_update.py", helper)

    command = out / "光律-更新.command"
    command.write_text(
        UPDATE_COMMAND.replace(
            "__REPO__", os.getenv("UPDATE_REPO", "twbzpngd58-beep/guanglv-workbench")
        ).replace("__TAG__", tag),
        encoding="utf-8",
    )
    command.chmod(command.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)

    meta = out / "release.json"
    meta.write_text(
        "\n".join(
            [
                "{",
                f'  "version": "{version}",',
                f'  "tag": "{tag}",',
                f'  "package": "{package.name}",',
                f'  "sha256": "{digest}",',
                f'  "size": {package.stat().st_size},',
                f'  "files": {len(files)},',
                f'  "built_at": "{datetime.now().astimezone().isoformat(timespec="seconds")}"',
                "}",
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    print(f"发行包：{package}")
    print(f"  文件数 {len(files)} ｜ 大小 {package.stat().st_size // 1024} KB ｜ sha256 {digest[:16]}…")
    print(f"校验单：{sums}")
    print(f"更新助手：{helper}")
    print(f"老用户脚本：{command}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
