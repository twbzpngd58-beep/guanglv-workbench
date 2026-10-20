"""gates — 五道人工复核门禁（出图器版，最小实现）

只保留「出图/复核」需要的部分：复核清单、设计指纹、冻结保护。
不含任何商务与财务逻辑。
"""
from __future__ import annotations
import hashlib, json
from datetime import datetime, timezone
from fastapi import HTTPException

GATES = ["requirements", "layout", "lighting", "pricing", "delivery"]
LABELS = {"requirements": "需求", "layout": "布置", "lighting": "灯光", "pricing": "价格", "delivery": "交付"}


def stamp():
    return datetime.now(timezone.utc).isoformat()


def design_hash(p):
    return hashlib.sha256(json.dumps(p["design"], sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def initial():
    return dict(schemaVersion=1, designFreeze=None, changes=[], packageReviews={}, contacts=[])


def ensure(p):
    c = p.get("cooperation")
    if not isinstance(c, dict):
        c = p["cooperation"] = initial()
    c.setdefault("designFreeze", None)
    c.setdefault("changes", [])
    p["approved"] = (not p.get("isDemo")) and all(k in p.get("reviews", {}) for k in GATES)
    return p


def gate_check(p, key):
    c = ensure(p)["cooperation"]
    if key == "lighting" and (c.get("scope") or {}).get("smart") and not p["design"].get("scenes"):
        raise HTTPException(422, "范围包含智能控制，必须配置场景并复核控制逻辑")


def assert_design_edit(p):
    c = ensure(p)["cooperation"]
    if any(v.get("status") in ("pending", "confirmed") for v in c.get("changes") or []):
        raise HTTPException(409, "变更尚未确认，不能直接修改设计")
    if c.get("designFreeze"):
        raise HTTPException(409, "设计已冻结：先解冻再修改")


def register(api):
    """出图器不带合作/商务接口，保留空实现以兼容旧调用。"""
    return None
