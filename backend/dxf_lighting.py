#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dxf_lighting — 把室内灯源 DXF 解析成工作台三维灯光项目数据

产出（JSON）:
{
  "source": {...},                       # 图纸文件名/时间/统计
  "units": "m", "bbox": [x0,z0,x1,z1],   # 已归一到米、左下角为原点
  "ceiling": 2.8, "wall_cut": 1.5,       # 层高由建档表单覆盖
  "walls":   [ {x0,z0,x1,z1,t} ],        # 墙段（剖切高度由页面控制）
  "doors":   [ {x0,z0,x1,z1} ],
  "windows": [ {x0,z0,x1,z1} ],
  "furniture":[ {x0,z0,x1,z1,hint} ],
  "rooms":   [ {id,name,area,rects:[[x0,z0,x1,z1]],bbox:[...],cx,cz} ],
  "lamps":   [ {x,z,code,room,circuit,type,source} ],
  "strips":  [ {path:[[x,z]...], room, circuit, length} ],
  "circuits":[ {id,room,type,count} ],
  "unassigned": [ {x,z,reason} ],        # 待确认清单：编号对不上的灯位
  "warnings": [ "..." ]
}

设计口径（用户确认）:
  · 灯具图层 → 灯位（INSERT/CIRCLE）；灯具图层里的多段线 → 灯带
  · 灯型不靠块名（块名无型号）；靠"灯具编号"图层里的文字（D15/D24/...）与最近灯位配对
  · 编号 → 产品参数（功率/色温/光束角/零售价）由产品库负责，本模块只出编号
  · 房间名图纸里没有 → 出编号占位，交「待确认清单」由人在工作台确认
"""
import os, re, sys, json, math, time
from collections import Counter, defaultdict

import numpy as np

try:
    import ezdxf
except Exception as e:  # pragma: no cover
    ezdxf = None
    _import_err = e

# ---------------------------------------------------------------- 图层语义
WALL_KW = ("墙体", "P-A01", "原始结构", "0-通用完成面粗线", "结构墙",
           "砌墙", "剪力墙", "承重墙", "隔墙", "新建墙", "原墙")
DOOR_KW = ("门扇", "P-A07")
WIN_KW = ("窗帘", "窗")
FURN_KW = ("活动家具", "FF-FURN", "P-A13", "家具", "FF-PLANTS", "配饰", "人物")
LAMP_KW = ("灯具", "灯位")
STRIP_KW = ("灯带",)
CODE_LAYER_KW = ("编号",)
NOISE_KW = ("尺寸", "标注", "DIM", "DEFPOINTS", "$AUDIT", "布线", "索引", "图例", "材料", "说明")
CEIL_KW = ("吊顶", "天花")

# 双线墙反推：CAD 平面里「墙」＝一对平行、间距在墙厚区间、沿长度重叠的线。
# 图纸把墙画在哪个图层不一定（常有整层丢在 '0' 层、或墙在块里），
# 所以图层名认不出来时靠几何反推，否则三维里就是「没有墙」。
BAND_T_MIN = 60.0         # 墙厚下限（mm）
BAND_T_MAX = 400.0        # 墙厚上限（mm）
BAND_ANG_MAX = 6.0        # 平行容差（度）
BAND_OVERLAP_MIN = 400.0  # 沿墙方向最小重叠（mm）
BAND_MIN_LEN = 250.0      # 墙段最短长度（mm）
# 反推墙时排除的「不是墙」的图层：楼梯/地面/吊顶/填充/轴线/标注等
BAND_SKIP_KW = ("楼梯", "台阶", "铺贴", "地面", "天花", "吊顶", "顶--", "HATCH", "填充",
                "轴线", "中线", "定位", "标注", "尺寸", "图例", "索引", "材料", "说明",
                "WIPEOUT", "空调", "设备", "洁具", "家电")

LAMP_CODE_RE = re.compile(r"^[A-Z]{1,3}\d{1,3}[a-z]?$")
PAIR_MAX_M = 1.6          # 编号文字与灯位的最大配对距离（米）
STRIP_MIN_LEN = 0.5       # 灯具图层里多段线算灯带的最短长度（米）
STRIP_LINE_MIN = 1.0      # 灯具图层里 **直线** 算灯带的最短长度（米）——直线可能是引线/示意线，门槛抬高
STRIP_NAMED_MIN = 0.5     # 图层名里写着「灯带」的，不论图元类型，超过这个长度就是灯带

# 灯位几何兜底（细则 §十.6 建议1 / §十.11 施工清单#8）：灯具图层一个都没命中时才启用。
# 参数是实测的那张真图纸（13 房间 / 27 灯位）标定出来的，扫描结果见下表（召回 / 误报）：
#   repeat≥4 + 小圆≤400mm …… 93% / 10 个误报（太多）
#   repeat≥6 + 小圆≤400mm …… 93% / 10
#   repeat≥6 + 小圆 150–300mm  93% / **0**   ← 取这一档
#   repeat≥6 不带小圆     …… 93% / 0
LAMP_GUESS_MIN_REPEAT = 6        # 同一符号块重复插入 ≥6 次才算「灯具符号」
LAMP_GUESS_MAX_SIDE_MM = 1500.0  # 符号最大边 ≤1.5m（更大的块是家具/图框）
LAMP_GUESS_MIN_RADIUS_MM = 150.0 # 小圆：太小是杂点/文字笔画
LAMP_GUESS_MAX_RADIUS_MM = 300.0 # 太大不是筒灯/射灯符号；150–300mm 是实际尺寸档
LAMP_GUESS_MAX_TOTAL = 300       # 猜出这么多就明显不对，宁可不用
# 扫描范围：认不出图层名的灯具只会落进这几类（墙/门/窗/家具/吊顶各有自己的层，# 那些层上的重复小符号是结构/家具件，不是灯——扫进去会多出一堆误报）。
LAMP_GUESS_KINDS = ("other", "noise")
MIN_ROOM_AREA = 1.5       # 小于此面积不当作房间（㎡）
ROOM_OVERLAP_TOLERANCE = 0.035  # 两个空间的重叠超过较小者的这个比例就算「同一间画了两圈」；
                                # 与确认空间的硬闸 polygon_overlap_violations 同门槛（解析结果必须过得了那道闸）
# 解析器版本：**改了解析逻辑就要 +1**。工作台拿它跟存档里的版本比，
# 不一致就在三维页提示「解析已过期，请重新生成」——踩过：改了解析器但老项目不重生成，
# 用户看到的还是旧的错结果，还以为是没修好。
PARSER_VERSION = "2026-10-16.1"

WALL_T = 0.12             # 墙厚（米，出 3D 用）
DOOR_SEAL_T = 0.30        # 门扇线加粗用来封住门洞（米）

# 家具：三维里按「类型」出固定样式的模型（不吃风格，只按图纸尺寸缩放）。
# 高度按类型给（米），认不出来就用「通用」块。
# 下拉分组（语义调整面板用它渲染 optgroup；跟构件表一一对应）
FURN_GROUPS = (
    ("会客起居", ("沙发", "贵妃沙发", "单人沙发", "茶几", "边几", "电视柜")),
    ("餐厨", ("餐桌", "圆餐桌", "餐椅", "凳", "岛台", "吧台", "吊柜", "餐边柜",
              "冰箱", "灶台", "水槽")),
    ("卧室", ("床", "婴儿床", "床头柜", "梳妆台")),
    ("柜类", ("矮柜", "到顶柜", "鞋柜", "书架")),
    ("其他", ("洗衣机", "马桶", "浴缸", "台盆", "植物", "地毯", "钢琴", "通用")),
)
# 33 类（与 frontend/src/furnitureModels.ts 的构件表一一对应）。下拉里按这个顺序分组显示。
FURN_KINDS = ("沙发", "贵妃沙发", "单人沙发", "茶几", "边几", "电视柜",
              "餐桌", "圆餐桌", "餐椅", "凳", "岛台", "吧台", "吊柜", "餐边柜",
              "冰箱", "灶台", "水槽",
              "床", "婴儿床", "床头柜", "梳妆台",
              "矮柜", "到顶柜", "鞋柜", "书架",
              "洗衣机", "马桶", "浴缸", "台盆", "植物", "地毯", "钢琴", "通用")
# 高度（米）。到顶柜不用这个值：高度＝项目「吊顶后层高 − 0.05」，由 furniture_of 现算。
# 旧名字（柜/衣柜/电视/桌/架/毯）保留在表里，老项目的 store 才过得去校验。
FURN_H = {"沙发": 0.85, "贵妃沙发": 0.85, "单人沙发": 0.80, "茶几": 0.45, "边几": 0.55,
          "电视柜": 0.45, "餐桌": 0.76, "圆餐桌": 0.76, "餐椅": 0.88, "凳": 0.45,
          "岛台": 0.90, "吧台": 1.05, "吊柜": 0.80, "餐边柜": 0.90, "冰箱": 1.80,
          "灶台": 0.89, "水槽": 0.89, "床": 0.50, "婴儿床": 0.92, "床头柜": 0.55,
          "梳妆台": 0.75, "矮柜": 0.88, "到顶柜": 2.40, "鞋柜": 1.10, "书架": 1.90,
          "洗衣机": 0.90, "马桶": 0.78, "浴缸": 0.58, "台盆": 0.85, "植物": 0.95,
          "地毯": 0.03, "钢琴": 1.05, "通用": 0.50,
          "柜": 0.88, "衣柜": 2.40, "电视": 0.45, "桌": 0.76, "架": 1.90, "毯": 0.03}
# 块名/图层名 → 类型。**顺序即优先级**：「床头柜」必须在「床」之前，
# 「电视柜」在「电视」之前，否则永远只会命中后面那个短词。
FURN_NAME_KW = (("餐边柜", "餐边柜"), ("吊柜", "吊柜"), ("到顶", "到顶柜"), ("满墙", "到顶柜"),
           ("整墙", "到顶柜"), ("高柜", "到顶柜"), ("衣帽间", "到顶柜"), ("衣柜", "到顶柜"),
           ("书柜", "书架"), ("书架", "书架"), ("鞋柜", "鞋柜"), ("电视柜", "电视柜"),
           ("电视", "电视柜"), ("岛台", "岛台"), ("吧台", "吧台"),
           ("贵妃", "贵妃沙发"), ("单人沙发", "单人沙发"), ("沙发", "沙发"),
           ("床头柜", "床头柜"), ("婴儿床", "婴儿床"), ("床头", "床"), ("床", "床"),
           ("圆餐桌", "圆餐桌"), ("餐桌", "餐桌"), ("梳妆", "梳妆台"),
           ("茶", "茶几"), ("边几", "边几"), ("桌", "餐桌"), ("椅", "餐椅"), ("凳", "凳"),
           ("矮柜", "矮柜"), ("地柜", "矮柜"), ("储物柜", "矮柜"), ("柜", "矮柜"),
           ("冰箱", "冰箱"), ("洗衣", "洗衣机"), ("马桶", "马桶"), ("浴缸", "浴缸"),
           ("盆", "台盆"), ("洗手", "台盆"), ("灶", "灶台"), ("水槽", "水槽"),
           ("绿植", "植物"), ("植物", "植物"), ("地毯", "地毯"), ("钢琴", "钢琴"))
# 这些图层/块名上的闭合轮廓与块**不是家具**（实测它们会混进家具清单）：
# 门扇与门弧、楼梯、梁、窗、轴线标注。用大写比对（.upper()）。
FURN_SKIP_KW = ("DOOR", "STAIR", "STEP", "BEAM", "WINDOW", "DIM", "AXIS",
                "门扇", "门弧", "楼梯", "梁", "窗洞", "轴线", "标注")


def dec(s):
    """R12 DXF 常见：中文图层名被按 cp1252 读进来，按 gbk 还原"""
    if not isinstance(s, str):
        return "" if s is None else str(s)
    try:
        return s.encode("latin-1").decode("gbk")
    except Exception:
        return s


def plain_text(s):
    """去掉 MTEXT 的格式码：{\\fSimSun|b0|i0|c134|p2;\\C0;客厅} → 客厅

    踩过：空间名文字多是 MTEXT，原始 text 里带字体/颜色码，不去掉就一条都认不出来
    （实测「图纸上明明写着客厅」但解析说「没读到空间名文字」）。
    """
    s = str(s or "")
    s = s.replace("\\\\", "\\")
    s = re.sub(r"\\[A-Za-z][^;]*;", "", s)      # \fSimSun|...;  \C0;  \T1.25;
    s = re.sub(r"[{}\\]", "", s)
    return s.strip()


def furn_kind(name: str, layer: str, w: float, d: float) -> str:
    """猜家具类型：先看图上的块名/图层名（常直接写「沙发」「床」），再按占地尺寸猜。

    尺寸规则按「长边 × 短边」判（图纸里家具横放竖放都有）：
    认错没关系——工作台里可逐件改类型（语义调整）；但**不能像以前那样不管多大都猜「椅」**，
    0.4×0.5 的碎线全变成椅子，三维里就是满地小方块。
    """
    text = f"{name} {layer}"
    for kw, kind in FURN_NAME_KW:
        if kw in text:
            return kind
    a, b = max(w, d), min(w, d)          # a = 长边，b = 短边
    if a >= 1.85 and b >= 1.30:
        return "床"
    if a >= 1.85 and b >= 0.68:
        return "沙发"
    if a >= 1.60 and b <= 0.45:
        return "矮柜"                     # 长条柜：电视柜 / 餐边柜 / 矮柜 / 到顶柜（名字没写清时先按矮的）
    if a >= 1.15 and b >= 0.68:
        return "餐桌"
    if a >= 1.05 and b >= 0.40:
        if b <= 0.55:
            return "矮柜"                 # 1.5×0.5 这种浅长条是柜子，不是餐桌
        return "茶几" if a <= 1.45 else "餐桌"
    if a >= 0.95 and b <= 0.58:
        return "茶几"
    if a >= 0.90 and b <= 0.45:
        return "矮柜"
    if a <= 0.60 and b <= 0.60:           # 小件：0.42~0.56 见方是边几，再大是椅子，再小是凳
        if a < 0.40:
            return "通用"
        if b < 0.40:
            return "凳"
        if a <= 0.56:
            return "边几"
        return "餐椅"
    if b >= 0.55:
        return "餐椅"
    if b >= 0.32:
        return "凳" if (a / max(b, 0.01)) > 2.2 else "餐椅"
    return "通用"



def guess_lamps(data, inbox):
    """灯具图层认不出时的**几何兜底**（细则 §十.6 建议1 / §十.11 施工清单#8）。

    不用图层名，只用几何证据：
      · 同一个符号块被大量重复插入（≥4 次）且尺寸小（最大边 ≤1.5m）——灯具符号就是「同一个块
        插满全屋」；家具/图框不会这么刷；
      · 小圆（半径 ≤400mm）——筒灯/射灯常画成小圆。
    实测（§十.6）：同一张「灯具层丢 0 层」的图上，45 个真灯位找回 40 个（89%），3 个误报。

    返回 (候选灯位列表, 命中块名统计)。调用方负责标 guessed 并给提示——这是**推测**，不是识别。
    """
    hits = {}
    for kind in LAMP_GUESS_KINDS:
        for rec in data.get(kind, []):
            if rec.get("type") != "INSERT":
                continue
            bb = rec.get("bbox")
            if not bb:
                continue
            side = max(abs(bb[2] - bb[0]), abs(bb[3] - bb[1]))
            if not (40.0 <= side <= LAMP_GUESS_MAX_SIDE_MM):
                continue
            hits.setdefault(rec.get("block") or "", []).append(rec)

    out = []
    for block, recs in hits.items():
        if len(recs) < LAMP_GUESS_MIN_REPEAT:
            continue
        for rec in recs:
            bb = rec["bbox"]
            cx, cy = (bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2
            if not inbox((cx, cy)):
                continue
            out.append({"x": None, "z": None, "_mm": (cx, cy), "guessed": True,
                        "source": f"几何推测·块 {block or '（无名）'}"})
    for kind in LAMP_GUESS_KINDS:
        for rec in data.get(kind, []):
            if rec.get("type") != "CIRCLE":
                continue
            bb = rec.get("bbox")
            if not bb:
                continue
            r = abs(bb[2] - bb[0]) / 2.0
            if not (LAMP_GUESS_MIN_RADIUS_MM < r <= LAMP_GUESS_MAX_RADIUS_MM):
                continue
            cx, cy = (bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2
            if not inbox((cx, cy)):
                continue
            out.append({"x": None, "z": None, "_mm": (cx, cy), "guessed": True,
                        "source": "几何推测·小圆"})
    if len(out) > LAMP_GUESS_MAX_TOTAL:
        return [], hits
    return out, hits


def classify(layer):
    if any(k in layer for k in NOISE_KW):
        return "noise"
    if any(k in layer for k in CODE_LAYER_KW):
        return "code"
    if any(k in layer for k in STRIP_KW):
        return "lamp"
    if any(k in layer for k in LAMP_KW):        # 灯具/天棚灯具/中位灯具/RC-天花灯具都算灯具层
        return "lamp"
    if any(k in layer for k in DOOR_KW):
        return "door"
    # 「墙」只要出现在图层名里就算墙——但楼梯/地面/吊顶这类带「墙」字却不是墙的图层要挡掉。
    # 踩过：只认「墙体」时，『2砌墙』（后砌隔墙）整层被当成 other 丢掉，三维里外圈墙缺一半。
    if any(k in layer for k in WALL_KW) or (
            "墙" in layer and not any(k in layer for k in BAND_SKIP_KW)):
        return "wall"
    if any(k in layer for k in WIN_KW):
        return "window"
    if any(k in layer for k in CEIL_KW):
        return "ceiling"
    if any(k in layer for k in FURN_KW):
        return "furniture"
    return "other"


# ---------------------------------------------------------------- 取几何
def _poly_pts(e):
    t = e.dxftype()
    try:
        if t == "LINE":
            return [(e.dxf.start.x, e.dxf.start.y), (e.dxf.end.x, e.dxf.end.y)]
        if t == "LWPOLYLINE":
            return [(x, y) for x, y, *_ in e.get_points("xyseb")]
        if t == "POLYLINE":
            return [(v.dxf.location.x, v.dxf.location.y) for v in e.vertices]
        if t == "CIRCLE":
            # 圆按它自己的轴向方框出四点。**不能只返回圆心**——包框会缩成 0×0 被当碎件丢掉，
            # 实测漏掉「茶几（圆形）」「圆形落地灯」这类整件家具（块里就一个 CIRCLE 的必踩）。
            r = float(e.dxf.radius or 0)
            c = e.dxf.center
            return [(c.x - r, c.y - r), (c.x + r, c.y - r), (c.x + r, c.y + r), (c.x - r, c.y + r)]
        if t == "ARC":
            # 圆弧：按扫掠角采样（只用圆心同样会把包框缩成一点；用整圆的框又会放大）
            c = e.dxf.center
            r = float(e.dxf.radius or 0)
            a0 = math.radians(float(getattr(e.dxf, "start_angle", 0.0) or 0.0))
            a1 = math.radians(float(getattr(e.dxf, "end_angle", 0.0) or 0.0))
            if a1 <= a0:
                a1 += 2 * math.pi
            n = 24
            return [(c.x + r * math.cos(a0 + (a1 - a0) * k / n),
                     c.y + r * math.sin(a0 + (a1 - a0) * k / n)) for k in range(n + 1)]
        if t == "POINT":
            p = e.dxf.location
            return [(p.x, p.y)]
    except Exception:
        pass
    return []


def _block_bbox(e, depth=0):
    """INSERT 的包框：用块内实体（展开变换）算，块名无型号也能拿到几何"""
    if depth > 1:
        return None
    xs, ys = [], []
    try:
        for v in e.virtual_entities():
            pts = _poly_pts(v)
            if not pts and v.dxftype() == "INSERT":
                bb = _block_bbox(v, depth + 1)
                if bb:
                    xs += [bb[0], bb[2]]; ys += [bb[1], bb[3]]
            for x, y in pts:
                xs.append(x); ys.append(y)
    except Exception:
        return None
    if not xs:
        return None
    return (min(xs), min(ys), max(xs), max(ys))


def collect(doc, layers_only=None):
    """扫模型空间，返回按语义分好的实体列表（坐标仍是 mm，未归一）"""
    out = defaultdict(list)
    texts = []
    for e in doc.modelspace():
        layer = dec(getattr(e.dxf, "layer", ""))
        kind = classify(layer)
        t = e.dxftype()
        if kind == "noise":
            continue
        if kind == "code" or t in ("TEXT", "MTEXT", "ATTRIB", "ATTDEF"):
            raw = getattr(e.dxf, "text", "") or ""
            if not raw and t == "MTEXT":
                raw = e.plain_text() if hasattr(e, "plain_text") else e.text
            v = plain_text(dec(raw))
            try:
                p = e.dxf.insert
            except Exception:
                p = None
            if v and p is not None:
                texts.append({"layer": layer, "text": v, "x": p.x, "y": p.y})
            if kind == "code":
                continue
        if t == "INSERT":
            bb = _block_bbox(e)
            ip = e.dxf.insert
            rec = {"type": "INSERT", "layer": layer, "x": ip.x, "y": ip.y, "bbox": bb,
                   "block": dec(getattr(e.dxf, "name", ""))}
            out[kind].append(rec)
            if kind == "lamp" and bb:
                out["lamp_shape"].append(rec)
        elif t in ("LINE", "LWPOLYLINE", "POLYLINE", "CIRCLE", "ARC"):
            pts = _poly_pts(e)
            if not pts:
                continue
            xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
            bb = (min(xs), min(ys), max(xs), max(ys))
            closed = False
            try:
                closed = bool(e.closed) if t == "LWPOLYLINE" else (bool(e.is_closed) if t == "POLYLINE" else False)
            except Exception:
                closed = False
            rec = {"type": t, "layer": layer, "pts": pts, "bbox": bb, "closed": closed}
            out[kind].append(rec)
            if kind == "lamp" and t in ("LINE", "LWPOLYLINE", "POLYLINE"):
                ln = sum(math.dist(a, b) for a, b in zip(pts, pts[1:])) / 1000.0
                # 灯带＝线状灯具。判定按「图层名先于图元类型」：
                #   图层名写着「灯带」（天棚灯带/中位灯带/…）→ 不论 LINE 还是多段线都算；
                #   其余灯具图层：多段线 ≥STRIP_MIN_LEN，直线 ≥STRIP_LINE_MIN（直线可能是引线）。
                # 踩过：灯带画成 LINE 时一条都不认 —— 实测漏掉 3.82m + 8.36m 两条，
                # 灯带按米进报价，等于直接漏钱。
                if any(k in layer for k in STRIP_KW):
                    need = STRIP_NAMED_MIN
                elif t == "LINE":
                    need = STRIP_LINE_MIN
                else:
                    need = STRIP_MIN_LEN
                if ln >= need:
                    out["strip"].append({"layer": layer, "pts": pts, "length": ln})
    out["text"] = texts
    return out


# ---------------------------------------------------------------- 主体定位

# 住宅没有 100m 长的墙：单条 >100m 的记录是图框线/长导线/别的图纸，
# 让它参与外框会把 16m 的户型撑成几百米（后面家具、灯位全跟着跑飞）。
SUBJECT_MAX_SIDE_MM = 100000.0
def _bbox_of(data, kinds, mask=None):
    xs, ys = [], []
    for kind in kinds:
        for rec in data.get(kind, []):
            bb = rec.get("bbox")
            if not bb:
                continue
            cx, cy = (bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2
            if mask and not mask(cx, cy):
                continue
            xs += [bb[0], bb[2]]; ys += [bb[1], bb[3]]
    if not xs:
        return None
    return (min(xs), min(ys), max(xs), max(ys))


def _wall_boxes_for_frame(data):
    """墙线包框，但**先扔掉图框/长导线**再算户型外框。

    实测（实测 2026-10-16 那张图纸）：一条 654m 的杂线落在墙图层上，外框从 16m 被撑到 684m，
    家具/引线跟着跑到 300–680m 外；进设计画布（×26）后越过接口 ±10000 的上限，
    「确认空间」直接 422「家具位置 数值超出范围」，人还以为是自己的空间画错了。
    单条 >100m 的记录当不了住宅墙，先排除；全部都不像墙时再退回老口径（不至于把图判空）。
    """
    out = []
    for rec in data.get("wall", []):
        bb = rec.get("bbox")
        if not bb:
            continue
        if (bb[2] - bb[0]) > SUBJECT_MAX_SIDE_MM or (bb[3] - bb[1]) > SUBJECT_MAX_SIDE_MM:
            continue
        out.append(bb)
    return out


def locate_subject(data, bin_m=2.0):
    """定位住宅主体。一张 DXF 常塞好几张图（灯源/天花/家具/插座/水源各一份），
    所以先看墙线在哪儿，再用落在墙线范围内的吊顶层补外框。
    没有墙线时退化为"图元最密的那一片连通区"。
    """
    boxes_w = _wall_boxes_for_frame(data)
    wb = ((min(b[0] for b in boxes_w), min(b[1] for b in boxes_w),
           max(b[2] for b in boxes_w), max(b[3] for b in boxes_w)) if boxes_w
          else _bbox_of(data, ("wall",)))
    if wb:
        def inw(x, y):
            return wb[0] - 500 <= x <= wb[2] + 500 and wb[1] - 500 <= y <= wb[3] + 500
        extra = [_bbox_of(data, (k,), inw) for k in ("ceiling", "lamp", "door")]
        boxes = [b for b in extra if b] + [wb]
        return (min(b[0] for b in boxes), min(b[1] for b in boxes),
                max(b[2] for b in boxes), max(b[3] for b in boxes)), 0

    pts = []
    for kind in ("wall", "door", "window", "furniture", "lamp", "ceiling"):
        for rec in data.get(kind, []):
            bb = rec.get("bbox")
            if bb:
                pts.append(((bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2))
    for rec in data.get("text", []):
        pts.append((rec["x"], rec["y"]))
    pts = [p for p in pts if abs(p[0]) > 1 or abs(p[1]) > 1]   # 丢掉 (0,0) 堆积的块引用点
    if not pts:
        return None, 0
    step = bin_m * 1000.0
    cnt = Counter((int(p[0] / step), int(p[1] / step)) for p in pts)
    peak = max(cnt, key=lambda k: cnt[k])
    occ = set(cnt.keys())
    grow = {(a + dx, b + dy) for (a, b) in occ for dx in range(-1, 2) for dy in range(-1, 2)}
    seen, stack, region = {peak}, [peak], []
    while stack:
        c = stack.pop(); region.append(c)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                n = (c[0] + dx, c[1] + dy)
                if n in grow and n not in seen:
                    seen.add(n); stack.append(n)
    kept = [k for k in region if k in occ] or [peak]
    ks = set(kept)
    x0 = min(k[0] for k in kept) * step
    y0 = min(k[1] for k in kept) * step
    x1 = (max(k[0] for k in kept) + 1) * step
    y1 = (max(k[1] for k in kept) + 1) * step
    # 格子是按「图元中心」计数的：半张户型可能整段落在格子外（墙画在 '0' 层的图纸必踩）。
    # 所以再用格子内图元的真实包框把主体撑开，别把墙裁在外面。
    for kind in ("wall", "door", "window", "furniture", "lamp", "ceiling", "other"):
        for rec in data.get(kind, []):
            bb = rec.get("bbox")
            if not bb or (bb[2] - bb[0]) > 100000 or (bb[3] - bb[1]) > 100000:
                continue
            if (int((bb[0] + bb[2]) / 2 / step), int((bb[1] + bb[3]) / 2 / step)) not in ks:
                continue
            x0 = min(x0, bb[0]); y0 = min(y0, bb[1])
            x1 = max(x1, bb[2]); y1 = max(y1, bb[3])
    return (x0, y0, x1, y1), len(kept)


def rooms_from_ceiling(data, bbox, min_area=2.5):
    """吊顶轮廓（吊顶蓝线）里的闭合环 = 房间轮廓。
    比"墙线连通域"稳：图纸的墙常只画结构墙，门洞又不封闭。"""
    x0, y0, x1, y1 = bbox
    out = []
    for rec in data.get("ceiling", []):
        pts = rec.get("pts") or []
        if len(pts) < 3:
            continue
        if not all(x0 <= p[0] <= x1 and y0 <= p[1] <= y1 for p in pts):
            continue
        a = _poly_area_m2(pts)
        if not rec.get("closed") and len(pts) < 4:
            continue
        if a < min_area:
            continue
        out.append({"poly_mm": pts, "area": round(a, 2), "layer": rec["layer"],
                    "closed": bool(rec.get("closed"))})
    out.sort(key=lambda r: -r["area"])
    return out


def _poly_area_m2(pts_mm):
    s = 0.0
    seq = list(pts_mm) + [pts_mm[0]]
    for a, b in zip(seq, seq[1:]):
        s += a[0] * b[1] - b[0] * a[1]
    return abs(s) / 2 / 1e6


def _in_poly(poly, x, z):
    inside = False
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]; x2, y2 = poly[(i + 1) % n]
        if (y1 > z) != (y2 > z):
            xin = (x2 - x1) * (z - y1) / ((y2 - y1) or 1e-9) + x1
            if x < xin:
                inside = not inside
    return inside


def _loop_overlap(a, b):
    """两个闭合环的重叠量 ÷ 较小者的面积（0＝不挨着，1＝完全套住）。

    必须按**面积**判，不能只看中心点 + 面积比：实测 2026-10-16 那张图里 R3 被 R2 完整套住
    （重叠 100%），但面积正好是 R2 的 82%（>0.8），旧规则放它过去，结果「确认空间」被硬闸拦下。
    shapely 是可选的（算不出来时退回中心点近似，宁可漏判也不乱删房间）。
    """
    try:
        from shapely.geometry import Polygon
        pa, pb = Polygon(a), Polygon(b)
        if not pa.is_valid:
            pa = pa.buffer(0)
        if not pb.is_valid:
            pb = pb.buffer(0)
        small = min(pa.area, pb.area)
        if small <= 0:
            return 0.0
        return max(0.0, float(pa.intersection(pb).area) / small)
    except Exception:
        def centroid(p):
            return (sum(q[0] for q in p) / len(p), sum(q[1] for q in p) / len(p))
        return 1.0 if (_in_poly(a, *centroid(b)) or _in_poly(b, *centroid(a))) else 0.0


# ---------------------------------------------------------------- 空间名（图纸上的房间文字）
# 图纸一般会写房间名（客厅/餐厅/主卧…），但常画在「颜色图层」（color#…）或块里的『文字』图层上，
# 文字本身还可能是 GBK 乱码。不读它，三维里就只剩「房间1/2/3」，回路名、情景也全跟着错。
SPACE_KW = ("客厅", "餐厅", "厨房", "卧室", "主卧", "次卧", "书房", "儿童", "小孩", "老人", "保姆",
            "卫", "厨", "厅", "室", "房", "间", "玄关", "入户", "门厅", "过道", "走廊", "阳台",
            "露台", "院", "梯", "衣帽", "储物", "家政", "洗衣", "设备", "电竞", "影音", "健身",
            "茶", "娱乐", "多功能", "前室", "区", "榻榻米", "亲子")
NON_SPACE_KW = ("柜", "桌", "椅", "床", "沙发", "灯", "电视机", "音响", "音箱", "低音炮", "地毯",
                "窗帘", "家具", "踏步", "洁具", "马桶", "花洒", "台盆", "洗手", "镜", "水槽",
                "灶", "烤箱", "蒸箱", "冰箱", "冰柜", "洗衣机", "垃圾", "洗碗机", "饮水", "直饮",
                "升降", "雨伞", "行李", "儿童车", "工具", "露营", "调料", "碗", "收纳", "晾",
                "插座", "开关", "面板", "主机", "摄像", "报警", "热水器", "新风", "空调", "地暖",
                "软膜", "投影", "幕布", "留空", "预留", "拆", "落差", "标高", "吧台", "岛台",
                "咖啡角", "卡座", "茶几", "床头", "餐边", "壁龛", "隔断", "水井", "消防",
                "电梯门", "井道")


def space_name(text):
    """一条文字是不是空间名：是就返回规范化的名字，不是返回 None。

    规则：2~8 个汉字、命中房间关键词、且不含家具/设备词。
    """
    s = re.sub(r"\s+", "", plain_text(dec(text)))
    if not (2 <= len(s) <= 8):
        return None
    if not any("\u4e00" <= ch <= "\u9fff" for ch in s):
        return None
    if LAMP_CODE_RE.match(s) or re.fullmatch(r"[\d\.\-/×xX*]+", s):
        return None
    if any(k in s for k in NON_SPACE_KW):
        return None
    if any(k in s for k in SPACE_KW):
        return s
    return None


def space_texts(data, doc, inbox):
    """图纸上所有空间名文字（模型空间 + 块内文字，块内那批藏在『文字』图层里）。"""
    found = []

    def push(s, x, y, layer):
        nm = space_name(s)
        if nm and x is not None and y is not None and inbox((x, y)):
            found.append({"text": nm, "x": x, "y": y, "layer": layer})

    for t in data.get("text", []):
        push(t.get("text"), t.get("x"), t.get("y"), t.get("layer"))
    for e in doc.modelspace():
        if e.dxftype() != "INSERT":
            continue
        host = dec(getattr(e.dxf, "layer", ""))
        try:
            subs = list(e.virtual_entities())
        except Exception:
            continue
        if len(subs) > BLOCK_ENT_MAX:
            continue
        for v in subs:
            if v.dxftype() not in ("TEXT", "MTEXT"):
                continue
            lay = _layer_inherit(dec(getattr(v.dxf, "layer", "")), host)
            if any(k in lay for k in NOISE_KW):
                continue
            try:
                if v.dxftype() == "TEXT":
                    s, p = v.dxf.text, v.dxf.insert
                else:
                    s = v.dxf.text or ""            # MTEXT 原始串带格式码，后面统一清
                    p = v.dxf.insert
            except Exception:
                continue
            push(plain_text(s), p.x, p.y, lay)
    seen, out = set(), []
    for t in found:                      # 同一个块被插多次时名字会重复
        k = (t["text"], round(t["x"] / 100), round(t["y"] / 100))
        if k in seen:
            continue
        seen.add(k)
        out.append(t)
    return out


# ---------------------------------------------------------------- 栅格化分房
def room_mask(walls, doors, bbox, cell=0.05, close_px=2):
    """墙线栅格化 → 门洞用门扇线封住 → 返回 (室内掩膜, x0_mm, y0_mm, cell, 面积掩膜)。

    室内 = 不含墙、且不与画布边界连通的自由像素。
    · **墙按它自己的实测厚度画**（`rec["t"]`），不是一律 0.12——踩过：保利那套图的墙段
      是双线反推出来的、厚度 100~400mm，按 0.12 画到处都是缝，室内只剩 17㎡（画布 293㎡），
      整户连成一片；按实测厚度画 + 膨胀两格封缝，室内 99.6㎡、9 个空间，才对得上。
    · 真图纸的墙总有几个小缺口，`close_px` 格膨胀把缝扎上（门洞 900mm 不受影响）。
    · **膨胀只用于「封缝 + 判连通」，面积要用膨胀前的自由像素**（第 5 个返回值）。
      踩过：close_px=2 的 0.1m 沿墙一圈把 105.5㎡ 的室内算成 96.9㎡，全屋系统性偏小 8%，
      报价按 ¥/㎡ 乘就是钱。
    """
    x0, y0, x1, y1 = bbox
    W = max(2, int((x1 - x0) / 1000.0 / cell) + 1)
    H = max(2, int((y1 - y0) / 1000.0 / cell) + 1)
    mask = np.zeros((H, W), dtype=bool)

    def stroke(pts, width_m, close=False):
        w = max(1, int(round(width_m / cell)))
        seq = list(pts) + ([pts[0]] if close and len(pts) > 2 else [])
        for a, b in zip(seq, seq[1:]):
            n = max(2, int(math.dist(a, b) / 1000.0 / cell) + 1)
            for k in range(n):
                t = k / (n - 1)
                px = a[0] + (b[0] - a[0]) * t
                py = a[1] + (b[1] - a[1]) * t
                ix = int((px - x0) / 1000.0 / cell)
                iy = int((py - y0) / 1000.0 / cell)
                mask[max(0, iy - w):iy + w + 1, max(0, ix - w):ix + w + 1] = True

    for rec in walls:
        pts = rec.get("pts") or []
        if len(pts) >= 2:
            pen = float(rec.get("t") or WALL_T) / 2.0
            stroke(pts, pen, close=(rec.get("type") in ("LWPOLYLINE", "POLYLINE")))
    for rec in doors:                       # 门扇线 = 封门洞
        pts = rec.get("pts") or []
        if len(pts) >= 2:
            stroke(pts, DOOR_SEAL_T / 2)
    raw = mask.copy()                       # 膨胀前：面积按它算
    for _ in range(max(0, int(close_px))):  # 补小缝：膨胀墙线
        m = mask
        mask = (m | np.roll(m, 1, 0) | np.roll(m, -1, 0)
                | np.roll(m, 1, 1) | np.roll(m, -1, 1))

    def _outside_of(area):
        """与画布边界连通的自由像素 = 室外（4 邻域洪泛）"""
        out = np.zeros_like(area)
        stack = []
        for i in range(H):
            for j in (0, W - 1):
                if area[i, j] and not out[i, j]:
                    out[i, j] = True; stack.append((i, j))
        for j in range(W):
            for i in (0, H - 1):
                if area[i, j] and not out[i, j]:
                    out[i, j] = True; stack.append((i, j))
        while stack:
            i, j = stack.pop()
            for di, dj in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                a, b = i + di, j + dj
                if 0 <= a < H and 0 <= b < W and area[a, b] and not out[a, b]:
                    out[a, b] = True; stack.append((a, b))
        return out

    free = ~mask
    inside = free & ~_outside_of(free)
    raw_free = ~raw
    area_inside = raw_free & ~_outside_of(raw_free)
    return inside, x0, y0, cell, area_inside


def _grow_labels(ids, target, rounds=12):
    """把标签从 ids 的已标注像素扩到 target 掩膜上（就近归属，4 邻域逐圈外扩）。

    分房用膨胀后的掩膜（缝封住才不会把几个房间并成一片），面积却要用膨胀前的自由像素；
    把标签扩回膨胀前的那一圈，面积才不被吃掉。跨房间不会串——相邻房间的膨胀前自由像素
    之间隔着墙线本身（≥2 格），扩不过去。
    """
    out = ids.copy()
    valid = (ids > 0) | target
    for _ in range(max(1, int(rounds))):
        if not (target & (out == 0)).any():
            break
        grown = out
        for di, dj in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            rolled = np.roll(np.roll(out, di, 0), dj, 1)
            grown = np.where((grown == 0) & (rolled > 0), rolled, grown)
        out = np.where(valid, grown, 0)
    return out


def mask_rooms(ids, x0, y0, cell, min_area=MIN_ROOM_AREA, names=None, area_mask=None):
    """分区数组 → 房间列表（行游程合并成矩形，够用且不需要轮廓追踪）。

    ids：int 数组，值为 0 = 背景，>0 = 空间编号（每个编号一块互不相通的区域，
    同名不同区域的会被分成两间）。names：{编号: 空间名}。
    area_mask：面积掩膜（`room_mask` 的第 5 个返回值）。给了就按它算面积——分房在膨胀后的
    掩膜上做（缝封住），面积回到膨胀前的自由像素，避免沿墙一圈被吃掉。
    """
    H, W = ids.shape
    if area_mask is not None and area_mask.shape == ids.shape:
        ids = _grow_labels(ids, area_mask)
    seen = np.zeros((H, W), dtype=bool)
    out = []
    for i in range(H):
        for j in range(W):
            if not ids[i, j] or seen[i, j]:
                continue
            tile = ids[i, j]
            stack = [(i, j)]
            seen[i, j] = True
            pix = []
            while stack:
                a, b = stack.pop(); pix.append((a, b))
                for da, db in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    c, d = a + da, b + db
                    if 0 <= c < H and 0 <= d < W and ids[c, d] == tile and not seen[c, d]:
                        seen[c, d] = True; stack.append((c, d))
            area = len(pix) * cell * cell
            if area < min_area:
                continue
            # 行游程 → 竖向合并成矩形
            runs = defaultdict(list)
            for a, b in pix:
                runs[a].append(b)
            rects = []
            for a, bs in runs.items():
                bs.sort()
                s = bs[0]; p = bs[0]
                for b in bs[1:]:
                    if b == p + 1:
                        p = b; continue
                    rects.append((a, s, p)); s = b; p = b
                rects.append((a, s, p))
            merged = {}
            for a, s, p in rects:
                merged.setdefault((s, p), []).append(a)
            boxes = []
            for (s, p), rows in merged.items():
                rows.sort()
                st = rows[0]; pr = rows[0]
                for r in rows[1:]:
                    if r == pr + 1:
                        pr = r; continue
                    boxes.append((s, st, p, pr)); st = r; pr = r
                boxes.append((s, st, p, pr))
            boxes = [(s, t, p, q) for (s, t, p, q) in boxes if (p - s + 1) * (q - t + 1) >= 12]
            if not boxes:
                continue
            rects_m = []
            for (s, t, p, q) in boxes:
                ax = x0 / 1000.0 + s * cell; az = y0 / 1000.0 + t * cell
                bx = x0 / 1000.0 + (p + 1) * cell; bz = y0 / 1000.0 + (q + 1) * cell
                rects_m.append([round(ax, 3), round(az, 3), round(bx, 3), round(bz, 3)])
            xs = [r[0] for r in rects_m] + [r[2] for r in rects_m]
            zs = [r[1] for r in rects_m] + [r[3] for r in rects_m]
            out.append({"rects": rects_m, "area": round(area, 2),
                        "bbox": [min(xs), min(zs), max(xs), max(zs)],
                        "cx": round((min(xs) + max(xs)) / 2, 3),
                        "cz": round((min(zs) + max(zs)) / 2, 3),
                        "name": (names or {}).get(tile)})
    out.sort(key=lambda r: -r["area"])
    return out


def rasterize_rooms(walls, doors, bbox, cell=0.05):
    """墙线栅格化 → 连通域 = 房间（门一关，几个房间就不会并成一片）"""
    mask, x0, y0, cell, area_mask = room_mask(walls, doors, bbox, cell)
    return mask_rooms(mask.astype(np.int32), x0, y0, cell, area_mask=area_mask)


def rooms_from_names(walls, doors, bbox, texts, cell=0.05):
    """按「离哪个空间名最近」把室内分区：门洞没封、墙有缺口也不影响归属。

    真图纸（尤其灯光图）墙常是断的，连通域会把客厅+餐厅+厨房并成一片；
    可图纸上明明写着「客厅」「餐厅」「厨房」——按最近的名字分就分得对。
    texts = [(空间名, x_mm, y_mm)]；返回的房间 rects 是**绝对米**（与 rasterize_rooms 一致）。
    """
    if not texts:
        return []
    mask, x0, y0, cell, area_mask = room_mask(walls, doors, bbox, cell)
    H, W = mask.shape
    ids = np.zeros((H, W), dtype=np.int32)
    names = {}
    gy, gx = np.mgrid[0:H, 0:W]
    dist = np.full((H, W), np.inf)
    for k, (nm, px, py) in enumerate(texts, 1):
        names[k] = nm
        cx = (px - x0) / 1000.0 / cell
        cy = (py - y0) / 1000.0 / cell
        d = np.hypot(gx - cx, gy - cy)
        upd = mask & (d < dist)
        ids[upd] = k
        dist[upd] = d[upd]
    return mask_rooms(ids, x0, y0, cell, names=names, area_mask=area_mask)


def _in_room(room, x, z):
    if room.get("poly"):
        return _in_poly(room["poly"], x, z)
    for a, b, c, d in room["rects"]:
        if a <= x <= c and b <= z <= d:
            return True
    return False


# ---------------------------------------------------------------- 主流程
def _wall_segs(rec, T):
    """一条墙记录 → 若干墙段（折线按点逐个成段，不退回用整体包框）"""
    pts = rec.get("pts") or []
    segs = []
    for a, b in zip(pts, pts[1:]):
        (ax, az), (bx, bz) = T(a[0], a[1]), T(b[0], b[1])
        if math.dist((ax, az), (bx, bz)) < 0.02:
            continue
        segs.append({"x0": ax, "z0": az, "x1": bx, "z1": bz, "t": WALL_T, "layer": rec["layer"]})
    return segs


def _poly_segs(rec, close=True):
    """一条图元记录 → 线段列表（多段线按点逐个成段；闭合环补上收口那一段）"""
    pts = rec.get("pts") or []
    if len(pts) < 2:
        return []
    seq = list(pts)
    if close and rec.get("closed") and len(seq) > 2:
        seq = seq + [seq[0]]
    return [(a[0], a[1], b[0], b[1]) for a, b in zip(seq, seq[1:])]


def _seg_list(data, kinds, inbox, skip_kw=()):
    """按语义取线段（mm 坐标）：用于双线墙反推"""
    out = []
    for kind in kinds:
        for rec in data.get(kind, []):
            lay = rec.get("layer") or ""
            if skip_kw and any(k in lay for k in skip_kw):
                continue
            for (x0, y0, x1, y1) in _poly_segs(rec):
                if not (inbox((x0, y0)) or inbox((x1, y1))):
                    continue
                if math.dist((x0, y0), (x1, y1)) < 100:      # 指甲盖大小的碎线不看
                    continue
                out.append((x0, y0, x1, y1))
    return out


def band_walls(segs, t_min=BAND_T_MIN, t_max=BAND_T_MAX, ang_max=BAND_ANG_MAX,
               overlap_min=BAND_OVERLAP_MIN):
    """双线墙反推：一对平行线，垂距在墙厚区间、沿长度重叠 ⇒ 中间就是一段墙。

    返回 [{x0,y0,x1,y1,t}]（mm，中线 + 实测厚度）。
    """
    n = len(segs)
    if n < 2:
        return []
    A = np.asarray(segs, dtype=float)
    dx = A[:, 2] - A[:, 0]
    dy = A[:, 3] - A[:, 1]
    ln = np.hypot(dx, dy)
    ang = np.degrees(np.arctan2(dy, dx)) % 180.0
    ux, uy = dx / ln, dy / ln
    out = []
    for i in range(n):
        da = np.abs(ang - ang[i])
        da = np.minimum(da, 180.0 - da)
        cand = np.nonzero(da <= ang_max)[0]
        cand = cand[cand > i]
        if not len(cand):
            continue
        rx = A[cand, 0] - A[i, 0]
        ry = A[cand, 1] - A[i, 1]
        perp = np.abs(rx * uy[i] - ry * ux[i])
        p0 = rx * ux[i] + ry * uy[i]
        p1 = (A[cand, 2] - A[i, 0]) * ux[i] + (A[cand, 3] - A[i, 1]) * uy[i]
        lo = np.maximum(0.0, np.minimum(p0, p1))
        hi = np.minimum(ln[i], np.maximum(p0, p1))
        ov = hi - lo
        ok = (perp >= t_min) & (perp <= t_max) & (ov >= overlap_min)
        for k in np.nonzero(ok)[0]:
            L = A[cand[k]]
            t = (lo[k] + hi[k]) / 2
            mx = A[i, 0] + ux[i] * t
            my = A[i, 1] + uy[i] * t
            nx, ny = -uy[i], ux[i]
            hx, hy = ux[i] * ov[k] / 2, uy[i] * ov[k] / 2
            mx += nx * perp[k] / 2
            my += ny * perp[k] / 2
            out.append({"x0": mx - hx, "y0": my - hy, "x1": mx + hx, "y1": my + hy,
                        "t": float(perp[k])})
    return out


def merge_bands(bands, ang_tol=4.0, off_tol=140.0, gap_tol=150.0, min_len=BAND_MIN_LEN):
    """把同一条墙上的碎段并成一条（方向一致、垂距很近、首尾相接），厚度取中位。"""
    rows = []
    for b in bands:
        L = math.dist((b["x0"], b["y0"]), (b["x1"], b["y1"]))
        if L < 1:
            continue
        a = math.degrees(math.atan2(b["y1"] - b["y0"], b["x1"] - b["x0"])) % 180.0
        rows.append({"a": a, "L": L, "t": b["t"], "b": b,
                     "ux": (b["x1"] - b["x0"]) / L, "uy": (b["y1"] - b["y0"]) / L})
    rows.sort(key=lambda r: (round(r["a"]), round(r["b"]["y0"]), round(r["b"]["x0"])))
    used = [False] * len(rows)
    out = []
    for i, r in enumerate(rows):
        if used[i]:
            continue
        used[i] = True
        ux, uy = r["ux"], r["uy"]
        p0 = r["b"]["x0"] * ux + r["b"]["y0"] * uy
        p1 = r["b"]["x1"] * ux + r["b"]["y1"] * uy
        lo, hi = min(p0, p1), max(p0, p1)
        ts = [r["t"]]
        for j in range(i + 1, len(rows)):
            if used[j]:
                continue
            s = rows[j]
            da = abs(s["a"] - r["a"])
            if min(da, 180.0 - da) > ang_tol:
                continue
            rx = s["b"]["x0"] - r["b"]["x0"]
            ry = s["b"]["y0"] - r["b"]["y0"]
            if abs(rx * uy - ry * ux) > off_tol:
                continue
            q0 = s["b"]["x0"] * ux + s["b"]["y0"] * uy
            q1 = s["b"]["x1"] * ux + s["b"]["y1"] * uy
            if max(q0, q1) < lo - gap_tol or min(q0, q1) > hi + gap_tol:
                continue
            used[j] = True
            lo, hi = min(lo, min(q0, q1)), max(hi, max(q0, q1))
            ts.append(s["t"])
        d = hi - lo
        if d < min_len:
            continue
        ax = r["b"]["x0"] + ux * (lo - p0)
        ay = r["b"]["y0"] + uy * (lo - p0)
        ts.sort()
        out.append({"x0": ax, "y0": ay, "x1": ax + ux * d, "y1": ay + uy * d,
                    "t": round(ts[len(ts) // 2], 1)})
    return out


def wall_source_of(data, inbox, T, wall_recs, rooms):
    """挑三维要用的墙，并说明墙是哪来的。

    优先级：图纸墙图层的双线（带实测厚度）→ 图纸墙图层的墙线 → 通用图层的双线
    → 房间轮廓反推（最后的兜底，会漏内墙）。返回 (walls_m, 说明)。
    """
    wall_segs = []
    for rec in wall_recs:
        wall_segs += _poly_segs(rec)
    wall_segs = [s for s in wall_segs if inbox((s[0], s[1])) or inbox((s[2], s[3]))]
    struct_len = sum(math.dist((s[0], s[1]), (s[2], s[3])) for s in wall_segs)

    bands = merge_bands(band_walls(wall_segs)) if wall_segs else []
    bands_len = sum(math.dist((b["x0"], b["y0"]), (b["x1"], b["y1"])) for b in bands)

    # 墙图层几乎没有东西（整图丢在 '0' 层的图纸）→ 拿通用图层再反推一次
    gen_bands, gen_len = [], 0.0
    if struct_len < 15000:
        gen_segs = _seg_list(data, ("other",), inbox, BAND_SKIP_KW)
        gen_bands = merge_bands(band_walls(gen_segs))
        gen_len = sum(math.dist((b["x0"], b["y0"]), (b["x1"], b["y1"])) for b in gen_bands)

    def _to_m(items, layer=""):
        return [{"x0": T(b["x0"], b["y0"])[0], "z0": T(b["x0"], b["y0"])[1],
                 "x1": T(b["x1"], b["y1"])[0], "z1": T(b["x1"], b["y1"])[1],
                 "t": round(b["t"] / 1000.0, 3), "layer": layer} for b in items]

    if bands_len >= max(struct_len * 0.7, 5000):
        return _to_m(bands), f"墙来自图纸墙图层（双线反推 {len(bands)} 段，实测厚度）"
    if struct_len >= 15000:
        walls = [{"x0": T(s[0], s[1])[0], "z0": T(s[0], s[1])[1],
                  "x1": T(s[2], s[3])[0], "z1": T(s[2], s[3])[1], "t": WALL_T}
                 for s in wall_segs]
        return walls, f"墙来自图纸墙图层（墙线 {len(wall_segs)} 段）"
    if gen_len >= 8000:
        return _to_m(gen_bands, "other"), f"墙由通用图层的双线反推（{len(gen_bands)} 段，图纸没有墙图层）"
    if bands_len:
        return _to_m(bands, "wall"), f"墙由图纸墙图层的双线反推（{len(bands)} 段）"
    return (walls_from_rooms(rooms),
            "图纸里没有可用的墙线：墙按房间轮廓反推，内墙会有缺失")


def walls_from_rooms(rooms, t=WALL_T):
    """从房间轮廓反推墙：相邻房间的公共边 = 内墙，外边 = 外墙。

    只在图纸里连墙都找不到时兜底——吊顶轮廓覆盖不到的地方就没有墙。
    """
    seen = {}
    order = []
    for r in rooms:
        polys = [r["poly"]] if r.get("poly") else []
        for a, b, c, d in r.get("rects", []):
            polys.append([(a, b), (c, b), (c, d), (a, d)])
        for poly in polys:
            for a, b in zip(poly, poly[1:] + poly[:1]):
                ka = (round(a[0], 2), round(a[1], 2))
                kb = (round(b[0], 2), round(b[1], 2))
                if ka == kb:
                    continue
                key = tuple(sorted([ka, kb]))
                if key in seen:
                    seen[key] += 1
                    continue
                seen[key] = 1
                order.append((a, b))
    out = []
    for a, b in order:
        if math.dist(a, b) < 0.15:
            continue
        out.append({"x0": round(a[0], 3), "z0": round(a[1], 3),
                    "x1": round(b[0], 3), "z1": round(b[1], 3), "t": t})
    return out


# ---------------------------------------------------------------- 家具：碎线并件 + 类型
# 真图纸里家具是怎么画的（实测两套住宅图都没有「一件家具一个块」这种好事）：
#   · 大件（床/沙发/衣柜）常整套塞在一个块里，块包框跨几米甚至十几米；
#   · 家具图层上散着几十上百条短线（填充线、装饰线）和一堆闭合小多段线（椅子、单件）；
#   · 有的图纸干脆把家具画在 '0' 层，一点图层线索都没有。
# 只按「一条记录 = 一件家具」收，结果就是：大件全漏、碎线全变成 0.4×0.5 的「椅子」。
FURN_TOL = 60.0              # 零散线段归到「包住它的那件」的容差（mm）
FURN_MIN_SIDE = 250.0        # 小于这个不成件（图案点、符号）
FURN_MAX_SIDE = 4500.0       # 大于这个不成件（房间轮廓、窗帘长条、拉伸坏块）
FURN_MAX_SIDE_BIG = 12000.0  # 「整墙/到顶」柜体的放宽上限（整墙书柜实测 8.4m，别被上面那条裁掉）
FURN_BIG_KW = ("整墙", "到顶", "满墙", "衣柜", "书柜", "电视柜", "餐边柜", "鞋柜", "高柜", "岛台",
               "吊柜", "矮柜", "地柜")
# 出三维引擎时按「类型」判大件（那里拿不到块名，只有类型）
FURN_BIG_KINDS = ("矮柜", "到顶柜", "吊柜", "餐边柜", "电视柜", "鞋柜", "书架", "岛台", "吧台",
                  "柜", "衣柜", "电视", "通用")
FURN_INST_MIN = 300.0        # 块实例整体成件的边长区间（图纸里大件家具常整块塞在块里）
FURN_INST_MAX = 4000.0
FURN_ELEM_MAX_SIDE = 4000.0  # 收集元素时先丢掉这么长的线（标注引出线会横跨整张图）
FURN_LOOP_MIN = 300.0        # 「像家具」的闭合轮廓边长区间（mm）
FURN_LOOP_MAX = 4500.0       # 长条柜/衣柜能到 3~4 米，别卡在 3.2；房间轮廓靠贴墙判断排掉
BLOCK_ENT_MAX = 6000         # 单个块内图元超过这个数＝坏块，不展开


def _bbox_of_pts(pts):
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return (min(xs), min(ys), max(xs), max(ys))


def _layer_inherit(inner_layer, host_layer):
    """块内画在 0 层的图元跟宿主图层走（CAD 惯例：0 层不承载语义）"""
    return host_layer if inner_layer in ("", "0") else inner_layer


def _block_elements(insert, furniture_block):
    """展开块引用 → 元素 [(bbox_mm, layer, block, loop, pts)]

    家具块（宿主在图家具层）里所有图元都算候选；
    非家具块里只认「闭合轮廓」（否则会把墙线杂线一起吞进来）。
    """
    block = dec(getattr(insert.dxf, "name", ""))
    host = dec(getattr(insert.dxf, "layer", ""))
    try:
        subs = list(insert.virtual_entities())
    except Exception:
        return []
    if len(subs) > BLOCK_ENT_MAX:
        return []
    out = []
    for v in subs:
        t = v.dxftype()
        pts = _poly_pts(v)
        if len(pts) < 2:
            continue
        lay = _layer_inherit(dec(getattr(v.dxf, "layer", "")), host)
        loop = False
        if t == "LWPOLYLINE":
            loop = bool(getattr(v, "closed", False)) and len(pts) >= 3
        elif t == "POLYLINE":
            loop = bool(getattr(v, "is_closed", False)) and len(pts) >= 3
        elif t == "CIRCLE":
            loop = True
        if not furniture_block and not loop:
            continue
        out.append((_bbox_of_pts(pts), lay, block, loop, pts))
    return out


def _furniture_elements(data, doc, inbox):
    """家具候选三路（缺一路就漏家具）：

    1. 块实例：家具图层上的块引用，块包框本身就像一件家具 ⇒ 整块算一件（不再拆碎）；
    2. 闭合轮廓：图家具层的闭合多段线/圆 + **通用图层**（'0' 层）里尺寸像家具的闭合轮廓
       —— 有的图纸把家具画在 '0' 层，图层线索一点没有；
    3. 零散线段：家具图层上的线（有的图纸整件家具就是一堆线），回头归到包住它的那件上。
    """
    inst, loops, lines = [], [], []

    def add_loop(bb, layer, block):
        w, h = bb[2] - bb[0], bb[3] - bb[1]
        if FURN_LOOP_MIN <= w <= FURN_LOOP_MAX and FURN_LOOP_MIN <= h <= FURN_LOOP_MAX:
            loops.append({"bbox": tuple(bb), "layer": layer, "block": block})

    for rec in data.get("furniture", []):
        bb = rec.get("bbox")
        if not bb or not (inbox(bb[:2]) or inbox(bb[2:])):
            continue
        layer = rec.get("layer") or ""
        block = dec(rec.get("block") or "")
        if rec.get("closed") and len(rec.get("pts") or []) >= 3:
            add_loop(bb, layer, block)
        else:
            lines.append({"bbox": tuple(bb), "layer": layer, "block": block})

    for rec in data.get("other", []):
        if not rec.get("closed") or len(rec.get("pts") or []) < 3:
            continue
        layer = rec.get("layer") or ""
        if any(k in layer for k in BAND_SKIP_KW):   # 轴线/铺贴/吊顶这些层的闭环不是家具
            continue
        if any(k in layer.upper() for k in FURN_SKIP_KW):   # 门扇/楼梯/梁/窗的闭环也不是家具
            continue
        bb = rec.get("bbox")
        if not bb or not (inbox(bb[:2]) or inbox(bb[2:])):
            continue
        add_loop(bb, layer, "")

    for e in doc.modelspace():
        if e.dxftype() != "INSERT":
            continue
        host = dec(getattr(e.dxf, "layer", ""))
        is_furn = classify(host) == "furniture"
        name = dec(getattr(e.dxf, "name", ""))
        # 门外那类块里也有一堆闭合轮廓（门弧、梁体、楼梯），别把它们当家具收进来
        if any(k in f"{host} {name}".upper() for k in FURN_SKIP_KW):
            continue
        bb = _block_bbox(e)
        if bb and not (inbox(bb[:2]) or inbox(bb[2:])):
            continue
        if is_furn and bb:
            w, h = bb[2] - bb[0], bb[3] - bb[1]
            # 整墙/到顶的柜体块本身就跨几米，别按 4m 的上限把它拆成碎线
            inst_cap = FURN_MAX_SIDE_BIG if any(k in f"{host} {name}" for k in FURN_BIG_KW) else FURN_INST_MAX
            if FURN_INST_MIN <= w <= inst_cap and FURN_INST_MIN <= h <= inst_cap:
                inst.append({"bbox": tuple(bb), "layer": host, "block": name})
                continue                 # 整块就是一件家具，别再拆
        for el in _block_elements(e, is_furn):
            ebb, lay, block, loop, _pts = el
            if not (inbox(ebb[:2]) or inbox(ebb[2:])):
                continue
            if loop:
                add_loop(ebb, lay, block)
            elif is_furn:
                lines.append({"bbox": tuple(ebb), "layer": lay, "block": block})

    # 横跨整张图的标注线会把远处几件家具连成一件 → 丢掉；图案点也丢
    def usable(p):
        bb = p["bbox"]
        w, h = bb[2] - bb[0], bb[3] - bb[1]
        # 名字写着「整墙/到顶/衣柜/书柜…」的，量级本来就是几米，放宽上限
        big = any(k in f"{p.get('layer') or ''} {p.get('block') or ''}" for k in FURN_BIG_KW)
        return max(w, h) <= (FURN_MAX_SIDE_BIG if big else FURN_ELEM_MAX_SIDE) and not (w < 40 and h < 40)

    return {"inst": [p for p in inst if usable(p)],
            "loops": [p for p in loops if usable(p)],
            "lines": [p for p in lines if usable(p)]}


def _contains(outer, inner, tol=FURN_TOL):
    return (outer[0] - tol <= inner[0] and outer[1] - tol <= inner[1]
            and inner[2] <= outer[2] + tol and inner[3] <= outer[3] + tol)


def _area(bb):
    return max(0.0, bb[2] - bb[0]) * max(0.0, bb[3] - bb[1])


def _cluster_boxes(boxes, tol=FURN_TOL, max_overlap=0.6):
    """包框邻近就归为一组（并查集）。boxes = [(x0,y0,x1,y1)] → [[下标...]]

    但**贴得很深的两个件不能并**：椅子塞在餐桌底下时包框大面积重叠，
    一并不光把餐桌变成 3.3×2.4 的「床」，三维里还会长出一张大到离谱的家具。
    """
    n = len(boxes)
    parent = list(range(n))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    grow = [(b[0] - tol, b[1] - tol, b[2] + tol, b[3] + tol) for b in boxes]
    order = sorted(range(n), key=lambda i: grow[i][0])
    for a in range(n):
        i = order[a]
        for b in range(a + 1, n):
            j = order[b]
            if grow[j][0] > grow[i][2]:
                break
            if not (grow[j][1] <= grow[i][3] and grow[i][1] <= grow[j][3]):
                continue
            ow = min(boxes[i][2], boxes[j][2]) - max(boxes[i][0], boxes[j][0])
            oh = min(boxes[i][3], boxes[j][3]) - max(boxes[i][1], boxes[j][1])
            ai = (boxes[i][2] - boxes[i][0]) * (boxes[i][3] - boxes[i][1])
            aj = (boxes[j][2] - boxes[j][0]) * (boxes[j][3] - boxes[j][1])
            small = min(ai, aj)
            if small > 0 and ow > 0 and oh > 0 and (ow * oh) / small > max_overlap:
                continue
            ri, rj = find(i), find(j)
            if ri != rj:
                parent[max(ri, rj)] = min(ri, rj)
    groups = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)
    return list(groups.values())


def _pt_seg_dist(p, a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    l2 = dx * dx + dy * dy
    t = 0.0 if l2 == 0 else max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2))
    return math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))


def _on_walls(bb, walls, ratio=0.85, step=0.25, tol=0.10, min_area=3.0):
    """这件「家具」的边是不是**四面**都压在墙上？

    四面压墙的多半不是家具，是**房间轮廓**（'0' 层里闭合的房间线）——
    实测保利那套图会冒出一个 2.9×2.9 的「床」，其实是间小房间的轮廓。
    阈值必须给到 0.85：床贴着两面墙放很正常（3 面贴墙也有），别把真床一起杀了。
    """
    if not walls:
        return False
    x0, y0, x1, y1 = bb
    if (x1 - x0) * (y1 - y0) < min_area:
        return False
    pts = []
    for x in [x0 + i * step for i in range(int(max(1, (x1 - x0) / step)) + 1)]:
        pts += [(x, y0), (x, y1)]
    for y in [y0 + i * step for i in range(int(max(1, (y1 - y0) / step)) + 1)]:
        pts += [(x0, y), (x1, y)]
    near = 0
    for p in pts:
        for w in walls:
            if _pt_seg_dist(p, (w["x0"], w["z0"]), (w["x1"], w["z1"])) <= (w.get("t") or 0.12) / 2 + tol:
                near += 1
                break
    return near >= ratio * len(pts)


def furniture_pieces(data, doc, inbox, T, walls=None):
    """家具清单（米制、与引擎同坐标系）。

    规则（顺序就是优先级）：
      1. 块实例：整块像一件家具 ⇒ 一件（大件家具常整块塞在块里，拆碎更糟）；
      2. 闭合轮廓：一件家具一个轮廓；**被更大轮廓整个包住的轮廓是细部**（坐垫、枕头、
         塞在餐桌底下的椅子），不再单独出一件，否则三维里就是满地重复小方块；
        贴着墙走的闭合轮廓按房间轮廓排除；
      3. 家具图层上没被任何轮廓圈住的线段 ⇒ 聚成件（有的图纸一件家具就是一堆线）。
    """
    els = _furniture_elements(data, doc, inbox)
    pieces = [{"bbox": list(p["bbox"]), "layers": {p["layer"]} if p["layer"] else set(),
               "blocks": {p["block"]} if p["block"] else set(), "loops": 0, "parts": 1,
               "inst": True} for p in els["inst"]]

    kept = []
    for lp in sorted(els["loops"], key=lambda q: -_area(q["bbox"])):
        if any(_contains(k["bbox"], lp["bbox"]) for k in kept):
            continue                                   # 细部：已经有更大的轮廓罩着它
        k = {"bbox": list(lp["bbox"]), "layers": {lp["layer"]} if lp["layer"] else set(),
             "blocks": {lp["block"]} if lp["block"] else set(), "loops": 1, "parts": 1,
             "inst": False}
        kept.append(k)
        pieces.append(k)

    def attach(bb, layer, block):
        """零散线段：归到包住它的那件上（床垫褶线、柜门分格都靠它）"""
        for p in pieces:
            if _contains(p["bbox"], bb) or _contains(p["bbox"], ((bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2,
                                                                 (bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2)):
                p["bbox"][0] = min(p["bbox"][0], bb[0]); p["bbox"][1] = min(p["bbox"][1], bb[1])
                p["bbox"][2] = max(p["bbox"][2], bb[2]); p["bbox"][3] = max(p["bbox"][3], bb[3])
                p["parts"] += 1
                if layer:
                    p["layers"].add(layer)
                if block:
                    p["blocks"].add(block)
                return True
        return False

    orphans = [ln for ln in els["lines"] if not attach(ln["bbox"], ln["layer"], ln["block"])]

    # 家具图层上的孤立线段：聚成件（别的图层不行，'0' 层杂线太多）
    if orphans:
        for idxs in _cluster_boxes([o["bbox"] for o in orphans]):
            group = [orphans[i] for i in idxs]
            if len(group) < 3 or not any(classify(o["layer"]) == "furniture" for o in group):
                continue
            x0 = min(o["bbox"][0] for o in group); y0 = min(o["bbox"][1] for o in group)
            x1 = max(o["bbox"][2] for o in group); y1 = max(o["bbox"][3] for o in group)
            pieces.append({"bbox": [x0, y0, x1, y1],
                           "layers": {o["layer"] for o in group if o["layer"]},
                           "blocks": {o["block"] for o in group if o["block"]},
                           "loops": 0, "parts": len(group), "inst": False})

    items, seen = [], set()
    for p in pieces:
        x0, y0, x1, y1 = p["bbox"]
        w, h = x1 - x0, y1 - y0
        layers = sorted(p["layers"])
        blocks = sorted(b for b in p["blocks"] if b)
        names = " ".join(blocks)
        # 大件豁免：块名/图层名写着「整墙/到顶/衣柜/书柜…」的不受 FURN_MAX_SIDE 约束。
        # 那个上限是用来挡「房间轮廓冒充家具」的，整墙柜本来就该有几米长——
        # 实测 8380×740mm 的整墙书柜被 4500mm 一刀裁掉，三维里和报价里都没了。
        big = any(k in f"{' '.join(layers)} {names}" for k in FURN_BIG_KW)
        cap = FURN_MAX_SIDE_BIG if big else FURN_MAX_SIDE
        if w < FURN_MIN_SIDE or h < FURN_MIN_SIDE or w > cap or h > cap:
            continue
        kind = furn_kind(blocks[0] if blocks else "", f"{' '.join(layers)} {names}",
                         w / 1000.0, h / 1000.0)
        a, b = T(x0, y1)
        c, d = T(x1, y0)
        key = (round(min(a, c), 2), round(min(b, d), 2), round(max(a, c), 2), round(max(b, d), 2))
        if key in seen:
            continue
        if _on_walls(key, walls):
            continue                       # 边都贴在墙上 ⇒ 房间轮廓，不是家具
        seen.add(key)
        items.append({"bbox": list(key), "layer": layers[0] if layers else "",
                      "block": names, "kind": kind, "loops": p["loops"], "parts": p["parts"]})
    items.sort(key=lambda it: -((it["bbox"][2] - it["bbox"][0]) * (it["bbox"][3] - it["bbox"][1])))
    if len(items) > 120:                      # 碎件太多时先留占地最大的
        items = items[:120]
    return items


def _bbox_gap(a, b):
    """两个包框的间距（0 = 相交）"""
    dx = max(0.0, max(a[0] - b[2], b[0] - a[2]))
    dz = max(0.0, max(a[1] - b[3], b[1] - a[3]))
    return math.hypot(dx, dz)


def _merge_same_names(rooms, gap=1.2):
    """同名空间被墙切碎时并回一间——三维里不该出现两个「餐厅」。"""
    out = []
    for r in sorted(rooms, key=lambda q: -(q.get("area") or 0)):
        host = next((k for k in out
                     if k.get("name") == r.get("name") and _bbox_gap(k["bbox"], r["bbox"]) <= gap),
                    None)
        if host is None:
            out.append(r)
            continue
        host["rects"] = list(host["rects"]) + list(r["rects"])
        host["area"] = round((host.get("area") or 0) + (r.get("area") or 0), 2)
        host["bbox"] = [min(host["bbox"][0], r["bbox"][0]), min(host["bbox"][1], r["bbox"][1]),
                        max(host["bbox"][2], r["bbox"][2]), max(host["bbox"][3], r["bbox"][3])]
        host["cx"] = round((host["bbox"][0] + host["bbox"][2]) / 2, 3)
        host["cz"] = round((host["bbox"][1] + host["bbox"][3]) / 2, 3)
    return out


def _rect_room_to_frame(r, x0, y1, source):
    """rasterize_rooms / rooms_from_names 出来的 rects 是**绝对米** → 转到 T 框架（米）。"""
    r = dict(r)
    r["rects"] = [[round(a - x0 / 1000.0, 3), round(y1 / 1000.0 - d, 3),
                   round(c - x0 / 1000.0, 3), round(y1 / 1000.0 - b, 3)]
                  for a, b, c, d in r["rects"]]
    bx = [q[0] for q in r["rects"]] + [q[2] for q in r["rects"]]
    bz = [q[1] for q in r["rects"]] + [q[3] for q in r["rects"]]
    r["bbox"] = [round(min(bx), 3), round(min(bz), 3), round(max(bx), 3), round(max(bz), 3)]
    r["cx"] = round((r["bbox"][0] + r["bbox"][2]) / 2, 3)
    r["cz"] = round((r["bbox"][1] + r["bbox"][3]) / 2, 3)
    r["poly"] = r.get("poly") or []
    r["source"] = source
    return r


# ---------------------------------------------------------------- 图纸体检
def drawing_health(parsed, ceiling_from_archive=False, ceil=None, net=None):
    """把「墙 / 空间 / 家具 / 灯位 / 层高」逐项体检，直接说清哪一块可能是没认出来。

    为什么要有它：三轮都是同一个毛病——解析错了（墙丢、家具错、空间名没读），
    工作台一声不吭，等用户在三维里自己发现。自检至少要让问题**在页面上说出来**。
    返回 {"level": ok|warn|bad, "items": [{"key","label","level","detail"}]}。
    """
    items = []
    walls = parsed.get("walls") or []
    rooms = parsed.get("rooms") or []
    furn = parsed.get("furniture") or []
    lamps = parsed.get("lamps") or []
    bb = parsed.get("bbox") or [0, 0, 0, 0]
    area = max(1.0, float(bb[2]) * float(bb[3]))
    wlen = sum(math.dist((w["x0"], w["z0"]), (w["x1"], w["z1"])) for w in walls)
    dens = wlen / area
    src_note = parsed.get("wall_source") or ""

    if len(walls) < 8 or dens < 0.35:
        items.append({"key": "walls", "label": "墙", "level": "bad",
                      "detail": f"只认到 {len(walls)} 段墙（{wlen:.0f}m ≈ {dens:.2f} m/㎡）："
                                f"图纸的墙可能画在别的图层上，或这张图只有灯位层"})
    elif "房间轮廓" in src_note:
        items.append({"key": "walls", "label": "墙", "level": "warn",
                      "detail": "墙是按房间轮廓反推的（图纸里没找到墙线），内墙会有缺失"})
    else:
        items.append({"key": "walls", "label": "墙", "level": "ok",
                      "detail": f"{len(walls)} 段 / {wlen:.0f}m；{src_note}"})

    named = [r for r in rooms if r.get("name") and not re.fullmatch(r"房间\d+", str(r["name"]))]
    if len(rooms) <= 1:
        items.append({"key": "rooms", "label": "空间", "level": "bad",
                      "detail": "没分出空间（只有一个兜底范围）：空间名与回路名都会跟着不准"})
    elif not named:
        items.append({"key": "rooms", "label": "空间", "level": "warn",
                      "detail": f"分出 {len(rooms)} 个空间但都是「房间N」：图纸上没读到空间名文字，"
                                f"请在「语义调整」里改名"})
    elif len(named) < len(rooms):
        items.append({"key": "rooms", "label": "空间", "level": "warn",
                      "detail": f"{len(rooms)} 个空间里 {len(named)} 个有名字，其余请在「语义调整」里确认"})
    else:
        items.append({"key": "rooms", "label": "空间", "level": "ok",
                      "detail": f"{len(rooms)} 个空间，名字取自图纸文字（面积是按墙反推的近似值）"})

    if not furn:
        items.append({"key": "furniture", "label": "家具", "level": "warn",
                      "detail": "一件家具都没认出来（三维里只有墙和灯）"})
    elif len(furn) < 5:
        items.append({"key": "furniture", "label": "家具", "level": "warn",
                      "detail": f"只认出 {len(furn)} 件，可能有漏（家具整套塞在块里或画在别的图层）"})
    else:
        items.append({"key": "furniture", "label": "家具", "level": "ok",
                      "detail": f"{len(furn)} 件；类型是尺寸猜的，认错的用「语义调整」逐件改"})

    if not lamps:
        items.append({"key": "lamps", "label": "灯位", "level": "bad",
                      "detail": "没读到灯位：确认图纸里有「灯具 / 灯位」图层"})
    else:
        coded = sum(1 for l in lamps if l.get("code"))
        if coded == 0:
            items.append({"key": "lamps", "label": "灯位", "level": "warn",
                          "detail": f"{len(lamps)} 个灯位一个编号都没配上：图纸可能没有「灯具编号」图层，"
                                    f"报价里会缺这些灯"})
        elif coded < len(lamps) * 0.6:
            items.append({"key": "lamps", "label": "灯位", "level": "warn",
                          "detail": f"{len(lamps)} 个灯位只有 {coded} 个有编号（{coded / len(lamps) * 100:.0f}%），"
                                    f"报价会缺没编号的那些"})
        else:
            items.append({"key": "lamps", "label": "灯位", "level": "ok",
                          "detail": f"{len(lamps)} 个灯位，{coded} 个有编号"})

    c, n = ceil or parsed.get("ceiling"), net or parsed.get("ceiling_net")
    if ceiling_from_archive:
        items.append({"key": "ceiling", "label": "层高", "level": "ok",
                      "detail": f"原始 {c}m / 吊顶后 {n}m（建档表单填的）：光斑直径按它算"})
    else:
        items.append({"key": "ceiling", "label": "层高", "level": "warn",
                      "detail": f"用的是默认层高 {c}m / 吊顶后 {n}m——在项目建档或本页填一下层高，"
                                f"光斑大小才准"})

    level = ("bad" if any(i["level"] == "bad" for i in items)
             else "warn" if any(i["level"] == "warn" for i in items) else "ok")
    return {"level": level, "items": items,
            "parser_version": PARSER_VERSION,
            "counts": {"walls": len(walls), "wall_len": round(wlen, 1), "rooms": len(rooms),
                       "furniture": len(furn), "lamps": len(lamps)}}


def parse(path, opts=None, progress=None):
    opts = opts or {}

    def _p(pct, stage):
        if progress:
            try:
                progress(pct, stage)
            except Exception:
                pass

    if ezdxf is None:
        raise RuntimeError(f"缺 ezdxf: {_import_err}")
    t0 = time.time()
    _p(0.08, "读取图纸")
    doc = ezdxf.readfile(path)
    data = collect(doc)
    _p(0.22, "整理图元")
    bbox_mm, nseg = locate_subject(data)
    _p(0.34, "定位住宅主体")
    warnings = []
    if not bbox_mm:
        warnings.append("没找到墙线，无法定位住宅主体")
        bbox_mm = (0, 0, 1, 1)
    x0, y0, x1, y1 = bbox_mm
    pad = 1000.0
    x0 -= pad; y0 -= pad; x1 += pad; y1 += pad

    def inbox(p):
        return x0 <= p[0] <= x1 and y0 <= p[1] <= y1

    def clip(recs):
        return [r for r in recs if r.get("bbox") and inbox(((r["bbox"][0] + r["bbox"][2]) / 2, (r["bbox"][1] + r["bbox"][3]) / 2))]

    walls, doors, wins, furns = clip(data["wall"]), clip(data["door"]), clip(data["window"]), clip(data["furniture"])

    # 归一：x 取 x0→0；y 取上边界→0 并翻转（图纸 y 向上，三维 z 向下）
    def T(px, py):
        return (round((px - x0) / 1000.0, 3), round((y1 - py) / 1000.0, 3))

    # 房间：优先用吊顶轮廓（闭合环 = 一个房间），不够两个再退化到墙线连通域
    poly_rooms = rooms_from_ceiling(data, (x0, y0, x1, y1), min_area=float(opts.get("min_room", 2.5)))
    rooms = []
    for r in poly_rooms:
        poly = [list(T(px, py)) for px, py in r["poly_mm"]]
        xs = [p[0] for p in poly]; zs = [p[1] for p in poly]
        rooms.append({"poly": poly, "rects": [], "area": r["area"], "source": "ceiling",
                      "bbox": [round(min(xs), 3), round(min(zs), 3), round(max(xs), 3), round(max(zs), 3)],
                      "cx": round((min(xs) + max(xs)) / 2, 3), "cz": round((min(zs) + max(zs)) / 2, 3)})
    if len(rooms) < 2:
        rooms = [_rect_room_to_frame(r, x0, y1, "walls")
                 for r in rasterize_rooms(walls, doors, (x0, y0, x1, y1),
                                          cell=float(opts.get("cell", 0.05)))]
        if not rooms:
            warnings.append("没识别出房间：吊顶轮廓和墙线连通域都没成型")
        else:
            warnings.append(f"房间来自墙线连通域 {len(rooms)} 个（这张图没有可用的吊顶轮廓）")
    else:
        warnings.append(f"房间来自吊顶轮廓 {len(rooms)} 个闭合环，请确认房间名与合并关系")
        # 吊顶常一层套一层（灯槽/叠级/同一间画了两圈）→ 被别的环压住的小环，不单独当房间。
        # 判定按面积（见 _loop_overlap），门槛与确认空间的硬闸对齐：解析出来的空间必须过得了那道闸，
        # 否则「导入图纸 → 确认空间」必然卡在重叠上（实测 2026-10-16 那张图：3 对环正好压住 100%）。
        kept, dropped = [], []
        for r in sorted(rooms, key=lambda x: -x["area"]):
            host, ratio = None, 0.0
            for k in kept:
                ratio = _loop_overlap(k["poly"], r["poly"])
                if ratio > ROOM_OVERLAP_TOLERANCE:
                    host = k; break
            if host:
                dropped.append(f'{r["area"]}㎡(被 {host["area"]}㎡ 的环压住 {round(ratio * 100)}%)')
            else:
                kept.append(r)
        if dropped:
            warnings.append("已剔除与相邻空间重叠的吊顶环（同一间的灯槽/叠级或重复环，只留大的那个）："
                            + "、".join(dropped))
        rooms = kept
    if not rooms:
        # 认不出房间：按整张图纸范围兜一个「空间1」，别让三维页一片空。
        W0 = max(1.0, (x1 - x0) / 1000.0)
        H0 = max(1.0, (y1 - y0) / 1000.0)
        rooms = [{"poly": [], "rects": [[0.0, 0.0, round(W0, 3), round(H0, 3)]],
                  "area": round(W0 * H0, 2), "source": "fallback",
                  "bbox": [0.0, 0.0, round(W0, 3), round(H0, 3)],
                  "cx": round(W0 / 2, 3), "cz": round(H0 / 2, 3)}]

    # 墙：图纸墙图层 / 双线反推（墙画在 '0' 层这类图纸靠它）/ 房间轮廓兜底。
    # 只从房间轮廓反推的话，吊顶轮廓没盖到的地方就没有墙——三维里看着就是「墙丢了」。
    _p(0.58, "识别墙体")
    wall_list, wall_note = wall_source_of(data, inbox, T, walls, rooms)
    warnings.append(wall_note)

    # 空间名：图纸上写着「客厅/主卧…」就照用。名字比房间多（或墙是断的、几个空间并成一片）
    # 就直接按「离哪个名字最近」重新分区——门洞没封、墙有缺口都不影响归属。
    _p(0.66, "读取空间名")
    txt_names = space_texts(data, doc, inbox)
    if txt_names:
        for r in rooms:
            inside = [t for t in txt_names if _in_room(r, *T(t["x"], t["y"]))]
            if inside:
                inside.sort(key=lambda t: -len(t["text"]))
                r["name"] = inside[0]["text"]
        named_ok = sum(1 for r in rooms if not re.fullmatch(r"房间\d+", r.get("name") or ""))
        if len(txt_names) >= 2 and (len(rooms) < 2 or named_ok < len(rooms)
                                    or len(txt_names) > len(rooms)):
            wall_recs = walls or [{"pts": [(x0 + w["x0"] * 1000, y1 - w["z0"] * 1000),
                                          (x0 + w["x1"] * 1000, y1 - w["z1"] * 1000)],
                                   "closed": False, "type": "LINE", "t": w.get("t"),
                                   "layer": w.get("layer") or "wall"}
                                  for w in wall_list]
            by_name = rooms_from_names(wall_recs, doors, (x0, y0, x1, y1),
                                       [(t["text"], t["x"], t["y"]) for t in txt_names],
                                       cell=float(opts.get("cell", 0.05)))
            if len(by_name) >= 2:
                rooms = [_rect_room_to_frame(r, x0, y1, "names") for r in by_name]
                rooms = _merge_same_names(rooms)
                warnings.append("空间按图纸上的空间名划分：" + "、".join(
                    dict.fromkeys(r["name"] for r in rooms if r.get("name"))))
    else:
        warnings.append("图纸上没读到空间名文字，房间名请人工确认")

    _p(0.70, "整理空间")
    rooms.sort(key=lambda r: -r["area"])
    for i, r in enumerate(rooms, 1):
        r["id"] = f"R{i}"
        if not r.get("name") or re.fullmatch(r"房间\d+", r["name"]):
            r["name"] = f"房间{i}"
    rooms_raw = rooms

    # 面积对账：图纸自带的闭合环（外/内墙线）是多边形面积，最可靠；房间是按栅格反推的。
    # 差太多就报出来——踩过：全屋面积系统性偏小 21% 却一路绿灯，报价直接按错的平方数出。
    rings = []
    for rec in walls:
        pts = rec.get("pts") or []
        if rec.get("closed") and len(pts) >= 3:
            rings.append(_poly_area_m2(pts))
    rings.sort(reverse=True)
    if rings:
        ref = rings[1] if len(rings) > 1 and rings[1] >= rings[0] * 0.6 else rings[0]
        tot = sum(r["area"] for r in rooms_raw)
        if ref >= 5 and abs(tot - ref) / ref > 0.12:
            warnings.append(f"面积对账：房间合计 {tot:.1f}㎡，图纸闭合环围合 {ref:.1f}㎡"
                            f"（最大环 {rings[0]:.1f}㎡）——差 {abs(tot - ref) / ref * 100:.0f}%，"
                            f"请核墙线是否读全、有无没圈进来的房间")

    # 灯位
    lamps = []
    for rec in data.get("lamp_shape", []):
        bb = rec["bbox"]
        cx, cy = (bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2
        if not inbox((cx, cy)):
            continue
        x, z = T(cx, cy)
        lamps.append({"x": x, "z": z, "_mm": (cx, cy), "source": rec.get("block") or rec["type"]})
    for rec in data.get("lamp", []):
        if rec["type"] != "CIRCLE":
            continue
        bb = rec["bbox"]                        # CIRCLE 的包框＝center±r，位置取中心
        cx, cy = (bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2
        if not inbox((cx, cy)):
            continue
        x, z = T(cx, cy)
        lamps.append({"x": x, "z": z, "_mm": (cx, cy), "source": "CIRCLE"})
    lamp_source = "layer"
    if not lamps:
        # 灯具图层一个都没命中 → 几何兜底（档 B）。认灯只认图层名是致命伤：设计师把灯具画在
        # 自己起的图层上、或干脆丢 0 层，房间墙家具都在，就是没有灯——没灯＝没报价没场景。
        guessed, hits = guess_lamps(data, inbox)
        if guessed:
            lamps, lamp_source = guessed, "geometry"
            for l in lamps:                     # 兜底出来的是图纸毫米坐标，换成和后面对齐的坐标
                l["x"], l["z"] = T(*l["_mm"])
            by_block = sum(1 for l in lamps if str(l.get("source", "")).startswith("几何推测·块"))
            by_circle = len(lamps) - by_block
            named = "、".join(f"{k or '（无名块）'}×{len(v)}" for k, v in
                              sorted(hits.items(), key=lambda kv: -len(kv[1]))[:3])
            parts = ([f"重复小符号 {named}"] if by_block else []) +                     ([f"小圆 {by_circle} 个"] if by_circle else [])
            warnings.append(
                f"这张图没有可用的灯具图层：当前 {len(lamps)} 个灯位是**按几何推测**出来的"
                f"（{' ＋ '.join(parts)}），请逐个核对；不认可可以整层清掉。"
            )
    # 去掉灯带图层里被当成灯位的杂点
    strips = []
    seen_strip = set()
    for rec in data.get("strip", []):
        pts = [p for p in rec["pts"] if inbox(p)] if all(inbox(p) for p in rec["pts"]) else None
        if not pts:
            continue
        path_m = [T(px, py) for px, py in pts]
        # 同一段灯带在图上画两遍很常见（复制/镜像时重复），按端点去重——
        # 灯带按米进报价，不去重就是长度翻倍。实测 TEST 图 6.27m 那条画了两次。
        k = (tuple(round(v, 2) for v in path_m[0]), tuple(round(v, 2) for v in path_m[-1]))
        if k in seen_strip or (k[1], k[0]) in seen_strip:
            continue
        seen_strip.add(k)
        strips.append({"path": path_m, "length": round(rec["length"], 2), "layer": rec["layer"]})

    # 编号配对（编号文字 → 最近灯位）
    codes = [t for t in data.get("text", []) if LAMP_CODE_RE.match(t["text"]) and inbox((t["x"], t["y"]))]
    used = set()
    for t in codes:
        best, bd = None, 1e9
        for i, lp in enumerate(lamps):
            if i in used:
                continue
            d = math.dist((t["x"], t["y"]), lp["_mm"])
            if d < bd:
                bd, best = d, i
        if best is not None and bd <= PAIR_MAX_M * 1000:
            lamps[best]["code"] = t["text"]
            lamps[best]["code_layer"] = t["layer"]
            used.add(best)
    _p(0.80, "配对灯具编号")
    for lp in lamps:
        lp.pop("_mm", None)

    # 归房间
    for lp in lamps:
        lp["room"] = None
        for r in rooms_raw:
            if _in_room(r, lp["x"], lp["z"]):
                lp["room"] = r["id"]; break
    for st in strips:
        st["room"] = None
        for r in rooms_raw:
            if _in_room(r, st["path"][0][0], st["path"][0][1]):
                st["room"] = r["id"]; break

    # 回路 = 房间·灯型（灯型先按编号/来源归类，产品库接上后细化）
    def ltype(lp):
        return lp.get("code") or "灯具"

    byc = defaultdict(list)
    for lp in lamps:
        cid = f"{(lp['room'] or '未归属')}·{ltype(lp)}"
        byc[cid].append(lp)
        lp["circuit"] = cid
    circuits = [{"id": k, "room": k.split("·")[0], "type": k.split("·")[1], "count": len(v)}
                for k, v in sorted(byc.items())]

    unassigned = [{"x": lp["x"], "z": lp["z"], "room": lp["room"], "reason": "编号对不上"}
                  for lp in lamps if not lp.get("code")]
    if lamps and len(unassigned) == len(lamps):
        warnings.append("全部灯位都没配上编号：这张图可能没有「灯具编号」图层（测试图正常）")
    if strips:
        warnings.append(f"识别到 {len(strips)} 段灯带，请确认是否都是灯带")

    def box_items(recs):
        """把图元包框搬到米制坐标，并把上下边顺序摆正（图纸 y 向上、三维 z 向下）。"""
        out = []
        for r in recs:
            bb = r.get("bbox")
            if not bb:
                continue
            ax, az = T(bb[0], bb[1])
            bx, bz = T(bb[2], bb[3])
            out.append({"bbox": [min(ax, bx), min(az, bz), max(ax, bx), max(az, bz)],
                        "layer": r.get("layer", ""), "block": r.get("block", "")})
        return out

    # 家具：闭合轮廓成件 + 块实例 + 家具层线聚件；要拿墙当参照排掉「房间轮廓冒充家具」
    _p(0.72, "识别家具")
    furn_items = furniture_pieces(data, doc, inbox, T, wall_list)

    _p(0.95, "整理数据")
    W = (x1 - x0) / 1000.0; H = (y1 - y0) / 1000.0
    return {
        "parser_version": PARSER_VERSION,
        "source": {"file": os.path.basename(path), "dxf": doc.dxfversion,
                   "source_unit": "mm", "source_scale": 0.001,
                   "source_base_xy": [x0, y1], "source_y_flip": True,
                   "lamp_layer": "GUANGLV_修改灯位",
                   "layers": sorted({dec(getattr(e.dxf, "layer", "")) for e in doc.modelspace()}),
                   "wall_segments": nseg, "parsed_at": time.strftime("%Y-%m-%d %H:%M:%S"),
                   "elapsed": round(time.time() - t0, 1)},
        "units": "m",
        "bbox": [0.0, 0.0, round(W, 3), round(H, 3)],
        "ceiling": float(opts.get("ceiling", 2.8)),
        "wall_cut": float(opts.get("wall_cut", 1.5)),
        "walls": wall_list,
        "wall_source": wall_note,
        "struct_walls": [seg for rec in walls for seg in _wall_segs(rec, T)],
        "doors": box_items(doors),
        "windows": box_items(wins),
        "furniture": furn_items,
        "rooms": rooms_raw,
        "lamps": lamps,
        "lamp_source": lamp_source,
        "strips": strips,
        "circuits": circuits,
        "unassigned": unassigned,
        "warnings": warnings,
    }


# ---------------------------------------------------------------- 出给三维引擎
SCENE_TMPL = [
    ("全开", {"*": 1.0}, "全屋全开。先看这一档：天花有没有没被灯打亮的暗角、墙面有没有漏光——"
                        "灯位排得合不合理，这一档最容易看出来。"),
    ("会客", {"客": 1.0, "餐": 1.0, "厅": 1.0, "过道": 0.6, "玄关": 0.6, "厨": 0.6},
     "会客档。公共区全亮、卧室不亮：人是坐在客厅和餐厅的，亮的地方跟着人走，"
     "卧室留着暗，聊完送客不用再一间一间关。"),
    ("观影", {"客": 0.15, "厅": 0.15, "餐": 0.15, "过道": 0.2, "灯带": 0.35},
     "观影档。只留灯带和极少量的顶灯做环境光：屏幕不反光，走动也不摸黑。"
     "注意灯带这时候是画面的背景光，不是照明——亮度压在三成左右。"),
    ("夜灯", {"过道": 0.22, "玄关": 0.22, "厅": 0.12, "灯带": 0.3},
     "夜灯档。只留过道的落地光和卧室的床底灯带：起夜不刺眼，也不影响同睡的人。"),
    ("全关", {}, "全关。离家和睡觉用，一键全灭——顺便验收：全关要真的全灭，不能有灯偷跑电。"),
]


def _room_name(rooms_by_id, rid):
    r = rooms_by_id.get(rid)
    return (r or {}).get("name") or (rid or "未归属")


def furniture_of(parsed, kinds=None, rots=None, net=None, sizes=None, hidden=None, extra=None):
    """家具清单（三维用）：只保留成件的家具，按类型给固定高度。

    类型来自解析结果，工作台里改过的类型（kinds，键=家具序号）优先；
    rots（键=家具序号，度）是逐件改过的朝向，有就带出去（渲染时优先于自动贴墙）。
    到顶柜的高度＝项目「吊顶后层高 − 0.05」（net），不是固定值。
    """
    kinds = kinds or {}
    rots = rots or {}
    sizes = sizes or {}
    hidden = {str(x) for x in (hidden or [])}
    out = []
    for i, f in enumerate(parsed.get("furniture", [])):
        a, b, c, d = f["bbox"]
        x0, x1 = min(a, c), max(a, c)
        z0, z1 = min(b, d), max(b, d)
        w, dd = x1 - x0, z1 - z0
        # 上限用来挡「房间轮廓冒充家具」。柜/书架/衣柜这类整墙家具本来就跨几米，
        # 按 4.5m 一刀切会把解析器刚救回来的整墙书柜又丢掉（三维里没有、清单里也没有）。
        # 工作台里手填的宽深（默认跟图纸；填了就以手填的为准）
        sz = sizes.get(str(i)) or {}
        try:
            if float(sz.get("w") or 0) > 0.3:
                w = min(float(sz["w"]), FURN_MAX_SIDE_BIG / 1000.0 * 12)
            if float(sz.get("d") or 0) > 0.3:
                dd = min(float(sz["d"]), FURN_MAX_SIDE_BIG / 1000.0 * 12)
        except (TypeError, ValueError, KeyError):
            pass
        kind0 = str(kinds.get(str(i)) or f.get("kind") or "通用")
        cap = FURN_MAX_SIDE_BIG if kind0 in FURN_BIG_KINDS else 4.5
        if w < 0.3 or dd < 0.3 or w > cap or dd > cap:
            continue
        kind = kind0
        if kind == "衣柜":
            kind = "到顶柜"                  # 老名字也走「到顶」口径
        if kind not in FURN_H:
            kind = "通用"
        h = FURN_H[kind]
        if kind == "到顶柜":
            h = round(max(1.60, float(net or 2.60) - 0.05), 3)
        item = {"i": i, "x": round((x0 + x1) / 2, 3), "z": round((z0 + z1) / 2, 3),
                "w": round(w, 3), "d": round(dd, 3), "h": h, "kind": kind}
        if str(i) in hidden:
            # 工作台里删掉的（认错的门弧/梁/楼梯）：留在清单里打标记，面板才能「恢复」
            item["hidden"] = True
        try:
            if rots.get(str(i)) is not None:
                item["rot"] = int(round(float(rots[str(i)]))) % 360
        except (TypeError, ValueError):
            pass
        out.append(item)
    # 工作台里手动添加的家具（键=自己给的 id）：与图纸识别出来的同一套字段，extra 标记出来。
    for e in (extra or []):
        if not isinstance(e, dict):
            continue
        kind = str(e.get("kind") or "通用")
        if kind not in FURN_H:
            continue
        try:
            x, z = float(e.get("x")), float(e.get("z"))
            w, dd = float(e.get("w") or 0.6), float(e.get("d") or 0.6)
        except (TypeError, ValueError):
            continue
        if not (-500 <= x <= 500 and -500 <= z <= 500 and 0.3 <= w <= 12 and 0.3 <= dd <= 12):
            continue
        h = FURN_H[kind]
        if kind == "到顶柜":
            h = round(max(1.60, float(net or 2.60) - 0.05), 3)
        item = {"id": str(e.get("id") or f"fx{len(out) + 1}"), "x": round(x, 3), "z": round(z, 3),
                "w": round(w, 3), "d": round(dd, 3), "h": h, "kind": kind, "extra": True}
        try:
            item["rot"] = int(round(float(e.get("rot") or 0))) % 360
        except (TypeError, ValueError):
            pass
        out.append(item)
    if len(out) > 90:                        # 太碎就先留占地最大的几十件
        out = sorted(out, key=lambda q: -(q["w"] * q["d"]))[:90]
    return out


def to_engine(parsed, opts=None):
    """解析结果 + 产品库 → 三维引擎的数据结构（用户口径：3000K 暖白、不做 IES）"""
    opts = opts or {}
    rooms_by_id = {r["id"]: r for r in parsed.get("rooms", [])}
    rooms_all_placeholder = bool(parsed.get("rooms")) and all(
        re.fullmatch(r"房间\d+", (r.get("name") or "")) for r in parsed["rooms"])
    products = opts.get("products") or {}
    CEIL = float(opts.get("ceiling") or parsed.get("ceiling") or 2.8)
    NET = float(opts.get("ceiling_net") or CEIL)

    circuits = {}
    lights = []
    for lp in parsed.get("lamps", []):
        code = lp.get("code") or ""
        prod = products.get(code) or {}
        cat = prod.get("category") or ("灯具" if code else "未编号灯具")
        cid = f"{_room_name(rooms_by_id, lp.get('room'))}·{cat}"
        if cid not in circuits:
            circuits[cid] = {"id": cid, "room": _room_name(rooms_by_id, lp.get("room")),
                             "type": cat, "color": 0xffc98a,
                             "watts": prod.get("watt") or 7,
                             "half": round((prod.get("angle") or 40) / 2.0, 1),
                             "code": code, "price": prod.get("price"), "unit": prod.get("unit") or "个"}
        lights.append({"c": cid, "x": lp["x"], "z": lp["z"]})

    strips = []
    for st in parsed.get("strips", []):
        rname = _room_name(rooms_by_id, st.get("room"))
        cid = f"{rname}·灯带"
        if cid not in circuits:
            circuits[cid] = {"id": cid, "room": rname, "type": "灯带", "color": 0xffd6ac,
                             "watts": 10, "half": None, "code": "", "price": None, "unit": "米"}
        # 洗墙方向：朝房间中心
        room = rooms_by_id.get(st.get("room") or "")
        mid = st["path"][len(st["path"]) // 2]
        dx, dz = 0.0, -0.5
        if room:
            dx, dz = (room["cx"] - mid[0]), (room["cz"] - mid[1])
            n = math.hypot(dx, dz) or 1.0
            dx, dz = dx / n * 0.5, dz / n * 0.5
        strips.append({"c": cid, "path": st["path"], "inside": [round(dx, 3), round(dz, 3)]})

    # 场景：按房间名关键字匹配
    on_names = [c["id"] for c in circuits.values()]
    scenes = []
    for sid, lv, base in SCENE_TMPL:
        levels = {}
        for c in circuits.values():
            room, typ = c["room"], c["type"]
            picked = None
            if "*" in lv and isinstance(lv["*"], float) and sid == "全开":
                picked = lv["*"]
            else:
                for kw, v in lv.items():
                    if kw == "*" or kw == "灯带":
                        continue
                    if kw in (room or ""):
                        picked = v; break
                if picked is None and "灯带" in lv and typ == "灯带" and \
                        any(k in (room or "") for k in ("客", "厅", "主", "卧")):
                    picked = lv["灯带"]
            if picked:
                levels[c["id"]] = picked
        lit = [k for k in levels if levels[k] > 0.02]
        # 房间名还没确认时（全是「房间N」），关键字一个都匹配不上 → 会客/观影会一片黑。
        # 拿最大房间当公共区占位，并把这件事写进讲解词，别让用户以为坏了。
        if not lit and sid != "全关" and rooms_all_placeholder:
            main = parsed["rooms"][0]
            base_v = max([v for k, v in lv.items() if k not in ("灯带", "*")] or [0.6])
            for c in circuits.values():
                if c["room"] == main["name"]:
                    levels[c["id"]] = round(base_v, 2)
                elif c["type"] == "灯带" and "灯带" in lv:
                    levels[c["id"]] = round(lv["灯带"], 2)
                else:
                    levels[c["id"]] = round(base_v * 0.3, 2)
            lit = [k for k in levels if levels[k] > 0.02]
            base = base + "（房间名还没确认，这一档先按最大房间「%s」推的占位）" % main["name"]
        tail = ("点亮：" + "、".join(lit[:8]) + ("等" if len(lit) > 8 else "")) if lit else "全灭"
        scenes.append({"id": sid, "levels": levels, "script": base + "（" + tail + "）"})
    if opts.get("scripts"):
        for s in scenes:
            if opts["scripts"].get(s["id"]):
                s["script"] = opts["scripts"][s["id"]]

    furn = furniture_of(parsed, opts.get("furn_kinds"), opts.get("furn_rots"), NET,
                        opts.get("furn_sizes"), opts.get("furn_hidden"), opts.get("furn_extra"))
    furn = [f for f in furn if not f.get("hidden")]   # 三维里不画删掉的

    return {
        "name": opts.get("name") or parsed.get("source", {}).get("file", "三维灯光"),
        "area": opts.get("area") or round(sum(r["area"] for r in parsed.get("rooms", [])), 1),
        "ceiling": CEIL, "ceiling_net": NET, "wall_cut": parsed.get("wall_cut", 1.5),
        "bbox": parsed.get("bbox"),
        "rooms": [{"id": r["id"], "name": r["name"], "area": r["area"], "bbox": r["bbox"],
                   "cx": r["cx"], "cz": r["cz"], "poly": r.get("poly") or [], "rects": r.get("rects") or []}
                  for r in parsed.get("rooms", [])],
        "walls": parsed.get("walls", []),
        "furniture": furn,
        "circuits": list(circuits.values()),
        "lights": lights,
        "strips": strips,
        "sensors": [],
        "scenes": scenes,
    }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit("用法: python backend/dxf_lighting.py <图纸.dxf> [输出.json]")
    src = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else os.path.splitext(src)[0] + ".lighting3d.json"
    d = parse(src)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, indent=1)
    print("OK ->", out, round(os.path.getsize(out) / 1024), "KB", "耗时", d["source"]["elapsed"], "s")
    print("主体", d["bbox"], "| 墙段", len(d["walls"]), "| 房间", len(d["rooms"]),
          "| 灯位", len(d["lamps"]), "| 灯带", len(d["strips"]), "| 回路", len(d["circuits"]))
    print("房间:", [(r["id"], r["area"], r["bbox"]) for r in d["rooms"]])
    print("警告:", d["warnings"])
