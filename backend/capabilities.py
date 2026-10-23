"""能力表（capability API）· 外壳 v2 用。

单用户本机工作台：edition 默认来自 GUANGLV_EDITION，允许 ?edition= 演示覆盖。
真正的许可/签名在 S1.5 接入；这里只返回「哪一版、装了什么、槽位在哪」。
"""
from __future__ import annotations

import hmac
import json
import os
from fastapi import APIRouter, Query, UploadFile, File, HTTPException, Body
from . import license as license_mod

router = APIRouter()
ALLOW_DEMO = os.getenv("GUANGLV_DEMO_EDITIONS", "1") == "1"

KERNEL = [
    {"id": "import.dxf", "slots": []},
    {"id": "plan.core", "slots": ["dock:plan"]},
    {"id": "scene.standard", "slots": ["dock:scenes"]},
    {"id": "view.3d", "slots": ["canvas:3d"]},
    {"id": "view.render", "slots": ["canvas:render"]},
    {"id": "export.basic", "slots": ["export:json", "export:png", "export:dxf", "export:xlsx",
                                     "export:docx", "export:pdf", "export:html", "export:panels", "export:zip"]},
    {"id": "catalog.partners", "slots": ["panel:catalog"]},
    {"id": "catalog.partner-ies", "slots": ["panel:ies"]},
    {"id": "review.core", "slots": ["review:gates"]},
]

KNX = [
    {"id": "knx.catalog", "slots": ["panel:knx-catalog"]},
    {"id": "knx.mapping", "slots": ["dock:knx", "panel:knx-mapping"]},
    {"id": "knx.ga", "slots": ["dock:knx", "export:knx-ga"]},
    {"id": "knx.engrave", "slots": ["dock:knx", "export:knx-engrave"]},
    {"id": "knx.commission", "slots": ["dock:knx", "panel:knx-commission"]},
    {"id": "knx.handover", "slots": ["dock:knx", "export:knx-handover", "deliver:knx-handover"]},
]

ENTERPRISE = [
    {"id": "biz.quote", "slots": ["deliver:quote", "export:quote"]},
    {"id": "biz.customer", "slots": ["nav:customers", "panel:customers"]},
    {"id": "biz.channel", "slots": ["nav:channel"]},
    {"id": "biz.pricing", "slots": ["deliver:enterprise"]},
    {"id": "brand.auth", "slots": ["panel:brand-auth"]},
    {"id": "brand.whitelabel", "slots": ["settings:branding"]},
    {"id": "team.roles", "slots": ["nav:team", "settings:roles"]},
    {"id": "ops.audit", "slots": ["settings:audit"]},
    {"id": "deliver.supplier", "slots": ["deliver:supplier"]},
    {"id": "deliver.template", "slots": ["settings:template", "export:template"]},
    {"id": "ies.studio", "slots": ["nav:ies", "panel:ies"]},
]

PROFILES = {
    "personal": {"label": "个人版", "license": "none", "packs": []},
    "knx": {"label": "KNX 工程师版", "license": "knx-annual", "packs": ["pack.knx"]},
    "enterprise": {"label": "企业定制版", "license": "enterprise-perpetual", "packs": ["pack.knx", "pack.enterprise"]},
}


def _active(edition: str | None) -> str:
    name = (edition or os.getenv("GUANGLV_EDITION") or "personal").strip().lower()
    return name if name in PROFILES else "personal"


def _modules(active: str, granted: set[str] | None = None):
    rows = []
    for m in KERNEL:
        rows.append({**m, "pack": "kernel", "enabled": True})
    for m in KNX:
        rows.append({**m, "pack": "pack.knx",
                     "enabled": active in ("knx", "enterprise") and (not granted or m["id"] in granted)})
    for m in ENTERPRISE:
        rows.append({**m, "pack": "pack.enterprise",
                     "enabled": active == "enterprise" and (not granted or m["id"] in granted)})
    return rows


@router.get("/api/capabilities")
def capabilities(edition: str | None = Query(default=None)):
    lic = license_mod.load()
    # 有合法许可 → 默认按许可版本；?edition= 仅在本机演示开关打开时覆盖。
    demo = bool(edition) and ALLOW_DEMO
    active = _active(edition) if demo else (lic["edition"] if lic.get("valid") else _active(None))
    prof = PROFILES[active]
    granted = set(lic.get("modules") or []) if lic.get("valid") else set()
    return {
        "ok": True,
        "edition": active,
        "label": prof["label"],
        "kernel": {"version": "2.0.0", "apiVersion": "2.0"},
        "packs": prof["packs"],
        "license": {"profile": prof["license"], "valid": bool(lic.get("valid")),
                    "licensee": lic.get("licensee", ""), "expiresAt": lic.get("expiresAt", ""),
                    "reason": lic.get("reason", ""), "modules": sorted(granted)},
        "modules": _modules(active, granted or None),
        "demoEditionsAllowed": ALLOW_DEMO,
        "source": "capability-api/1",
        "note": "单用户本机演示；许可/签名在 S1.5 接入；?edition= 仅本机演示用。",
    }


@router.post("/api/license/sign")
def sign_license(payload: dict = Body(...)):
    """本机签发：发行方输入 secret，签出 license.json 并直接安装。

    仅本机单用户工具；正式发行应在离线签发机执行，不把 secret 配到工作台。
    """
    expected = os.getenv("GUANGLV_LICENSE_SECRET", "")
    if not expected:
        raise HTTPException(422, "服务端未配置 GUANGLV_LICENSE_SECRET，不能在本机签发")
    secret = str(payload.get("secret") or "")
    if not secret or not hmac.compare_digest(secret, expected):
        raise HTTPException(403, "签名密钥不匹配")
    edition = str(payload.get("edition") or "")
    if edition not in PROFILES:
        raise HTTPException(422, "edition 不合法")
    licensee = str(payload.get("licensee") or "").strip()
    if not licensee:
        raise HTTPException(422, "授权方不能为空")
    expires = str(payload.get("expires") or "").strip()
    if expires:
        import re as _re
        if not _re.match(r"^\d{4}-\d{2}-\d{2}$", expires):
            raise HTTPException(422, "到期日格式应为 YYYY-MM-DD")
    modules = payload.get("modules") or []
    if not isinstance(modules, list):
        raise HTTPException(422, "modules 必须是数组")
    all_ids = {m["id"] for m in KERNEL + KNX + ENTERPRISE}
    bad = [m for m in modules if m not in all_ids]
    if bad:
        raise HTTPException(422, "未知模块：" + ", ".join(bad[:5]))
    body = {
        "edition": edition,
        "profile": str(payload.get("profile") or edition),
        "licensee": licensee,
        "expiresAt": expires,
        "modules": modules,
    }
    body["signature"] = license_mod._sign(body, expected)
    path = license_mod.license_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(body, ensure_ascii=False, indent=2), encoding="utf-8")
    return install_status()


@router.post("/api/install/license")
async def install_license_file(file: UploadFile = File(...)):
    """安装方只上传 license.json；验签通过才落盘，密钥不经过工作台。"""
    raw = await file.read(1024 * 1024 + 1)
    if len(raw) > 1024 * 1024:
        raise HTTPException(413, "license.json 过大")
    try:
        doc = json.loads(raw.decode("utf-8"))
    except Exception:
        raise HTTPException(422, "license.json 不是合法 JSON")
    ok, reason = license_mod.verify(doc)
    if not ok:
        raise HTTPException(422, f"许可无效：{reason}")
    path = license_mod.license_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(raw)
    return install_status()


@router.delete("/api/install/license")
def remove_license_file():
    path = license_mod.license_path()
    try:
        path.unlink(missing_ok=True)
    except Exception:
        raise HTTPException(500, "无法删除许可文件")
    return install_status()


@router.get("/api/install/status")
def install_status():
    lic = license_mod.load()
    return {
        "ok": True,
        "license": lic,
        "licenseFile": str(license_mod.license_path()),
        "licenseFileExists": license_mod.license_path().is_file(),
        "secretConfigured": bool(os.getenv("GUANGLV_LICENSE_SECRET", "")),
        "demoEditionsAllowed": ALLOW_DEMO,
    }


def register(app):
    app.include_router(router)
