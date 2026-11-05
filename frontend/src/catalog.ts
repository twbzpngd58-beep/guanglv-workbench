// 灯具选型目录（飞利浦 WiZ/Hue + FLOS）：品牌 → 型号 → 参数。
// 目录由 scripts/build_catalog.py 从知识库生成，经 /api/catalog 只读下发；不进产品库、不动库表。
import type { Obj } from "./types";
import { applyColorMode } from "./codes";

export type CatalogCct =
  | { kind: "fixed"; value: number; rgb?: boolean }
  | { kind: "range"; min: number; max: number; rgb?: boolean }
  | { kind: "options"; options: number[]; default: number; rgb?: boolean };

export type CatalogBeam =
  | { kind: "fixed"; value: number }
  | { kind: "options"; options: number[]; default: number }
  | { kind: "label"; value: string };

export type CatalogParams = {
  power?: number;
  lumen?: number;
  cct?: CatalogCct;
  beam?: CatalogBeam;
  glare?: { options: string[] };
  finish?: { options?: string[]; fixed?: string };
  cutout?: string;
  size?: string;
  ip?: string;
  ugr?: string;
  material?: string;
  dimmable?: boolean;
  imageSize?: number[];
};

export type CatalogModel = {
  id: string;
  brand: string;
  brandLabel: string;
  series: string;
  model: string;
  variant: string;
  name: string;
  type: string;
  image: string | null;
  params: CatalogParams;
  price: {
    amount: number | null;
    currency: string;
    basis: string;
    verified: boolean;
    listPrice?: number;
    source: string;
  };
  dealerPrice?: { amount: number | null; currency: string; basis: string };
  spec: string;
  source: string;
};

export type CatalogBrand = {
  id: string;
  name: string;
  series: string[];
  models: CatalogModel[];
};

export type Catalog = {
  schemaVersion: number;
  note: string;
  brands: CatalogBrand[];
};

/** 目录加载一次就够：/api/catalog 是静态文件，改完目录重启服务即可。 */
let cached: Catalog | null = null;
let inflight: Promise<Catalog | null> | null = null;

export function loadCatalog(): Promise<Catalog | null> {
  if (cached) return Promise.resolve(cached);
  if (inflight) return inflight;
  inflight = fetch("/api/catalog")
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (d && Array.isArray(d.brands)) cached = d as Catalog;
      return cached;
    })
    .catch(() => null)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function catalogBrand(cat: Catalog | null, brandId: string): CatalogBrand | null {
  return cat?.brands.find((b) => b.id === brandId) || null;
}

export function catalogModel(cat: Catalog | null, modelId: string): CatalogModel | null {
  if (!cat || !modelId) return null;
  for (const b of cat.brands) {
    const hit = b.models.find((m) => m.id === modelId);
    if (hit) return hit;
  }
  return null;
}

/** 灯具上存的 catalogId 找回目录行：删过的型号返回 null，界面退回手动配置。 */
export function catalogModelOfFixture(cat: Catalog | null, f: Obj): CatalogModel | null {
  return catalogModel(cat, String(f?.catalogId || ""));
}

/** 下拉里怎么叫这个型号：飞利浦「型号 · 规格」，FLOS「品名 · 货号」。 */
export function catalogModelLabel(m: CatalogModel): string {
  if (m.brand === "flos") {
    return `${m.variant || m.name} · ${m.model}`;
  }
  return m.variant ? `${m.model} · ${m.variant}` : m.model;
}

export function catalogPriceText(m: CatalogModel): string {
  const p = m.price;
  if (!p || p.amount === null || p.amount === undefined) return "待补价";
  const sym = p.currency === "EUR" ? "€" : "¥";
  const n = Number(p.amount).toLocaleString("zh-CN", { maximumFractionDigits: 2 });
  return `${sym}${n}`;
}

export function catalogCctText(c: CatalogCct | undefined): string {
  if (!c) return "";
  if (c.kind === "fixed") return `${c.value}K`;
  if (c.kind === "range") return `${c.min}K–${c.max}K`;
  return c.options.map((k) => `${k}K`).join(" / ");
}

export function catalogBeamText(b: CatalogBeam | undefined): string {
  if (!b) return "";
  if (b.kind === "fixed") return `${b.value}°`;
  if (b.kind === "options") return b.options.map((k) => `${k}°`).join(" / ");
  return b.value;
}

/** 该型号把哪些参数锁死了：界面据此隐藏对应手填控件。
 *  cct 为 true 表示色温由型号决定（固定值 / 区间 / 单色档位），不再让用户逐灯改。 */
export function catalogLocks(m: CatalogModel | null): {
  cct: boolean;
  cctOptions: boolean;
  beam: boolean;
  beamOptions: boolean;
  power: boolean;
  lumen: boolean;
} {
  const p = m?.params || {};
  return {
    cct: !!p.cct,
    cctOptions: p.cct?.kind === "options",
    beam: !!p.beam,
    beamOptions: p.beam?.kind === "options",
    power: p.power !== undefined && p.power !== null,
    lumen: p.lumen !== undefined && p.lumen !== null,
  };
}

export type CatalogSelection = {
  cct?: number;
  beamAngle?: number;
  glare?: string;
  finish?: string;
};

/** 把目录型号落到灯具上：名称/型号/品牌/功率/价格之外，色温与光束角按型号口径收口。
 *  控制方式不在这里——总线/无线方案说了算（与 applyProductToFixture 同一口径）。 */
export function applyCatalogModel(f: Obj, m: CatalogModel, sel: CatalogSelection = {}): void {
  f.catalogId = m.id;
  f.catalogBrand = m.brand;
  f.brand = m.brandLabel;
  f.model = m.model;
  f.name = m.name;
  f.type = m.type;
  const p = m.params || {};
  if (p.power !== undefined && p.power !== null) f.power = p.power;
  if (p.lumen !== undefined && p.lumen !== null) f.lumen = p.lumen;
  if (p.cutout) f.cutout = p.cutout;
  if (p.dimmable) f.dimmable = true;
  if (m.price && m.price.amount !== null && m.price.amount !== undefined) {
    f.priceBasis = m.price.basis;
    f.priceSource = m.price.source;
    if (m.price.currency === "CNY") {
      f.price = m.price.amount;
      f.priceVerified = !!m.price.verified;
      f.priceCurrency = "CNY";
      delete f.catalogPriceAmount;
      delete f.catalogPriceCurrency;
    } else {
      // 工作台的「参考单价」与报价合计都是人民币字段：欧元目录价不直接写进去，
      // 单存在 catalogPrice* 里，界面标币种，报价前按结算汇率折算并人工核实。
      f.price = 0;
      f.priceVerified = false;
      f.priceCurrency = m.price.currency;
      f.catalogPriceAmount = m.price.amount;
      f.catalogPriceCurrency = m.price.currency;
    }
  } else {
    delete f.catalogPriceAmount;
    delete f.catalogPriceCurrency;
  }
  const c = p.cct;
  /* 目录写了色温就解除「待核」：那个标记是 CAD 导入时打的（图纸没给色温才打），
   * 不清掉的话，产品明明写着 2700–6000K，界面还在报「色温待核 1 盏」，
   * 导出清单也跟着标「待核」（2026-11-03 用户口径：产品里有色温就不该提示缺失）。 */
  if (c?.kind === "fixed") {
    f.colorMode = "单色";
    f.cct = c.value;
    f.cctMin = c.value;
    f.cctMax = c.value;
    f.tunable = false;
    f.colored = !!c.rgb;
    delete f.cctPending;
  } else if (c?.kind === "range") {
    f.cctMin = c.min;
    f.cctMax = c.max;
    applyColorMode(f, c.rgb ? "彩色" : "双色");
    const want = Number(sel.cct ?? f.cct);
    f.cct = Number.isFinite(want) ? Math.min(c.max, Math.max(c.min, want)) : c.min;
    delete f.cctPending;
  } else if (c?.kind === "options") {
    const want = Number(sel.cct);
    const pick = c.options.includes(want) ? want : c.default;
    f.colorMode = "单色";
    f.cct = pick;
    f.cctMin = pick;
    f.cctMax = pick;
    f.tunable = false;
    f.colored = !!c.rgb;
    delete f.cctPending;
  }
  const b = p.beam;
  if (b?.kind === "options") {
    const want = Number(sel.beamAngle);
    f.beamAngle = b.options.includes(want) ? want : b.default;
  } else if (b?.kind === "fixed") {
    f.beamAngle = b.value;
  }
  if (b?.kind === "label") {
    f.beamLabel = b.value;
  } else {
    delete f.beamLabel;
  }
  if (p.glare?.options?.length) {
    f.glare = sel.glare && p.glare.options.includes(sel.glare) ? sel.glare : p.glare.options[0];
  } else {
    delete f.glare;
  }
  if (p.finish?.options?.length) {
    f.finish = sel.finish && p.finish.options.includes(sel.finish) ? sel.finish : p.finish.options[0];
  } else if (p.finish?.fixed) {
    f.finish = p.finish.fixed;
  } else {
    delete f.finish;
  }
}

/** 换型号时清掉上一款的选择：旧档位（如 4000K）不在新型号里就落回默认。 */
export function catalogSelectionOf(f: Obj): CatalogSelection {
  return {
    cct: Number(f?.cct) || undefined,
    beamAngle: Number(f?.beamAngle) || undefined,
    glare: f?.glare || undefined,
    finish: f?.finish || undefined,
  };
}
