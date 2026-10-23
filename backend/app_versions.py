"""本机版本历史 / 回退 / 本版更新。

数据来自本机版本库（默认 ../光律版本库，可用 GUANGLV_VERSION_STORE 覆盖）。
回退本身交给版本库的 version_rollback.sh：预存当前版本 → 停服务 → 恢复 → 重启 → 自检。
这里只负责把请求异步交给 helper，先让 HTTP 响应返回，避免服务被自己停掉时请求断在半路。
"""
from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
import threading
from pathlib import Path

from fastapi import APIRouter, Body, HTTPException

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.getenv("DATA_DIR", str(ROOT / "data"))).resolve()
VERSION_STORE = Path(
    os.getenv("GUANGLV_VERSION_STORE") or (ROOT.parent / "光律版本库")
).resolve()
VERSIONS = VERSION_STORE / "versions"
ROLLBACK_SCRIPT = VERSION_STORE / "scripts" / "version_rollback.sh"
BUILD_BASELINE = ROOT / "build-baseline.json"

router = APIRouter(prefix="/api/app", tags=["app-versions"])
_rollback_lock = threading.Lock()
_rollback_started = False

# 当前版本的更新内容（给人看，不参与构建）。以后升版在这里追加一条。
RELEASE_NOTES = {
    "1.3.3": {
        "releasedAt": "2026-10-23",
        "items": [
            {
                "date": "2026-10-23",
                "title": "修设置页被刷回工作台",
                "detail": "1.3.2 的版本面板只要读到「上次更新成功」就会自动刷新，进设置页被刷回工作台；改为只有本次点「立即更新」完成后才刷新一次，并按目标版本记账，进页面只读状态。",
            },
            {
                "date": "2026-10-23",
                "title": "老用户更新脚本更稳",
                "detail": "光律更新脚本优先用 python3 下载更新助手（macOS 自动读系统代理；curl 只认环境变量），变量名后接中文标点改用 ${VAR}，已是最新时按成功处理。",
            },
            {
                "date": "2026-10-23",
                "title": "真机更新数据零变化",
                "detail": "本机实测 1.3.1→1.3.2、1.3.2→1.3.3 各一次：项目、产品、版本、上传文件、SQLite 完整性更新前后逐项一致；data/ 与 .env 不动，更新前自动快照。",
            },
        ],
    },
    "1.3.2": {
        "releasedAt": "2026-10-23",
        "items": [
            {
                "date": "2026-10-23",
                "title": "隐藏与定位修复",
                "detail": "隐藏改为元素内联 display:none !important，能盖过更具体的样式规则、切页/重渲染后仍生效；隐藏或恢复后底部弹出提示（带「恢复」按钮），左下角常驻「已隐藏 N 个功能 / 全部恢复」；定位会关闭清单、滚动并闪烁目标、浮出编号标；功能不在当前页时给出说明，并在清单里用圆点标出「本页/其他页」。",
            },
            {
                "date": "2026-10-23",
                "title": "功能编号与隐藏",
                "detail": "每个功能一个固定编号（模块码 + 序号，如 L-07）：右下角「功能清单」或 Shift+F 可按编号搜索、定位、隐藏/恢复；点任一功能可看它具体做什么、被改过几次、每次改动的快照，并可按次回退；「编号」开关在界面上显示编号徽标；隐藏只影响本机浏览器。",
            },
            {
                "date": "2026-10-23",
                "title": "一键更新",
                "detail": "设置 → 版本与更新：检查到新版可「立即更新」——下载发行包、SHA256 校验、自动备份当前版本、停服务、覆盖程序、重启自检；data/ 与 .env 不动，失败可回退。装机版 1.3.1 用 Release 里的「光律-更新.command」双击升级。",
            },
            {
                "date": "2026-10-23",
                "title": "本机版本回退",
                "detail": "设置 → 版本与更新新增本机版本历史：可选择任意快照回退；回退只恢复程序与前端，不动 data/。",
            },
            {
                "date": "2026-10-23",
                "title": "外壳 v2 成为根入口",
                "detail": "根入口 / 默认终极形态 UI；旧壳用 ?shell=old，显式新版 ?shell=v2；项目壳同步 v2。",
            },
            {
                "date": "2026-10-23",
                "title": "三维空间名与家具",
                "detail": "空间名质心/锚点修正并缩小成小胶囊；CAD 标签恒定约 20px；多边形家具坐标单位修复，沙发等家具默认显示。",
            },
            {
                "date": "2026-10-23",
                "title": "施工令 v1 全量",
                "detail": "D-01~D-15：导出 500、B6 四接口、B1/B2 门禁、3D 三条 P0、B9 交付页、C9/C12/C1/C3、移动端与可读性；后端 verify 55/55。",
            },
            {
                "date": "2026-10-21",
                "title": "1.3.2 基线",
                "detail": "A1 白屏、A2 报价、A3 冻结后新建版本、B3 取消归档；本机单用户免登录部署。",
            },
        ],
    }
}


def _app_version() -> str:
    try:
        return (ROOT / "VERSION").read_text(encoding="utf-8").strip() or "0.0.0"
    except OSError:
        return "0.0.0"


def _baseline() -> dict:
    try:
        data = json.loads(BUILD_BASELINE.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _version_rows() -> list[dict]:
    rows: list[dict] = []
    if not VERSIONS.is_dir():
        return rows
    for p in VERSIONS.iterdir():
        if not p.is_dir():
            continue
        mf = p / "MANIFEST.json"
        tar = p / "code.tar.gz"
        if not mf.is_file() or not tar.is_file():
            continue
        try:
            m = json.loads(mf.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(m, dict):
            continue
        rows.append(
            {
                "id": str(m.get("id") or p.name),
                "createdAt": str(m.get("created_at") or ""),
                "version": str(m.get("version") or ""),
                "buildId": str(m.get("buildId") or ""),
                "asset": str(m.get("asset") or ""),
                "tag": str(m.get("tag") or ""),
                "note": str(m.get("note") or ""),
                "sizeBytes": int(m.get("size_bytes") or 0),
            }
        )
    rows.sort(key=lambda r: (r["createdAt"], r["id"]), reverse=True)
    cur = _baseline()
    for r in rows:
        if cur and r["buildId"] and r["buildId"] == str(cur.get("buildId") or "") and r["asset"] == str(cur.get("asset") or ""):
            r["current"] = True
            break
    return rows


@router.get("/release-notes")
def release_notes():
    version = _app_version()
    info = RELEASE_NOTES.get(version) or {}
    return {
        "version": version,
        "releasedAt": info.get("releasedAt", ""),
        "items": info.get("items", []),
    }


@router.get("/versions")
def app_versions():
    return {
        "current": {**_baseline(), "version": _app_version()},
        "versions": _version_rows(),
    }


@router.post("/versions/{vid}/rollback")
def rollback(vid: str, payload: dict = Body(default={})):
    global _rollback_started
    if not isinstance(payload, dict) or payload.get("confirm") is not True:
        raise HTTPException(400, "回退需要二次确认（confirm=true）")
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,160}", vid or ""):
        raise HTTPException(400, "版本 id 不合法")
    target = VERSIONS / vid
    if not (target / "MANIFEST.json").is_file() or not (target / "code.tar.gz").is_file():
        raise HTTPException(404, "本机没有这个版本快照")
    if not ROLLBACK_SCRIPT.is_file():
        raise HTTPException(500, "找不到版本回退脚本，请检查版本库")

    with _rollback_lock:
        if _rollback_started:
            raise HTTPException(409, "已有一次回退正在进行中")
        _rollback_started = True

    log_path = VERSION_STORE / "ui-rollback.log"
    # helper 独立会话：先留 3 秒把 HTTP 响应发出去，再停服务 / 恢复 / 重启。
    cmd = "sleep 3; exec /bin/bash %s --to %s --yes" % (
        shlex.quote(str(ROLLBACK_SCRIPT)),
        shlex.quote(vid),
    )
    try:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with open(log_path, "ab") as log:
            subprocess.Popen(
                ["/bin/bash", "-c", cmd],
                cwd=str(VERSION_STORE),
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=log,
                start_new_session=True,
                close_fds=True,
            )
    except Exception as exc:  # noqa: BLE001
        with _rollback_lock:
            _rollback_started = False
        raise HTTPException(500, "回退进程启动失败：%s" % exc) from exc

    return {
        "ok": True,
        "target": vid,
        "message": "正在回退；服务会短暂重启，页面会自动重连。",
        "log": str(log_path),
    }


def register(app):
    app.include_router(router)
