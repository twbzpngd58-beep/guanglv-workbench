"""许可/签名骨架（S1.5 前置）。

单用户本机：license.json 由发行方用 HMAC 签，工作台只验签、不改许可。
没有 license / 验签失败 / 过期 → 一律回个人版，不阻断打开。
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import time
from pathlib import Path

EDITIONS = ("personal", "knx", "enterprise")
DEFAULT_PATH = Path(os.getenv("DATA_DIR", str(Path(__file__).resolve().parent.parent / "data"))) / "license.json"


def license_path() -> Path:
    return Path(os.getenv("GUANGLV_LICENSE_FILE") or DEFAULT_PATH)


def _secret() -> str:
    return os.getenv("GUANGLV_LICENSE_SECRET", "")


def _canonical(body: dict) -> bytes:
    return json.dumps(body, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()


def _sign(body: dict, secret: str) -> str:
    return hmac.new(secret.encode(), _canonical(body), hashlib.sha256).hexdigest()


def verify(doc: dict) -> tuple[bool, str]:
    if not isinstance(doc, dict):
        return False, "license 不是对象"
    edition = doc.get("edition")
    if edition not in EDITIONS:
        return False, "edition 不合法"
    signature = str(doc.get("signature") or "")
    secret = _secret()
    if not secret:
        return False, "服务端未配置 GUANGLV_LICENSE_SECRET"
    body = {k: v for k, v in doc.items() if k != "signature"}
    if not hmac.compare_digest(signature, _sign(body, secret)):
        return False, "签名不匹配"
    expires = str(doc.get("expiresAt") or "")
    if expires:
        try:
            if time.time() > time.mktime(time.strptime(expires[:10], "%Y-%m-%d")) + 86400:
                return False, "许可已过期"
        except Exception:
            return False, "expiresAt 格式不合法"
    return True, ""


def load() -> dict:
    path = license_path()
    base = {"edition": "personal", "valid": False, "profile": "none",
            "licensee": "", "expiresAt": "", "reason": "未安装许可"}
    if not path.is_file():
        return base
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        return {**base, "reason": f"许可文件读不了：{type(e).__name__}"}
    ok, reason = verify(doc)
    if not ok:
        return {**base, "reason": reason}
    return {"edition": doc["edition"], "valid": True,
            "profile": doc.get("profile") or doc["edition"],
            "licensee": doc.get("licensee") or "",
            "expiresAt": doc.get("expiresAt") or "",
            "modules": list(doc.get("modules") or []),
            "reason": ""}
