"""§5.2 品牌墙 + §7.9 P2 四层选品的代码正本（阶段 1，终极形态 v3 定稿）。

三条口径写死在这里，别处不再解释一遍：
1. 系统根本不存成本口径（§5.2 拍板）：写入只认 DTO 白名单，白名单外一律拒（422），
   不是「忽略」；金额永远只从 retail_price 读，任何折算系数都不许出现。
   旧价目表的折扣系数只活在迁移参考里，不是运行时概念。
2. L0 是硬闸不是权重：`WHERE 参数满足` 先于一切排序。交集为空就是 0 结果，
   返回「无合格品」，不降级推荐——独家品牌也不允许把装不上的灯顶回第一。
3. 授权层级是底牌：个人版只按参数＋价格排序、不显示独家/授权身份；
   企业版才用 L1 排序并露出层级与 valid_to（§5.2 Q4 拍板的数据分层）。

数据落在随源码分发的 `local_data/brands.json`（brand/brand_auth 两张表的记录），
产品复用 `local_data/products.json` 的 230 款零售价库；不动库表结构。
禁令词表在 `price_terms.py`（那是词表，不是金额计算，闸③按此排除它）。
"""
from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from pathlib import Path

from . import price_terms as PT

LOCAL_DIR = Path(__file__).resolve().parent / "local_data"
BRANDS_PATH = LOCAL_DIR / "brands.json"
PRODUCTS_PATH = LOCAL_DIR / "products.json"

PRICE_SCOPE = "零售价"
CURRENCY = "CNY"

# §5.2 闸①：结构上不存在这些字段；出现即拒，不给「悄悄收进备注」留口子。
FORBIDDEN_FIELDS = PT.FIELD_TERMS
FORBIDDEN_WORDS = PT.WORD_TERMS

TIER_EXCLUSIVE, TIER_AUTHORIZED, TIER_NONE = "EXCLUSIVE", "AUTHORIZED", "NONE"
TIERS = (TIER_EXCLUSIVE, TIER_AUTHORIZED, TIER_NONE)
TIER_RANK = {TIER_EXCLUSIVE: 0, TIER_AUTHORIZED: 1, TIER_NONE: 2}
TIER_LABELS = {TIER_EXCLUSIVE: "独家", TIER_AUTHORIZED: "有授权", TIER_NONE: "无授权"}

EDITION_PERSONAL, EDITION_ENTERPRISE = "personal", "enterprise"
EDITIONS = (EDITION_PERSONAL, EDITION_ENTERPRISE)

# §5.2 闸②：产品写入 DTO 白名单，就这四个键（price_scope 是常量校验，不由客户端给）
PRODUCT_DTO_FIELDS = ("model", "params", "retail_price", "currency")

NO_QUALIFIED = "无合格品"


def _norm(text) -> str:
    return unicodedata.normalize("NFKC", str(text or "")).strip()


def forbidden_hits(text) -> list[str]:
    """闸③的文案侧兜底：备注/来源里也不许出现成本口径的词。"""
    s = _norm(text)
    return [w for w in FORBIDDEN_WORDS if w in s] + [w for w in FORBIDDEN_FIELDS if w in s.lower()]


class ScopeError(ValueError):
    """价格口径不是「零售价」/ 写入带禁字段——一律拒，不静默丢弃。"""


def assert_retail_scope(value) -> str:
    v = _norm(value) or PRICE_SCOPE
    if v != PRICE_SCOPE:
        raise ScopeError(f"价格口径只允许「{PRICE_SCOPE}」，收到「{value}」："
                         f"存进成本口径＝把进货成本写进客户能看到的单据（§5.2 拍板：结构上不存在成本字段）")
    return v


# ---------------------------------------------------------------- 数据装载


def load_brands(path: Path | str | None = None) -> dict:
    payload = json.loads(Path(path or BRANDS_PATH).read_text(encoding="utf-8"))
    brands = {b["id"]: dict(b) for b in payload.get("brands", [])}
    auth = {}
    for a in payload.get("auth", []):
        auth.setdefault(a["brand_id"], []).append(dict(a))
    for b in brands.values():
        b.setdefault("status", "合作中")
        b.setdefault("sort_hint", 100)
    return {"brands": brands, "auth": auth,
            "schema": payload.get("schema", 1),
            "priceScope": payload.get("priceScope", PRICE_SCOPE)}


def load_products(path: Path | str | None = None) -> list[dict]:
    payload = json.loads(Path(path or PRODUCTS_PATH).read_text(encoding="utf-8"))
    out = []
    for r in payload.get("products", []):
        p = dict(r)
        p["retail_price"] = p.get("price")
        p["price_scope"] = _norm(p.get("price_source")) or PRICE_SCOPE
        p["sku"] = p.get("id") or ""
        out.append(p)
    return out


def retail_of(product: dict):
    """金额只从这一处读——没有任何 ×系数。"""
    price = product.get("retail_price")
    if price is None:
        price = product.get("price")
    try:
        v = float(price)
    except (TypeError, ValueError):
        return None
    return v if v > 0 else None


# ---------------------------------------------------------------- 授权层级


def tier_for(loaded: dict, brand_id: str) -> dict:
    """缺授权记录按 NONE 处理，并计一条数据质量告警（§5.2 排序实现表 L1 行的拒收口径）。"""
    recs = [a for a in loaded["auth"].get(brand_id, []) if _norm(a.get("tier")) in TIERS]
    if not recs:
        return {"brand_id": brand_id, "tier": TIER_NONE, "label": TIER_LABELS[TIER_NONE],
                "recorded": False, "valid_to": "", "warning": "缺授权记录，按 NONE 处理"}
    # 同一品牌多条授权取最优层级；region/valid_to 明细属企业版
    best = sorted(recs, key=lambda a: TIER_RANK[_norm(a["tier"])])[0]
    return {"brand_id": brand_id, "tier": _norm(best["tier"]),
            "label": TIER_LABELS[_norm(best["tier"])], "recorded": True,
            "valid_to": _norm(best.get("valid_to")), "region": _norm(best.get("region")),
            "warning": ""}


def brand_id_for(loaded: dict, name_or_id: str) -> str:
    """产品行只写品牌名，授权表按 id 记——两者对不上就等于全员 NONE，L1 排序是空的。"""
    want = _norm(name_or_id)
    if want in loaded["brands"]:
        return want
    for bid, b in loaded["brands"].items():
        if _norm(b.get("name")) == want:
            return bid
    return want


def brand_wall(products: list[dict] | None = None, loaded: dict | None = None,
               logo_dir: Path | str | None = None, edition: str = EDITION_PERSONAL) -> dict:
    """品牌墙两处展示位之一（选品面板）的数据；报价单品牌区另走 quote()。"""
    loaded = loaded or load_brands()
    products = products if products is not None else load_products()
    logo_dir = Path(logo_dir or LOCAL_DIR)
    counts: dict[str, int] = {}
    priced: dict[str, int] = {}
    for p in products:
        b = _norm(p.get("brand"))
        counts[b] = counts.get(b, 0) + 1
        if retail_of(p) is not None:
            priced[b] = priced.get(b, 0) + 1
    rows, warnings = [], []
    for bid, b in sorted(loaded["brands"].items(), key=lambda kv: (kv[1].get("sort_hint", 100), kv[0])):
        t = tier_for(loaded, bid)
        name = _norm(b.get("name")) or bid
        logo = _norm(b.get("logo_path"))
        logo_file = (logo_dir / logo) if logo else None
        logo_ok = bool(logo_file and logo_file.is_file() and logo_file.stat().st_size > 0)
        if t["warning"]:
            warnings.append(f"{name}：{t['warning']}")
        if not logo_ok:
            warnings.append(f"{name}：logo 加载不到（{logo or '未登记 logo_path'}）")
        rows.append({
            "brand_id": bid, "name": name, "status": _norm(b.get("status")),
            "logo_path": logo, "logo_ok": logo_ok,
            "product_count": counts.get(name, 0), "priced_count": priced.get(name, 0),
            # 个人版不露授权身份：只按 L0 硬闸过滤，不显示独家/有授权、不给 valid_to
            "tier": t["tier"] if edition == EDITION_ENTERPRISE else "",
            "tier_label": t["label"] if edition == EDITION_ENTERPRISE else "",
            "valid_to": t["valid_to"] if edition == EDITION_ENTERPRISE else "",
            "auth_recorded": t["recorded"],
        })
    cover = sum(1 for r in rows if r["auth_recorded"])
    return {
        "rows": rows, "brandCount": len(rows),
        "logoLoadable": sum(1 for r in rows if r["logo_ok"]),
        "authCovered": cover,
        "authCoverage": round(cover / len(rows) * 100, 1) if rows else 0.0,
        "dataQualityWarnings": warnings,
        "edition": edition,
        # 阶段 1 门槛【建议】：≥5 家 × 每家 ≥10 款，够跑通品牌墙
        "thresholdMet": len(rows) >= 5 and all(r["product_count"] >= 10 for r in rows),
        "rule": "只展示合作品牌的终端零售价；授权层级明细与 L1 排序只在企业版（§5.2 Q4 拍板）",
    }


# ---------------------------------------------------------------- L0 硬闸


def _cutout_mm(text):
    m = re.search(r"(?:Φ|φ|Ø|D|d)?\s*(\d+(?:\.\d+)?)", _norm(text))
    return float(m.group(1)) if m else None


def _cct_values(product: dict) -> list[float]:
    out = []
    for key in ("cct_min", "cct_max"):
        try:
            out.append(float(product.get(key)))
        except (TypeError, ValueError):
            pass
    for tok in re.findall(r"(\d{3,4})", _norm(product.get("cct"))):
        out.append(float(tok))
    if product.get("tunable"):
        out.extend([2700.0, 6500.0])
    return [v for v in out if 1000 <= v <= 10000]


def l0_failures(product: dict, req: dict) -> list[str]:
    """逐条给出「参数不符」的原因；空列表＝过 L0。缺失即不符，不做模糊匹配。"""
    bad = []
    cat = _norm(req.get("category"))
    if cat and _norm(product.get("category")) != cat:
        want = {"灯具": "light", "智能设备": "device", "灯带": "strip"}.get(cat, cat)
        if _norm(product.get("category")) != want:
            bad.append(f"品类不符（要 {cat}，产品 {product.get('category') or '空'}）")
    pmin, pmax = req.get("watt_min"), req.get("watt_max")
    watt = product.get("watt")
    if pmin is not None or pmax is not None:
        try:
            w = float(watt)
        except (TypeError, ValueError):
            bad.append("功率读不出，无法核 L0")
        else:
            if pmin is not None and w < float(pmin):
                bad.append(f"功率 {w:g}W < 需求 {float(pmin):g}W")
            if pmax is not None and w > float(pmax):
                bad.append(f"功率 {w:g}W > 需求 {float(pmax):g}W")
    cct = req.get("cct")
    if cct is not None:
        vals = _cct_values(product)
        want = float(re.sub(r"[^\d.]", "", str(cct)) or 0)
        if not vals:
            bad.append(f"色温读不出，无法核 L0（需求 {want:g}K）")
        elif not (min(vals) <= want <= max(vals)):
            bad.append(f"色温 {min(vals):g}–{max(vals):g}K 不含需求 {want:g}K")
    aamax, aamin = req.get("angle_max"), req.get("angle_min")
    if aamax is not None or aamin is not None:
        try:
            a = float(product.get("angle"))
        except (TypeError, ValueError):
            bad.append("光束角读不出，无法核 L0")
        else:
            if aamax is not None and a > float(aamax):
                bad.append(f"光束角 {a:g}° > 需求 {float(aamax):g}°（装上去光斑打大）")
            if aamin is not None and a < float(aamin):
                bad.append(f"光束角 {a:g}° < 需求 {float(aamin):g}°")
    cmax = req.get("cutout_max_mm")
    if cmax is not None:
        got = _cutout_mm(product.get("cutout"))
        if got is None:
            bad.append(f"开孔尺寸读不出，无法核 L0（上限 {float(cmax):g}mm）")
        elif got > float(cmax):
            bad.append(f"开孔 Φ{got:g} > 现场 {float(cmax):g}（板面装不下）")
    dim = _norm(req.get("dimmable"))
    if dim and dim not in _norm(product.get("dimmable")):
        bad.append(f"调光能力不符（要 {dim}，产品 {product.get('dimmable') or '空'}）")
    ctrl = _norm(req.get("control"))
    if ctrl and ctrl not in (_norm(product.get("control")) + _norm(product.get("protocol"))):
        bad.append(f"控制协议不符（要 {ctrl}，产品 {product.get('control') or product.get('protocol') or '空'}）")
    sch = _norm(req.get("scheme"))
    if sch and sch not in _norm(product.get("scheme")):
        bad.append(f"方案类型不符（要 {sch}，产品 {product.get('scheme') or '空'}）")
    brands = req.get("brand_in")
    if brands and _norm(product.get("brand")) not in [_norm(x) for x in brands]:
        bad.append(f"品牌不在需求范围（{product.get('brand') or '空'}）")
    return bad


def passes_l0(product: dict, req: dict) -> bool:
    return not l0_failures(product, req)


def rank_candidates(products: list[dict], req: dict, *,
                    loaded: dict | None = None,
                    edition: str = EDITION_PERSONAL) -> dict:
    """L0 WHERE 前置过滤 → L1 授权（仅企业版）→ L2 价/交期/库存。空即空，不降级。"""
    loaded = loaded or load_brands()
    kept = []
    rejected = []
    for p in products:
        bad = l0_failures(p, req)
        if bad:
            rejected.append({"sku": p.get("sku") or p.get("id") or "",
                             "model": p.get("model") or p.get("name"),
                             "why": bad})
            continue
        row = dict(p)
        row["hard_gate_pass"] = True          # 派生字段：不落库，只在这一刻算
        row["tier"] = tier_for(loaded, brand_id_for(loaded, p.get("brand")))["tier"]
        kept.append(row)
    if not kept:
        return {"rows": [], "noQualified": True, "label": NO_QUALIFIED,
                "checked": len(products), "rejected": rejected[:50],
                "rule": "L0 硬闸：参数不符即不出现；交集为空返回「无合格品」，不降级推荐（§5.2）"}
    price_key = lambda r: (retail_of(r) is None, retail_of(r) if retail_of(r) is not None else 0.0)
    lead_key = lambda r: (r.get("lead_time_days") is None, r.get("lead_time_days") or 0)
    stock_key = lambda r: -(r.get("stock_qty") or 0)
    # L1 是排序键的第一位（企业版）；个人版这一位恒为 0，等于只按参数＋价格
    kept.sort(key=lambda r: ((0 if edition != EDITION_ENTERPRISE
                              else TIER_RANK.get(r["tier"], 2)),
                             price_key(r)[0], price_key(r)[1],
                             lead_key(r)[0], lead_key(r)[1], stock_key(r)))
    tail = kept
    rows = []
    for i, r in enumerate(tail, start=1):
        rows.append({
            "rank": i, "sku": r.get("sku") or r.get("id") or "",
            "model": r.get("model") or r.get("name"),
            "brand": r.get("brand", ""), "hard_gate_pass": True,
            "retail_price": retail_of(r), "price_scope": PRICE_SCOPE,
            "currency": CURRENCY,
            "tier": r["tier"] if edition == EDITION_ENTERPRISE else "",
            "manual_override": False,
        })
    return {"rows": rows, "noQualified": False, "label": "",
            "checked": len(products), "qualified": len(rows),
            "rejected": rejected[:50],
            "edition": edition,
            "rule": "L0 WHERE 先于排序"
                    + ("；L1 独家>授权>无授权；L2 价格优>交期短>库存足（空值排末位）"
                       if edition == EDITION_ENTERPRISE
                       else "；个人版不排 L1，只按参数＋价格")}


def rank_snapshot(candidates: dict, req: dict, *, edition: str = EDITION_PERSONAL) -> str:
    """报价生成时存快照：改价后旧报价仍可复现（§7.9 rank_snapshot）。"""
    rows = candidates.get("rows") or []
    body = "|".join(f'{r.get("sku") or r.get("id") or ""}:{r.get("tier") or ""}:'
                    f'{r.get("retail_price") or "无价"}' for r in rows)
    req_s = json.dumps(req, ensure_ascii=False, sort_keys=True, default=str)
    tag = "L0+L1+L2" if edition == EDITION_ENTERPRISE else "L0+L2"
    digest = hashlib.sha256(f"{tag}|{req_s}|{body}".encode("utf-8")).hexdigest()[:16]
    return f"{tag}:{digest}:n={len(rows)}"


def apply_manual_override(rows: list[dict], sku: str, *, by: str, note: str,
                          reason: str = "") -> list[dict]:
    """L3 人工改选可以覆盖 L1/L2，但必须留痕，不静默（§5.2 L3 拒收条件）。"""
    if not _norm(by):
        raise ScopeError("人工改选必须留人：谁改的")
    if not (_norm(note) or _norm(reason)):
        raise ScopeError("人工改选必须写理由或说明，否则清单上看不出这是覆盖")
    hit = next((r for r in rows if _norm(r.get("sku")) == _norm(sku)), None)
    if hit is None:
        raise ScopeError(f"改选对象不在本次候选里：{sku}（L0 未过的 SKU 不允许被顶进来）")
    out = [dict(r) for r in rows]
    target = next(r for r in out if _norm(r.get("sku")) == _norm(sku))
    target["manual_override"] = True
    target["override_by"] = _norm(by)
    target["override_note"] = _norm(note or reason)
    out.insert(0, out.pop(out.index(target)))
    for i, r in enumerate(out, start=1):
        r["rank"] = i
    return out


# ---------------------------------------------------------------- 写入闸


def ingest_product(payload: dict) -> dict:
    """§5.2 闸②：白名单外的键报 422 而不是忽略。"""
    if not isinstance(payload, dict):
        raise ScopeError("产品写入必须是对象")
    keys = {k for k in payload if _norm(k)}
    extra = sorted(keys - set(PRODUCT_DTO_FIELDS) - {"id", "brand_id", "name", "unit"})
    if extra:
        raise ScopeError(f"产品写入含不允许的字段：{'、'.join(extra)}"
                         f"（白名单只有 {'、'.join(PRODUCT_DTO_FIELDS)}；成本口径字段结构上不存在）")
    hits = forbidden_hits(json.dumps(payload, ensure_ascii=False, default=str))
    if hits:
        raise ScopeError(f"写入内容里出现成本口径词：{'、'.join(sorted(set(hits)))}")
    assert_retail_scope(payload.get("price_scope"))
    params = payload.get("params") or {}
    if not isinstance(params, dict):
        raise ScopeError("params 必须是键值对象")
    price = payload.get("retail_price")
    try:
        price = float(price) if price is not None else None
    except (TypeError, ValueError):
        raise ScopeError(f"零售价读不出：{price!r}")
    if price is not None and price <= 0:
        raise ScopeError("零售价必须 >0（无价就留空，不写 0 冒充已核）")
    return {"id": _norm(payload.get("id")), "model": _norm(payload.get("model")),
            "brand_id": _norm(payload.get("brand_id")), "name": _norm(payload.get("name")),
            "params": dict(params), "retail_price": price,
            "price_scope": PRICE_SCOPE,
            "currency": _norm(payload.get("currency")) or CURRENCY,
            "unit": _norm(payload.get("unit")) or "个"}


# ---------------------------------------------------------------- 报价单


def quote_lines(lines: list[dict], products_by_sku: dict[str, dict],
                snapshot: str = "") -> dict:
    """lines＝[{sku, qty, note}]。金额＝Σ(零售价×数量)，只从 retail_price 读。"""
    out, total, unpriced = [], 0.0, []
    for ln in lines:
        sku = _norm(ln.get("sku"))
        prod = products_by_sku.get(sku)
        if prod is None:
            raise ScopeError(f"SKU 不在产品库：{sku or '（空）'}")
        assert_retail_scope(prod.get("price_scope"))
        bad = forbidden_hits(ln.get("note")) or forbidden_hits(prod.get("notes"))
        if bad:
            raise ScopeError(f"报价行里出现成本口径词：{'、'.join(sorted(set(bad)))}")
        try:
            qty = float(ln.get("qty") or 0)
        except (TypeError, ValueError):
            raise ScopeError(f"数量读不出：{ln.get('qty')!r}")
        if qty <= 0:
            raise ScopeError(f"数量必须 >0（{sku} 收到 {ln.get('qty')}）")
        price = retail_of(prod)
        if price is None:
            unpriced.append(sku)          # 81 款无价：不进金额，也不拿 0 凑合计
            continue
        amount = round(price * qty, 2)
        total += amount
        out.append({"sku": sku, "model": prod.get("model") or prod.get("name"),
                    "brand": prod.get("brand", ""), "retail_price": price,
                    "price_scope": PRICE_SCOPE, "currency": CURRENCY,
                    "qty": qty, "amount": amount,
                    "manual_override": bool(ln.get("manual_override"))})
    brand_area = {}
    for r in out:
        b = r["brand"] or "（无品牌）"
        brand_area.setdefault(b, {"brand": b, "qty": 0.0, "amount": 0.0})
        brand_area[b]["qty"] += r["qty"]
        brand_area[b]["amount"] = round(brand_area[b]["amount"] + r["amount"], 2)
    return {
        "lines": out, "total": round(total, 2),
        "formula": "Σ(零售价×数量)", "snapshot": snapshot,
        "unpricedSkus": unpriced,
        "brandArea": sorted(brand_area.values(), key=lambda x: -x["amount"]),
        "rule": "报价单品牌区写零售价；所有金额只从 retail_price 读，无系数折算（§5.2 闸③）",
    }


def placements_of(p: dict) -> list[dict]:
    """§7.9 选品落位：design.placements 里的每条 [{sku, params, qty}]。"""
    d = p.get("design") or {}
    return [x for x in d.get("placements", []) if isinstance(x, dict)]


def selection_gate(p: dict, products: list[dict] | None = None,
                   loaded: dict | None = None) -> dict:
    """A9（1.0 只验 L0）：落位 SKU 不在库／不过 L0／价格口径非零售价＝阻断级。"""
    products = products if products is not None else load_products()
    loaded = loaded or load_brands()
    by_sku = { _norm(x.get("sku")): x for x in products }
    problems, rows = [], []
    for i, pl in enumerate(placements_of(p)):
        sku = _norm(pl.get("sku"))
        fid = _norm(pl.get("fixture_id")) or f"placement{i + 1}"
        scope_err = ""
        try:
            assert_retail_scope(pl.get("price_scope"))
        except ScopeError as e:
            scope_err = str(e)
        prod = by_sku.get(sku)
        if not sku:
            problems.append({"fixture_id": fid, "field_key": "sku",
                             "why": f"灯位 {fid} 的选品 SKU 是空的"})
            continue
        if scope_err:
            problems.append({"fixture_id": fid, "field_key": "price_scope", "why": scope_err})
            continue
        if prod is None:
            problems.append({"fixture_id": fid, "field_key": "sku",
                             "why": f"{fid} 选的 {sku} 不在产品库（无从核 L0）"})
            continue
        bad = l0_failures(prod, pl.get("params") or {})
        if bad:
            problems.append({"fixture_id": fid, "field_key": "sku",
                             "why": f"{fid} 选的 {prod.get('model') or sku} 参数不符："
                                    + "；".join(bad)})
            continue
        rows.append({"fixture_id": fid, "sku": sku, "hard_gate_pass": True,
                     "retail_price": retail_of(prod), "price_scope": PRICE_SCOPE})
    return {"violations": len(problems), "problems": problems, "placed": rows,
            "placementCount": len(placements_of(p)),
            "pass": not problems and bool(placements_of(p)) is not None,
            "emptySelection": not placements_of(p),
            "rule": "A9：参数不符的 SKU 不得保存/落位，出现＝0（1.0 只验 L0，§12.1）"}
