"""分项复核失效：只让受本次改动影响的签名失效，并说清楚为什么。

  · 布置复核 layout   ← 房间、墙体、门窗、文字标注、底图/图纸文件、空间定义
  · 灯光复核 lighting ← 灯具、灯带、智能设备、面板、情景（现有五道复核里情景归在这一道）
  · 价格复核 pricing  ← 单价、核价、报价单、产品型号/品牌、数量（增删灯具设备、灯带长度）
  · 交付复核 delivery ← 以上任何一道失效都跟着失效（交付资料由它们汇总而来）
  · 需求复核 requirements 只看协作资料，设计改动不影响它。
色调、相机这类纯展示参数不让任何签名失效。
"""
from __future__ import annotations

LABELS = {
    "requirements": "需求复核",
    "layout": "布置复核",
    "lighting": "灯光复核",
    "pricing": "价格复核",
    "delivery": "交付复核",
}
DESIGN_GATES = ("layout", "lighting", "pricing", "delivery")

LAYOUT_LISTS = {"rooms": "房间", "walls": "墙体", "openings": "门窗", "texts": "文字标注"}
LAYOUT_FIELDS = {"baseFileId": "底图", "spaceDefinition": "空间定义", "planMasked": "底图遮罩", "architecture": "建筑结构"}
PRICE_ONLY = {"price", "priceVerified", "quote"}
PRICE_AND_PRODUCT = {"model", "brand", "length"}  # 型号/品牌换了产品也变；灯带长度＝数量
COSMETIC = {"palette", "camera"}


def _by_id(items):
    out = {}
    for i, x in enumerate(items or []):
        key = x.get("id") if isinstance(x, dict) else None
        out[key if key is not None else f"#{i}"] = x
    return out


def _diff(before, after):
    """Return (added, removed, changed-field-sets) for two lists of dicts keyed by id."""
    b, a = _by_id(before), _by_id(after)
    added = [k for k in a if k not in b]
    removed = [k for k in b if k not in a]
    changed = []
    for k in a.keys() & b.keys():
        x, y = b[k], a[k]
        if x == y:
            continue
        if isinstance(x, dict) and isinstance(y, dict):
            changed.append({f for f in x.keys() | y.keys() if x.get(f) != y.get(f)})
        else:
            changed.append({"*"})
    return added, removed, changed


def _count(label, added, removed, changed):
    parts = [f"新增 {len(added)}" if added else "", f"删除 {len(removed)}" if removed else "", f"修改 {len(changed)}" if changed else ""]
    return f"{label}{'、'.join(p for p in parts if p)}"


def design_impact(before: dict | None, after: dict | None) -> dict[str, list[str]]:
    """Map gate -> human-readable reasons for the change from `before` to `after` design."""
    before, after = before or {}, after or {}
    reasons: dict[str, list[str]] = {}

    def hit(gate, why):
        reasons.setdefault(gate, [])
        if why not in reasons[gate]:
            reasons[gate].append(why)

    for key, label in LAYOUT_LISTS.items():
        added, removed, changed = _diff(before.get(key), after.get(key))
        if added or removed or changed:
            hit("layout", _count(label, added, removed, changed))
    for key, label in LAYOUT_FIELDS.items():
        if before.get(key) != after.get(key):
            hit("layout", f"{label}变更")

    for key, label in (("fixtures", "灯具"), ("devices", "智能设备")):
        added, removed, changed = _diff(before.get(key), after.get(key))
        if added or removed:
            text = _count(label, added, removed, [])
            hit("lighting", text)
            hit("pricing", f"{text}（数量变化）")
        product = [f for f in changed if f & PRICE_AND_PRODUCT or "*" in f]
        price = [f for f in changed if f & PRICE_ONLY]
        other = [f for f in changed if f - PRICE_ONLY]
        if other:
            hit("lighting", _count(label, [], [], other))
        if product:
            hit("pricing", f"{label}型号/数量修改 {len(product)}")
        if price:
            hit("pricing", f"{label}单价/报价修改 {len(price)}")

    added, removed, changed = _diff(before.get("scenes"), after.get("scenes"))
    if added or removed or changed:
        hit("lighting", _count("情景", added, removed, changed))

    known = set(LAYOUT_LISTS) | set(LAYOUT_FIELDS) | {"fixtures", "devices", "scenes"} | COSMETIC
    for key in (before.keys() | after.keys()) - known:
        if before.get(key) != after.get(key):
            # 没归类的新字段宁可多失效，也不能让签名悄悄留着
            hit("layout", f"{key} 变更")
            hit("lighting", f"{key} 变更")
    if reasons:
        hit("delivery", "设计内容变更：" + "、".join(LABELS[g] for g in reasons) + "相关")
    return reasons


def apply(p: dict, reasons: dict[str, list[str]], at: str) -> list[str]:
    """Drop the affected signed reviews; return event lines for those that were actually signed."""
    lines = []
    marks = p.setdefault("invalidatedReviews", {})
    for gate in list(LABELS):
        if gate not in reasons:
            continue
        why = "；".join(reasons[gate])
        if gate in p.get("reviews", {}):
            signed = p["reviews"].pop(gate)
            marks[gate] = {"at": at, "reason": why, "reviewer": signed.get("reviewer", "")}
            lines.append(f"{LABELS[gate]}失效：{why}")
    if not marks:
        p.pop("invalidatedReviews", None)
    return lines
