// 智能家居场景模式（细化增强版）规则引擎。
//
// 场景不再逐灯列举，而是用「空间 × 职能 × 位置」选择器推导：
//   灯具编号 = 空间码 + 位置码 + 职能码(大写) + 序号，例如 kcA001（客厅·茶几·氛围灯 1 号）
//   场景规则 = 命中哪些空间/职能/位置的灯，以及这些灯在该情景下的开关、亮度、色温。
// 未命中的灯返回 null，表示「本情景不控制这盏灯」（保持现状），例如安防灯 X 在生活情景中保持不变。
//
// 单一数据源：frontend/src/data/scene-package.json（前端与后端共用，场景数量与参数以它为准）。
import packData from "./data/scene-package.json";
import type { Obj } from "./types";
import { SPACE_LIBRARY, type HouseType } from "./spaces";

export type LampState = { on: boolean; brightness: number; cct: number };

export type RoleCode = "M" | "F" | "E" | "A" | "G" | "X" | "C" | "W";

export type SceneRule = {
  /** 命中的空间码；省略或空数组 = 任意空间 */
  s?: string[];
  /** 命中的职能码；省略或空数组 = 任意职能 */
  r?: string[];
  /** 命中的位置码；省略或空数组 = 任意位置 */
  p?: string[];
  /** 默认 true（开） */
  on?: boolean;
  /** 亮度 %，默认 100（开）/ 0（关） */
  b?: number;
  /** 色温 K，默认 3000（开）/ 2700（关） */
  c?: number;
};

export type SceneDef = {
  code: string;
  name: string;
  space?: string;
  spaces?: string[];
  level?: string;
  priority?: string;
  fade?: number;
  trigger?: string;
  exclude?: string;
  exit?: string;
  description?: string;
  rules: SceneRule[];
  /** 仅用于兼容旧标准情景（会客/观影/温馨/浪漫/小憩/阅读/游戏），不作为新情景写入 */
  legacyOnly?: boolean;
};

export const SCENE_PACKAGE = packData as unknown as {
  id: string;
  name: string;
  version: string;
  source: string;
  principle: string;
  roleCodes: { code: RoleCode; name: string; note: string }[];
  priorityModel: { code: string; name: string; note: string }[];
  quietHours: { window: string; level: string; examples: string }[];
  scenes: SceneDef[];
};

export const ROLE_CODES = SCENE_PACKAGE.roleCodes;
export const PRIORITY_MODEL = SCENE_PACKAGE.priorityModel;
export const QUIET_HOURS = SCENE_PACKAGE.quietHours;
export const ALL_SCENES: SceneDef[] = SCENE_PACKAGE.scenes;

/** 可作为标准情景写入项目的场景（43 个，不含兼容用的旧情景） */
export const PACKAGE_SCENES: SceneDef[] = ALL_SCENES.filter((s) => !s.legacyOnly);

export const roleName = (code: string): string =>
  ROLE_CODES.find((r) => r.code === code)?.name || "";
export const priorityName = (code: string): string =>
  PRIORITY_MODEL.find((p) => p.code === code)?.name || "";

// 名称最长的先匹配：「会客茶叙模式」优先于「会客模式」，避免子串误命中。
const BY_NAME = [...ALL_SCENES].sort((a, b) => b.name.length - a.name.length);

/** 情景标题（如「1.1 迎宾模式」）→ 场景定义；自定义情景返回 null（保持不干预）。 */
export function sceneDefFor(label: string): SceneDef | null {
  const text = (label || "").trim();
  if (!text) return null;
  return BY_NAME.find((s) => text.includes(s.name)) || null;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** 一条规则是否命中这盏灯（空间 / 职能 / 位置三层选择器，缺省即通配）。 */
export function ruleMatches(rule: SceneRule, spaceCode: string, role: string, positionCode: string): boolean {
  if (rule.s?.length && !rule.s.includes(spaceCode)) return false;
  if (rule.r?.length && !rule.r.includes(role)) return false;
  if (rule.p?.length && !rule.p.includes(positionCode)) return false;
  return true;
}

/** 功能补光 F / 安防 X 统一 3000K 高显色，覆盖场景包里的 4000–5000K。 */
export const FIXED_CCT_ROLES = ["F", "X"];
export const FIXED_ROLE_CCT = 3000;
/** RGBW 彩色律动只在电竞房生效；空间库没有单列电竞房，暂按 go 游戏室（别名 娱乐室/电玩室）算。 */
export const RGBW_SPACES = ["go"];
export const isRgbwSpace = (spaceCode: string): boolean => RGBW_SPACES.includes(spaceCode);

/** 首条命中的规则决定状态；没有规则命中 = 本情景不控制这盏灯。 */
export function rulesState(
  rules: SceneRule[],
  spaceCode: string,
  role: string,
  positionCode: string,
  fixture: Obj,
): LampState | null {
  const max = Number(fixture?.brightnessMax) || 100;
  const cctMin = Number(fixture?.cctMin) || 2700;
  const cctMax = Number(fixture?.cctMax) || 6500;
  for (const rule of rules || []) {
    if (!ruleMatches(rule, spaceCode, role, positionCode)) continue;
    const on = rule.on !== false;
    let cct = Number(rule.c ?? (on ? 3000 : 2700)) || 0;
    if (FIXED_CCT_ROLES.includes(role)) cct = FIXED_ROLE_CCT;
    // 电竞房以外的彩色灯 C：情景只调亮度，色温保持灯具自身白光（不走律动配色）。
    else if (role === "C" && !isRgbwSpace(spaceCode))
      cct = Number(fixture?.cct) || FIXED_ROLE_CCT;
    return {
      on,
      brightness: on ? Math.min(clamp(Number(rule.b ?? 100) || 0, 0, 100), max) : 0,
      cct: clamp(cct, cctMin, cctMax),
    };
  }
  return null;
}

/** 由编号（空间 + 职能 + 位置）推导某情景下这盏灯的状态。 */
export function sceneStateFor(
  label: string,
  spaceCode: string,
  role: string,
  positionCode: string,
  fixture: Obj,
): LampState | null {
  const def = sceneDefFor(label);
  if (!def) return null;
  return rulesState(def.rules, spaceCode, role, positionCode, fixture);
}

/** 触发方式归一化到工作台可选项（手动 / 面板按键 / 定时 / 传感器）。 */
export function triggerKind(def: SceneDef): string {
  const text = `${def.trigger || ""}${def.description || ""}`;
  if (/传感器|人体|门锁|照度|微波|红外|水浸|烟雾|燃气|CO/.test(text)) return "传感器";
  if (/定时|点后|时间窗口|小时|分钟|闹钟|作息/.test(text)) return "定时";
  if (/面板|语音|按键|手动|一键/.test(text)) return "面板按键";
  return "手动";
}

export type PackageTemplate = {
  id: string;
  code: string;
  name: string;
  description: string;
  trigger: string;
  fade: number;
  priority: string;
  level: string;
  exit: string;
  exclude: string;
  space: string;
  automation: string;
  packageId: string;
  mode: string;
  standard: boolean;
  roleRules: SceneRule[];
};

/** 43 个场景 → 工作台标准情景模板（前端与后端 /api/scene-templates 同源）。 */
export const PACKAGE_TEMPLATES: PackageTemplate[] = PACKAGE_SCENES.map((s) => ({
  id: `scene-pkg-${s.code.replace(/\./g, "-")}`,
  code: s.code,
  name: s.name,
  description: s.description || "",
  trigger: triggerKind(s),
  fade: Number.isFinite(s.fade) ? Number(s.fade) : 1,
  priority: s.priority || "P4",
  level: s.level || "L2",
  exit: s.exit || "",
  exclude: s.exclude || "",
  space: s.space || "全屋",
  automation: `${s.level || "L2"} · ${s.priority || "P4"} ${priorityName(s.priority || "")}`.trim(),
  packageId: SCENE_PACKAGE.id,
  mode: "standard",
  standard: true,
  roleRules: s.rules,
}));


/**
 * 户型 → 该户型合理包含的空间码；用于按户型裁剪可用场景。
 * 前 18 个老空间的码位保持历史口径不变（否则老项目的可用场景会漂移），
 * 空间库里新增的空间按 spaces.ts 的「适用户型」追加。
 */
const LEGACY_HOUSE_TYPE_SPACES: Record<string, string[]> = {
  '平层': ['m', 'k', 'c', 'f', 'z', 'w', 'e', 's', 'b', 'y', 't', 'g', 'x'],
  '复式': ['m', 'k', 'c', 'f', 'z', 'w', 'e', 's', 'b', 'y', 't', 'g', 'l', 'q', 'x'],
  '别墅': ['m', 'k', 'c', 'f', 'z', 'w', 'e', 's', 'b', 'y', 't', 'g', 'l', 'q', 'u', 'v', 'r', 'x'],
  '商业空间': ['m', 'k', 'c', 'f', 'b', 'g', 'l', 'q', 'x'],
};

export const HOUSE_TYPE_SPACES: Record<string, string[]> = Object.fromEntries(
  Object.entries(LEGACY_HOUSE_TYPE_SPACES).map(([type, codes]) => [
    type,
    [
      ...codes,
      ...SPACE_LIBRARY.filter((s) => !s.legacy && s.houses.includes(type as HouseType)).map((s) => s.code),
    ],
  ]),
);

export function spaceCodesForHouseType(houseType: string): string[] {
  return HOUSE_TYPE_SPACES[(houseType || '').trim()] || HOUSE_TYPE_SPACES['平层'];
}

/** 空间名 → 空间码（与 codes.ts 的 SPACE_CODES 同一套词表）。 */
const SCENE_SPACE_NAME_TO_CODE: Record<string, string> = Object.fromEntries(
  SPACE_LIBRARY.map((s) => [s.name, s.code]),
);

/** 场景的「主空间」名：声明为 全屋 或未声明时视为全屋级。 */
export function sceneHomeSpaceName(def: SceneDef): string {
  const home = (def.space || '').trim();
  return !home || home === '全屋' ? '全屋' : home;
}

/** 场景主空间码；全屋级返回 null（恒可用，不受本项目空间限制）。 */
export function sceneHomeSpaceCode(def: SceneDef): string | null {
  const home = sceneHomeSpaceName(def);
  if (home === '全屋') return null;
  return SCENE_SPACE_NAME_TO_CODE[home] || null;
}

/**
 * 按「户型 + 本项目空间」筛出可用场景。
 * 判定看场景的「主空间」：主空间属于本项目的空间才可用，全屋级恒可用。
 * 只看主空间、不再看它在哪些空间里顺带控制灯，否则会出现「平层里冒出庭院 / 影音室 / 楼梯间情景」。
 */
export function availableScenes(houseType: string, projectSpaceCodes: string[]): SceneDef[] {
  const allowed = spaceCodesForHouseType(houseType);
  // 项目明确声明的空间优先：用户给平层加了影音室，就该出现影音室情景，
  // 房型表只在「项目还没选空间」时兜底。
  const have = (projectSpaceCodes || []).filter(Boolean);
  const effective = have.length ? have : allowed;
  return PACKAGE_SCENES.filter((s) => {
    const home = sceneHomeSpaceCode(s);
    if (!home) return true;
    return effective.includes(home);
  });
}

/** 被户型/空间裁掉的场景（这个项目用不上的），用于界面透明展示。 */
export function excludedScenes(houseType: string, projectSpaceCodes: string[]): SceneDef[] {
  const keep = new Set(availableScenes(houseType, projectSpaceCodes).map((s) => s.code));
  return PACKAGE_SCENES.filter((s) => !keep.has(s.code));
}
