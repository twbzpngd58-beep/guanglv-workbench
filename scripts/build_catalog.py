"""从知识库（NAS 只读挂载）生成灯具选型目录：backend/catalog/catalog.json + 图片。

只收飞利浦（WiZ 灯具 + Hue 灯具）与 FLOS 装饰灯具；驱动 / 电源 / 面板 / 轨道 / 配件 / 灯泡不收。
可重跑：知识库内容与解析口径不变时，输出字节级一致（图片按内容命名，JSON 里不写生成时间）。

用法：
    .venv/bin/python scripts/build_catalog.py
    .venv/bin/python scripts/build_catalog.py --vault /private/tmp/nas/知识库/15-产品库 --out backend/catalog
"""
from __future__ import annotations

import argparse
import csv
import html
import json
import re
import shutil
import sys
import unicodedata
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

import fitz  # PyMuPDF
from PIL import Image

PH_PRICE_MD = "飞利浦/Philips Wiz&Hue体系产品解决方案清单合作伙伴价格体系表-2025（含政策）.md"
PH_XLSX = "飞利浦/灯具产品库-厂家询价单-飞利浦Hue+Wiz-20261016.xlsx"
FLOS_DIR = "FLOS/FLOS_202403_中国区装饰系列价目表"
FLOS_PARAMS = f"{FLOS_DIR}/FLOS_202403_产品参数总表.csv"
FLOS_PRICE = f"{FLOS_DIR}/FLOS_202403_价格体系表_拿货6折_统一零售65折.csv"
FLOS_LIGHT = f"{FLOS_DIR}/FLOS_202403_光源配置表.csv"
FLOS_PDF_DIR = f"{FLOS_DIR}/官网技术规格表"


def clean(s: str) -> str:
    s = re.sub(r"<img[^>]*>", "", s or "")
    s = re.sub(r"<br\s*/?>", " / ", s)
    s = re.sub(r"<[^>]+>", " ", s)
    s = html.unescape(s)
    return re.sub(r"\s+", " ", s).strip()


def num(s) -> float | None:
    """'1,340.84' / '11,5' / 'Φ55mm' → 数字；解析不出返回 None。"""
    t = str(s or "").replace(",", ".") if re.search(r"\d,\d{1,2}\b", str(s or "")) else str(s or "").replace(",", "")
    m = re.search(r"-?\d+(?:\.\d+)?", t)
    if not m:
        return None
    v = float(m.group(0))
    return v


def money(s) -> float | None:
    t = str(s or "").replace(",", "")
    m = re.search(r"\d+(?:\.\d+)?", t)
    return float(m.group(0)) if m else None


def slug(s: str, maxlen: int = 60) -> str:
    s = unicodedata.normalize("NFKD", s or "")
    s = re.sub(r"[^\w\u4e00-\u9fff]+", "-", s).strip("-").lower()
    return s[:maxlen].strip("-")


def write_image(src: Image.Image, dst: Path, max_side: int = 480) -> list[int]:
    im = src.convert("RGBA")
    w, h = im.size
    if max(w, h) > max_side:
        r = max_side / max(w, h)
        im = im.resize((max(1, round(w * r)), max(1, round(h * r))), Image.LANCZOS)
    bg = Image.new("RGB", im.size, (255, 255, 255))
    bg.paste(im, mask=im.split()[-1])
    dst.parent.mkdir(parents=True, exist_ok=True)
    bg.save(dst, "WEBP", quality=86, method=6)
    return [bg.width, bg.height]


# ---------------------------------------------------------------- 飞利浦

def parse_philips_tables(md_path: Path) -> tuple[list[list[str]], list[list[str]]]:
    wiz: list[list[str]] = []
    hue: list[list[str]] = []
    section = ""
    for line in md_path.read_text(encoding="utf-8").splitlines():
        if line.startswith("###"):
            section = clean(line.lstrip("#"))
            continue
        if not re.match(r"^\|\s*\d+\s*\|", line):
            continue
        cells = [clean(c) for c in line.strip().strip("|").split("|")]
        if "Wiz产品选型" in section and len(cells) == 13:
            wiz.append(cells)
        elif "Hue产品选型" in section and len(cells) == 7:
            hue.append(cells)
    return wiz, hue


def cct_of(text: str) -> dict | None:
    raw = text.strip()
    t = raw.replace(" ", "")
    rgb = bool(re.search(r"RGB|全彩", t, re.I))
    ks = [int(x) for x in re.findall(r"(\d{4})K", t)]
    if not ks:
        return None
    uniq = sorted(set(ks))
    if len(uniq) == 1:
        out = {"kind": "fixed", "value": uniq[0]}
    elif re.search(r"\d{4}K-\d{4}K", t) or re.search(r"\d{4}K\s*/\s*-\s*/\s*\d{4}K", raw) or len(uniq) == 2:
        out = {"kind": "range", "min": uniq[0], "max": uniq[-1]}
    elif len(uniq) <= 4:
        out = {"kind": "options", "options": uniq, "default": uniq[0]}
    else:
        out = {"kind": "range", "min": uniq[0], "max": uniq[-1]}
    if rgb:
        out["rgb"] = True
    return out


def beam_of(text: str) -> dict | None:
    t = text.strip()
    if not t or t == "/":
        return None
    degs = [int(x) for x in re.findall(r"(\d{1,3})", t)]
    if degs and re.search(r"[°˚]", t):
        uniq = sorted(set(d for d in degs if 1 <= d <= 180))
        if len(uniq) == 1:
            return {"kind": "fixed", "value": uniq[0]}
        if uniq:
            return {"kind": "options", "options": uniq, "default": uniq[0]}
    return {"kind": "label", "value": t}


def glare_of(text: str) -> dict | None:
    t = text.strip()
    if not t or t == "/":
        return None
    parts = [p.strip() for p in t.split("/") if p.strip() and p.strip() != "-"]
    return {"options": parts} if parts else None


def ph_type(name: str, category: str = "") -> str:
    n = f"{name} {category}"
    if "踢脚灯" in n or "地脚灯" in n:
        return "地脚灯"
    if "洗墙灯" in n:
        return "洗墙灯"
    if "灯带" in n or "灯管" in n:
        return "灯带"
    if "线性灯" in n:
        return "线性灯"
    if "磁吸" in n:
        return "磁吸轨道"
    if "吸顶灯" in n:
        return "吸顶灯"
    if "落地灯" in n:
        return "落地灯"
    if "桌灯" in n or "魔灯" in n or "便携" in n:
        return "台灯"
    if "筒灯" in n:
        return "筒灯"
    return "射灯"


def params_of(text: str) -> dict:
    out: dict = {}
    m = re.search(r"功率[:：]\s*([\d.]+)\s*W", text)
    if m:
        out["power"] = float(m.group(1))
    m = re.search(r"开孔(?:尺寸)?[:：]\s*([^ ]+?)(?:\s|$)", text)
    if m:
        out["cutout"] = m.group(1).replace("mm", "")
    m = re.search(r"(?:产品尺寸|灯具尺寸)[:：]\s*([^:：]*?)(?=\s*(?:功率|防护|眩光|开孔|材质|电压|Ra|$))", text)
    if m:
        size = re.sub(r"\s*/\s*", "", m.group(1).strip())
        if size and size != "/":
            out["size"] = size
    m = re.search(r"(IP\d{2})", text)
    if m:
        out["ip"] = m.group(1)
    m = re.search(r"眩光值[:：]\s*(UGR[<＜]\d+)", text, re.I)
    if m:
        out["ugr"] = m.group(1).replace("＜", "<")
    m = re.search(r"材质[:：]\s*(\S+)", text)
    if m:
        out["material"] = m.group(1)
    m = re.search(r"光通量[:：]?\s*(\d+)\s*lm", text)
    if m:
        out["lumen"] = int(m.group(1))
    return out


def xlsx_images(path: Path) -> dict[str, bytes]:
    """WPS 单元格图片：DISPIMG 里的 ID → xl/media 图片字节。"""
    with zipfile.ZipFile(path) as z:
        names = set(z.namelist())
        if "xl/cellimages.xml" not in names:
            return {}
        xml = z.read("xl/cellimages.xml").decode("utf-8")
        rels = z.read("xl/_rels/cellimages.xml.rels").decode("utf-8")
    rid2img = dict(re.findall(r'Id="(rId\d+)"[^>]*Target="([^"]+)"', rels))
    out: dict[str, bytes] = {}
    for pic in re.findall(r"<etc:cellImage>.*?</etc:cellImage>", xml, re.S):
        idm = re.search(r'name="(ID_[0-9A-F]+)"', pic)
        rid = re.search(r'r:embed="(rId\d+)"', pic)
        if idm and rid and rid.group(1) in rid2img:
            target = rid2img[rid.group(1)].split("/")[-1]
            with zipfile.ZipFile(path) as z:
                if f"xl/media/{target}" in z.namelist():
                    out[idm.group(1)] = z.read(f"xl/media/{target}")
    return out


def xlsx_rows(path: Path) -> list[dict]:
    """询价单只用来取「型号 → 图片 ID / 分类 / 简称」，价格不用它（它是厂家报价）。"""
    import openpyxl

    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb.worksheets[0]
    out = []
    for r in range(4, ws.max_row + 1):
        model = ws.cell(r, 2).value
        img = ws.cell(r, 3).value
        name = ws.cell(r, 5).value
        if not name:
            continue
        out.append({
            "row": r,
            "model": str(model or "").strip(),
            "imgid": (re.search(r'"(ID_[0-9A-F]+)"', str(img or "")).group(1)
                      if re.search(r'"(ID_[0-9A-F]+)"', str(img or "")) else ""),
            "brand": str(ws.cell(r, 4).value or ""),
            "name": str(name).strip(),
            "category": str(ws.cell(r, 6).value or "").strip(),
            "power": ws.cell(r, 8).value,
            "cct": str(ws.cell(r, 9).value or "").strip(),
            "cutout": str(ws.cell(r, 10).value or "").strip(),
            "beam": str(ws.cell(r, 11).value or "").strip(),
            "note": str(ws.cell(r, 19).value or "").strip(),
        })
    return out


def build_philips(vault: Path, img_dir: Path) -> list[dict]:
    wiz_rows, hue_rows = parse_philips_tables(vault / PH_PRICE_MD)
    xrows = xlsx_rows(vault / PH_XLSX)
    media = xlsx_images(vault / PH_XLSX)

    # 图片键 = 型号 + 功率 + 色温首值：同型号多规格（SL630 9W 射灯 vs 10W 格栅灯、
    # LS270 双色 vs 单色）各有各的图，不能只按型号码套。
    def img_key(model: str, power, cct: str) -> str:
        try:
            pw = f"{float(power):g}" if power not in (None, "", "/") else ""
        except (TypeError, ValueError):
            pw = ""
        ks = re.findall(r"(\d{4})", str(cct or ""))
        return f"{model}|{pw}|{ks[0] if ks else ''}"

    model2img: dict[str, str] = {}
    model2cat: dict[str, str] = {}
    model_imgs: dict[str, list[str]] = {}
    for x in xrows:
        if x["model"]:
            if x["imgid"]:
                model2img.setdefault(img_key(x["model"], x["power"], x["cct"]), x["imgid"])
                model_imgs.setdefault(x["model"], []).append(x["imgid"])
            if x["category"]:
                model2cat.setdefault(x["model"], x["category"])

    models: list[dict] = []
    seen: dict[str, int] = {}

    def add(mid: str, model: str, variant: str, name: str, type_: str, p: dict,
            price: float | None, dealer: float | None, spec: str, source: str,
            brand_label: str, series: str, imgid: str = "") -> None:
        key = mid
        seen[key] = seen.get(key, 0) + 1
        if seen[key] > 1:
            mid = f"{mid}-{seen[key]}"
        models.append({
            "id": mid,
            "brand": "philips",
            "brandLabel": brand_label,
            "series": series,
            "model": model,
            "variant": variant,
            "name": name,
            "type": type_,
            "image": None,
            "_imgid": imgid or None,
            "params": p,
            "price": {"amount": price, "currency": "CNY", "basis": "建议最低零售价",
                      "verified": True,
                      "source": "Philips Wiz&Hue体系产品解决方案清单合作伙伴价格体系表-2025"},
            "dealerPrice": {"amount": dealer, "currency": "CNY", "basis": "经销商价格"},
            "spec": spec,
            "source": source,
        })

    for cells in wiz_rows:
        no, _img, brand, model, params_raw, cct_raw, beam_raw, glare_raw, unit, _pack, retail, dealer, note = cells
        no = int(no)
        model = re.sub(r"\s*/\s*", " ", model).strip()
        if no > 29:  # 30-34 是球泡 / 烛泡 / 声光同步套装，不进灯具选型
            continue
        name = ""
        m = re.search(r"名称[:：]\s*(.*?)(?:\s*(?:材质|产品尺寸|灯具尺寸|色温)[:：]|$)", params_raw)
        if m:
            name = m.group(1).strip()
        name = name or model
        p = params_of(params_raw)
        cct = cct_of(cct_raw)
        if cct:
            p["cct"] = cct
        beam = beam_of(beam_raw)
        if beam:
            p["beam"] = beam
        glare = glare_of(glare_raw)
        if glare:
            p["glare"] = glare
        p["power"] = p.get("power") or None
        type_ = ph_type(name, model2cat.get(model, ""))
        variant_bits = []
        if p.get("power"):
            variant_bits.append(f"{p['power']:g}W")
        if p.get("cutout"):
            variant_bits.append(f"开孔{p['cutout']}")
        variant = " · ".join(variant_bits)
        mid = "philips-wiz-" + slug(f"{model}-{variant}", 80)
        add(mid, model, variant, name, type_, p,
            money(retail), money(dealer), params_raw,
            "Philips Wiz&Hue体系产品解决方案清单合作伙伴价格体系表-2025（Wiz 灯具表）",
            "飞利浦 WiZ", "WiZ", model2img.get(img_key(model, p.get("power"), cct_raw), ""))

    # Hue：价目表 7 列表格（编号 1-33），只取灯具，不取传感器 / 开关 / 桥接 / 同步盒 / 驱动 / 轨道 / 配件。
    hue_specs = {
        "929003531901": dict(name="Infuse 睿喜白光和彩光氛围吸顶灯", type_="吸顶灯", power=52.5, lumen=3700,
                             size="425×425×86mm", cct=None),
        "929003123601": dict(name="51105 睿玥 LED 智能筒灯 圆形", type_="筒灯", power=4.5, lumen=350,
                             size="95×95×60mm", cutout="80mm", cct=None),
        "929002269102": dict(name="Hue LIGHTSTRIP PLUS V4 CN 2米 基础装", type_="灯带", power=20, lumen=1700,
                             size="2000×14.5×5.5mm", cct=None),
        "929002269202": dict(name="Hue LIGHTSTRIP PLUS V4 CN 1米 延展装", type_="灯带", power=None, lumen=1030,
                             size="1000×14.5×5.5mm", cct=None),
        "929003498507": dict(name="Hue 电脑 PC 渐变灯带（24-27寸）", type_="灯带", power=15, lumen=800,
                             size="17×16×905mm", cct=None),
        "929003498607": dict(name="Hue 电脑 PC 渐变灯带（32-34寸）", type_="灯带", power=32, lumen=2550,
                             size="17×16×1165mm", cct=None),
        "929002422804": dict(name="Hue 电视 PC 渐变灯带（65寸）", type_="灯带", power=20, lumen=1100,
                             size="17×16×2540mm", cct=None),
        "929002422904": dict(name="Hue 电视 PC 渐变灯带（75寸）", type_="灯带", power=20, lumen=1100,
                             size="17×16×3040mm", cct=None),
        "929003555101": dict(name="Hue 睿迹 彩光渐变落地灯", type_="落地灯", power=19, lumen=1000,
                             size="111×111×1458mm", cct=None),
        "915005822201": dict(name="Hue Go 二代魔灯", type_="台灯", power=6.2, lumen=530,
                             size="150×150×80mm", cct={"kind": "range", "min": 2000, "max": 6500, "rgb": True}),
        "929003128901": dict(name="Hue Go 便携桌灯 白色", type_="台灯", power=6.2, lumen=530,
                             size="142×142×350mm", cct={"kind": "range", "min": 2000, "max": 6500, "rgb": True}),
        "929003644501": dict(name="Perifo 磁吸轨道圆柱型射灯", type_="磁吸轨道", power=5.3, lumen=510,
                             size="177×67×128mm", cct=None, beam={"kind": "fixed", "value": 38}),
        "929003644701": dict(name="Perifo 磁吸轨道垂吊射灯", type_="磁吸轨道", power=5.3, lumen=510,
                             size="177×67×288mm", cct=None, beam={"kind": "fixed", "value": 38}),
        "929003644901": dict(name="Perifo 磁吸轨道线性灯", type_="线性灯", power=29, lumen=2050,
                             size="950×26.2×64.5mm", cct=None),
        "929003645101": dict(name="Perifo 磁吸轨道渐变灯管（短款）", type_="磁吸轨道", power=12, lumen=1060,
                             size="713.5×26.2×67.7mm", cct=None),
        "929003645301": dict(name="Perifo 磁吸轨道渐变灯管（长款）", type_="磁吸轨道", power=29.5, lumen=2050,
                             size="1190×26.2×67.7mm", cct=None),
    }
    for cells in hue_rows:
        no, _img, brand, name, code, retail, dealer = cells
        code = code.strip()
        if code not in hue_specs:
            continue
        s = hue_specs[code]
        p: dict = {"power": s["power"]}
        if s.get("lumen"):
            p["lumen"] = s["lumen"]
        if s.get("size"):
            p["size"] = s["size"]
        if s.get("cutout"):
            p["cutout"] = s["cutout"]
        if s.get("cct"):
            p["cct"] = s["cct"]
        if s.get("beam"):
            p["beam"] = s["beam"]
        mid = "philips-hue-" + slug(code, 60)
        imgid = model2img.get(img_key(code, s["power"], "")) or ""
        if not imgid:
            uniq = sorted(set(model_imgs.get(code, [])))
            if len(uniq) == 1:
                imgid = uniq[0]
        add(mid, code, "", s["name"], s["type_"], p, money(retail), money(dealer),
            f"{s['name']} · {code}", "Philips Wiz&Hue体系产品解决方案清单合作伙伴价格体系表-2025（Hue 表）"
            " + Hue + Wiz 产品手册（0815）", "飞利浦 Hue", "Hue", imgid)

    # 同型号同规格文字（SL670 可调 / 不可调、XQ709520 Φ103 / Φ124）用尺寸或角度区分
    seen2: dict[tuple[str, str], int] = {}
    for m in models:
        k = (m["model"], m["variant"])
        seen2[k] = seen2.get(k, 0) + 1
        if seen2[k] > 1:
            adj = "可调" if "可调" in m["spec"] else "固定"
            extra = " · ".join(x for x in [adj, m["params"].get("size", "")] if x)
            m["variant"] = f"{m['variant']} · {extra}".strip(" ·")
            m["id"] = re.sub(r"-\d+$", "", m["id"]) + "-" + slug(extra, 24) + f"-{seen2[k]}"
    # 图片按最终 id 落盘：上面的去重会再改一次 id，先写图会写出孤儿文件
    for m in models:
        imgid = m.pop("_imgid", None)
        if imgid and imgid in media:
            im = Image.open(__import__("io").BytesIO(media[imgid]))
            dst = img_dir / "philips" / f"{m['id']}.webp"
            m["params"]["imageSize"] = write_image(im, dst, max_side=320)
            m["image"] = f"philips/{dst.name}"
    return models


# ---------------------------------------------------------------- FLOS

def name_tokens(s: str) -> set[str]:
    s = unicodedata.normalize("NFKD", s or "").lower()
    s = re.sub(r"[^a-z0-9]+", " ", s)
    stop = {"the", "and", "with", "for", "led", "kit", "set", "small", "mini", "new"}
    return {t for t in s.split() if len(t) > 1 and t not in stop}


def flos_type(install: str) -> str:
    i = (install or "").lower()
    if "suspension" in i or "吊装" in i:
        return "吊灯"
    if "ceiling" in i and "wall" not in i:
        return "吸顶灯"
    if "ceiling" in i:
        return "吸顶灯"
    if "wall" in i:
        return "壁灯"
    if "floor" in i or "落地" in i:
        return "落地灯"
    if "table" in i or "portable" in i:
        return "台灯"
    return "其他灯具"


def flos_cct(row: dict, bulb_kelvins: dict[str, list[int]]) -> dict | None:
    k = num(row.get("色温(K)"))
    if k and 1500 <= k <= 12000:
        return {"kind": "fixed", "value": int(k)}
    opts = bulb_kelvins.get(row["产品名称"].strip())
    if opts:
        uniq = sorted(set(opts))
        if len(uniq) == 1:
            return {"kind": "fixed", "value": uniq[0]}
        return {"kind": "options", "options": uniq, "default": uniq[0]}
    return None


def flos_power_lumen(row: dict) -> tuple[float | None, int | None]:
    src = row.get("光源", "")
    power = None
    m = re.search(r"([\d.,]+)\s*W", src)
    if m:
        power = num(m.group(1))
    if power is None:
        m = re.search(r"([\d.,]+)\s*W", row.get("功率", ""))
        if m:
            power = num(m.group(1))
    lumen = None
    m = re.search(r"([\d.,]+)\s*lm", src)
    if m:
        lumen = int(num(m.group(1)) or 0) or None
    if not lumen:
        lumen = int(num(row.get("实际光通量(lm)")) or 0) or None
    return power, lumen


def flos_bulb_kelvins(vault: Path) -> dict[str, list[int]]:
    out: dict[str, list[int]] = {}
    path = vault / FLOS_LIGHT
    for row in csv.DictReader(path.open(encoding="utf-8-sig")):
        fit = (row.get("fitting") or "").strip()
        ks = [int(x) for x in re.findall(r"(\d{4})\s*K", row.get("kelvin") or "")]
        if fit and ks:
            out.setdefault(fit, []).extend(ks)
    return out


def flos_family(name: str) -> str:
    norm = unicodedata.normalize("NFKD", name or "").lower()
    toks = re.findall(r"[a-z0-9]+", norm)
    return toks[0] if toks else ""


def flos_bad_pdf(pdf: Path) -> bool:
    return bool(re.search(r"dimmer|alimentatore|trasformatore|accessor|driver", pdf.stem.lower()))


def pick_flos_pdf(row: dict, pdfs: list[Path]) -> tuple[Path | None, float]:
    """规格书按价目表行序编号（README：197 份对 197 项）。同序号且产品族名对得上就认，
    这样 CL III 这种只有控制模块不同、规格书沿用基础款的也能拿到同一灯具的图；
    规格书写成调光器 / 驱动器的不认。序号对不上时退回按名称相似度找。"""
    idx = int(row["序号"]) - 1
    fam = flos_family(row["产品名称"])
    if 0 <= idx < len(pdfs):
        same = pdfs[idx]
        if same.name.startswith(f"{idx:03d}_") and fam and fam in same.stem.lower() and not flos_bad_pdf(same):
            return same, 1.0
    want = name_tokens(row["产品名称"])
    code = re.sub(r"[^0-9a-z.]", "", row["主代码"].split("/")[0].strip().lower())
    best: tuple[float, Path | None] = (0.0, None)
    for pdf in pdfs:
        if flos_bad_pdf(pdf):
            continue
        stem = pdf.stem.lower()
        toks = name_tokens(re.sub(r"^\d+_tech-spec-", "", stem).split("_")[0])
        score = len(want & toks) / max(1, len(want))
        if code and code in stem:
            score += 1.0
        if score > best[0]:
            best = (score, pdf)
    return best[1], best[0]


def extract_pdf_image(pdf: Path) -> tuple[Image.Image | None, list[int] | None]:
    """取规格书第 1 页最大的一张产品照。带 SMask 的图多是投影 / 蒙版（RGB 全黑），跳过；
    全黑或全白的占位图也跳过，宁可无图也不放一张黑块。"""
    import io

    doc = fitz.open(pdf)
    best: tuple[int, Image.Image] | None = None
    for page in doc[:2]:
        for info in page.get_images(full=True):
            xref, smask, w, h = info[0], info[1], info[2], info[3]
            if smask:
                continue
            if w < 120 or h < 120 or not 0.45 <= w / h <= 2.2:
                continue
            try:
                raw = doc.extract_image(xref)
                im = Image.open(io.BytesIO(raw["image"]))
            except Exception:
                continue
            im = im.convert("RGBA")
            flat = Image.new("RGB", im.size, (255, 255, 255))
            flat.paste(im, mask=im.split()[-1])
            gray = flat.convert("L")
            lo, hi = gray.getextrema()
            if hi - lo < 24:
                continue
            area = w * h
            if best is None or area > best[0]:
                best = (area, flat)
        if best:
            break
    doc.close()
    return (best[1], [best[1].width, best[1].height]) if best else (None, None)


def build_flos(vault: Path, img_dir: Path, report: list[str]) -> list[dict]:
    rows = list(csv.DictReader((vault / FLOS_PARAMS).open(encoding="utf-8-sig")))
    prices = {r["序号"]: r for r in csv.DictReader((vault / FLOS_PRICE).open(encoding="utf-8-sig"))}
    bulbs = flos_bulb_kelvins(vault)
    pdfs = sorted((vault / FLOS_PDF_DIR).glob("*.pdf"))

    models: list[dict] = []
    for row in rows:
        name = row["产品名称"].strip()
        code_full = row["主代码"].strip()
        code = code_full.split("/")[0].strip() or f"row{row['序号']}"
        light_src = (row.get("光源") or "").upper()
        ctrl = " · Casambi" if "CASAMBI" in light_src else (" · 触控调光" if "TOUCH" in light_src else "")
        price_row = prices.get(row["序号"], {})
        retail = money(price_row.get("统一零售价(65折)"))
        list_price = money(price_row.get("标价(欧元)"))
        power, lumen = flos_power_lumen(row)
        cct = flos_cct(row, bulbs)
        finishes = [x.strip() for x in re.split(r"[,;]", row.get("颜色饰面") or "") if x.strip()]
        p: dict = {}
        if power:
            p["power"] = power
        if lumen:
            p["lumen"] = lumen
        if cct:
            p["cct"] = cct
        if len(finishes) > 1:
            p["finish"] = {"options": finishes}
        elif finishes:
            p["finish"] = {"fixed": finishes[0]}
        if row.get("IP"):
            p["ip"] = row["IP"] if str(row["IP"]).upper().startswith("IP") else f"IP{row['IP']}"
        if row.get("尺寸"):
            p["size"] = row["尺寸"]
        mid = "flos-" + slug(f"{name}-{code}", 70)
        pdf, score = pick_flos_pdf(row, pdfs)
        image = None
        if pdf is not None and score >= 0.99:
            im, size = extract_pdf_image(pdf)
            if im is not None:
                dst = img_dir / "flos" / f"{mid}.webp"
                p["imageSize"] = write_image(im, dst, max_side=480)
                image = f"flos/{dst.name}"
        if pdf is not None and score < 0.99:
            report.append(f"FLOS 无可靠规格书：{row['序号']} {name}（最佳 {pdf.name}，分 {score:.2f}）")
        models.append({
            "id": mid,
            "brand": "flos",
            "brandLabel": "FLOS",
            "series": code_full if code_full != code else "",
            "model": code,
            "variant": f"{name}{ctrl}",
            "name": name,
            "type": flos_type(row.get("安装方式", "")),
            "image": image,
            "params": p,
            "price": {"amount": retail, "currency": "EUR", "basis": "统一零售价（65折）",
                      "verified": True, "listPrice": list_price,
                      "source": "FLOS 2024年3月中国区装饰系列建议零售价目表"},
            "dealerPrice": {"amount": money(price_row.get("拿货价(6折)")), "currency": "EUR", "basis": "拿货价（6折）"},
            "spec": " · ".join(x for x in [
                row.get("设计师", ""), row.get("尺寸", ""), row.get("光源", ""),
                f"色温 {row['色温(K)']}K" if row.get("色温(K)") else "",
                f"{row['实际光通量(lm)']}lm" if row.get("实际光通量(lm)") else "",
                row.get("材质", ""), row.get("调光", ""),
            ] if x),
            "source": "FLOS 2024年3月中国区装饰系列建议零售价目表（产品参数总表）",
        })
    return models


# ---------------------------------------------------------------- main

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--vault", default="/private/tmp/nas/知识库/15-产品库")
    ap.add_argument("--out", default="backend/catalog")
    args = ap.parse_args()
    vault = Path(args.vault)
    out = Path(args.out)
    if not (vault / PH_PRICE_MD).exists():
        print(f"知识库不可读：{vault / PH_PRICE_MD}", file=sys.stderr)
        print("先把 NAS 只读挂载到 /private/tmp/nas（或传 --vault 指向 15-产品库）。", file=sys.stderr)
        return 2

    img_dir = out / "img"
    if img_dir.exists():
        shutil.rmtree(img_dir)
    img_dir.mkdir(parents=True, exist_ok=True)

    report: list[str] = []
    philips = build_philips(vault, img_dir)
    flos = build_flos(vault, img_dir, report)

    catalog = {
        "schemaVersion": 1,
        "note": "只收灯具：飞利浦 WiZ/Hue 灯具 + FLOS 装饰灯具；驱动/电源/面板/轨道/配件/灯泡不收。",
        "sources": {
            "philipsPrice": "知识库/15-产品库/" + PH_PRICE_MD,
            "philipsInquiry": "知识库/15-产品库/" + PH_XLSX,
            "flosParams": "知识库/15-产品库/" + FLOS_PARAMS,
            "flosPrice": "知识库/15-产品库/" + FLOS_PRICE,
        },
        "brands": [
            {"id": "philips", "name": "飞利浦", "series": ["WiZ", "Hue"], "models": philips},
            {"id": "flos", "name": "FLOS", "series": [], "models": flos},
        ],
    }
    seen_ids: dict[str, int] = {}
    for b in catalog["brands"]:
        for m in b["models"]:
            n = seen_ids.get(m["id"], 0) + 1
            seen_ids[m["id"]] = n
            if n > 1:
                m["id"] = f"{m['id']}-{n}"
    out.mkdir(parents=True, exist_ok=True)
    (out / "catalog.json").write_text(
        json.dumps(catalog, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    by_brand: dict[str, list[dict]] = {}
    for b in catalog["brands"]:
        by_brand[b["id"]] = b["models"]
    for bid, ms in by_brand.items():
        imgs = sum(1 for m in ms if m["image"])
        print(f"{bid}: {len(ms)} 个型号，{imgs} 张图，{len(ms) - imgs} 个无图")
    for line in report[:40]:
        print("  " + line)
    print("输出：", (out / "catalog.json").resolve())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
