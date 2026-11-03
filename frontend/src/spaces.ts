// 空间库：工作台唯一的空间词表。数据在 data/code-library.json（前端与后端共用同一份；
// 后端识别词表、导出「编号规则」对照表都从它读，勿单边手改）。
//
// 每个空间 = 空间码 + 名称 + 分区 + 适用户型 + 图纸别名 + 主要功能：
//   空间码   灯具/设备编号的前缀（kc001 = 客厅·茶几 1 号灯）。老 18 个空间保持一位小写字母不变，
//            新增空间用两位小写字母；编号解析按「先长后短、整段严丝合缝」进行，不会混读。
//   分区     管理空间 / 新增空间 / 布灯 下拉里的分组。
//   适用户型 该空间在哪些户型里属于常规配置；项目里明确新增的空间永远优先，不受这里限制。
//   别名     图纸上的常见写法（玄关→门厅、家庭影院→影音室…），与后端读数词表同名同义。

import lib from "./data/code-library.json";

export type HouseType = "平层" | "复式" | "别墅" | "商业空间";

export type SpaceDef = {
  /** 空间码（编号前缀）：老空间一位字母，新增空间两位 */
  code: string;
  name: string;
  /** 管理界面里的分区 */
  group: string;
  houses: HouseType[];
  /** 图纸别名（与 backend/recognition.py 的别名表同义） */
  aliases: string[];
  /** 主要功能（界面提示 / 导出说明用） */
  note: string;
  /** 场景包里有标准情景的原有空间 */
  legacy?: boolean;
};

/** 分区顺序（管理空间、新增空间、布灯下拉共用）。 */
export const SPACE_GROUPS: string[] = lib.groups;

export const SPACE_LIBRARY: SpaceDef[] = lib.spaces as SpaceDef[];

/** 分区 → 该分区空间（顺序与 SPACE_LIBRARY 一致），空分区不返回。 */
export const GROUPED_SPACES: { group: string; spaces: SpaceDef[] }[] = SPACE_GROUPS.map(
  (group) => ({ group, spaces: SPACE_LIBRARY.filter((s) => s.group === group) }),
).filter((g) => g.spaces.length > 0);

/** 空间码 → 空间定义。 */
export const spaceMapByCode: Map<string, SpaceDef> = new Map(
  SPACE_LIBRARY.map((s) => [s.code, s]),
);

/** 空间名 → 空间定义。 */
export const spaceMapByName: Map<string, SpaceDef> = new Map(
  SPACE_LIBRARY.map((s) => [s.name, s]),
);

/** 图纸别名 → 空间定义（玄关→门厅、家庭影院→影音室、储物间→收纳间…）。 */
export const spaceMapByAlias: Map<string, SpaceDef> = new Map(
  SPACE_LIBRARY.flatMap((s) =>
    (s.aliases || []).map((a) => [a, s] as [string, SpaceDef]),
  ),
);

/** 某户型常规包含的空间（项目里明确选过的空间永远优先）。 */
export function spacesForHouseType(houseType: string): SpaceDef[] {
  const type = (houseType || "").trim();
  return SPACE_LIBRARY.filter((s) => s.houses.includes(type as HouseType));
}

/**
 * 房间名里可能同时含两类空间（「餐厅、客厅」「厨房及餐厅」「客厅/餐厅」）：
 * 按分隔符切开逐个认，按出现顺序返回，去重。
 * 为什么单独一个函数：解析器会把连通的两个空间合成一间房、只留一个 spaceCode，
 * 布灯/设备的位置下拉若只按那一个码取表，另一类空间的家具位就整片消失（2026-10-27 用户报的 bug）。
 * 这里只负责「名字里有哪几类空间」，不改房间数据、不改 spaceCode 的既有含义。
 */
export function spaceCodesOfRoomName(name: string): SpaceDef[] {
  const nm = (name || "").trim();
  if (!nm) return [];
  const out: SpaceDef[] = [];
  const push = (s?: SpaceDef | null) => {
    if (s && !out.some((x) => x.code === s.code)) out.push(s);
  };
  const resolve = (token: string) => {
    const exact = spaceMapByName.get(token) || spaceMapByAlias.get(token);
    if (exact) { push(exact); return true; }
    return false;
  };
  for (const raw of nm.split(/[、,，/／+＋&·\s]+/).map((t) => t.trim()).filter(Boolean)) {
    if (resolve(raw)) continue;
    // 「厨房及餐厅」「卧室和书房」：连词两侧都认得才算拆分，避免把「和室」这类词误切。
    const parts = raw.split(/[及和与跟]/).map((t) => t.trim()).filter(Boolean);
    if (parts.length > 1 && parts.every((p) => spaceMapByName.has(p) || spaceMapByAlias.has(p))) {
      parts.forEach((p) => resolve(p));
      continue;
    }
    // 带后缀的房间名（餐厅2 / 客厅阳台）：按最长空间名做前缀匹配，与 roomSpaceCodeOf 的旧口径一致。
    const hit = [...SPACE_LIBRARY]
      .sort((a, b) => b.name.length - a.name.length)
      .find((s) => raw.startsWith(s.name));
    push(hit);
  }
  return out;
}
