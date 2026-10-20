"""Input-dependent, offline 2D floor-plan boundary extraction.

This is classical image processing, NOT a semantic vision model. Open-plan areas
stay connected; measured pixels never become invented square metres or names.
"""

from pathlib import Path
from PIL import Image, ImageOps
from io import BytesIO
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError
import os, json, base64, re, shutil, subprocess, tempfile
import uuid
import numpy as np

CANVAS = (25.0, 25.0, 750.0, 610.0)


SEMANTIC_STYLE = {
    "客厅": "#d8eadf",
    "餐厅": "#f2dfbd",
    "厨房": "#d5e8f1",
    "主卧": "#ead9e8",
    "次卧": "#e4e9bf",
    "书房": "#e5d8cb",
    "卫生间": "#cfe7ed",
    "主卫": "#c4e0e8",
    "阳台": "#dce9cc",
    "门厅": "#ede2d0",
    "其他空间": "#e6e8df",
    "儿童房": "#ebe0ea",
    "衣帽间": "#ebe0ea",
    "走廊": "#eaeae3",
    "楼梯间": "#eaeae3",
    "设备间": "#e8ded1",
    "庭院": "#dce9cc",
    "车库": "#e7e1d3",
    "影音室": "#dde4f2",
    "玄关柜/衣帽区": "#ede2d0",
    "前廊/门廊": "#ede2d0",
    "家庭厅": "#dfeadd",
    "起居厅/小客厅": "#dfeadd",
    "茶室/会客茶间": "#dfeadd",
    "琴房": "#dfeadd",
    "早餐区/便餐厅": "#f4e0be",
    "西厨/岛台区": "#f4e0be",
    "吧台/酒水区": "#f4e0be",
    "备餐间/传菜间": "#f4e0be",
    "酒窖/恒温酒柜间": "#f4e0be",
    "雪茄房": "#f4e0be",
    "食品储藏间/冷库": "#f4e0be",
    "老人房": "#ebe0ea",
    "客卧": "#ebe0ea",
    "保姆房": "#ebe0ea",
    "梳妆区": "#ebe0ea",
    "婴儿房": "#ebe0ea",
    "次卫": "#d2e8ee",
    "干湿分离卫浴": "#d2e8ee",
    "独立马桶间": "#d2e8ee",
    "桑拿房": "#d2e8ee",
    "SPA/泡池区": "#d2e8ee",
    "独立工作室": "#e8ded1",
    "儿童学习区": "#e8ded1",
    "家政间": "#e8ded1",
    "洗衣房": "#e8ded1",
    "收纳间": "#e8ded1",
    "工具间": "#e8ded1",
    "健身房": "#dde4f2",
    "瑜伽房": "#dde4f2",
    "台球室": "#dde4f2",
    "游戏室": "#dde4f2",
    "室内泳池": "#dde4f2",
    "收藏陈列室": "#dde4f2",
    "音乐室": "#dde4f2",
    "家用电梯": "#eaeae3",
    "地下连廊": "#eaeae3",
    "楼梯平台": "#eaeae3",
    "前院/车道": "#dce9cc",
    "后院/草坪": "#dce9cc",
    "屋顶花园": "#dce9cc",
    "檐廊/雨棚区": "#dce9cc",
    "烧烤区": "#dce9cc",
    "阳光房": "#dce9cc",
    "景观花园": "#dce9cc",
    "水景": "#dce9cc",
    "户外泳池": "#dce9cc",
    "车棚": "#e7e1d3",
    "自行车房": "#e7e1d3",
    "地下储物间": "#e7e1d3",
    "独立库房": "#e7e1d3",
    "员工区": "#e5e1ec",
    "门卫房": "#e5e1ec",
    "快递间": "#e5e1ec",
    "垃圾间": "#e5e1ec",
    "宠物房": "#f0e4d6",
    "宠物洗澡间": "#f0e4d6",
    "宠物活动室": "#f0e4d6",
    "佛堂": "#e1e5ed",
    "祈祷室": "#e1e5ed",
    "冥想室": "#e1e5ed",
    "收藏品储藏间": "#e6e8df",
    "保险库": "#e6e8df",
}


def add_local_semantic_suggestions(rooms: list[dict]) -> None:
    """Give a usable colour-plan naming draft from geometry only.

    This deliberately exposes low confidence: it is a fallback when no semantic
    vision/OCR service has been configured, not a claim that furniture was understood.
    """
    if not rooms:
        return
    ordered = sorted(rooms, key=lambda r: r.get("pixelArea", r.get("width", 0) * r.get("height", 0)), reverse=True)
    areas = [max(1, r.get("pixelArea", r.get("width", 0) * r.get("height", 0))) for r in ordered]
    largest = areas[0]
    labels: list[str] = []
    for i, room in enumerate(ordered):
        area = areas[i]
        ratio = room.get("width", 1) / max(room.get("height", 1), 1)
        if i == 0:
            label = "客厅"
        elif area < largest * 0.16:
            label = "卫生间" if "卫生间" not in labels else "门厅"
        elif i == 1:
            label = "主卧"
        elif i == 2:
            label = "餐厅"
        elif i == 3:
            label = "厨房"
        elif ratio > 3.2 or ratio < 0.30:
            label = "阳台"
        elif "次卧" not in labels:
            label = "次卧"
        elif "书房" not in labels:
            label = "书房"
        else:
            label = "其他空间"
        labels.append(label)
        number = sum(1 for v in labels if v == label)
        room["type"] = label
        room["name"] = label if number == 1 else f"{label} {number}"
        room["color"] = SEMANTIC_STYLE[label]
        room["semanticSource"] = "local-geometry-suggestion"
        room["semanticConfidence"] = "low"
        room["semanticNote"] = "根据空间轮廓、面积和相对位置自动推测；未识别家具或文字，请在彩平图中确认或修改。"


def semantic_plan_configured() -> bool:
    """Whether a real semantic-vision route is enabled.

    ``hermes-deepseek`` deliberately uses the managed Hermes profile rather than
    putting a provider key into this application's environment.
    """
    provider = os.getenv("PLAN_VISION_PROVIDER", "disabled").strip().lower()
    if provider == "hermes-deepseek":
        executable = os.getenv(
            "HERMES_CLI_PATH",
            "hermes",
        )
        return Path(executable).is_file() or shutil.which(executable) is not None
    return bool(os.getenv("PLAN_VISION_URL", "").strip()) and provider != "disabled"


def colour_plan_signature(image: Image.Image) -> tuple[float, float]:
    """Return ``(coloured_pixel_ratio, light_background_ratio)`` for a raster page.

    Near-binary line drawings stay close to zero on the colour axis even when they
    carry a few coloured dimension markers, while a rendered colour plan (彩平图)
    or a photo-like sheet spends a substantial share of pixels on channel spread.
    Both ratios are measured on a bounded probe so large sheets stay cheap.
    """
    probe = image.copy()
    probe.thumbnail((1400, 1400), Image.Resampling.LANCZOS)
    arr = np.asarray(probe).astype(np.int16)
    spread = arr.max(axis=2) - arr.min(axis=2)
    luminance = 0.299 * arr[:, :, 0] + 0.587 * arr[:, :, 1] + 0.114 * arr[:, :, 2]
    return float((spread > 12).mean()), float((luminance > 205).mean())


def is_rendered_colour_plan(image: Image.Image) -> bool:
    """Whether a raster page is a rendered colour plan rather than a line drawing."""
    coloured, light = colour_plan_signature(image)
    # Colour plans keep a light drawing background; ordinary photographs score high
    # on colour but not on a light background, so they stay on the honest-failure
    # path instead of being guessed at.
    return coloured >= 0.02 and light >= 0.55


def should_use_semantic_vision(path: Path, metadata: dict) -> bool:
    """Route drawings the deterministic geometry path cannot interpret to vision.

    The classical boundary extractor only understands near-binary line drawings.
    Rendered colour plans (彩平图) — what a designer normally drops in for a quick
    space take-off — need real visual semantics for room names and boundaries.
    Compact synthetic sketches stay on the deterministic path so no visual
    inference is spent on fixtures. Vector drawings keep their measurable
    geometry, but a rendered colour page inside a PDF/SVG has no usable vector
    geometry, so that page is routed to vision as well.
    """
    if not semantic_plan_configured():
        return False
    image = raster_image(path, metadata)
    width, height = image.size
    if min(width, height) < 160:
        return False
    if metadata.get("type") in {"PDF", "SVG"}:
        return is_rendered_colour_plan(image)
    return width * height >= 1_000_000 or is_rendered_colour_plan(image)


def semantic_plan_from_external(path: Path, metadata: dict) -> dict:
    """Use a configured vision service to return actual room semantics and polygons.

    Contract: POST JSON including imageBase64 plus the prompt. Response is JSON with
    `rooms`, each `{name,type,points:[{x,y},...]}` where x/y are either normalized
    0..1000 image coordinates or source-image pixel coordinates. No heuristic room
    naming is used here.
    """
    provider = os.getenv("PLAN_VISION_PROVIDER", "disabled").strip().lower()
    if provider == "hermes-deepseek":
        value = semantic_plan_from_managed_deepseek(path, metadata)
        return _semantic_response_to_result(value, metadata, path)

    image = raster_image(path, metadata)
    w, h = image.size
    raw = BytesIO(); image.save(raw, format="PNG")
    prompt = (
        "You are reading an architectural floor-plan drawing. Return JSON only: "
        "{rooms:[{name,type,points:[{x:number,y:number}]}],notes:string}. "
        "Identify actual enclosed functional spaces from walls, doors, fixtures and labels. "
        "Do not return furniture, dimensions, title blocks, isolated symbols, or fragments. "
        "Use one outer boundary polygon per room, 3-16 vertices; coordinates must be normalized 0..1000. "
        "Use Chinese types such as 客厅、餐厅、厨房、主卧、次卧、书房、卫生间、阳台、门厅、走廊、其他空间. "
        "If uncertain, omit the room instead of inventing it."
    )
    body = {"imageBase64": base64.b64encode(raw.getvalue()).decode("ascii"), "mimeType": "image/png", "prompt": prompt, "responseFormat": "floor-plan-semantic-v1", "sourceImage": {"width": w, "height": h}}
    headers = {"Content-Type": "application/json"}
    if os.getenv("PLAN_VISION_TOKEN"):
        headers["Authorization"] = "Bearer " + os.getenv("PLAN_VISION_TOKEN", "")
    try:
        req = Request(os.getenv("PLAN_VISION_URL", ""), data=json.dumps(body, ensure_ascii=False).encode("utf-8"), headers=headers, method="POST")
        with urlopen(req, timeout=100) as response:
            value = json.loads(response.read().decode("utf-8"))
    except (HTTPError, URLError, TimeoutError, OSError, ValueError) as e:
        raise ValueError("语义户型接口未完成：" + str(e)[:220])
    return _semantic_response_to_result(value, metadata, path)


def _extract_json_object(value: str, key: str = "rooms") -> dict:
    """Extract one JSON object from a managed CLI response without trusting prose."""
    value = value.strip()
    if value.startswith("```"):
        value = re.sub(r"^```(?:json)?\s*", "", value, flags=re.I)
        value = re.sub(r"\s*```$", "", value)
    decoder = json.JSONDecoder()
    candidates = []
    for match in re.finditer(r"\{", value):
        try:
            result, _ = decoder.raw_decode(value[match.start():])
            if isinstance(result, dict):
                candidates.append(result)
        except json.JSONDecodeError:
            continue
    # Hermes prints the query (which contains the requested schema) before the
    # final answer. The final valid room payload is therefore the last candidate
    # carrying a non-empty rooms list, not the first JSON object in stdout.
    payloads = [
        item for item in candidates
        if isinstance(item.get(key), list) and item[key]
    ]
    if payloads:
        return payloads[-1]
    raise ValueError("DeepSeek 未返回可解析的 JSON 数据（期望字段 " + key + "）")


PLAN_PROMPT = (
    "你是户型图语义识别服务。只返回一个合法 JSON 对象，不要 Markdown、解释或推理。"
    '格式：{"rooms":[{"name":"客厅","type":"客厅",'
    '"points":[{"x":0,"y":0}]}],"notes":""}。'
    "读取附图中的建筑墙体、门洞、功能标注和固定卫浴/厨房设备，识别真实且可用的室内空间。"
    "严禁把家具、灯具、尺寸标注、文字图框、图例、独立符号或零碎线条作为空间。"
    "每个 points 是沿房间内墙边界的 3 到 16 个点，使用整张图 0 到 1000 的归一化坐标。"
    "type 只能是空间库里的中文空间名（如 客厅、餐厅、厨房、主卧、次卧、儿童房、书房、卫生间、主卫、"
    "衣帽间、阳台、门厅、玄关、走廊、楼梯间、设备间、家庭厅、起居厅、茶室、影音室、健身房、酒窖、"
    "洗衣房、收纳间、保姆房、老人房、客卧、桑拿房、阳光房、露台、庭院、车库、储藏间 等），"
    "无法归类时才用「其他空间」。"
    "边界或用途不能判断时宁可省略，不得猜测。"
    "不同房间之间不得相互重叠；同一空间不要重复返回多个房间。"
    "所有坐标必须严格限制在 0 到 1000 之间（含边界）。"
)


PLAN_TEXT_PROMPT = (
    "你是户型图读数服务。只返回一个合法 JSON 对象，不要 Markdown、解释或推理。"
    '输出格式固定为 {"labels":[...]}，labels 里只装「图纸上真的印着的空间名称文字」。'
    '图上没有印任何空间名称文字时，必须返回 {"labels":[]}，不要返回空以外的任何东西。'
    "下面的字表只是把你的抄录规范成标准写法的词表，不是可以照抄的答案："
    "示例和字表里出现过的名字，只要图上没印着，一个都不要写进来。"
    "只抄录图纸上以文字标注的空间名称（例如 客厅/餐厅/厨房/主卧/次卧/儿童房/书房/卫生间/主卫/"
    "衣帽间/阳台/露台/门厅/玄关/走廊/过道/楼梯间/设备间/家庭厅/起居厅/茶室/琴房/影音室/健身房/"
    "酒窖/雪茄房/洗衣房/家政间/收纳间/储藏室/保姆房/老人房/客卧/婴儿房/桑拿房/SPA/阳光房/屋顶花园/"
    "庭院/前院/后院/车库/车棚/门卫房/快递间/宠物房/佛堂/冥想室 等）。"
    "不要返回坐标、多边形、家具、尺寸线、图例、图号、公司名或说明文字。"
    "同一个空间名称在图上出现几次就列几次（图上标了两个次卧，就返回两个「次卧」）。"
    "看不清或不确定的文字直接省略，不要猜测。"
)


TEXT_GLYPH_MIN_HEIGHT = 5
TEXT_GLYPH_MAX_HEIGHT = 50
TEXT_GLYPH_MIN_WIDTH = 3
TEXT_GLYPH_MAX_WIDTH = 50
# 低于这个字形块数就认为「图上没有文字标注」。标定：有文字的图 ≥16，无文字的图 =0。
TEXT_GLYPHS_MIN = 2


def _ink_mask(gray: "Image.Image", long_side: int = 1000):
    """内容 mask：与页面背景（中位灰度）差异大的像素。

    用**双向**差异而不是「只认深色」——白底黑线的图纸和深底浅字的图（例如工作台自己出的
    深色情景演示图）都要能取到内容，只认深色会把整张深底图算成墨水或整张漏掉。
    """
    size = max(gray.size)
    if size != long_side:
        scale = long_side / size
        gray = gray.resize(
            (max(1, round(gray.width * scale)), max(1, round(gray.height * scale))),
            Image.Resampling.LANCZOS,
        )
    arr = np.asarray(gray)
    median = float(np.median(arr))
    return (np.abs(arr.astype(np.int16) - median) > 60).astype(np.uint8)


def page_looks_empty(image: "Image.Image", min_ink_ratio: float = 0.001) -> bool:
    """整页近乎空白（内容和背景几乎一样）＝没有可读的东西，别送去读字。

    存在的理由是一次真实事故：一张 420×300 纯白图走「只读文字」这条路，视觉模型把
    提示词里的示例名字原样抄了回来，空白图凭空多出「客厅/主卧/次卧」三个空间。
    差量像素低于千分之一直接判空，既不花这一次视觉调用，也不给模型编的机会。
    """
    return float(_ink_mask(image.convert("L")).mean()) < min_ink_ratio


def count_text_glyphs(image: "Image.Image"):
    """数一数页面上有多少「像字」的小块；数不出来返回 None。

    第二道闸门：整页不空、但**找不到任何字形证据**的图（照片式平面、纯线稿、只有墙没有标注），
    同样不去问模型——问它就会照着提示词编名字。判据是连通域的形状/尺寸范围，
    和 OCR 无关，所以不依赖任何外部服务。

    标定（2026-10-12，本机真数据）：实测 8 张真图纸 23~182、仓库样本 16；
    无文字的合成图与 furnished-plan 全是 0。取 TEXT_GLYPHS_MIN=2，两侧余量都很大。
    本机没有 cv2 时返回 None（不拦，退回原行为）。
    """
    try:
        import cv2
    except Exception:
        return None
    ink = _ink_mask(image.convert("L"))
    total, _, stats, _ = cv2.connectedComponentsWithStats(ink, connectivity=8)
    glyphs = 0
    for i in range(1, total):
        w, h, area = int(stats[i][2]), int(stats[i][3]), int(stats[i][4])
        if w <= 0 or h <= 0:
            continue
        if not (TEXT_GLYPH_MIN_HEIGHT <= h <= TEXT_GLYPH_MAX_HEIGHT):
            continue
        if not (TEXT_GLYPH_MIN_WIDTH <= w <= TEXT_GLYPH_MAX_WIDTH):
            continue
        if not 0.12 <= w / float(h) <= 4.0:
            continue
        if not 0.10 <= area / float(w * h) <= 0.90:
            continue
        glyphs += 1
    return glyphs


def _managed_vision_json(path: Path, metadata: dict, prompt: str, key: str = "rooms") -> dict:
    """Run the environment-managed DeepSeek vision CLI and parse its JSON.

    The Hermes CLI owns provider authentication. This process never reads,
    serializes, or persists its credentials. A non-JSON or unavailable visual
    response fails closed, so no local geometry/furniture fragments can become a
    false result.
    """
    cli = os.getenv(
        "HERMES_CLI_PATH",
        "hermes",
    )
    if not (Path(cli).is_file() or shutil.which(cli)):
        raise ValueError("当前环境未找到 Hermes 受管 DeepSeek 服务")
    profile_home = os.getenv(
        "HERMES_PROFILE_HOME",
        "",
    )
    profile = os.getenv("HERMES_PROFILE", "designer")
    model = os.getenv("PLAN_VISION_MODEL", "deepseek-v4-flash")
    reasoning = os.getenv("PLAN_VISION_REASONING", "none")
    # The managed CLI only accepts real raster images, so PDF/SVG pages are
    # rasterised (and oversized sheets downscaled) into one temporary PNG first.
    # Coordinates stay normalised 0..1000 of the whole page, so this is lossless
    # for the semantic contract.
    source = raster_image(path, metadata)
    source.thumbnail((2000, 2000), Image.Resampling.LANCZOS)
    page_dir = tempfile.mkdtemp(prefix="gv-planvision-")
    page_path = Path(page_dir) / "page.png"
    source.save(page_path, format="PNG")
    env = os.environ.copy()
    env["HERMES_HOME"] = profile_home
    env["HERMES_PROFILE"] = profile
    command = [
        cli, "--provider", "deepseek", "--model", model, "--reasoning", reasoning, "--ignore-rules",
        "chat", "--image", str(page_path), "--query", prompt, "--oneshot",
    ]
    try:
        completed = subprocess.run(
            command, cwd="/tmp", env=env, check=False, capture_output=True,
            text=True, timeout=int(os.getenv("PLAN_VISION_TIMEOUT_SECONDS", "150")),
        )
    except subprocess.TimeoutExpired:
        raise ValueError("DeepSeek 视觉识别超时，请稍后重试")
    finally:
        shutil.rmtree(page_dir, ignore_errors=True)
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "").strip().replace("\n", " ")
        raise ValueError("DeepSeek 视觉服务未完成：" + detail[:220])
    return _extract_json_object(completed.stdout, key)


def semantic_plan_from_managed_deepseek(path: Path, metadata: dict) -> dict:
    """Room polygons + names (the 彩平 geometry contract)."""
    return _managed_vision_json(path, metadata, PLAN_PROMPT, "rooms")


# ── 只读文字模式：只抄录图纸上的空间名称，不返回边界 ────────────────────────
# 空间名（与 frontend/src/spaces.ts 空间库同名同义；长名优先，避免「楼梯平台」被「楼梯间」吃掉）
SPACE_NAME_ORDER = sorted(
[
    "门厅",
    "客厅",
    "餐厅",
    "厨房",
    "主卧",
    "次卧",
    "儿童房",
    "书房",
    "卫生间",
    "衣帽间",
    "阳台",
    "走廊",
    "楼梯间",
    "设备间",
    "庭院",
    "车库",
    "影音室",
    "其他空间",
    "玄关柜/衣帽区",
    "前廊/门廊",
    "家庭厅",
    "起居厅/小客厅",
    "茶室/会客茶间",
    "琴房",
    "早餐区/便餐厅",
    "西厨/岛台区",
    "吧台/酒水区",
    "备餐间/传菜间",
    "酒窖/恒温酒柜间",
    "雪茄房",
    "食品储藏间/冷库",
    "主卫",
    "老人房",
    "客卧",
    "保姆房",
    "梳妆区",
    "婴儿房",
    "次卫",
    "干湿分离卫浴",
    "独立马桶间",
    "桑拿房",
    "SPA/泡池区",
    "独立工作室",
    "儿童学习区",
    "家政间",
    "洗衣房",
    "收纳间",
    "工具间",
    "健身房",
    "瑜伽房",
    "台球室",
    "游戏室",
    "室内泳池",
    "收藏陈列室",
    "音乐室",
    "家用电梯",
    "地下连廊",
    "楼梯平台",
    "前院/车道",
    "后院/草坪",
    "屋顶花园",
    "檐廊/雨棚区",
    "烧烤区",
    "阳光房",
    "景观花园",
    "水景",
    "户外泳池",
    "车棚",
    "自行车房",
    "地下储物间",
    "独立库房",
    "员工区",
    "门卫房",
    "快递间",
    "垃圾间",
    "宠物房",
    "宠物洗澡间",
    "宠物活动室",
    "佛堂",
    "祈祷室",
    "冥想室",
    "收藏品储藏间",
    "保险库",
],
    key=len, reverse=True,
)

# 图纸别名 → 空间名。由空间库别名表派生；图纸把两个空间写在一起时用下面的 SPLITS 拆开。
SPACE_LABEL_ALIASES = {
    "玄关": "门厅",
    "入户": "门厅",
    "前室": "门厅",
    "门厅": "门厅",
    "会客厅": "客厅",
    "起居室": "客厅",
    "正客厅": "客厅",
    "客厅": "客厅",
    "正餐厅": "餐厅",
    "餐厨": "餐厅",
    "餐厅厨房": "餐厅",
    "餐厅": "餐厅",
    "中厨": "厨房",
    "中式厨房": "厨房",
    "双厨房": "厨房",
    "厨房": "厨房",
    "主卧室": "主卧",
    "主卧房": "主卧",
    "主卧套房": "主卧",
    "主卧": "主卧",
    "卧室": "次卧",
    "次卧室": "次卧",
    "子女房": "次卧",
    "次卧": "次卧",
    "儿童卧室": "儿童房",
    "宝宝房": "儿童房",
    "儿童房": "儿童房",
    "办公室": "书房",
    "办公书房": "书房",
    "书房": "书房",
    "洗手间": "卫生间",
    "浴室": "卫生间",
    "卫浴": "卫生间",
    "公卫": "卫生间",
    "公共卫生间": "卫生间",
    "卫生间": "卫生间",
    "步入式衣帽间": "衣帽间",
    "更衣室": "衣帽间",
    "衣帽间": "衣帽间",
    "露台": "阳台",
    "生活阳台": "阳台",
    "景观阳台": "阳台",
    "洗衣阳台": "阳台",
    "阳台": "阳台",
    "过道": "走廊",
    "走道": "走廊",
    "廊道": "走廊",
    "走廊": "走廊",
    "楼梯": "楼梯间",
    "梯间": "楼梯间",
    "主楼梯": "楼梯间",
    "次楼梯": "楼梯间",
    "楼梯间": "楼梯间",
    "机房": "设备间",
    "设备平台": "设备间",
    "锅炉房": "设备间",
    "配电间": "设备间",
    "新风机房": "设备间",
    "设备间": "设备间",
    "花园": "庭院",
    "院子": "庭院",
    "内院": "庭院",
    "下沉庭院": "庭院",
    "景观庭院": "庭院",
    "庭院": "庭院",
    "车位": "车库",
    "停车位": "车库",
    "地下车库": "车库",
    "车库": "车库",
    "家庭影院": "影音室",
    "影院": "影音室",
    "投影室": "影音室",
    "影音室": "影音室",
    "其他空间": "其他空间",
    "玄关柜": "玄关柜/衣帽区",
    "衣帽区": "玄关柜/衣帽区",
    "鞋帽区": "玄关柜/衣帽区",
    "挂衣区": "玄关柜/衣帽区",
    "前廊": "前廊/门廊",
    "门廊": "前廊/门廊",
    "雨棚门廊": "前廊/门廊",
    "家庭起居厅": "家庭厅",
    "家人厅": "家庭厅",
    "家庭室": "家庭厅",
    "起居厅": "起居厅/小客厅",
    "小客厅": "起居厅/小客厅",
    "家庭小客厅": "起居厅/小客厅",
    "茶室": "茶室/会客茶间",
    "茶间": "茶室/会客茶间",
    "会客茶间": "茶室/会客茶间",
    "品茶室": "茶室/会客茶间",
    "琴房": "琴房",
    "练琴房": "琴房",
    "演奏室": "琴房",
    "早餐区": "早餐区/便餐厅",
    "便餐厅": "早餐区/便餐厅",
    "简餐台": "早餐区/便餐厅",
    "早餐台": "早餐区/便餐厅",
    "西厨": "西厨/岛台区",
    "岛台": "西厨/岛台区",
    "开放厨房": "西厨/岛台区",
    "西厨岛台": "西厨/岛台区",
    "吧台": "吧台/酒水区",
    "酒水区": "吧台/酒水区",
    "水吧": "吧台/酒水区",
    "饮品区": "吧台/酒水区",
    "备餐间": "备餐间/传菜间",
    "传菜间": "备餐间/传菜间",
    "备餐区": "备餐间/传菜间",
    "酒窖": "酒窖/恒温酒柜间",
    "恒温酒柜": "酒窖/恒温酒柜间",
    "藏酒间": "酒窖/恒温酒柜间",
    "雪茄房": "雪茄房",
    "储茄间": "雪茄房",
    "食品储藏间": "食品储藏间/冷库",
    "冷库": "食品储藏间/冷库",
    "食材间": "食品储藏间/冷库",
    "干货间": "食品储藏间/冷库",
    "主卫": "主卫",
    "主卫生间": "主卫",
    "卫浴套间": "主卫",
    "主浴室": "主卫",
    "长辈房": "老人房",
    "老人卧室": "老人房",
    "父母房": "老人房",
    "老人房": "老人房",
    "客房": "客卧",
    "客卧室": "客卧",
    "次客房": "客卧",
    "客卧": "客卧",
    "家政房": "保姆房",
    "住家人员房": "保姆房",
    "管家房": "保姆房",
    "保姆房": "保姆房",
    "梳妆区": "梳妆区",
    "化妆间": "梳妆区",
    "梳妆台": "梳妆区",
    "婴儿房": "婴儿房",
    "育婴室": "婴儿房",
    "婴儿室": "婴儿房",
    "育婴区": "婴儿房",
    "次卫": "次卫",
    "客卫": "次卫",
    "客用卫生间": "次卫",
    "次卫生间": "次卫",
    "干湿分离卫浴": "干湿分离卫浴",
    "干湿分离卫生间": "干湿分离卫浴",
    "分区卫浴": "干湿分离卫浴",
    "独立马桶间": "独立马桶间",
    "马桶间": "独立马桶间",
    "独立厕位": "独立马桶间",
    "桑拿房": "桑拿房",
    "蒸汽房": "桑拿房",
    "汗蒸房": "桑拿房",
    "SPA": "SPA/泡池区",
    "泡池区": "SPA/泡池区",
    "水疗区": "SPA/泡池区",
    "按摩池": "SPA/泡池区",
    "工作室": "独立工作室",
    "画室": "独立工作室",
    "手工间": "独立工作室",
    "创作室": "独立工作室",
    "儿童学习区": "儿童学习区",
    "学习区": "儿童学习区",
    "书桌区": "儿童学习区",
    "家政间": "家政间",
    "家务台": "家政间",
    "家务间": "家政间",
    "熨烫间": "家政间",
    "洗衣房": "洗衣房",
    "洗涤间": "洗衣房",
    "洗衣间": "洗衣房",
    "收纳间": "收纳间",
    "储藏室": "收纳间",
    "储藏间": "收纳间",
    "储物间": "收纳间",
    "杂物间": "收纳间",
    "工具间": "工具间",
    "工作间": "工具间",
    "维修间": "工具间",
    "园艺工具间": "工具间",
    "健身房": "健身房",
    "健身区": "健身房",
    "器械房": "健身房",
    "瑜伽房": "瑜伽房",
    "舞蹈室": "瑜伽房",
    "形体室": "瑜伽房",
    "台球室": "台球室",
    "棋牌室": "台球室",
    "麻将室": "台球室",
    "桌游室": "台球室",
    "游戏室": "游戏室",
    "娱乐室": "游戏室",
    "电玩室": "游戏室",
    "室内泳池": "室内泳池",
    "恒温泳池": "室内泳池",
    "室内游泳": "室内泳池",
    "收藏陈列室": "收藏陈列室",
    "陈列室": "收藏陈列室",
    "展示厅": "收藏陈列室",
    "藏品室": "收藏陈列室",
    "音乐室": "音乐室",
    "录音间": "音乐室",
    "录音室": "音乐室",
    "排练室": "音乐室",
    "家用电梯": "家用电梯",
    "电梯": "家用电梯",
    "无障碍电梯": "家用电梯",
    "地下连廊": "地下连廊",
    "车库连廊": "地下连廊",
    "入户连廊": "地下连廊",
    "楼梯平台": "楼梯平台",
    "中庭": "楼梯平台",
    "楼梯厅": "楼梯平台",
    "前院": "前院/车道",
    "车道": "前院/车道",
    "前庭": "前院/车道",
    "入户庭院": "前院/车道",
    "后院": "后院/草坪",
    "草坪": "后院/草坪",
    "后庭": "后院/草坪",
    "屋顶花园": "屋顶花园",
    "屋顶平台": "屋顶花园",
    "屋面平台": "屋顶花园",
    "屋顶露台": "屋顶花园",
    "檐廊": "檐廊/雨棚区",
    "雨棚区": "檐廊/雨棚区",
    "廊下": "檐廊/雨棚区",
    "烧烤区": "烧烤区",
    "户外餐区": "烧烤区",
    "BBQ区": "烧烤区",
    "阳光房": "阳光房",
    "温室": "阳光房",
    "花房": "阳光房",
    "玻璃房": "阳光房",
    "景观花园": "景观花园",
    "绿化庭院": "景观花园",
    "水景": "水景",
    "喷泉": "水景",
    "锦鲤池": "水景",
    "景观水池": "水景",
    "户外泳池": "户外泳池",
    "泳池": "户外泳池",
    "游泳池": "户外泳池",
    "室外泳池": "户外泳池",
    "SPA池": "户外泳池",
    "车棚": "车棚",
    "停车棚": "车棚",
    "自行车房": "自行车房",
    "单车房": "自行车房",
    "摩托车存放间": "自行车房",
    "非机动车库": "自行车房",
    "地下储物间": "地下储物间",
    "地下储藏": "地下储物间",
    "杂物库": "地下储物间",
    "独立库房": "独立库房",
    "库房": "独立库房",
    "园艺库房": "独立库房",
    "员工区": "员工区",
    "家政区": "员工区",
    "员工休息区": "员工区",
    "门卫房": "门卫房",
    "门房": "门卫房",
    "保安室": "门卫房",
    "门厅岗": "门卫房",
    "快递间": "快递间",
    "快递收纳": "快递间",
    "收发室": "快递间",
    "配送收纳间": "快递间",
    "垃圾间": "垃圾间",
    "垃圾分类间": "垃圾间",
    "垃圾暂存间": "垃圾间",
    "垃圾收纳间": "垃圾间",
    "宠物房": "宠物房",
    "宠物间": "宠物房",
    "宠物洗澡间": "宠物洗澡间",
    "宠物清洁间": "宠物洗澡间",
    "宠物活动室": "宠物活动室",
    "狗房": "宠物活动室",
    "猫房": "宠物活动室",
    "宠物活动区": "宠物活动室",
    "佛堂": "佛堂",
    "供奉室": "佛堂",
    "佛龛室": "佛堂",
    "静修室": "佛堂",
    "祈祷室": "祈祷室",
    "禅意空间": "祈祷室",
    "静心室": "祈祷室",
    "冥想室": "冥想室",
    "打坐间": "冥想室",
    "禅修室": "冥想室",
    "收藏品储藏间": "收藏品储藏间",
    "恒温藏品间": "收藏品储藏间",
    "藏品储藏间": "收藏品储藏间",
    "保险库": "保险库",
    "金库": "保险库",
    "贵重品保管间": "保险库",
    "保险间": "保险库",
}

# 图上把两个空间写在一起时，拆成两个空间。
SPACE_LABEL_SPLITS = {
    "客餐厅": ["客厅", "餐厅"],
    "客厅餐厅": ["客厅", "餐厅"],
}


def normalize_space_label(raw) -> list:
    """图纸上的文字 → 工作台空间类型名列表（认不出返回空列表）。"""
    text = re.sub(r"[\s\u3000]+", "", str(raw or ""))
    text = re.sub(r"[0-9]+$", "", text)
    text = text.strip("（）()【】[]·、,，.。/\\-—_")
    if not text:
        return []
    if text in SPACE_LABEL_SPLITS:
        return list(SPACE_LABEL_SPLITS[text])
    if text in SPACE_LABEL_ALIASES:
        return [SPACE_LABEL_ALIASES[text]]
    for name in SPACE_NAME_ORDER:
        if text == name:
            return [name]
    for name in SPACE_NAME_ORDER:
        if name in text:
            return [name]
    return []


def labels_to_result(value: dict, metadata: dict, floor: int = 1) -> dict:
    """只读文字识别结果 → 空间草稿（无边界：名称即空间，落到指定楼层）。"""
    if isinstance(value.get("data"), dict):
        value = value["data"]
    if isinstance(value.get("result"), dict):
        value = value["result"]
    raw = value.get("labels")
    if not isinstance(raw, list):
        raise ValueError("读数响应缺少 labels 数组")
    counts = {}
    rooms = []
    for item in raw[:80]:
        if isinstance(item, str):
            text = item
        elif isinstance(item, dict):
            text = item.get("name") or item.get("text")
        else:
            text = None
        for name in normalize_space_label(text):
            counts[name] = counts.get(name, 0) + 1
            n = counts[name]
            rooms.append(dict(
                id=uuid.uuid4().hex[:12],
                name=name if n == 1 else "%s %d" % (name, n),
                type=name,
                floor=floor,
                x=400, y=320, width=1, height=1, points=[], area=0, heightM=2.8,
                color=SEMANTIC_STYLE.get(name, SEMANTIC_STYLE["其他空间"]),
                source="semantic-labels",
                sourceFileId=metadata.get("id"),
                confidence=None,
                semanticSource="vision-read-labels",
                semanticConfidence="requires-review",
                needsReview=True,
                notes="按图纸文字识别建立的空间（无边界）；编号即可定位，无需框选。",
            ))
    if not rooms:
        raise ValueError("图纸上没读到可用的空间名称文字")
    names = "、".join(r["name"] for r in rooms[:12])
    return dict(
        provider=os.getenv("PLAN_VISION_PROVIDER", "hermes-deepseek"),
        simulated=False,
        confidence=None,
        status="draft",
        rooms=rooms,
        walls=[], openings=[], texts=[],
        unrecognized=["空间边界、面积与门窗关系未识别（本模式只读文字）"],
        message="已按图纸文字识别出 %d 个空间（第 %d 层）：%s。只建空间、不画边界，编号即可定位。" % (len(rooms), floor, names),
        semantic={"provider": "external-vision", "mode": "labels", "confidence": "requires-review"},
    )


def semantic_labels_from_external(path: Path, metadata: dict, floor: int = 1) -> dict:
    """只用视觉读图纸上的空间名称文字，不做几何分割。"""
    provider = os.getenv("PLAN_VISION_PROVIDER", "disabled").strip().lower()
    if provider != "hermes-deepseek":
        raise ValueError("未配置语义视觉服务，无法读取图纸文字")
    page = raster_image(path, metadata)
    # 闸门一：整页空白，没有文字可读。
    if page_looks_empty(page):
        raise ValueError("这一页几乎是空白，没有可读的空间名称文字")
    # 闸门二：有内容、但找不到任何字形证据（照片式平面 / 纯线稿 / 只有墙没有标注）。
    # 这种图问模型只会得到编出来的名字，所以干脆不问，诚实报「没读到文字」。
    glyphs = count_text_glyphs(page)
    if glyphs is not None and glyphs < TEXT_GLYPHS_MIN:
        raise ValueError(
            "这一页没有找到文字标注（字形级检查）：请确认上传的是带空间名称的图纸，"
            "或在「底图与空间」手动新增空间"
        )
    value = _managed_vision_json(path, metadata, PLAN_TEXT_PROMPT, "labels")
    return labels_to_result(value, metadata, floor)


def polygon_overlap_violations(rooms: list[dict], tolerance_ratio: float = 0.035) -> list[str]:
    """Reject semantic room sets that stack one room on another.

    Shared wall edges are fine; meaningful filled overlap is not.  Vision models
    often return approximate rectangles.  Letting those rectangles overlap makes
    an unusable colour plan, so this is a hard quality gate rather than something
    the designer must discover after import.
    """
    if len(rooms) < 2:
        return []
    try:
        import cv2 as cv
    except Exception:
        return []
    masks=[]
    for room in rooms:
        pts=room.get('points') or []
        if len(pts) < 3: continue
        arr=np.asarray([[round(float(v['x'])),round(float(v['y']))] for v in pts],dtype=np.int32)
        mask=np.zeros((660,800),np.uint8)
        cv.fillPoly(mask,[arr],1)
        masks.append((room,mask,int(mask.sum())))
    errors=[]
    for i,(a,ma,aa) in enumerate(masks):
        for b,mb,ab in masks[i+1:]:
            overlap=int(np.count_nonzero(ma & mb))
            threshold=max(18, int(min(aa,ab)*tolerance_ratio))
            if overlap > threshold:
                errors.append(f"{a.get('name','空间')} 与 {b.get('name','空间')} 重叠 {round(overlap/max(min(aa,ab),1)*100)}%")
    return errors


def _polygon_from_mask(mask, min_area: int = 30):
    """Extract a <=8-point polygon from a binary mask (largest external contour)."""
    import cv2 as cv
    contours, _ = cv.findContours(mask, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None
    contour = max(contours, key=cv.contourArea)
    if cv.contourArea(contour) < min_area:
        return None
    # Axis-aligned masks (the common case) come back as exact vertices from
    # CHAIN_APPROX_SIMPLE; keep those as-is so a narrow notch is not smoothed away.
    if 3 <= len(contour) <= 8:
        pts = contour
    else:
        peri = cv.arcLength(contour, True)
        approx = None
        for eps in (0.005, 0.01, 0.02, 0.03, 0.05, 0.08, 0.12, 0.2):
            candidate = cv.approxPolyDP(contour, eps * peri, True)
            if 3 <= len(candidate) <= 8:
                approx = candidate
                break
        if approx is None:
            hull = cv.convexHull(contour)
            if 3 <= len(hull) <= 8:
                approx = hull
            else:
                x, y, w, h = cv.boundingRect(contour)
                approx = np.array(
                    [[[x, y]], [[x + w, y]], [[x + w, y + h]], [[x, y + h]]], dtype=np.int32
                )
        pts = approx
    return [{"x": float(p[0][0]), "y": float(p[0][1])} for p in pts]


def _resolve_overlapping_rooms(rooms, tolerance_ratio: float = 0.035):
    """Return a non-overlapping room set, carving smaller rooms out of larger ones.

    Semantic vision models routinely return overlapping rectangles: duplicate
    spaces, a corridor stacking on a room, or an en-suite bathroom overlapping
    its bedroom. A hard overlap gate used to turn that into a total import
    failure. Now we instead:

      1. drop near-duplicate / fully-nested rooms (overlap > 50% of the smaller
         room), keeping the larger interpretation;
      2. carve the smaller room out of the larger one for partial overlaps, so
         both spaces survive (e.g. a bathroom carved out of a bedroom);
      3. leave anything still overlapping for the designer's review.

    Returns ``(rooms, summary)``; ``summary`` carries ``carved``/``dropped``.
    """
    summary = {"carved": 0, "dropped": 0}
    if len(rooms) < 2:
        return rooms, summary
    try:
        import cv2 as cv
    except Exception:
        return rooms, summary

    def mask_of(pts):
        arr = np.asarray(
            [[round(float(v["x"])), round(float(v["y"]))] for v in pts], dtype=np.int32
        )
        m = np.zeros((660, 800), np.uint8)
        cv.fillPoly(m, [arr], 1)
        return m

    indexed = []
    for room in rooms:
        pts = room.get("points") or []
        if not isinstance(pts, list) or len(pts) < 3:
            continue
        m = mask_of(pts)
        indexed.append([room, m, int(m.sum())])
    indexed.sort(key=lambda t: -t[2])

    placed = []  # list of [room, mask, area]
    for room, m, area in indexed:
        # 1) near-duplicate / fully nested -> drop the smaller interpretation.
        if any(
            (min(area, parea) > 0 and int(np.count_nonzero(m & pmask)) / min(area, parea) > 0.5)
            for _, pmask, parea in placed
        ):
            summary["dropped"] += 1
            continue
        # 2) carve this (smaller) room out of each overlapping placed (larger) room.
        drop_current = False
        for i in range(len(placed)):
            proom, pmask, parea = placed[i]
            overlap = int(np.count_nonzero(m & pmask))
            smaller = min(area, parea)
            if overlap <= max(18, int(smaller * tolerance_ratio)):
                continue
            new_mask = pmask & (~m)
            if int(new_mask.sum()) < 30:
                placed[i] = None
                summary["dropped"] += 1
                continue
            new_pts = _polygon_from_mask(new_mask)
            if new_pts is None:
                continue
            new_m = mask_of(new_pts)
            if int(np.count_nonzero(new_m & m)) > max(18, int(smaller * tolerance_ratio)):
                # Donut-like; cannot separate -> drop the smaller room.
                drop_current = True
                break
            xs = [v["x"] for v in new_pts]
            ys = [v["y"] for v in new_pts]
            proom["points"] = new_pts
            proom["x"] = min(xs)
            proom["y"] = min(ys)
            proom["width"] = round(max(xs) - min(xs), 2)
            proom["height"] = round(max(ys) - min(ys), 2)
            proom.pop("rawPoints", None)
            placed[i] = [proom, new_m, int(new_m.sum())]
            summary["carved"] += 1
        if drop_current:
            summary["dropped"] += 1
            continue
        placed = [p for p in placed if p is not None]
        placed.append([room, m, area])
    return [p[0] for p in placed], summary


def _semantic_response_to_result(value: dict, metadata: dict, path: Path) -> dict:
    """Validate a semantic-provider response and translate it to canvas objects."""
    # External adapters can return source-image pixel coordinates, so retain
    # source dimensions alongside the normalized coordinate path.
    image = raster_image(path, metadata)
    w, h = image.size
    # Accommodate an adapter that nests provider output in data/result.
    if isinstance(value.get("data"), dict): value = value["data"]
    if isinstance(value.get("result"), dict): value = value["result"]
    raw_rooms = value.get("rooms")
    if not isinstance(raw_rooms, list):
        raise ValueError("语义户型接口响应缺少 rooms 数组")
    ox, oy, cw, ch = CANVAS
    palette = SEMANTIC_STYLE
    allowed = set(palette) | {"走廊"}
    out = []
    for i, item in enumerate(raw_rooms[:40]):
        if not isinstance(item, dict): continue
        points = item.get("points")
        if not isinstance(points, list) or not 3 <= len(points) <= 16: continue
        normalized = max([abs(float(v.get("x", 0))) for v in points] + [abs(float(v.get("y", 0))) for v in points]) <= 1100
        converted = []
        try:
            for v in points:
                x, y = float(v["x"]), float(v["y"])
                if normalized:
                    x = min(1000.0, max(0.0, x))
                    y = min(1000.0, max(0.0, y))
                    x, y = ox + x / 1000 * cw, oy + y / 1000 * ch
                else: x, y = ox + x / w * cw, oy + y / h * ch
                if not (ox - 10 <= x <= ox + cw + 10 and oy - 10 <= y <= oy + ch + 10): raise ValueError
                converted.append({"x": round(x, 2), "y": round(y, 2)})
        except (KeyError, TypeError, ValueError):
            continue
        xs, ys = [v["x"] for v in converted], [v["y"] for v in converted]
        if max(xs) - min(xs) < 12 or max(ys) - min(ys) < 12: continue
        kind = str(item.get("type") or "其他空间").strip()
        if kind not in allowed: kind = "其他空间"
        name = str(item.get("name") or kind).strip()[:50] or kind
        out.append(dict(id=uuid.uuid4().hex[:12], name=name, type=kind, floor=1, x=min(xs), y=min(ys), width=round(max(xs)-min(xs), 2), height=round(max(ys)-min(ys), 2), points=converted, area=0, heightM=2.8, color=palette.get(kind, palette["其他空间"]), source="semantic-vision", sourceFileId=metadata.get("id"), confidence=None, semanticSource="external-vision", semanticConfidence="requires-review", needsReview=True, notes="外部语义户型接口生成的彩平草稿；空间边界、用途和面积必须人工确认。"))
    if not out:
        raise ValueError("语义户型接口没有返回可用空间边界")
    out, summary = _resolve_overlapping_rooms(out)
    if not out:
        raise ValueError("语义户型接口返回的空间全部相互叠压，无可用独立空间")
    overlaps = polygon_overlap_violations(out)
    unrecognized = ["空间名称、边界、面积与门窗关系需人工确认"]
    notes = []
    if summary.get("dropped"):
        notes.append(f"已自动合并 {summary['dropped']} 个重复或嵌套空间")
    if summary.get("carved"):
        notes.append(f"已自动消除 {summary['carved']} 处空间叠压")
    if overlaps:
        notes.append(f"仍有 {len(overlaps)} 组空间存在叠压需人工校正：" + "；".join(overlaps[:3]))
        unrecognized.append("存在相互叠压的空间，请在确认彩平前逐项校正")
    message = f"语义户型接口已生成 {len(out)} 个空间草稿；" + ("；".join(notes) + "。" if notes else "已通过空间叠压校验。") + "仍须在原图上确认。"
    return dict(provider=os.getenv("PLAN_VISION_PROVIDER", "external-vision"), simulated=False, confidence=None, status="draft", rooms=out, walls=[], openings=[], texts=[], unrecognized=unrecognized, message=message, semantic={"provider": "external-vision", "confidence": "requires-review", "message": "基于外部视觉语义接口生成，已通过基础几何质量门槛，待设计师确认。"})


def pdf_page(metadata: dict, count: int | None = None) -> int:
    try:
        page = int(metadata.get("page") or 1)
    except (TypeError, ValueError):
        page = 1
    count = count or int(metadata.get("pages") or 1)
    return min(max(page, 1), max(count, 1))


def raster_image(path: Path, metadata: dict) -> Image.Image:
    """Use the same orientation/white compositing as the visible original preview."""
    if path.suffix.lower() in (".pdf", ".svg"):
        import fitz

        with fitz.open(path) as doc:
            if not len(doc) or doc.is_encrypted:
                raise ValueError("空文件或加密文件无法分析")
            # 多页 PDF 按图纸记录的页码（从 1 起）取页；旧图纸没有页码＝第 1 页。
            page = doc[pdf_page(metadata, len(doc)) - 1]
            scale = min(2.0, 1800 / max(page.rect.width, page.rect.height, 1))
            pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
            return Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
    with Image.open(path) as raw:
        if raw.width * raw.height > 40_000_000:
            raise ValueError("图像超过 4000 万像素，请缩小后上传")
        image = ImageOps.exif_transpose(raw).convert("RGBA")
        white = Image.new("RGBA", image.size, "white")
        white.alpha_composite(image)
        return white.convert("RGB")


def regularize_boundary(poly, contour, neighbors=(), max_points=8):
    """Remove small notches and align edges; validate geometry against original pixels."""
    import cv2 as cv

    original = np.asarray(poly, dtype=np.int32).reshape(-1, 2)
    x, y, w, h = cv.boundingRect(contour)
    # Compare at local image resolution, including padding for snapped corners.
    margin = max(20, round(min(w, h) * 0.16))
    origin = np.array([x - margin, y - margin])
    shape = (h + 2 * margin, w + 2 * margin)

    def mask(points):
        out = np.zeros(shape, np.uint8)
        cv.fillPoly(
            out, [(np.asarray(points).reshape(-1, 2) - origin).astype(np.int32)], 1
        )
        return out

    reference = mask(contour)

    def acceptable(points, minimum=0.82):
        if len(points) < 3 or abs(cv.contourArea(points.astype(np.float32))) < 1:
            return False

        # Reject crossing nonadjacent edges (including collinear intersections).
        def intersects(a, b, c, d):
            def cross(p, q, r):
                u, v = q - p, r - p
                return float(u[0] * v[1] - u[1] * v[0])

            if max(min(a[0], b[0]), min(c[0], d[0])) > min(
                max(a[0], b[0]), max(c[0], d[0])
            ) or max(min(a[1], b[1]), min(c[1], d[1])) > min(
                max(a[1], b[1]), max(c[1], d[1])
            ):
                return False
            return (
                cross(a, b, c) * cross(a, b, d) <= 0
                and cross(c, d, a) * cross(c, d, b) <= 0
            )

        n = len(points)
        for i in range(n):
            for j in range(i + 2, n):
                if i == 0 and j == n - 1:
                    continue
                if intersects(
                    points[i], points[(i + 1) % n], points[j], points[(j + 1) % n]
                ):
                    return False
        proposed = mask(points)
        union = np.count_nonzero(proposed | reference)
        if np.count_nonzero(proposed & reference) / max(union, 1) < minimum:
            return False
        for neighbor in neighbors:
            other = mask(neighbor)
            if (
                np.count_nonzero(proposed & other)
                > np.count_nonzero(reference & other) + 2
            ):
                return False
        return True

    rect = np.array(
        [[x, y], [x + w - 1, y], [x + w - 1, y + h - 1], [x, y + h - 1]], np.int32
    )
    if cv.contourArea(contour) / max((w - 1) * (h - 1), 1) >= 0.94 and acceptable(rect):
        return rect.reshape(-1, 1, 2), "rectangle"

    def clean(points):
        points = [
            p for i, p in enumerate(points) if not np.array_equal(p, points[i - 1])
        ]
        changed = True
        while changed and len(points) > 3:
            changed = False
            for i in range(len(points)):
                a, b, c = points[i - 1], points[i], points[(i + 1) % len(points)]
                u, v = b - a, c - b
                if u[0] * v[1] - u[1] * v[0] == 0 and np.dot(u, v) >= 0:
                    points.pop(i)
                    changed = True
                    break
        return np.array(points, np.int32)

    def align(points):
        points = np.asarray(points).reshape(-1, 2)
        snapped = points.astype(float)
        for axis in (0, 1):
            parents = list(range(len(points)))

            def root(i):
                while parents[i] != i:
                    i = parents[i]
                return i

            for i, a in enumerate(points):
                j = (i + 1) % len(points)
                delta = np.abs(points[j] - a)
                if delta[1 - axis] > 0 and delta[axis] / delta[1 - axis] <= 0.30:
                    parents[root(j)] = root(i)
            for group in set(root(i) for i in range(len(points))):
                indices = [i for i in range(len(points)) if root(i) == group]
                snapped[indices, axis] = np.mean(points[indices, axis])
        return clean(np.rint(snapped).astype(np.int32))

    choices = []

    def offer(points, mode):
        points = clean(points)
        if not 3 <= len(points) <= max_points or not acceptable(points):
            return
        proposed = mask(points)
        iou = np.count_nonzero(proposed & reference) / max(
            np.count_nonzero(proposed | reference), 1
        )
        # Prefer substantially fewer editable corners, without bounding-boxing L rooms.
        score = len(points) + 30 * (1 - iou)
        choices.append((score, points, mode))

    snapped = align(original)
    offer(snapped, "axis-aligned")
    # Test coarse outlines against the original mask, never truncate vertices.
    for epsilon in (0.006, 0.012, 0.02, 0.03, 0.045, 0.065):
        simple = cv.approxPolyDP(
            contour, max(2, cv.arcLength(contour, True) * epsilon), True
        )
        offer(align(simple), "eight-point-fit")
    # Rectangular morphology suppresses furniture-sized notches and tiny protrusions.
    # Always validate against ORIGINAL pixels and all neighbors, not a smoothed mask.
    for ratio in (0.035, 0.065, 0.10, 0.14, 0.18):
        size = max(3, round(min(w, h) * ratio)) | 1
        kernel = cv.getStructuringElement(cv.MORPH_RECT, (size, size))
        smoothed = cv.morphologyEx(reference, cv.MORPH_CLOSE, kernel)
        smoothed = cv.morphologyEx(smoothed, cv.MORPH_OPEN, kernel)
        contours, _ = cv.findContours(
            smoothed, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE
        )
        if not contours:
            continue
        candidate = max(contours, key=cv.contourArea) + origin.reshape(1, 1, 2)
        for tolerance in (0.004, 0.008, 0.012, 0.02, 0.03):
            approx = cv.approxPolyDP(
                candidate.astype(np.int32),
                max(2, cv.arcLength(candidate.astype(np.int32), True) * tolerance),
                True,
            )
            aligned = align(approx)
            # Convert only short oblique connectors into right-angle corners.
            # Large genuine diagonal walls are retained.
            expanded = []
            for i, a in enumerate(aligned):
                b = aligned[(i + 1) % len(aligned)]
                delta = np.abs(b - a)
                expanded.append(a)
                if min(delta) > 0 and max(delta) <= min(w, h) * 0.30:
                    elbows = [np.array([a[0], b[1]]), np.array([b[0], a[1]])]
                    scores = []
                    for elbow in elbows:
                        triangle = mask([a, elbow, b])
                        # Choose the elbow closest to the filled original region.
                        inside = np.count_nonzero(triangle & reference)
                        outside = np.count_nonzero(triangle) - inside
                        cross = (b[0] - a[0]) * (elbow[1] - a[1]) - (b[1] - a[1]) * (
                            elbow[0] - a[0]
                        )
                        orientation = cv.contourArea(
                            aligned.astype(np.float32), oriented=True
                        )
                        adds = cross * orientation < 0
                        scores.append(outside if adds else inside)
                    expanded.append(elbows[int(np.argmin(scores))])
            offer(np.array(expanded), "orthogonal-simplified")
    if choices:
        _, points, mode = min(choices, key=lambda v: v[0])
        return points.reshape(-1, 1, 2), mode
    return poly, "original-preserved"


def wall_evidence(gray):
    """Architectural ribbon candidates, not semantic wall/furniture recognition.

    Double parallel strokes or long thick strokes are evidence. Single isolated
    thin strokes (most furniture/text) never become barriers just for being dark.
    """
    import cv2 as cv

    h, w = gray.shape
    binary = cv.threshold(gray, 205, 255, cv.THRESH_BINARY_INV)[1]
    short = max(14, round(min(h, w) * 0.028))
    min_width = max(3, round(min(h, w) * 0.005))
    max_width = max(min_width + 2, round(min(h, w) * 0.020))
    barriers = np.zeros_like(binary)
    for vertical in (False, True):
        src = binary.T.copy() if vertical else binary
        continuous = cv.morphologyEx(src, cv.MORPH_CLOSE, np.ones((1, 5), np.uint8))
        runs = cv.morphologyEx(continuous, cv.MORPH_OPEN, np.ones((1, short), np.uint8))
        paired = np.zeros_like(src)
        for distance in range(min_width, max_width + 1):
            common = cv.bitwise_and(runs[:-distance], runs[distance:])
            # Require shared length > 3x wall thickness: small symbols are not walls.
            common = cv.morphologyEx(
                common, cv.MORPH_OPEN, np.ones((1, max(short, distance * 3)), np.uint8)
            )
            rows, cols = np.where(common > 0)
            if not len(rows):
                continue
            for offset in range(distance + 1):
                paired[rows + offset, cols] = 255
        # Filled structural wall bands; discard thin furniture outlines.
        thick = cv.morphologyEx(
            src, cv.MORPH_OPEN, np.ones((min_width, short), np.uint8)
        )
        evidence = cv.bitwise_or(paired, thick)
        barriers = cv.bitwise_or(barriers, evidence.T.copy() if vertical else evidence)
    # Link architectural ribbons at corners, but do not resurrect all original ink.
    linked = cv.dilate(barriers, np.ones((3, 3), np.uint8))
    count, labels, stats, _ = cv.connectedComponentsWithStats(linked, 8)
    retained = np.zeros_like(barriers)
    for i in range(1, count):
        x, y, rw, rh, area = map(int, stats[i])
        if max(rw, rh) >= min(h, w) * 0.20 and area >= short * min_width:
            retained[labels == i] = barriers[labels == i]
    # Restore only major EXTERIOR outlines, not the entire connected ink component:
    # furniture touching a wall must not be reintroduced through connectivity.
    contours, _ = cv.findContours(binary, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)
    for contour in contours:
        if cv.contourArea(contour) > h * w * 0.10:
            perimeter = cv.arcLength(contour, True)
            outline = cv.approxPolyDP(contour, max(1.5, perimeter * 0.001), True)
            cv.drawContours(retained, [outline], -1, 255, 2)
    return retained, dict(
        method="parallel-and-thick-ribbons",
        wallWidthPixels=[min_width, max_width],
        rawInkPixels=int(np.count_nonzero(binary)),
        wallEvidencePixels=int(np.count_nonzero(retained)),
        suppressedInkPixels=int(np.count_nonzero((binary > 0) & (retained == 0))),
        caveat="几何墙带候选，不是语义分类；贴墙柜体/双线家具仍可能混淆，细墙/斜墙可能遗漏。",
    )


class ImageAnalysisProvider:
    """Extract spaces from architectural ribbon evidence rather than all dark ink.

    Door gaps are bridged at several measured pixel scales. Candidate boundaries
    are suggestions and explicitly require review; no confidence probability is
    invented and no room/furniture semantic class is guessed.
    """

    def recognize(self, path: Path, metadata: dict) -> dict:
        import cv2 as cv

        cv.setNumThreads(1)
        image = raster_image(path, metadata)
        original_size = image.size
        image.thumbnail((1400, 1400), Image.Resampling.LANCZOS)
        gray = cv.cvtColor(np.asarray(image), cv.COLOR_RGB2GRAY)
        h, w = gray.shape
        scale = min(CANVAS[2] / w, CANVAS[3] / h)
        ox = CANVAS[0] + (CANVAS[2] - w * scale) / 2
        oy = CANVAS[1] + (CANVAS[3] - h * scale) / 2

        def xy(x, y):
            return dict(
                x=round(ox + float(x) * scale, 2), y=round(oy + float(y) * scale, 2)
            )

        result = dict(
            provider="local-boundary-analysis",
            simulated=False,
            confidence=None,
            confidenceNote="未提供经过校准的识别概率；结果必须人工复核",
            rooms=[],
            walls=[],
            openings=[],
            texts=[],
            boundarySegments=[],
            unresolvedRegions=[],
            maxRoomVertices=8,
            status="no-spaces",
            algorithmVersion="wall-evidence-v4",
            sourceDimensions=list(original_size),
            analyzedDimensions=[w, h],
            canvasTransform=dict(x=ox, y=oy, width=w * scale, height=h * scale),
            page=pdf_page(metadata),
            pageCount=metadata.get("pages") or 1,
            unrecognized=[
                "房间用途及名称（当前未接入 OCR / 语义模型）",
                "实际面积、长度比例、层高及楼层关系",
                "独立墙体、门窗、承重属性与开放空间的功能分区",
            ],
        )
        if min(h, w) < 80:
            result["message"] = (
                "图片分辨率太低，未识别出空间。请上传清晰、完整的户型平面图。"
            )
            return result
        # Support black-background CAD screenshots, but reject ordinary photographs.
        inverted = float(np.mean(gray < 70)) > 0.65
        if inverted:
            gray = 255 - gray
        light_ratio = float(np.mean(gray > 205))
        dark_ratio = float(np.mean(gray < 160))
        result["metrics"] = dict(
            lightPixelRatio=round(light_ratio, 3),
            darkPixelRatio=round(dark_ratio, 3),
            inverted=inverted,
        )
        if light_ratio < 0.48 or dark_ratio > 0.40:
            result["message"] = (
                "这张图片不像可直接解析的线稿平面图，未生成房间。实景照片、深色效果图或复杂彩平需要视觉模型或人工描绘。"
            )
            return result
        excluded_mask = np.zeros_like(gray)
        exclusions = metadata.get("recognitionOptions", {}).get("exclusions", [])
        for box in exclusions:
            x1 = max(0, min(w, round((box["x"] - ox) / scale)))
            y1 = max(0, min(h, round((box["y"] - oy) / scale)))
            x2 = max(0, min(w, round((box["x"] + box["width"] - ox) / scale)))
            y2 = max(0, min(h, round((box["y"] + box["height"] - oy) / scale)))
            gray[y1:y2, x1:x2] = 255
            excluded_mask[y1:y2, x1:x2] = 255
        structural, evidence_metrics = wall_evidence(gray)
        structural[excluded_mask > 0] = 0
        result["exclusions"] = exclusions
        result["wallEvidenceContours"] = []
        evidence_contours, _ = cv.findContours(
            structural, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE
        )
        for contour in evidence_contours:
            poly = cv.approxPolyDP(
                contour, max(1.5, cv.arcLength(contour, True) * 0.003), True
            )
            if len(poly) >= 3:
                result["wallEvidenceContours"].append(
                    [xy(v[0][0], v[0][1]) for v in poly]
                )
        result["wallEvidence"] = evidence_metrics
        if np.count_nonzero(structural) < w * h * 0.001:
            result["message"] = (
                "未找到足够的双线或粗线墙带证据。不会把家具细线直接当作墙体，请人工确认墙体或上传建筑底图。"
            )
            return result
        min_area = max(300, int(w * h * 0.008))
        min_side = max(18, int(min(h, w) * 0.045))
        trials = []
        gaps = sorted(
            set(
                [1]
                + [
                    max(3, round(min(h, w) * r))
                    for r in (0.010, 0.020, 0.035, 0.055, 0.075, 0.10)
                ]
            )
        )
        for gap in gaps:
            a = cv.morphologyEx(
                structural,
                cv.MORPH_CLOSE,
                cv.getStructuringElement(cv.MORPH_RECT, (gap, 1)),
            )
            b = cv.morphologyEx(
                structural,
                cv.MORPH_CLOSE,
                cv.getStructuringElement(cv.MORPH_RECT, (1, gap)),
            )
            mask = cv.bitwise_or(a, b)
            mask = cv.dilate(mask, np.ones((3, 3), np.uint8))
            count, labels, stats, _ = cv.connectedComponentsWithStats(255 - mask, 8)
            candidates = []
            for i in range(1, count):
                x, y, rw, rh, pixels = map(int, stats[i])
                if x < 2 or y < 2 or x + rw > w - 2 or y + rh > h - 2:
                    continue
                if (
                    pixels < min_area
                    or min(rw, rh) < min_side
                    or max(rw / rh, rh / rw) > 9
                ):
                    continue
                region = (labels[y : y + rh, x : x + rw] == i).astype(np.uint8) * 255
                contours, _ = cv.findContours(
                    region, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE
                )
                if not contours:
                    continue
                contour = max(contours, key=cv.contourArea)
                contour = contour + np.array([[[x, y]]], dtype=np.int32)
                area = float(cv.contourArea(contour))
                if area < min_area or area / (rw * rh) < 0.22:
                    continue
                candidates.append(
                    dict(
                        contour=contour,
                        area=area,
                        x=x,
                        y=y,
                        width=rw,
                        height=rh,
                        pixels=pixels,
                    )
                )
            # Filled external contours include furniture holes. Drop enclosed bed/table
            # interiors instead of promoting those nested shapes to "rooms".
            candidates.sort(key=lambda c: -c["area"])
            kept = []
            for c in candidates:
                probes = [
                    tuple(map(float, pt[0]))
                    for pt in c["contour"][:: max(1, len(c["contour"]) // 8)]
                ]
                if any(
                    all(
                        cv.pointPolygonTest(k["contour"], pt, False) >= 0
                        for pt in probes
                    )
                    for k in kept
                ):
                    continue
                kept.append(c)
            total_area = sum(c["area"] for c in kept)
            # Prefer preserved enclosed floor coverage; do not maximize the number of fragments.
            score = (
                total_area / (w * h) * 20
                + min(len(kept), 12) * 0.65
                - gap / min(h, w) * 2
            )
            trials.append((score, gap, kept, total_area))
        _, gap, candidates, total_area = max(trials, key=lambda t: t[0])
        candidates.sort(key=lambda c: (round(c["y"] / max(h * 0.12, 1)), c["x"]))
        if not candidates:
            result["message"] = (
                "未识别出可靠的封闭空间。可能存在大开口、低对比度或图纸裁切；请补齐边界，或在底图上手工绘制区域。"
            )
            return result
        candidates = candidates[:60]
        accepted_contours = []
        for index, c in enumerate(candidates):
            contour = c["contour"]
            perimeter = cv.arcLength(contour, True)
            poly = cv.approxPolyDP(contour, max(1.5, perimeter * 0.004), True)
            # Bound edit complexity while retaining non-rectangular room outlines.
            for tolerance in (0.007, 0.012, 0.02):
                if len(poly) <= 40:
                    break
                poly = cv.approxPolyDP(contour, max(2, perimeter * tolerance), True)
            if len(poly) < 3:
                continue
            raw_points = [xy(pt[0][0], pt[0][1]) for pt in poly]
            poly, regularization = regularize_boundary(
                poly,
                contour,
                accepted_contours
                + [other["contour"] for other in candidates[index + 1 :]],
            )
            if len(poly) > 8:
                result["unresolvedRegions"].append(
                    dict(
                        name=f"待划分区域 {len(result['unresolvedRegions'])+1}",
                        x=round(ox + c["x"] * scale, 2),
                        y=round(oy + c["y"] * scale, 2),
                        width=round(c["width"] * scale, 2),
                        height=round(c["height"] * scale, 2),
                        reason="边界过于复杂，无法在8点内可靠拟合；可能是开放区、贴墙家具干扰或墙体缺失，请确认墙带后人工划分。",
                        rawPoints=raw_points,
                    )
                )
                continue
            accepted_contours.append(poly)
            points = [xy(pt[0][0], pt[0][1]) for pt in poly]
            # A changed winding or starting vertex is NOT a geometry improvement.
            if len(raw_points) == len(points) and any(
                ordered[start:] + ordered[:start] == raw_points
                for ordered in (points, list(reversed(points)))
                for start in range(len(points))
            ):
                points = raw_points
            xs = [v["x"] for v in points]
            ys = [v["y"] for v in points]
            rid = uuid.uuid4().hex[:12]
            room = dict(
                id=rid,
                name=f"空间 {index+1:02}",
                type="其他空间",
                floor=1,
                x=min(xs),
                y=min(ys),
                width=round(max(xs) - min(xs), 2),
                height=round(max(ys) - min(ys), 2),
                points=points,
                rawPoints=raw_points,
                boundaryRegularization=regularization,
                area=0,
                heightM=2.8,
                color=["#d8eadf", "#f2dfbd", "#d5e8f1", "#ead9e8", "#e4e9bf", "#f0d7c9"][index % 6],
                source="image-analysis",
                sourceFileId=metadata.get("id"),
                sourcePage=1,
                confidence=None,
                needsReview=True,
                pixelArea=round(c["area"]),
                notes="从上传图像提取的空间边界草稿。名称、面积、层高和楼层待人工输入；家具和开放区可能影响边界。",
            )
            room["regularizationStats"] = dict(
                beforeVertices=len(raw_points),
                afterVertices=len(points),
                changed=raw_points != points,
            )
            result["rooms"].append(room)
            for a, b in zip(points, points[1:] + points[:1]):
                result["boundarySegments"].append(
                    dict(
                        id=uuid.uuid4().hex[:12],
                        x=a["x"],
                        y=a["y"],
                        x2=b["x"],
                        y2=b["y"],
                        floor=1,
                        layer="图像空间边界参考",
                        source="image-analysis",
                        sourceFileId=metadata.get("id"),
                        sourceRoomId=rid,
                    )
                )
        add_local_semantic_suggestions(result["rooms"])
        result["semantic"] = {
            "provider": "local-geometry-suggestion",
            "confidence": "low",
            "message": "已按空间面积、轮廓和相对位置自动生成彩平用途草稿；未使用家具/文字语义模型，名称必须人工确认。",
        }
        result["metrics"].update(
            gapClosingPixels=gap,
            spacePixelFraction=round(total_area / (w * h), 3),
            candidateCounts=[len(t[2]) for t in trials],
        )
        result["status"] = "draft" if result["rooms"] else "no-spaces"
        result["message"] = (
            f"已从原图实际提取 {len(result['rooms'])} 个候选空间边界（本地图像分析，非固定示例）。"
            "先提取双线/粗线墙带证据，抑制孤立细线家具；不是语义家具识别。自动空间均不超过8点。"
            "贴墙柜体和双线家具仍可能混淆，漏检的区域不能当作已识别；请查看墙带候选层，必要时框选家具排除区后重新识别。"
            f"另有 {len(result['unresolvedRegions'])} 个复杂区域需人工划分；名称、面积和尺寸仍需人工校正。"
        )
        if metadata.get("pages", 0) and metadata["pages"] > 1:
            result[
                "message"
            ] += f" 当前自动分析 PDF 第 {pdf_page(metadata)} 页 / 共 {metadata['pages']} 页。"
        return result
