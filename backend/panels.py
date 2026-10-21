"""面板键位规范化与刻字预填 —— 世聪「4键8功能」＋ 知识库刻字口径。

「4 键」＝世聪面板标注的「4键8功能」：4 个物理键 ×（短按 / 长按）= 8 个功能。
**一个物理键只刻一次**：刻字 / 图标对应短按；长按只做功能绑定，不刻字。
字段约定（`design.devices[]` 里 `type == "面板"` 的条目）：

    keys            按键数档位（1 / 2 / 4 / 12），默认 4；4 即「4键8功能」，12 ＝ 1.9 寸屏 APP 自定义
    engraveMode     刻字形式：icon（全图标）/ text（全文字，2 字）/ screen（屏显免雕刻）——一块板只用一种
    keyLabels       每键刻字（icon 模式为图标词，如「会客」→ Guests）
    keyScenes       每键「短按」绑定情景 id
    keyLongLabels   每键「长按」功能说明（不刻字）
    keyLongScenes   每键「长按」绑定情景 id

型号目录与刻字口径在 `frontend/src/data/citron-panels.json`（出处：世聪官网
+ 02-智能家居/场景联动/刻字与面板触发源.md）。前端 `frontend/src/Workspace.tsx` 的
`normalizePanel` / `fillPanelKeys` / `panelIssues` 是同一套规则的另一份实现；两侧必须同步。
"""

from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path

PANEL_KEY_COUNTS = (1, 2, 4, 12)
PANEL_DEFAULT_KEYS = 4
PANEL_FIELDS = ("keyLabels", "keyScenes", "keyLongLabels", "keyLongScenes")
ENGRAVE_MODES = ("icon", "text", "screen")
CATALOG_FILE = Path(__file__).resolve().parents[1] / "frontend" / "src" / "data" / "citron-panels.json"
_CODE_PREFIX = re.compile(r"^\s*\d+(?:\.\d+)*\s*")


@lru_cache(maxsize=1)
def catalog():
    return json.loads(CATALOG_FILE.read_text(encoding="utf-8"))


def rules():
    return catalog()["rules"]


def catalog_models():
    out = []
    for s in catalog()["series"]:
        for m in s["models"]:
            out.append({**m, "series": s["series"], "protocol": s["protocol"], "material": s.get("material", "")})
    return out


def catalog_model(product_id):
    return next((m for m in catalog_models() if m["id"] == product_id), None) if product_id else None


def panel_text_max(model):
    """单条刻字字数上限：型号 textMax 或全局默认（2 字）。"""
    return model.get("textMax", rules()["textMax"]) if model else rules()["textMax"]


def _fit(dev, field, n):
    v = dev.get(field)
    out = [("" if x is None else str(x)) for x in v[:n]] if isinstance(v, list) else []
    while len(out) < n:
        out.append("")
    dev[field] = out


def normalize_panel(dev):
    """对齐一个面板的键数与刻字 / 绑定长度；选了世聪目录型号的，键数与刻字形式跟型号走。"""
    if not isinstance(dev, dict) or dev.get("type") != "面板":
        return dev
    model = catalog_model(dev.get("productId"))
    try:
        n = int(model["keys"] if model else dev.get("keys"))
    except (TypeError, ValueError):
        n = 0
    if n not in PANEL_KEY_COUNTS:
        n = PANEL_DEFAULT_KEYS
    dev["keys"] = n
    for field in PANEL_FIELDS:
        _fit(dev, field, n)
    if model and model.get("engrave") == "screen":
        dev["engraveMode"] = "screen"
    elif dev.get("engraveMode") not in ENGRAVE_MODES or dev.get("engraveMode") == "screen":
        dev["engraveMode"] = "text"
    return dev


def normalize_panels(design):
    for dev in (design or {}).get("devices") or []:
        normalize_panel(dev)
    return design


def scene_word(name):
    """情景名 → 去掉模板编号（「01.1 会客模式」→「会客模式」）。"""
    return _CODE_PREFIX.sub("", str(name or "")).strip()


def room_template(room):
    """按空间名称 / 类型取键位预算模板（刻字与面板触发源.md 第五节）。"""
    text = "%s %s" % ((room or {}).get("name") or "", (room or {}).get("type") or "")
    for tpl in rules()["roomTemplates"]:
        if any(k in text for k in tpl["match"]):
            return tpl
    return rules()["defaultTemplate"]


def _find_scene(word, room, scenes):
    if word == "全关":
        return next((s for s in scenes if s.get("mode") == "all-off"), None)
    if word == "全开":
        return next((s for s in scenes if s.get("mode") == "all-on"), None)
    if word in rules()["circuitWords"]:
        return None
    aliases = rules()["aliases"].get(word, [word])
    hits = [s for s in scenes if any(a in scene_word(s.get("name")) for a in aliases)]
    name, rtype = (room or {}).get("name"), (room or {}).get("type")
    scoped = [s for s in hits if s.get("space") and s.get("space") in (name, rtype)]
    return (scoped or hits or [None])[0]


def _long_word(word):
    if word == "全关":
        return "全开"
    return "调光" if word in rules()["circuitWords"] else ""


def _blank(arr):
    return not isinstance(arr, list) or not any(str(x or "").strip() for x in arr)


def is_legacy_fill(dev, scenes):
    """旧版预填：刻字直接抄了情景全名（「01.1 会客模式」）。这类整板按口径重排，手改过的不动。"""
    names = {str(s.get("name") or "").strip() for s in scenes or [] if isinstance(s, dict)}
    used = [str(x).strip() for f in ("keyLabels", "keyLongLabels") for x in dev.get(f) or [] if str(x or "").strip()]
    return bool(used) and all(x in names and x != scene_word(x) for x in used)


def fill_panel_keys(dev, room, scenes, force=False):
    """按知识库键位预算预填：短按刻字＝空间模板词（图标词 / 2 字），长按＝不刻字的辅助功能。

    只在整排空白或仍是旧版「情景全名」预填时改写（force=True 用于新建 / 手动重排），
    设计师改过的刻字一律不动。屏显型号（1.9 寸屏）不刻字，只补绑定。
    """
    normalize_panel(dev)
    scenes = [s for s in (scenes or []) if isinstance(s, dict) and s.get("id")]
    if not force and not _blank(dev.get("keyLabels")) and not is_legacy_fill(dev, scenes):
        return dev
    tpl = room_template(room)
    n = dev["keys"]
    if dev["engraveMode"] != "screen":
        dev["engraveMode"] = "icon" if tpl["mode"] == "icon" else "text"
    words = list(tpl["words"])
    if n < len(words):
        # 不够键位时先删能自动 / 次要的，「全关」永远留在最后一键。
        keep_off = "全关" in words
        words = [w for w in words if w != "全关"][: n - 1 if keep_off else n] + (["全关"] if keep_off else [])
    for i in range(n):
        word = words[i] if i < len(words) else ""
        long_word = _long_word(word)
        short = _find_scene(word, room, scenes) if word else None
        long_ = _find_scene(long_word, room, scenes) if long_word else None
        dev["keyLabels"][i] = word
        dev["keyScenes"][i] = (short or {}).get("id", "")
        dev["keyLongLabels"][i] = long_word
        dev["keyLongScenes"][i] = (long_ or {}).get("id", "")
    return dev


def fill_panels(design):
    """给设计里所有面板补齐键位与刻字（老项目一次性替换用）。"""
    design = design or {}
    rooms = {r.get("id"): r for r in design.get("rooms") or [] if isinstance(r, dict)}
    scenes = design.get("scenes") or []
    for dev in design.get("devices") or []:
        if isinstance(dev, dict) and dev.get("type") == "面板":
            fill_panel_keys(dev, rooms.get(dev.get("roomId")), scenes)
    return design


def label_issues(dev):
    """逐键刻字口径检查，返回 [(键位序号, 问题)]；键位序号 -1 表示整板问题。"""
    r = rules()
    mode = dev.get("engraveMode") or "text"
    out = []
    model = catalog_model(dev.get("productId"))
    text_max = panel_text_max(model)
    if (dev.get("brand") or "") == "" and not dev.get("model"):
        out.append((-1, "未选型：请选择品牌 / 系列 / 型号"))
    
    def check(raw, i, pre):
        lab = str(raw or "").strip()
        if not lab:
            return
        if any(w in lab for w in r["forbidden"]):
            out.append((i, "%s「%s」：交付文件不出现「语音」" % (pre, lab)))
        if mode == "screen":
            return
        if any(w in lab for w in r["offWall"]):
            out.append((i, "%s「%s」属自动触发场景，不上墙" % (pre, lab)))
        if mode == "icon" and lab not in r["icons"]:
            out.append((i, "%s「%s」不在厂家图标库（全图标板只能用：%s）" % (pre, lab, " ".join(r["icons"]))))
        if mode == "text" and len(lab) > text_max:
            model_note = (" %s " % model["model"]) if model else ""
            out.append((i, "%s「%s」超过 %d 字（%s文字镂空限 %d 字）" % (pre, lab, text_max, model_note, text_max)))
    
    for i, raw in enumerate(dev.get("keyLabels") or []):
        check(raw, i, "")
    if model and model.get("engraveLong"):
        for i, raw in enumerate(dev.get("keyLongLabels") or []):
            check(raw, i, "长按")
    if model and not model.get("longPress") and any(str(x or "").strip() for x in dev.get("keyLongScenes") or []):
        out.append((-1, "%s 不支持长按，长按绑定不会生效" % model["model"]))
    return out


def engrave_text(dev, i, long=False):
    """第 i 键的厂家刻字内容（图标写「中文 · 英文图标名」，屏显写免雕刻）。
    long=True 查询长按刻字（仅 engraveLong 型号）。"""
    mode = dev.get("engraveMode") or "text"
    model = catalog_model(dev.get("productId"))
    if long and not (model and model.get("engraveLong")):
        return ""
    labels = (dev.get("keyLongLabels") if long else dev.get("keyLabels")) or []
    lab = str(labels[i]).strip() if i < len(labels) and labels[i] else ""
    if mode == "screen":
        return "免雕刻（屏显：%s）" % lab if lab else "免雕刻"
    if not lab:
        return ""
    if mode == "icon":
        icon = rules()["icons"].get(lab)
        return "图标 %s（%s）" % (icon, lab) if icon else "图标待定（%s）" % lab
    return "文字「%s」" % lab


def mode_label(dev):
    """刻字形式标签（文字镂空字数按型号显示）。"""
    mode = dev.get("engraveMode") or "text"
    if mode == "screen":
        return "屏显免雕刻"
    if mode == "icon":
        return "全图标"
    model = catalog_model(dev.get("productId"))
    text_max = panel_text_max(model)
    return "全文字（%d 字）" % text_max


MODE_LABELS = {"icon": "全图标", "text": "全文字（2 字）", "screen": "屏显免雕刻"}  # deprecated, use mode_label
