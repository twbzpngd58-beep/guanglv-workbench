/* 功能编号登记表（唯一事实来源）。
 *
 * 每个用户可见的功能一个编号：模块码 + 两位序号，例如 L-07。
 * 界面元素用 data-fid="L-07" 打标；本表负责中文名、说明与分组。
 * 新增功能：先取本模块下一个未用号段，再在源码打标，最后在 FEATURES 里登记。
 */
export type FeatureKind = "button" | "panel" | "tab" | "dialog" | "action" | "switch" | "group";

export type FeatureDef = {
  id: string;
  name: string;
  module: string;
  kind: FeatureKind;
  desc: string;
  file?: string;
  hideable?: boolean;
};

export const FEATURE_MODULES: { code: string; label: string; desc: string }[] = [
  { code: "S", label: "外壳与页面", desc: "工作台首页、项目、灯具库、场景库、能力" },
  { code: "P", label: "项目工作台", desc: "顶栏、左轨、项目结构树、通用弹窗" },
  { code: "D", label: "底图与空间", desc: "图纸导入、识别、空间确认、门窗家具、楼层" },
  { code: "L", label: "布灯与设备", desc: "灯具、灯带、回路、面板、传感器" },
  { code: "R", label: "复核", desc: "自检、审阅、冻结" },
  { code: "E", label: "交付与导出", desc: "导出格式、交付对象、场景页、刻字" },
  { code: "C", label: "智能情景", desc: "情景编辑、场景包、漫游" },
  { code: "V", label: "效果与三维", desc: "效果图、示意、三维视图控件" },
  { code: "K", label: "设置与版本", desc: "工作台设置、版本更新、许可" },
  { code: "A", label: "能力与插件", desc: "能力表、版本切换、KNX/企业能力" },
  { code: "X", label: "通用组件", desc: "确认框、剪贴板、快捷键等公共能力" },
];

export const MODULE_LABEL: Record<string, string> = Object.fromEntries(
  FEATURE_MODULES.map((m) => [m.code, m.label]),
);

/** 全部功能登记。按模块顺序、编号顺序排列。 */
export const FEATURES: FeatureDef[] = [];

export const FEATURE_MAP: Map<string, FeatureDef> = new Map(FEATURES.map((f) => [f.id, f]));

export function featureName(id: string): string {
  return FEATURE_MAP.get(id)?.name || id;
}

/** 编号合法性：S-01 / L-23 这种形式。 */
export const FID_RE = /^[A-Z]{1,2}-\d{2}$/;

export function isKnownFeature(id: string): boolean {
  return FEATURE_MAP.has(id);
}
