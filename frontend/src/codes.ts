// 灯具编号 = 空间码 + 位置码 + 职能码 + 三位序号，例如 kc001 / kcA001：
//   k = 客厅（空间码）  c = 茶几（位置码）  A = 氛围（职能码，可省略）  001 = 该位置的 1 号灯
//
// 编号是整条链路的单一来源：它决定灯具属于哪个空间、装在什么位置、在情景里担什么职能，
// 并据此自动推导出标准情景里每一盏灯的状态——不需要逐个情景手调。
//   老编号 kc001（6 位）= 职能缺省，按「位置 → 默认职能」推导，历史图纸显示不变；
//   新编号 kcA001（7 位）= 带职能位，由「空间 × 职能 × 位置」选择器推导（规则见 sceneRules.ts）。
import type { Obj } from "./types";
import { ROLE_CODES, sceneDefFor, sceneStateFor, type LampState } from "./sceneRules";
import { SPACE_LIBRARY } from "./spaces";
import codeLib from "./data/code-library.json";

export { ROLE_CODES };
export type { LampState };

// 空间词表来自 spaces.ts（单一数据源）：老 18 个空间的码位与顺序保持不变，
// 新增空间按分区追加在后面。spaceByCode / spaceByName / 编号解析都由它派生。
export const SPACE_CODES: { code: string; name: string }[] = SPACE_LIBRARY.map((s) => ({
  code: s.code,
  name: s.name,
}));
// 位置词表来自 data/code-library.json（与空间库同一份）。位置**按空间取表**：
//   每个空间有自己的家具 / 功能位表（positionPalettes + spacePalette）——
//   卫生间＝镜柜·镜前 / 台盆 / 马桶 / 淋浴区 / 浴缸 / 干区 / 浴霸…，
//   卧室＝床头 / 床头柜 / 床尾 / 床榻 / 衣柜 / 梳妆台 / 书桌 / 飘窗 / 地面·起夜…；
//   通用位（c 茶几 / s 沙发 / t 电视墙 / z 餐桌·桌面 / d 天花灯带 / x 线型·洗墙 /
//   g 柜体·柜内 / w 墙面·壁灯 / v 展示·挂画 / q 其他位置）在任何空间里含义都不变，
//   空间专有位一律用其余 16 个字母，所以「空间码 + 位置码」永远唯一，老编号也不会被重新解释。
//   下面的 POSITION_CODES（26 位）是老编号的通用兜底表：存量图纸里的 (空间, 位置码) 含义一律不变。
export type PositionDef = {
  code: string;
  name: string;
  group: string;
  defaultRole: string;
  note: string;
};

/** 老通用兜底表（26 个位置，含义固定）。 */
export const POSITION_CODES: PositionDef[] = codeLib.positions as PositionDef[];

/** 通用位（含义固定，出现在多个空间的位置表里）。 */
export const UNIVERSAL_POSITION_CODES: string[] = codeLib.universalPositionCodes;

/** 位置表：一张表＝一类空间共用的家具 / 功能位。 */
export const POSITION_PALETTES: Record<
  string,
  { name: string; groups: string[]; positions: PositionDef[] }
> = codeLib.positionPalettes;

/** 空间码 → 位置表 id。 */
export const SPACE_PALETTE: Record<string, string> = codeLib.spacePalette;

/** 位置分组（老通用表的分组，兜底展示与导出仍用它）。 */
export const POSITION_GROUPS: string[] = codeLib.positionGroups;

const legacyPositionByCode = new Map(POSITION_CODES.map((p) => [p.code, p]));

/** 该空间的位置表；没有专属表的空间返回 null（回退老通用表）。 */
export function paletteOfSpace(spaceCode: string) {
  const id = SPACE_PALETTE[spaceCode];
  return id ? POSITION_PALETTES[id] || null : null;
}

/** 该空间的位置表（家具 / 功能位）。 */
export function positionsForSpace(spaceCode: string): PositionDef[] {
  const pal = paletteOfSpace(spaceCode);
  return pal ? pal.positions : POSITION_CODES;
}

/** 该空间的位置表，按分组返回（布灯 / 添加设备的下拉按它分组）。 */
export function groupedPositionsForSpace(
  spaceCode: string,
): { group: string; positions: PositionDef[] }[] {
  const pal = paletteOfSpace(spaceCode);
  if (!pal) return [{ group: "通用", positions: POSITION_CODES }];
  return pal.groups
    .map((group) => ({ group, positions: pal.positions.filter((p) => p.group === group) }))
    .filter((g) => g.positions.length > 0);
}

/** (空间, 位置码) → 位置定义：先按该空间的位置表，再回退老通用表（老编号不被重新解释）。 */
export function positionDefIn(spaceCode: string, positionCode: string): PositionDef | null {
  const pal = paletteOfSpace(spaceCode);
  const hit = pal?.positions.find((p) => p.code === positionCode);
  return hit || legacyPositionByCode.get(positionCode) || null;
}

/** (空间, 位置码) → 位置名（卫生间·o ＝ 马桶/坐便位）。 */
export function positionNameIn(spaceCode: string, positionCode: string): string {
  return positionDefIn(spaceCode, positionCode)?.name || "";
}

/** (空间, 位置名) → 位置码（复制粘贴 / 按名称回写编号用）。 */
export function positionCodeInSpace(spaceCode: string, name: string): string {
  const hit = positionsForSpace(spaceCode).find((p) => p.name === name);
  if (hit) return hit.code;
  return POSITION_CODES.find((p) => p.name === name)?.code || "";
}

/** (空间, 位置码) → 默认职能（老编号缺省职能时用它补齐）。 */
export function defaultRoleForPosition(spaceCode: string, positionCode: string): string {
  return positionDefIn(spaceCode, positionCode)?.defaultRole || "M";
}

/** 老通用表：位置码 → 默认职能（没有空间上下文时使用，保持历史口径）。 */
export const DEFAULT_ROLE_BY_POSITION: Record<string, string> = Object.fromEntries(
  POSITION_CODES.map((p) => [p.code, p.defaultRole]),
);

const spaceByCode = new Map(SPACE_CODES.map((s) => [s.code, s.name]));
const spaceByName = new Map(SPACE_CODES.map((s) => [s.name, s.code]));

export type FixtureCode = {
  /** 规范化后的编号：小写空间+位置、大写职能（kcA001） */
  code: string;
  spaceCode: string;
  space: string;
  positionCode: string;
  position: string;
  /** 显式职能码（大写）；老编号为空串 */
  roleCode: string;
  /** 实际生效职能（显式，或按位置补齐默认值） */
  role: string;
  roleName: string;
  explicitRole: boolean;
  serial: number;
};

const ROLE_LETTERS = "MFEAGXCW";
/** 编号去掉序号后的主体（空间码 + 位置码 + 可选职能码）。 */
const CODE_BODY_RE = /^([A-Za-z]+?)([0-9]{1,3})$/;
/** 历史编号规则：老图纸里可能有「KC001 / kca001」这类大小写混写的编号，只在新规则解析不到时兜底。 */
const LEGACY_CODE_RE = new RegExp(
  `^([A-Za-z])([A-Za-z])([${ROLE_LETTERS}${ROLE_LETTERS.toLowerCase()}]?)([0-9]{1,3})$`,
);
/** 先长后短：两位空间码优先匹配，其次一位，老空间编号的解析结果不变。 */
const SPACE_CODES_BY_LENGTH = [...SPACE_CODES].sort((a, b) => b.code.length - a.code.length);

function fixtureCodeOf(
  spaceCode: string,
  spaceName: string,
  positionCode: string,
  roleCode: string,
  serial: number,
): FixtureCode {
  const role = roleCode || defaultRoleForPosition(spaceCode, positionCode);
  return {
    code: spaceCode + positionCode + roleCode + String(serial).padStart(3, "0"),
    spaceCode,
    space: spaceName,
    positionCode,
    position: positionNameIn(spaceCode, positionCode),
    roleCode,
    role,
    roleName: ROLE_CODES.find((r) => r.code === role)?.name || "",
    explicitRole: !!roleCode,
    serial,
  };
}

/**
 * Parse a code such as kc001 (职能缺省) or kcA001 (带职能).
 *
 * 编号 = 空间码（小写，1-3 位）+ 位置码（小写，1 位）+ 职能码（大写，可省略）+ 序号（1-3 位）。
 * 小写字母段与大写职能位天然分段：候选空间码按「先长后短」逐个试，只有整段严丝合缝
 * （小写空间 + 小写位置 + 可选大写职能 + 数字）才算成立。所以空间库扩到 83 个空间（含两位码）、
 * 位置码扩到 26 个之后，同一个编号仍然只有一种解析 —— 这是编号能继续扩张的前提。
 * 历史编号先用新规则试，失败再走旧规则兜底（KC001、kca001 这类仍按老行为解析）。
 * Returns null for legacy「客厅-01」or free-form codes.
 */
export function parseFixtureCode(code: string): FixtureCode | null {
  const raw = (code || "").trim();
  const body = CODE_BODY_RE.exec(raw);
  if (body) {
    const head = body[1];
    const serial = Number(body[2]);
    for (const sc of SPACE_CODES_BY_LENGTH) {
      if (head.length <= sc.code.length) continue;
      if (head.slice(0, sc.code.length) !== sc.code) continue;
      const rest = head.slice(sc.code.length);
      const positionCode = rest[0];
      // 位置码必须小写且是已知位置；职能位必须大写 —— 这两条是「两位空间码」不被混读的关键。
      if (positionCode !== positionCode.toLowerCase()) continue;
      if (!positionDefIn(sc.code, positionCode)) continue;
      const roleCode = rest.slice(1);
      if (roleCode.length > 1) continue;
      if (roleCode && roleCode !== roleCode.toUpperCase()) continue;
      if (roleCode && !ROLE_LETTERS.includes(roleCode)) continue;
      return fixtureCodeOf(sc.code, sc.name, positionCode, roleCode, serial);
    }
  }
  const legacy = LEGACY_CODE_RE.exec(raw);
  if (!legacy) return null;
  const spaceCode = legacy[1].toLowerCase();
  const positionCode = legacy[2].toLowerCase();
  const spaceName = spaceByCode.get(spaceCode);
  if (!spaceName || !positionDefIn(spaceCode, positionCode)) return null;
  return fixtureCodeOf(spaceCode, spaceName, positionCode, (legacy[3] || "").toUpperCase(), Number(legacy[4]));
}

/**
 * 编号 → 人话：「洗衣房 · 其他位置 · 基础照明 M · 1 号」。
 * 空间一多，光看 xiqM001 认不出位置，界面与清单里都用它做旁注。
 */
export function describeFixtureCode(code: string): string {
  const p = parseFixtureCode(code);
  if (!p) return "";
  return `${p.space} · ${p.position} · ${p.roleName}（${p.role}）· ${p.serial} 号`;
}

/** 把编号的职能位换成指定职能（老编号会因此升级为 7 位新编号）。 */
export function codeWithRole(code: string, role: string): string {
  const parsed = parseFixtureCode(code);
  if (!parsed || !role) return code;
  return buildFixtureCode(parsed.spaceCode, parsed.positionCode, parsed.serial, role);
}

/** Space name a code belongs to ("" when the code carries no space). */
export function spaceFromFixtureCode(code: string): string {
  return parseFixtureCode(code)?.space || "";
}

/**
 * Next free serial for one 空间+位置(+职能) slot, e.g. kc+A -> 3 when kcA001/kcA002 exist.
 * 传 role 时按「空间+位置+职能」分号段；不传则覆盖该空间+位置下所有职能。
 */
export function nextSerial(fixtures: Obj[], spaceCode: string, positionCode: string, role?: string): number {
  let max = 0;
  fixtures.forEach((f) => {
    const parsed = parseFixtureCode(f.code || "");
    if (!parsed) return;
    if (parsed.spaceCode !== spaceCode || parsed.positionCode !== positionCode) return;
    if (role && parsed.role !== role) return;
    max = Math.max(max, parsed.serial);
  });
  return max + 1;
}

/** 编号 = 空间码 + 位置码 + 职能码(可省略) + 三位序号。 */
export function buildFixtureCode(spaceCode: string, positionCode: string, serial: number, role?: string): string {
  return spaceCode + positionCode + (role ? role.toUpperCase() : "") + String(serial).padStart(3, "0");
}

export const spaceLetterOf = (name: string): string => spaceByName.get(name) || "x";
/** 位置名 → 位置码（无空间上下文的老通用表查找；有空间请用 positionCodeInSpace）。 */
export const positionLetterOf = (name: string): string =>
  POSITION_CODES.find((p) => p.name === name)?.code || "q";

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * 老编号（kc001，职能缺省）的标准情景推导：保持历史行为不变，避免老图纸显示回归。
 * 新编号走下面的 standardSceneState → 「空间 × 职能 × 位置」规则引擎。
 */
export function legacySceneState(
  sceneName: string,
  parsed: FixtureCode | null,
  fixture: Obj,
): LampState | null {
  const max = Number(fixture?.brightnessMax) || 100;
  const cctMin = Number(fixture?.cctMin) || 2700;
  const cctMax = Number(fixture?.cctMax) || 6500;
  const state = (on: boolean, brightness: number, cct: number): LampState => ({
    on,
    brightness: Math.min(clamp(brightness, 0, 100), max),
    cct: clamp(cct, cctMin, cctMax),
  });
  const name = sceneName || "";
  if (name.includes("全开")) return state(true, max, 4000);
  if (name.includes("全关")) return state(false, 0, 3000);
  if (!parsed) return null;
  const { space, positionCode: pos } = parsed;
  const 客厅 = space === "客厅";
  const 餐厨 = space === "餐厅" || space === "厨房";
  const 卧 = space === "主卧" || space === "次卧" || space === "儿童房";
  const 湿区过道 = space === "卫生间" || space === "门厅" || space === "走廊";
  const 氛围位 = pos === "d" || pos === "x";
  const 中心位 = pos === "c" || pos === "t";
  if (name.includes("会客")) {
    if (客厅) return state(true, 氛围位 ? 80 : 中心位 ? 60 : 45, 3000);
    if (space === "餐厅") return state(true, pos === "z" ? 60 : 40, 3000);
    if (space === "厨房" || space === "门厅" || space === "走廊") return state(true, 30, 3000);
    return state(false, 0, 3000);
  }
  if (name.includes("观影")) {
    if (客厅 && (氛围位 || pos === "s")) return state(true, 20, 2700);
    if (客厅 && pos === "g") return state(true, 15, 2700);
    return state(false, 0, 2700);
  }
  if (name.includes("温馨")) {
    if (客厅) return state(true, 50, 3000);
    if (space === "餐厅" || 卧) return state(true, 30, 3000);
    return state(false, 0, 3000);
  }
  if (name.includes("浪漫")) {
    if (客厅) return state(true, 氛围位 ? 60 : pos === "g" ? 60 : 40, 2700);
    if (space === "餐厅") return state(true, 40, 2700);
    return state(false, 0, 2700);
  }
  if (name.includes("备餐")) {
    if (space === "厨房") return state(true, 100, 4000);
    if (space === "餐厅") return state(pos === "z", pos === "z" ? 30 : 0, 3000);
    return state(false, 0, 3000);
  }
  if (name.includes("就餐")) {
    if (space === "厨房") return state(true, 50, 3000);
    if (space === "餐厅") return state(true, pos === "z" ? 100 : 60, 3000);
    if (客厅) return state(true, 40, 3000);
    return state(false, 0, 3000);
  }
  if (name.includes("清洁")) {
    if (餐厨) return state(true, 100, 4000);
    if (湿区过道) return state(true, 60, 4000);
    return state(false, 0, 4000);
  }
  if (name.includes("睡眠")) {
    if (卧) return state(pos === "h" || pos === "j", pos === "h" || pos === "j" ? 10 : 0, 2700);
    if (space === "走廊") return state(true, 5, 2700);
    return state(false, 0, 2700);
  }
  if (name.includes("小憩")) {
    if (客厅 && 氛围位) return state(true, 30, 3000);
    if (卧 && (pos === "h" || pos === "j" || 氛围位)) return state(true, 30, 3000);
    return state(false, 0, 3000);
  }
  if (name.includes("阅读") || name.includes("游戏")) {
    if (卧 && (pos === "h" || pos === "j")) return state(true, 60, 4000);
    if (space === "书房") return state(true, pos === "z" ? 60 : 40, 4000);
    if (客厅 && pos === "z") return state(true, 60, 4000);
    return state(false, 0, 4000);
  }
  if (name.includes("起夜")) {
    if (湿区过道) return state(true, 10, 2700);
    if (卧 && pos === "j") return state(true, 5, 2700);
    return state(false, 0, 2700);
  }
  return null;
}

/**
 * 标准情景状态：编号是唯一来源。
 *   带职能的新编号（kcA001）→ 场景规则引擎（空间 × 职能 × 位置，见 sceneRules.ts）
 *   老编号（kc001）        → 既有推导，保证历史图纸显示不变
 * 返回 null 表示本情景不控制这盏灯（例如安防灯 X 在生活情景中保持现状）。
 */
export function standardSceneState(
  sceneName: string,
  parsed: FixtureCode | null,
  fixture: Obj,
): LampState | null {
  if (/全开|全关/.test(sceneName || "")) return legacySceneState(sceneName, parsed, fixture);
  const def = sceneDefFor(sceneName);
  if (def && !def.legacyOnly && parsed)
    // 已纳入场景包的场景（迎宾/观影/睡眠/晨唤…）一律按「空间 × 职能 × 位置」推导，
    // 老编号按位置补齐默认职能，所以老图纸也能直接进新场景。
    return sceneStateFor(sceneName, parsed.spaceCode, parsed.role, parsed.positionCode, fixture);
  // 其余（会客/温馨/浪漫/小憩/阅读/游戏等旧情景、自定义情景）保持既有推导。
  return legacySceneState(sceneName, parsed, fixture);
}

/** 这盏灯实际生效的职能码（显式职能，或按位置补齐）。 */
export function roleOfCode(code: string): string {
  return parseFixtureCode(code)?.role || "";
}

/**
 * 装饰型灯具：吊灯 / 吸顶灯 / 壁灯 / 落地灯 / 台灯 / 镜前灯
 * （与 types.ts 的 lightTypes 里连续的那一组一致）。
 * 这类灯具不做定向照射：图上不画地面光斑，也不显示照射直径 / 面积。
 */
export const DECORATIVE_LIGHT_TYPES = [
  "吊灯",
  "吸顶灯",
  "壁灯",
  "落地灯",
  "台灯",
  "镜前灯",
];
export function isDecorativeLight(type?: string): boolean {
  const t = type || "";
  return DECORATIVE_LIGHT_TYPES.some((x) => t.includes(x));
}
/** 装饰型灯具图上「光晕 / 光斑」的基准直径（米）：吊灯、吸顶灯以环境光为主，台灯、壁灯偏小。
 *  这只是画法上的观感尺寸（可用「光斑大小 ×」缩放），不是照射直径 / 面积，界面不显示数字。 */
export const DECORATIVE_HALO_DIAMETER_M: Record<string, number> = {
  吊灯: 5.2,
  吸顶灯: 5.6,
  壁灯: 3.0,
  落地灯: 3.6,
  台灯: 2.4,
  镜前灯: 2.6,
};
/** 灯具类型 → 默认名称：新布灯 / 换类型时用它，保证「类型 ↔ 名称」对得上。
 *  旧版只在 灯带 / 筒灯 两种类型上区分，其他类型一律叫「防眩射灯」，
 *  于是出现「灯具类型=吊灯、灯具名称=防眩射灯」这类不一致。 */
export const DEFAULT_FIXTURE_NAME: Record<string, string> = {
  射灯: "防眩射灯",
  筒灯: "防眩筒灯",
  洗墙灯: "洗墙灯",
  轨道射灯: "轨道射灯",
  磁吸轨道: "磁吸轨道灯",
  线性灯: "线性灯",
  灯带: "线性灯带",
  吊灯: "吊灯",
  吸顶灯: "吸顶灯",
  壁灯: "壁灯",
  落地灯: "落地灯",
  台灯: "台灯",
  镜前灯: "镜前灯",
  柜内灯: "柜内灯",
  地脚灯: "地脚灯",
  感应地脚灯: "感应地脚灯",
  踏步灯: "踏步灯",
  庭院灯: "庭院灯",
  水下灯: "水下灯",
  其他灯具: "灯具",
};
export function defaultFixtureName(type: string): string {
  const t = type || "";
  if (DEFAULT_FIXTURE_NAME[t]) return DEFAULT_FIXTURE_NAME[t];
  const hit = Object.keys(DEFAULT_FIXTURE_NAME).find((k) => t.includes(k));
  return hit ? DEFAULT_FIXTURE_NAME[hit] : t || "灯具";
}
/** 这个名字是不是本工具自动生成的默认名（即用户没自己改过）：用于按类型对齐。 */
export function isAutoFixtureName(name?: string): boolean {
  const n = String(name || "").trim();
  if (!n) return true;
  return Object.values(DEFAULT_FIXTURE_NAME).includes(n)
    || n === "防眩射灯" || n === "防眩筒灯" || n === "线性灯带";
}
/** 灯具类型 → 默认型号：只给能确定的两类，其他留空让用户从知识库选（旧版一律 DL-07）。 */
export function defaultFixtureModel(type: string): string {
  const t = type || "";
  if (t.includes("灯带")) return "ST-01";
  if (t.includes("射灯") || t.includes("筒灯")) return "DL-07";
  return "";
}
export function decorativeHaloRadiusUnits(type: string, area: number): number {
  const t = type || "";
  const key = DECORATIVE_LIGHT_TYPES.find((x) => t.includes(x)) || "";
  const dia = DECORATIVE_HALO_DIAMETER_M[key] ?? 3.2;
  return Math.min(1400, Math.max(12, (dia / 2) * unitsPerMetre(area)));
}

/** 常用灯具的默认光束角（度）。 */
export function defaultBeamAngle(type: string): number {
  const t = type || "";
  if (t.includes("射灯")) return 24;
  if (t.includes("筒灯")) return 60;
  if (t.includes("吊灯")) return 120;
  if (t.includes("壁灯")) return 90;
  if (t.includes("灯带") || t.includes("线性") || t.includes("磁吸")) return 120;
  return 60;
}

const halfAngleRad = (beamAngle: number) =>
  (Math.max(1, Math.min(180, Number(beamAngle) || 24)) / 2) * (Math.PI / 180);

/**
 * 半角光束角理论值：地面光斑半径（米）= 安装高度 × tan(半角)。
 * 预留 IES 光度文件后会改为按实测配光曲线计算，目前以理论值为准。
 */
export function spotRadiusMetres(installHeight: number, beamAngle: number): number {
  const h = Number(installHeight) > 0 ? Number(installHeight) : 2.8;
  return h * Math.tan(halfAngleRad(beamAngle));
}

export function spotDiameterMetres(installHeight: number, beamAngle: number): number {
  return spotRadiusMetres(installHeight, beamAngle) * 2;
}

/**
 * 名义比例（旧标定，仅保留供其他用途）：画布宽 750 单位 ≈ 1.6×√面积 米。
 * 光斑现已改用下面的「15° 基准」标定。
 */
export function unitsPerMetre(area: number): number {
  const a = Number(area) > 0 ? Number(area) : 100;
  return 750 / Math.max(1.6 * Math.sqrt(a), 1);
}

/** 基准光束角：其他所有角度都以它为倍数基准。 */
export const SPOT_BASE_ANGLE = 15;

/**
 * 基准光斑直径（画布单位）：15° 光束角在 2.8 m 高度时的观感尺寸，
 * 由单位换算 unitsPerMetre(area) 推出（保留作标定/自检用，不再直接作为绘制值）。
 */
export const SPOT_BASE_DIAMETER_UNITS = 160;

/** 基准安装高度：光斑尺寸随高度线性变化，基准取 2.8 m。 */
export const SPOT_BASE_HEIGHT_M = 2.8;

/**
 * 相对 15° 的真实倍数（半角正切之比）：
 * 15°→×1.00、24°→×1.62、30°→×2.19、50°→×3.54、60°→×4.53。
 */
export function spotMultiple(beamAngle: number): number {
  return Math.tan(halfAngleRad(beamAngle)) / Math.tan(halfAngleRad(SPOT_BASE_ANGLE));
}

/**
 * 画布单位下的光斑直径 = 15° 基准尺寸 × 真实倍数 ×（安装高度/基准高度）。
 * 画布不是施工比例，所以绝对尺寸以 15°=茶几 标定，倍数关系与物理完全一致。
 */
export function spotDiameterUnits(
  installHeight?: number,
  beamAngle?: number,
  area?: number,
): number {
  // 地面光斑直径（画布单位）＝物理直径 spotDiameterMetres(h,θ)＝2·h·tan(θ/2) 米 × 画布比例。
  // 与「地面光斑 Ø…m」读数同源：改光束角或安装高度（任意一个或两个一起改）才会变，
  // 图上拖动只移动灯具，不改变光斑大小。
  const h = Number(installHeight) > 0 ? Number(installHeight) : SPOT_BASE_HEIGHT_M;
  const b = Number(beamAngle) > 0 ? Number(beamAngle) : SPOT_BASE_ANGLE;
  return spotDiameterMetres(h, b) * unitsPerMetre(Number(area) > 0 ? Number(area) : 100);
}

/** 画布单位下的光斑半径（area 仅为兼容旧调用）。 */
export function spotRadiusUnits(
  installHeight: number,
  beamAngle: number,
  area?: number,
): number {
  return Math.max(3, Math.min(1200, spotDiameterUnits(installHeight, beamAngle, area) / 2));
}

/* 光源类型（单色 / 双色 / 彩色）
 *   单色：单色温，默认 3000K，可选 2700K / 3000K / 3500K / 4000K；
 *   双色：可调色温，默认 2700K–6500K，仍可手动改上下限；
 *   彩色：RGB / RGBW 彩色灯具（含灯带），保留白光通道色温并可另配色相。
 * 灯带不再只是单色温：灯带同样可选单色 / 双色 / 彩色。 */
export type ColorMode = "单色" | "双色" | "彩色";
export const COLOR_MODES: ColorMode[] = ["单色", "双色", "彩色"];
export const SINGLE_CCT_OPTIONS = [2700, 3000, 3500, 4000];
export const SINGLE_CCT_DEFAULT = 3000;
export const DUAL_CCT_MIN_DEFAULT = 2700;
export const DUAL_CCT_MAX_DEFAULT = 6500;
export const COLOR_HUE_DEFAULT = 320;
export const COLOR_HEX_DEFAULT = "#ff5aa8";

/** 读取/推断光源类型：旧数据能调色温＝双色，不能调＝单色。 */
export function colorModeOf(f: Obj): ColorMode {
  const m = f && f.colorMode;
  if (m === "单色" || m === "双色" || m === "彩色") return m;
  if (f && f.colored) return "彩色";
  return f && f.tunable === false ? "单色" : "双色";
}

export const isColorful = (f: Obj): boolean => colorModeOf(f) === "彩色";

export const isStripType = (t: string): boolean => (t || "").includes("灯带");

/** 该灯具是否支持调色温（单色不支持）。 */
export function isTunable(f: Obj): boolean {
  if (colorModeOf(f) === "单色") return false;
  return !f || f.tunable !== false;
}

/** 按目标光源类型补全灯具字段（就地修改）。 */
export function applyColorMode(f: Obj, mode: ColorMode): void {
  f.colorMode = mode;
  if (mode === "单色") {
    const cct = SINGLE_CCT_OPTIONS.indexOf(Number(f.cct)) >= 0 ? Number(f.cct) : SINGLE_CCT_DEFAULT;
    f.cct = cct;
    f.cctMin = cct;
    f.cctMax = cct;
    f.tunable = false;
    f.colored = false;
    return;
  }
  if (mode === "双色") {
    const min = Number(f.cctMin);
    const max = Number(f.cctMax);
    if (!(min > 0 && max > 0 && max > min)) {
      f.cctMin = DUAL_CCT_MIN_DEFAULT;
      f.cctMax = DUAL_CCT_MAX_DEFAULT;
    }
    f.tunable = true;
    f.colored = false;
    return;
  }
  const min = Number(f.cctMin);
  const max = Number(f.cctMax);
  if (!(min > 0 && max > 0 && max > min)) {
    f.cctMin = DUAL_CCT_MIN_DEFAULT;
    f.cctMax = DUAL_CCT_MAX_DEFAULT;
  }
  f.colorHue = Number.isFinite(Number(f.colorHue)) ? Number(f.colorHue) : COLOR_HUE_DEFAULT;
  f.colorHex = f.colorHex || COLOR_HEX_DEFAULT;
  f.tunable = true;
  f.colored = true;
}

/* 色温口径（刀2）：手动布灯默认单色 3000K；偏离（双色 / 彩色 / 非 3000K）必须写原因。
 * 导入或知识库没给色温的灯 = 「待核」：内部先用 3000K 占位（后端要求上下限是数字），
 * 界面与导出一律显示「待核」，不再猜 2700/6500；人工改过光源类型或色温即解除待核。 */
export const CCT_PENDING_LABEL = "待核";
export const CCT_PLACEHOLDER = 3000;

/** 色温是否待核（导入 / 知识库缺色温）。 */
export const isCctPending = (f: Obj): boolean => !!(f && f.cctPending);

/** 偏离默认（单色 3000K）需要写原因；待核灯另走待核清单，不算偏离。 */
export function cctNeedsReason(f: Obj): boolean {
  if (!f || isCctPending(f)) return false;
  if (colorModeOf(f) !== "单色") return true;
  return Number(f.cct ?? f.cctMin) !== SINGLE_CCT_DEFAULT;
}

/** 色温简述：待核灯显示「待核」，其余按光源类型显示 K 值。 */
export function cctText(f: Obj): string {
  if (isCctPending(f)) return CCT_PENDING_LABEL;
  if (colorModeOf(f) === "单色") return `${f.cct ?? f.cctMin}K`;
  return `${f.cctMin}–${f.cctMax}K`;
}

/** 套用知识库产品：产品没色温就落成「待核」占位，不把 null 写进灯具（后端会拒存）。 */
export function applyProductCct(f: Obj, prod: Obj): void {
  const lo = Number(prod?.cctMin);
  const hi = Number(prod?.cctMax);
  if (prod?.cctPending || !(lo > 0) || !(hi > 0)) {
    f.cctPending = true;
    f.cct = CCT_PLACEHOLDER;
    f.cctMin = CCT_PLACEHOLDER;
    f.cctMax = CCT_PLACEHOLDER;
    f.colorMode = "单色";
    f.tunable = false;
    f.colored = false;
    return;
  }
  delete f.cctPending;
}

/** 把色温夹取到该灯具允许区间。 */
export function clampCctForFixture(f: Obj, cct: number): number {
  const min = Number(f.cctMin) || 2700;
  const max = Number(f.cctMax) || 6500;
  return Math.max(min, Math.min(max, Number(cct) || min));
}

/**
 * 情景状态归一：把每盏灯的状态夹进**它自己**的范围（色温 ∈ [cctMin,cctMax]、亮度 ≤ brightnessMax、
 * 缺值补齐）。返回被修动的字段数。
 *
 * 为什么必须有：全关这类模板早先直接写死 3000K，遇到 4000K 单色灯（cctMin=cctMax=4000）就会被后端
 * 的 422「色温 3000K 超出该灯具允许范围 4000-4000K」**整单拦下**——一键设置场景因此经常报错，
 * 而且后端是整份设计一起校验，一条坏状态会让**任何**保存都失败。放在唯一的保存咽喉（change()）里，
 * 覆盖场景包 / 一键设置场景 / 手改情景 / 导入 所有路径，以后新增模板也漏不出去。
 */
export function clampSceneStates(design: Obj): number {
  const byId = new Map<string, Obj>((design?.fixtures || []).map((f: Obj) => [String(f.id), f]));
  let fixed = 0;
  for (const s of design?.scenes || []) {
    const states = s?.states;
    if (!states || typeof states !== "object") continue;
    for (const fid of Object.keys(states)) {
      const f = byId.get(String(fid));
      const st = states[fid];
      if (!f || !st || typeof st !== "object") continue;
      const want = Number(st.cct);
      const cct = clampCctForFixture(f, Number.isFinite(want) && want > 0 ? want : 3000);
      if (cct !== want) { st.cct = cct; fixed += 1; }
      const max = Number(f.brightnessMax) || 100;
      const wantB = Number(st.brightness);
      const b = Math.max(0, Math.min(max, Number.isFinite(wantB) ? wantB : 0));
      if (b !== wantB) { st.brightness = b; fixed += 1; }
      if (typeof st.on !== "boolean") { st.on = !!st.on; fixed += 1; }
    }
  }
  return fixed;
}

/** 色温异常说明（无异常返回空数组）：灯具配置页逐灯显示 + 定位修改用。
 *  覆盖后端会拒绝保存的三种情况：上下限倒置 / 超出 1000–20000K / 情景里的色温越界。 */
export function cctIssuesOf(f: Obj, scenes: Obj[] = []): string[] {
  const out: string[] = [];
  const lo = Number(f?.cctMin);
  const hi = Number(f?.cctMax);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    out.push("色温上下限未填写");
    return out;
  }
  if (lo > hi) out.push(`最低色温 ${lo}K 高于最高色温 ${hi}K`);
  if (lo < 1000 || lo > 20000 || hi < 1000 || hi > 20000)
    out.push(`色温 ${lo}–${hi}K 超出允许范围 1000–20000K`);
  const min = Math.min(lo, hi);
  const max = Math.max(lo, hi);
  const bad = (scenes || []).filter((sc) => {
    const st = sc?.states?.[f.id];
    const c = Number(st?.cct);
    return Number.isFinite(c) && (c < min || c > max);
  });
  if (bad.length)
    out.push(
      `${bad.length} 个情景的色温超出该灯具范围（${bad
        .slice(0, 3)
        .map((sc) => sc.name)
        .join("、")}${bad.length > 3 ? " 等" : ""}）`,
    );
  if (colorModeOf(f) === "单色" && Number(f.cct) !== min)
    out.push(`单色灯具固定色温 ${f.cct}K 与上下限 ${lo}–${hi}K 不一致`);
  return out;
}

