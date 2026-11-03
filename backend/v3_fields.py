"""§7 数据字典 v0 的代码正本（终极形态 v3 定稿 2026-10-21）。

字段名、三档、取值域、事故文案、封板前/后分组只在这里定义一次：
缺件单（§7.8）、指名率（§7.2）、导出红标（§12.0）全部读这张表，
不在别处重复字段清单——§7.8 硬规矩 1 说 field_path 是唯一回填口，
那字段本身的定义也只能有一份。

闸门尺度如实标注：断路器/线径的换算系数（§7.4 两处【需核验】）本机没有
型号手册与查表依据，故这类项永远是 unknown＋【需核验】，不得称「通过」。
"""
from __future__ import annotations

import math
import re

REQUIRED, RECOMMENDED, DERIVED = "required", "recommended", "derived"
TIERS = (REQUIRED, RECOMMENDED, DERIVED)
TIER_LABELS = {REQUIRED: "缺即阻断", RECOMMENDED: "缺进缺件单", DERIVED: "只算不写"}

PRE, POST = "pre", "post"
STAGE_LABELS = {PRE: "封板前", POST: "封板后"}

BLOCK, HINT = "阻断", "提示"

ORIGINS = ("auto", "manual", "supplier")
STATUSES = ("draft", "named", "verified", "blocked")

ASK_WHOM = ("供应商", "电工", "柜厂", "产品资料", "设计师")
ASK_WHERE = ("手册", "报价单", "图纸页", "现场", "产品库")

PLACEHOLDERS = {"", "-", "—", "?", "？", "无", "待定", "待补", "待确认", "未知",
                "tbd", "todo", "n/a", "na", "null", "none", "xxx", "……", "..."}

# ---------------------------------------------------------------- 字段表


def _f(key, label, tier, domain, accident="", stage=PRE, ask="", where="",
       severity=BLOCK, group=""):
    return {"key": key, "label": label, "tier": tier, "domain": domain,
            "accident": accident, "stage": stage, "ask_whom": ask,
            "ask_where": where, "severity": severity, "group": group}


BASE_FIELDS = [
    _f("id", "对象 ID", REQUIRED, "ULID，项目内唯一不可改", "无 ID 的对象回不到真源，投影不可逆", ask="设计师"),
    _f("object_type", "对象类型", REQUIRED, "circuit/cabinet_cell/plate/power_entry/fixture/placement",
       "类型错位，闸门按错的表检查", ask="设计师"),
    _f("ref_name", "名称/编号（与 id_no 二取一）", REQUIRED, "非占位词，同类型不重名",
       "现场只说「那个灯」，变更无法指到人", ask="设计师"),
    _f("id_no", "自动编号（与 ref_name 二取一）", REQUIRED, "编号规则内唯一",
       "同上：无编号即无法指名", ask="设计师"),
    _f("origin", "来源", REQUIRED, "auto / manual / supplier（supplier 仅回传可写）",
       "分不清自动长出还是人工编的，审计无法追责", ask="设计师"),
    _f("status", "状态", REQUIRED, "draft / named / verified / blocked（有缺件则不得 verified）",
       "带缺件的对象被当成已核实", ask="设计师"),
    _f("src_trace", "源图元回溯", REQUIRED, "图层名＋图元 handle",
       "改图时找不到原图元，回写锚丢失", ask="设计师"),
]

# 回路 D1（§7.4，9 格；breaker 按一位字段处理，内含位数＋额定）
CIRCUIT_FIELDS = [
    _f("circuit_no", "回路号", REQUIRED, "房号-序号，如 A-01，项目内唯一",
       "回路号乱：现场分不清哪路线管，跳闸时无法定位", ask="电工"),
    _f("fixture_ids", "所辖灯位", REQUIRED, "灯位 id 列表，非空；每灯只挂 1 回路",
       "一灯挂两回路＝两处线；孤儿灯现场不知道接哪", ask="电工"),
    _f("power_total_w", "回路功率合计", DERIVED, "Σ 额定功率×数量，≥0", "", ask="电工"),
    _f("control_mode", "控制方式", REQUIRED, "开关 / 调光 / 场景 / 感应，须在执行器通道能力内",
       "控制方式超出通道能力，现场调不了光", ask="供应商", where="手册"),
    _f("breaker", "断路器（位数＋额定）", REQUIRED, "如 1P-10A；额定≥回路电流×系数【系数需核验】",
       "额定偏小频跳闸，偏大失去保护", ask="电工", severity=HINT),
    _f("panel_id", "所属配电箱", REQUIRED, "必须存在于取电进户台账",
       "配电箱对不上，D8-1 容量算错→增容换线", ask="电工"),
    _f("wire_gauge", "线径", REQUIRED, "1.5 / 2.5 / 4 mm²，≥载流量查表值【需核验】",
       "线径偏小发热压降；地线漏标验收不过", ask="电工", severity=HINT),
    _f("actuator_channel", "执行器通道", REQUIRED, "设备号＋通道号，同一通道不得两回路占用（T1，回路:通道＝1:1）",
       "两回路抢一通道，场景跑不起来只能重做", stage=POST, ask="供应商", where="手册"),
    _f("gateway_model", "网关机型", REQUIRED, "机型＋通道/负载上限【上限表需核验】（T2：已用≤上限＝硬闸）",
       "超网关地址数上限，末端设备配不上", stage=POST, ask="供应商", where="手册"),
]

# 柜体柜格（§7.4；plate_ref 已被 v3 删除，板面归属只由挂载表「宿主板面号」表达）
CABINET_FIELDS = [
    _f("cabinet_no", "柜体号", REQUIRED, "空间码-C<序号>，如 B2-C03，项目内唯一",
       "柜体没有身份，柜厂接图时对不上现场", ask="柜厂"),
    _f("room_id", "所在空间", REQUIRED, "有效空间 id", "柜体飘在空间外，坐标换算无从做起", ask="设计师"),
    _f("insert", "柜体插入点＋旋转角", REQUIRED, "T_cab＝(x,y,z)＋旋转角 mm/度",
       "柜子挪位后孔位跟着变——局部坐标必须是刚体坐标", ask="柜厂"),
]

CABINET_CELL_FIELDS = [
    _f("cell_id", "柜格号", REQUIRED, "柜体号-G<列>-<层>，如 B2-C03-G2-3，柜体内唯一",
       "柜格无身份，灯槽与取电点说不清在哪一格", ask="柜厂"),
    _f("cell_size", "柜格尺寸", REQUIRED, "(w,h,d) mm，>0 且与柜外形不矛盾",
       "格尺寸错→灯带长度与净空全错", ask="柜厂"),
    _f("plate_thickness", "板厚", REQUIRED, "5–25 mm，决定开孔可行性",
       "板厚不知→孔径超板宽，开孔崩边", ask="柜厂"),
    _f("cabinet_vendor", "柜体供应商", RECOMMENDED, "有值才可发协同包",
       "无供应商＝协同包发不出去，深化只能靠电话", stage=POST, severity=HINT, ask="供应商"),
]

# 板面（§9.1 第三级，柜格的子对象）
PLATE_FIELDS = [
    _f("plate_code", "板代号", REQUIRED, "L 左立板 / R 右立板 / B 底板 / T 顶板 / K 背板 / D 门板，柜格内唯一",
       "板代号错→柜厂开错板", ask="柜厂"),
    _f("plate_size", "板面标称尺寸", REQUIRED, "(W,H) mm，>0；权威值待柜厂回传后重判",
       "标称当实测，挂载 (u,v) 越界", ask="柜厂"),
]

# 取电进户 D8（§7.7 施工席版本，5 格）
POWER_ENTRY_FIELDS = [
    _f("d8_1", "进户电源", REQUIRED, "单相 220V／三相 380V＋容量 kW 或 A＋进线位置（房间＋坐标）",
       "容量估小→增容换线；三相不平衡；总包不给接", ask="电工"),
    _f("d8_2", "配电箱", REQUIRED, "位置（房间＋坐标）＋箱体尺寸＋总位数（含备用）",
       "位数不够→加回路只能外挂明箱；箱买大了装不进", ask="电工"),
    _f("d8_3", "主进线与敷设", REQUIRED, "相／零／地线径＋敷设方式（穿管/桥架/直埋）＋管径",
       "线径小→发热压降；地线漏标→验收不过、整改", ask="电工"),
    _f("d8_4", "柜内取电点", RECOMMENDED, "柜体柜格对象引用（必须指名）＋柜内位置（格／高度）＋用途＋是否预留",
       "柜厂开背板没留孔/插座→装完再开孔破坏板材；柜内灯带无电源", severity=HINT, ask="柜厂"),
    _f("d8_5", "柜内取电回路与容量", RECOMMENDED, "回路号＋分配功率＋线径／接口（插座/端子/插头）",
       "柜内灯带与插座同回路超载；柜体与回路对不上", stage=POST, severity=HINT, ask="电工"),
]

# 灯位（§7.5：D9 两格＋D10 三格＋D11 一格）与驱动（§7.6 D4 三格）
FIXTURE_FIELDS = [
    _f("x/y", "定位", REQUIRED, "图内坐标，落在有效空间；无坐标＝没法预埋",
       "无坐标＝没法预埋", ask="设计师", group="pos"),
    _f("installHeight", "安装高度 mount_h", REQUIRED, "z 向 mm（吊顶完成面基准）",
       "高度错→光斑直径与照度全偏", ask="设计师", group="pos"),
    _f("type", "灯具类型 fixture_type", REQUIRED, "筒射灯/线性/洗墙…，与需求表不矛盾",
       "类型与需求表矛盾，采购错货", ask="设计师", group="pos"),
    _f("circuitId", "所属回路 circuit_id", REQUIRED, "回路 id；未挂＝孤儿灯，阻断",
       "孤儿灯：现场不知道接哪路线管", ask="电工", group="pos"),
    _f("d9_1", "暗盒规格 D9-1", REQUIRED, "86 单联×50 深／86 单联×60 深（加深）／86 双联／100×100／无盒直埋／项目自定义；含明装/暗装",
       "加深型漏标→线塞不进、面板翘；直埋标成有盒→多埋盒、灯位让位", ask="电工"),
    _f("d9_2", "暗盒定位 D9-2", REQUIRED, "X／Y 双基准距墙（取整 5mm）＋Z 安装高度；嵌顶可填「随顶」",
       "按经验放盒→灯位偏 20–50mm，洗墙光斑切线歪，只能砸板", ask="电工"),
    _f("d10_1", "开孔孔径 D10-1", REQUIRED, "φ55/φ65/φ75/φ85/φ100…；明装、轨道填「不开孔」",
       "小于灯体外径→装不进、现场扩孔崩边；大于→遮不住缝、漏光", stage=POST, ask="产品资料", where="手册"),
    _f("d10_2", "对应 SKU D10-2", REQUIRED, "产品库型号（品牌＋型号＋功率＋色温＋光束角），不允许自由文本",
       "电工只拿到「数量＋型号」；换型即开孔全废、采购错货", ask="产品资料", where="产品库"),
    _f("d10_3", "净空 D10-3", REQUIRED, "自吊顶完成面向内，灯具＋驱动＋散热所需最小后方净空 mm",
       "净空不足→驱动塞不进／散热差光衰／顶到楼板，只能降吊顶或换灯", ask="产品资料", where="手册"),
    _f("d11", "避让状态 D11", RECOMMENDED,
       "无需避让／已避让（引用对象＋净距 mm）／冲突未解／待现场确认；默认「冲突未解」",
       "默认「无需」→灯压梁／风口／喷淋，封板后拆改；「已避让」不引用对象＝无避让依据",
       severity=HINT, ask="设计师"),
    _f("d4_1", "驱动型号与参数 D4-1", REQUIRED,
       "品牌型号＋恒流/恒压＋输入/输出（W／V／mA）＋调光协议（0-10V／DALI／可控硅／无线）",
       "恒流恒压混用、功率不匹配→闪灯烧灯；协议不符→调不了光", ask="产品资料", where="手册"),
    _f("d4_2", "驱动安装位置 D4-2", REQUIRED,
       "灯具本体／吊顶内／暗盒内／配电箱内／柜内＋定位＋是否留检修口；柜内驱动不挂板面，只挂柜体",
       "吊顶内无检修口→驱动坏了拆顶；暗盒内超容→盖不上", ask="电工"),
    _f("d4_3", "驱动带灯数与回路归属 D4-3", REQUIRED, "台/盏＋对应回路号＋所带灯位编号列表",
       "一拖多超载；换驱动找不到对应灯；回路功率算错跳闸", ask="电工"),
]

MOUNT_FIELDS = [
    _f("id", "附件号", REQUIRED, "全局唯一，空间层可查", "挂载无身份，回传确认无法一一对应", ask="柜厂"),
    _f("kind", "类型", REQUIRED, "灯具／开孔／取电／线槽", "类型错→柜厂按错的板加工", ask="柜厂"),
    _f("plate_id", "宿主板面号", REQUIRED, "三级编号；柜内灯不允许无宿主板面",
       "灯挂在空间上而不是板上——柜厂接不了图", ask="柜厂"),
    _f("u", "板面局部坐标 u", REQUIRED, "原点在正对板面的左下角，向右；0≤u≤板宽（越界不禁止但校验必红）",
       "越界＝板外挂载，开料作废", ask="柜厂"),
    _f("v", "板面局部坐标 v", REQUIRED, "向上；0≤v≤板高", "同上", ask="柜厂"),
    _f("cutout_id", "关联开孔号", RECOMMENDED, "嵌入式灯必填，裸装可空", severity=HINT, ask="柜厂"),
    _f("sku", "SKU／孔径Φ／净空", REQUIRED, "D10 三格随挂载带过来（§7.5），不允许与灯位上的值两份",
       "挂载与灯位各存一份 D10，改一处另一处不变→柜厂按旧值开孔", ask="柜厂"),
    _f("exit_dir", "出线方向", REQUIRED, "板面内 0/90/180/270，须指向最近出线孔",
       "出线方向乱→现场加线槽、明线", ask="柜厂"),
    _f("circuit_id", "来源回路号", REQUIRED, "反查 D1；灯具/取电必填",
       "柜内取电无回路号→与回路对不上", ask="电工"),
]

PLACEMENT_FIELDS = [
    _f("sku", "选品 SKU", REQUIRED, "产品库 id，须 hard_gate_pass",
       "参数不符的 SKU 落位（§5.2 L0 硬闸）", ask="产品资料", where="产品库"),
    _f("price_scope", "价格口径", REQUIRED, "常量「零售价」，非零售价直接拒",
       "存进成本口径＝泄露进货成本（§5.2 拍板：结构上不存在成本字段）", severity=BLOCK, ask="供应商", where="报价单"),
]

FIELD_TABLES = {
    "base": BASE_FIELDS,
    "circuit": CIRCUIT_FIELDS,
    "cabinet": CABINET_FIELDS,
    "cabinet_cell": CABINET_CELL_FIELDS,
    "plate": PLATE_FIELDS,
    "power_entry": POWER_ENTRY_FIELDS,
    "fixture": FIXTURE_FIELDS,
    "mount": MOUNT_FIELDS,
    "placement": PLACEMENT_FIELDS,
}

# §9.1 板代号与外法线（柜体轴：X 宽 左→右、Y 深 背→前、Z 高 下→上）
PLATE_CODES = {"L": "左立板", "R": "右立板", "B": "底板", "T": "顶板", "K": "背板", "D": "门板"}
PLATE_NORMALS = {
    "L": (1, 0, 0), "R": (-1, 0, 0), "B": (0, 0, 1),
    "T": (0, 0, -1), "K": (0, 1, 0), "D": (0, -1, 0),
}

D11_STATES = ("无需避让", "已避让", "冲突未解", "待现场确认")
D11_DEFAULT = "冲突未解"
D9_BOX_KINDS = ("86 单联×50 深", "86 单联×60 深", "86 双联", "100×100", "无盒直埋", "项目自定义")
WIRE_GAUGES = (1.5, 2.5, 4.0)
CONTROL_MODES = ("开关", "调光", "场景", "感应")

NEED_VERIFY_MARK = "【需核验】"
NEED_VERIFY_FIELDS = ("breaker", "wire_gauge", "gateway_model", "actuator_channel")

# 编号式（§9.1 三级）
CABINET_NO_RE = re.compile(r"^[A-Za-z0-9\u4e00-\u9fff]+-C\d{2,}$")
CELL_NO_RE = re.compile(r"^.+-G\d+-\d+$")
PLATE_NO_RE = re.compile(r"^.+-[LRBTKD]$")


def fields_of(table: str, tier: str | None = None) -> list[dict]:
    rows = FIELD_TABLES.get(table) or []
    return [x for x in rows if tier is None or x["tier"] == tier]


def field_of(table: str, key: str) -> dict | None:
    return next((x for x in FIELD_TABLES.get(table) or [] if x["key"] == key), None)


def is_named(value) -> bool:
    """有值＝非空且非占位词（§7.2 分子的判据）。数字 0 算有值——板面 u/v 可为 0。"""
    if value is None:
        return False
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return math.isfinite(value)
    if isinstance(value, (list, tuple, set)):
        return any(is_named(x) for x in value)
    if isinstance(value, dict):
        return any(is_named(x) for x in value.values())
    s = str(value).strip()
    return bool(s) and s.lower() not in PLACEHOLDERS


def has_number(obj: dict) -> bool:
    """自动编号覆盖即算指名（v3 删掉「id 唯一」这条：ULID 恒唯一会让分子≡分母）。"""
    for key in ("ref_name", "id_no", "code", "circuit_no", "cabinet_no", "cell_id",
                "plate_code", "entry_no", "mount_no"):
        if is_named(obj.get(key)):
            return True
    return False


def missing_in(obj: dict, table: str) -> list[dict]:
    """该对象缺的 required/recommended 格（derived 只算不写，永不可缺）。"""
    out = []
    for spec in fields_of(table):
        if spec["tier"] == DERIVED:
            continue
        vals = [obj.get(k) for k in spec["key"].split("/")] if "/" in spec["key"] else [obj.get(spec["key"])]
        if any(is_named(v) for v in vals):
            continue
        out.append(spec)
    return out


def severity_of(spec: dict) -> str:
    """required 缺＝阻断；recommended 缺＝提示（§7.8 severity 由系统给）。"""
    if spec["tier"] == REQUIRED:
        return BLOCK
    return spec.get("severity") or HINT


def path(kind: str, obj_id: str, field_key: str) -> str:
    """field_path：唯一回填口，形如 fixture.<id>.d10_1。id 与字段名都不含点。"""
    return f"{kind}.{obj_id}.{field_key}"


def parse_path(field_path: str) -> tuple[str, str, str]:
    """拆 field_path → (表, 对象 id, 字段)。A5 要求路径可解析，解析不了即拒。"""
    parts = str(field_path or "").split(".")
    if len(parts) != 3 or not all(parts):
        raise ValueError(f"field_path 无法解析：{field_path}")
    table, obj_id, field = parts
    if table not in FIELD_TABLES:
        raise ValueError(f"field_path 表名未知：{table}")
    if not field_of(table, field):
        raise ValueError(f"field_path 字段不在字典里：{table}.{field}")
    return table, obj_id, field


def plate_normal(code: str) -> tuple[int, int, int]:
    return PLATE_NORMALS.get(str(code or "")[-1:], (0, 0, 0))


# 板面 (u,v) 在柜体轴上的取向：原点＝正对板面看的左下角，u 向右、v 向上。
# 柜体轴 X 宽（左→右）、Y 深（背→前）、Z 高（下→上）。
PLATE_FRAME = {
    "L": ((0, 0, 0), (0, 1, 0), (0, 0, 1)),
    "R": ((1, 0, 0), (0, 1, 0), (0, 0, 1)),
    "B": ((0, 0, 0), (1, 0, 0), (0, 1, 0)),
    "T": ((0, 0, 1), (1, 0, 0), (0, 1, 0)),
    "K": ((0, 0, 0), (1, 0, 0), (0, 0, 1)),
    "D": ((0, 1, 0), (1, 0, 0), (0, 0, 1)),
}


def plate_to_world(cabinet: dict, plate_code: str, u: float, v: float) -> list[float]:
    """§9.1 唯一变换 P = T_cab(O_cab + R_board·(u,v,0))。

    R_board 把板面局部 (u,v) 摆到柜体轴，再按柜体旋转角（绕 Z）转到世界轴后平移。
    柜体平移/旋转时 (u,v) 不变、世界坐标重算——柜子挪位，柜厂孔位不许跟着变。
    """
    code = str(plate_code or "")[-1:]
    frame = PLATE_FRAME.get(code)
    if not frame:
        return []
    size = (_num(cabinet.get("width_mm")), _num(cabinet.get("depth_mm")), _num(cabinet.get("height_mm")))
    local = [0.0, 0.0, 0.0]
    for i in range(3):
        local[i] = (frame[0][i] * size[i]) + u * frame[1][i] + v * frame[2][i]
    theta = math.radians(_num(cabinet.get("rotation")))
    cos_t, sin_t = math.cos(theta), math.sin(theta)
    ins = cabinet.get("insert") or {}
    return [local[0] * cos_t - local[1] * sin_t + _num(ins.get("x")),
            local[0] * sin_t + local[1] * cos_t + _num(ins.get("y")),
            local[2] + _num(ins.get("z"))]


def world_to_plate(cabinet: dict, plate_code: str, point) -> tuple[float, float]:
    """改世界坐标 → 反算 (u,v)（§9.1 不变式 2）。旋转角与板代号不合法时返回空。"""
    code = str(plate_code or "")[-1:]
    frame = PLATE_FRAME.get(code)
    if not frame or not point or len(point) < 3:
        return None, None
    size = (_num(cabinet.get("width_mm")), _num(cabinet.get("depth_mm")), _num(cabinet.get("height_mm")))
    ins = cabinet.get("insert") or {}
    theta = math.radians(_num(cabinet.get("rotation")))
    cos_t, sin_t = math.cos(theta), math.sin(theta)
    lx = (float(point[0]) - _num(ins.get("x"))) * cos_t + (float(point[1]) - _num(ins.get("y"))) * sin_t
    ly = -(float(point[0]) - _num(ins.get("x"))) * sin_t + (float(point[1]) - _num(ins.get("y"))) * cos_t
    lz = float(point[2]) - _num(ins.get("z"))
    local = (lx - frame[0][0] * size[0], ly - frame[0][1] * size[1], lz - frame[0][2] * size[2])
    u = sum(local[i] * frame[1][i] for i in range(3))
    v = sum(local[i] * frame[2][i] for i in range(3))
    return u, v


def plate_out_of_range(plate: dict, u: float, v: float) -> bool:
    """板外挂载：越界不禁止但校验必红（§9.1）。板面尺寸权威在柜厂，标称值只是初值。"""
    w, h = _num(plate.get("width_mm")), _num(plate.get("height_mm"))
    uu, vv = _num(u, None), _num(v, None)
    if uu is None or vv is None or w <= 0 or h <= 0:
        return False
    return uu < -1e-6 or uu > w + 1e-6 or vv < -1e-6 or vv > h + 1e-6


def _num(v, default: float | None = 0.0) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    return f if math.isfinite(f) else default
