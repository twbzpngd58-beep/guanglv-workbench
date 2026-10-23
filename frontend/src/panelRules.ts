/**
 * 面板选型与刻字口径（世聪）。数据：./data/citron-panels.json
 * 出处：世聪官网，型号、键数、刻字一律以官网为准。
 *
 * - keyLabels ＝ 刻字（短按）；keyLongLabels ＝ 长按功能说明，默认不刻字；
 *   官网标注上下双刻的型号（engraveLong：TK3 / ST3）长按文字刻在键下方，同样受字数限制。
 * - 字数上限按型号（textMax，如 ST3-48R 4 字），缺省取 rules.textMax。
 * - offline ＝ 官网未列的旧型号：选型列表不再出现，已选项目仍可解析、导出。
 * - 一块板只用一种形式：engraveMode ＝ icon（全图标，厂家图标库）/ text（全文字，2 字）/ screen（屏显免雕刻）。
 * 后端 backend/panels.py 是同一套规则的另一份实现，改动时两侧同步。
 */
import catalogData from "./data/citron-panels.json";

type Obj = Record<string, any>;

export const PANEL_CATALOG: Obj = catalogData;
export const PANEL_RULES: Obj = PANEL_CATALOG.rules;
export const PANEL_BRAND: string = PANEL_CATALOG.brand;
/** 与后端 PANEL_KEY_COUNTS 一致：世聪实有 2 / 4 键面板与 12 键（1.9 寸屏 3 页）。 */
export const PANEL_KEY_COUNTS = [1, 2, 4, 12];
export const PANEL_DEFAULT_KEYS = 4;
export const ENGRAVE_MODES: { value: string; label: string }[] = [
  { value: "icon", label: "全图标（厂家图标库）" },
  { value: "text", label: "全文字（限 2 字）" },
  { value: "screen", label: "屏显免雕刻（APP 设定）" },
];
export const engraveModeLabel = (v?: string) =>
  ENGRAVE_MODES.find((m) => m.value === v)?.label || "全文字（限 2 字）";

export type PanelModel = Obj & {
  id: string; model: string; name: string; keys: number; longPress: boolean;
  engrave: string; colors: string[]; series: string; protocol: string; material: string;
  offline?: string; textMax?: number; engraveLong?: boolean;
};
export const PANEL_MODELS: PanelModel[] = (PANEL_CATALOG.series as Obj[]).flatMap((s) =>
  (s.models as Obj[]).map((m) => ({ ...m, series: s.series, protocol: s.protocol, material: s.material || "" }) as PanelModel),
);
export const panelModel = (id?: string) => (id ? PANEL_MODELS.find((m) => m.id === id) : undefined);
/** 选型列表：官网在售型号 + 当前已选（即便已下架，避免已有项目丢型号）。 */
export const pickableModels = (currentId?: string) => PANEL_MODELS.filter((m) => !m.offline || m.id === currentId);
export const panelTextMax = (m?: Obj | null): number => m?.textMax ?? PANEL_RULES.textMax;

/** 官网配图缩略图（产品资料 图片/ 2026-10-06 本地化，裁切压缩后随构建打包）。 */
const PANEL_IMAGES = import.meta.glob("./data/citron-img/*.webp", { eager: true, import: "default" }) as Record<string, string>;
export const panelImage = (m?: Obj | null): string | undefined =>
  m?.image ? PANEL_IMAGES[`./data/citron-img/${m.image}.webp`] : undefined;

const CODE_PREFIX = /^\s*\d+(?:\.\d+)*\s*/;
/** 情景名去模板编号：「01.1 会客模式」→「会客模式」。 */
export const sceneWord = (name: any) => String(name || "").replace(CODE_PREFIX, "").trim();

export function roomTemplate(room: Obj | undefined | null): Obj {
  const text = `${room?.name || ""} ${room?.type || ""}`;
  return (PANEL_RULES.roomTemplates as Obj[]).find((t) => t.match.some((k: string) => text.includes(k)))
    || PANEL_RULES.defaultTemplate;
}

function findScene(word: string, room: Obj | undefined | null, scenes: Obj[]): Obj | undefined {
  if (word === "全关") return scenes.find((s) => s.mode === "all-off");
  if (word === "全开") return scenes.find((s) => s.mode === "all-on");
  if (PANEL_RULES.circuitWords.includes(word)) return undefined;
  const aliases: string[] = PANEL_RULES.aliases[word] || [word];
  const hits = scenes.filter((s) => aliases.some((a) => sceneWord(s.name).includes(a)));
  const scoped = hits.filter((s) => s.space && room && (s.space === room.name || s.space === room.type));
  return scoped[0] || hits[0];
}
const longWord = (w: string) => (w === "全关" ? "全开" : PANEL_RULES.circuitWords.includes(w) ? "调光" : "");

/** 键数 / 刻字排长度对齐；选了世聪目录型号的，键数与屏显形式跟型号走。 */
export function normalizePanel(dev: Obj) {
  if (dev.type !== "面板") return;
  const model = panelModel(dev.productId);
  const want = Number(model ? model.keys : dev.keys);
  const n = PANEL_KEY_COUNTS.includes(want) ? want : PANEL_DEFAULT_KEYS;
  dev.keys = n;
  const fit = (v: any): string[] => {
    const out: string[] = Array.isArray(v) ? v.slice(0, n).map((x: any) => (x == null ? "" : String(x))) : [];
    while (out.length < n) out.push("");
    return out;
  };
  dev.keyLabels = fit(dev.keyLabels);
  dev.keyScenes = fit(dev.keyScenes);
  dev.keyLongLabels = fit(dev.keyLongLabels);
  dev.keyLongScenes = fit(dev.keyLongScenes);
  if (model?.engrave === "screen") dev.engraveMode = "screen";
  else if (!["icon", "text"].includes(dev.engraveMode)) dev.engraveMode = "text";
}

/** 旧版预填：刻字直接抄了情景全名（带编号）。整板仍是这种状态才按口径重排。 */
export function isLegacyFill(dev: Obj, scenes: Obj[]): boolean {
  const names = new Set((scenes || []).map((s) => String(s.name || "").trim()));
  const used = [...(dev.keyLabels || []), ...(dev.keyLongLabels || [])]
    .map((x: any) => String(x || "").trim()).filter(Boolean);
  return used.length > 0 && used.every((x) => names.has(x) && x !== sceneWord(x));
}

/** 按产品资料键位预算预填：短按刻字＝空间模板词，长按＝不刻字的辅助功能（全关↔全开、回路键长按调光）。
 *  只改整排空白 / 旧版情景全名预填的面板；force 用于新建与「按口径重排」。 */
export function fillPanelKeys(scenesAll: Obj[], dev: Obj, room: Obj | undefined | null, force = false) {
  normalizePanel(dev);
  const scenes = (scenesAll || []).filter((s) => s && s.id);
  const blank = !(dev.keyLabels || []).some((x: any) => String(x || "").trim());
  if (!force && !blank && !isLegacyFill(dev, scenes)) return;
  const tpl = roomTemplate(room);
  const n: number = dev.keys;
  if (dev.engraveMode !== "screen") dev.engraveMode = tpl.mode === "icon" ? "icon" : "text";
  let words: string[] = [...tpl.words];
  if (n < words.length) {
    // 不够键位时先删次要的，「全关」永远留在最后一键。
    const keepOff = words.includes("全关");
    words = words.filter((w) => w !== "全关").slice(0, keepOff ? n - 1 : n).concat(keepOff ? ["全关"] : []);
  }
  for (let i = 0; i < n; i += 1) {
    const w = words[i] || "";
    const lw = w ? longWord(w) : "";
    dev.keyLabels[i] = w;
    dev.keyScenes[i] = (w && findScene(w, room, scenes)?.id) || "";
    dev.keyLongLabels[i] = lw;
    dev.keyLongScenes[i] = (lw && findScene(lw, room, scenes)?.id) || "";
  }
}

/** 该空间按口径是否不设面板（卫浴 · 过道 · 楼梯 0 键）。 */
export const roomNeedsNoPanel = (room: Obj | undefined | null) => roomTemplate(room).mode === "none";

/** 逐键刻字口径检查：[键位序号（-1＝整板）, 问题]。 */
export function panelIssues(dev: Obj): [number, string][] {
  const out: [number, string][] = [];
  const mode = dev.engraveMode || "text";
  const model = panelModel(dev.productId);
  if (!dev.brand && !dev.model) out.push([-1, "未选型：请选择品牌 / 系列 / 型号"]);
  const textMax = panelTextMax(model);
  const check = (raw: any, i: number, pre: string) => {
    const lab = String(raw || "").trim();
    if (!lab) return;
    if (PANEL_RULES.forbidden.some((w: string) => lab.includes(w))) out.push([i, `${pre}「${lab}」：交付文件不出现「语音」`]);
    if (mode === "screen") return;
    if (PANEL_RULES.offWall.some((w: string) => lab.includes(w))) out.push([i, `${pre}「${lab}」属自动触发场景，不上墙`]);
    if (mode === "icon" && !PANEL_RULES.icons[lab])
      out.push([i, `${pre}「${lab}」不在厂家图标库（全图标板只能用：${Object.keys(PANEL_RULES.icons).join(" ")}）`]);
    if (mode === "text" && lab.length > textMax) out.push([i, `${pre}「${lab}」超过 ${textMax} 字（${model?.model || "文字镂空"}限 ${textMax} 字）`]);
  };
  (dev.keyLabels || []).forEach((raw: any, i: number) => check(raw, i, ""));
  if (model?.engraveLong) (dev.keyLongLabels || []).forEach((raw: any, i: number) => check(raw, i, "长按"));
  if (model && !model.longPress && (dev.keyLongScenes || []).some((x: any) => String(x || "").trim()))
    out.push([-1, `${model.model} 不支持长按，长按绑定不会生效`]);
  return out;
}

/** 预览 / 演示用的键面文字：图标板显示英文图标名；上下双刻型号 sub 为长按刻字。 */
export function keyFace(dev: Obj, i: number): { main: string; sub: string } {
  const lab = String(dev.keyLabels?.[i] || "").trim();
  if (dev.engraveMode === "screen") return { main: lab || `功能 ${i + 1}`, sub: "屏显" };
  const long = panelModel(dev.productId)?.engraveLong ? String(dev.keyLongLabels?.[i] || "").trim() : "";
  if (dev.engraveMode === "icon" && lab) return { main: PANEL_RULES.icons[lab] || "图标待定", sub: long ? `${lab} / ${long}` : lab };
  return { main: lab, sub: long };
}
