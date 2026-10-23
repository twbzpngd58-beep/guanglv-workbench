"""功能改动记录（按功能编号）。

- 功能清单里每个编号可以查询：具体作用、被改过几次、每次改动前后落在哪个本机快照；
- 回退由前端调用 /api/app/versions/<id>/rollback（整版快照回退），这里只负责读记录；
- 记录存 data/feature-history.json（不在版本快照范围：回退程序/前端后，改动记录仍在）；
- 首次读取时从仓库 docs/feature-history.json 播种。
"""
from __future__ import annotations

import json
import os
from pathlib import Path

from fastapi import APIRouter

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.getenv("DATA_DIR", str(ROOT / "data"))).resolve()
SEED = ROOT / "docs" / "feature-history.json"
STORE = DATA / "feature-history.json"

router = APIRouter()

MAX_ENTRIES = 2000


def _clean(data: object) -> dict | None:
    if not isinstance(data, dict):
        return None
    entries = data.get("entries")
    if not isinstance(entries, list):
        return None
    rows: list[dict] = []
    for item in entries[:MAX_ENTRIES]:
        if not isinstance(item, dict):
            continue
        ids = item.get("ids")
        if not isinstance(ids, list):
            continue
        ids = [str(x) for x in ids if isinstance(x, str) and 0 < len(x) <= 24]
        title = str(item.get("title") or "").strip()
        at = str(item.get("at") or "").strip()
        if not ids or not title or not at:
            continue
        rows.append(
            {
                "at": at,
                "ids": ids,
                "title": title,
                "detail": str(item.get("detail") or ""),
                "before": str(item.get("before") or ""),
                "after": str(item.get("after") or ""),
            }
        )
    return {"entries": rows}


def _read() -> dict:
    for path in (STORE, SEED):
        try:
            clean = _clean(json.loads(path.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            continue
        if clean is None:
            continue
        if path is SEED:
            try:
                STORE.parent.mkdir(parents=True, exist_ok=True)
                STORE.write_text(json.dumps(clean, ensure_ascii=False, indent=1), encoding="utf-8")
            except OSError:
                pass
        return clean
    return {"entries": []}


@router.get("/api/features/history")
def feature_history():
    """每个功能编号的改动记录（含 before/after 快照 id）。"""
    return _read()


def register(app):
    app.include_router(router)
