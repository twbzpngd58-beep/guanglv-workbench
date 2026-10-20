"""楼层模型：内部楼层号永远是 1..floors 的正整数。

项目里「楼层数量」(floors) = 总层数（地上 + 地下），``basements`` = 其中地下层数。
地下室不写成负数：floor=1 是最底下的那一层，地下层就是编号最小的那几层。
显示时用 ``floor_label`` 转成「B1 / 1F」，所以数据层、校验、按层分页、按层底图
这些既有逻辑继续用正整数，地下室只是标签和识别规则不同。
"""

from __future__ import annotations

_CN_DIGITS = "零一二三四五六七八九"
# 设计对象里会带楼层的集合；搬层时一起处理。
FLOOR_KEYS = ("rooms", "fixtures", "devices", "walls", "openings", "texts", "furniture")


def cn_number(n: int) -> str:
    """1 → 一、11 → 十一、20 → 二十；层名里用。"""
    if n <= 0:
        return str(n)
    if n < 10:
        return _CN_DIGITS[n]
    if n == 10:
        return "十"
    if n < 20:
        return "十" + _CN_DIGITS[n % 10]
    if n % 10 == 0:
        return _CN_DIGITS[n // 10] + "十"
    return _CN_DIGITS[n // 10] + "十" + _CN_DIGITS[n % 10]


def safe_basements(basements, floors) -> int:
    """地下层数：0..floors-1（至少留一层地上）。"""
    try:
        b = int(basements or 0)
    except (TypeError, ValueError):
        b = 0
    try:
        total = int(floors or 1)
    except (TypeError, ValueError):
        total = 1
    return max(0, min(b, max(0, total - 1)))


def above_floors(floors, basements=0) -> int:
    """地上层数。"""
    return max(0, int(floors or 1) - safe_basements(basements, floors))


def floor_label(floor, basements=0) -> str:
    """短标签：地下层 → B1/B2，地上 → 1F/2F。"""
    try:
        f = int(floor)
    except (TypeError, ValueError):
        f = 1
    b = max(0, int(basements or 0))
    if b and f <= b:
        return "B%d" % (b + 1 - f)
    return "%dF" % (f - b)


def floor_name(floor, basements=0) -> str:
    """中文层名：地下一层 / 一层 / 二层。"""
    try:
        f = int(floor)
    except (TypeError, ValueError):
        f = 1
    b = max(0, int(basements or 0))
    if b and f <= b:
        return "地下%s层" % cn_number(b + 1 - f)
    return "%s层" % cn_number(f - b)


def floor_choice_label(floor, basements=0) -> str:
    """下拉/按钮里用：「B1 · 地下一层」「2F · 二层」。"""
    return "%s · %s" % (floor_label(floor, basements), floor_name(floor, basements))


def levels(floors, basements=0) -> list[dict]:
    """全部楼层（从最底层往上）：value＝内部楼层号，label/name 供界面显示。"""
    total = max(1, int(floors or 1))
    b = safe_basements(basements, total)
    return [
        {
            "value": n,
            "label": floor_label(n, b),
            "name": floor_name(n, b),
            "choice": floor_choice_label(n, b),
            "isBasement": bool(b and n <= b),
        }
        for n in range(1, total + 1)
    ]


def project_levels(project: dict) -> list[dict]:
    return levels(project.get("floors", 1), project.get("basements", 0))


def present_floors(project: dict) -> set[int]:
    """项目里已经用到的楼层号（设计对象、图纸、渲染、识别草稿）。"""
    found: set[int] = set()

    def scan(items):
        for obj in items or []:
            if isinstance(obj, dict):
                try:
                    found.add(int(obj.get("floor") or 1))
                except (TypeError, ValueError):
                    found.add(1)

    design = project.get("design") or {}
    for key in FLOOR_KEYS:
        scan(design.get(key))
    scan(project.get("files"))
    scan(project.get("renders"))
    drafts = [project.get("recognition")]
    drafts += [f.get("recognition") for f in project.get("files") or []]
    seen: set[int] = set()
    for draft in drafts:
        if not isinstance(draft, dict) or id(draft) in seen:
            continue
        seen.add(id(draft))
        try:
            found.add(int(draft.get("floor") or 1))
        except (TypeError, ValueError):
            found.add(1)
        for key in ("rooms", "walls", "openings", "texts"):
            scan(draft.get(key))
    return found


def shift_project_floors(project: dict, delta: int) -> int:
    """整体上移/下移 N 层（加地下层时用），返回移动的对象数。

    标签因此在加地下层前后保持一致：原来的一层还是「1F」。
    """
    if not delta:
        return 0
    moved = 0

    def shift(items):
        nonlocal moved
        for obj in items or []:
            if isinstance(obj, dict):
                try:
                    base = int(obj.get("floor") or 1)
                except (TypeError, ValueError):
                    base = 1
                obj["floor"] = base + delta
                moved += 1

    data = project.get("design") or {}
    for key in FLOOR_KEYS:
        shift(data.get(key))
    shift(project.get("files"))
    shift(project.get("renders"))
    drafts = [project.get("recognition")]
    drafts += [f.get("recognition") for f in project.get("files") or []]
    seen: set[int] = set()
    for draft in drafts:
        if not isinstance(draft, dict) or id(draft) in seen:
            continue
        seen.add(id(draft))
        try:
            draft["floor"] = int(draft.get("floor") or 1) + delta
        except (TypeError, ValueError):
            draft["floor"] = 1 + delta
        for key in ("rooms", "walls", "openings", "texts"):
            shift(draft.get(key))
    return moved
