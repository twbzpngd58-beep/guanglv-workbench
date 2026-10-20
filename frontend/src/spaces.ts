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
