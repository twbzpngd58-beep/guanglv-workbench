/**
 * 总线智能里的飞利浦 WiZ/Hue 灯具载体（2026-11-04 用户口径）。
 *
 * 事实：WiZ/Hue 灯具本身是 Wi-Fi 灯，并入 KNX 只加一台飞利浦 Hue 网桥；
 * 与 DALI 一样是单灯单控，差别只在协议。所以这类灯没有「回路」——
 * 回路是「一组灯共用一路开关」的分组，单灯单控不成立。
 *
 * 口径：逐灯混用（同项目可有 DALI 灯、开闭灯、WiZ/Hue 灯）；载体仅限飞利浦 WiZ/Hue；
 * 网桥每层 1 台、每台最多 40 个设备。
 * 后端 backend/circuit_rules.py 是同一套判据的另一份实现，改这里要一起改。
 */
import type { Obj } from "./types";

/** 灯具「控制方式」里这一档的取值（与 DALI / 开关控制 / 蓝牙 Mesh 同一词表）。 */
export const BRIDGE_CONTROL = "WiZ/Hue";
export const BRIDGE_CONTROL_LABEL = "WiZ/Hue（网桥单灯单控）";
/** 每台飞利浦 Hue 网桥最多带 40 个设备。 */
export const BRIDGE_CAP = 40;
export const BRIDGE_MODEL = "Hue Bridge";
export const BRIDGE_BRAND = "飞利浦";

const str = (v: unknown) => String(v ?? "").trim();

export const isBridgeControl = (v: unknown) => str(v) === BRIDGE_CONTROL;
/** 这盏灯走网桥单灯单控：它不属于任何回路。 */
export const isBridgeLamp = (f?: Obj | null) => !!f && isBridgeControl(f.control);

/** 是否飞利浦 WiZ/Hue 的产品：选型目录按 catalogId/catalogBrand 认，产品库按品牌认。 */
export function isPhilipsWireless(v?: Obj | null): boolean {
  if (!v) return false;
  const id = str(v.catalogId || v.id);
  if (/^philips[-_]/i.test(id) || str(v.catalogBrand).toLowerCase() === "philips") return true;
  const text = `${str(v.brand)} ${str(v.model)} ${str(v.series)} ${str(v.name)}`;
  return /飞利浦|philips/i.test(text) && /wiz|hue/i.test(str(v.series) + str(v.model) + id);
}

/** 网桥台数：按楼层分开算，每层至少 1 台、每台 ≤BRIDGE_CAP 个设备。 */export function bridgeCountByFloor(
  lamps: Obj[],
  floorOf: (f: Obj) => number,
): { floor: number; lamps: number; bridges: number }[] {
  const per = new Map<number, number>();
  for (const f of lamps) {
    const fl = Math.max(1, Number(floorOf(f)) || 1);
    per.set(fl, (per.get(fl) || 0) + 1);
  }
  return [...per.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([floor, n]) => ({ floor, lamps: n, bridges: Math.ceil(n / BRIDGE_CAP) }));
}

/** 人明确写了开关控制的灯不跟着归位：现场可能就是要单独一路开关它（与 applyBusDefaults 同口径）。 */
export const BRIDGE_KEEP_CONTROL = "开关控制";

/**
 * 存量归位：总线智能（KNX）项目里，型号是飞利浦 WiZ/Hue 的灯落网桥单灯单控、摘掉回路。
 * 这类灯的载体 2026-11-04 才进工作台，存量设计里 control 还写着 DALI 或空、回路挂在 C01 上——
 * 按已拍板口径那些值是错的。返回改写盏数，调用方拿它出可见提示（不静默改数据）。
 * 后端 backend/circuit_rules.py converge_bus_carriers 同口径，兜住不走界面的保存。
 */
export function convergeBusCarriers(design: Obj, smart: unknown): number {
  if (str(smart) !== "KNX") return 0;
  let n = 0;
  for (const f of design.fixtures || []) {
    if (!f || f.type === "窗帘") continue;
    const ctrl = str(f.control);
    if (ctrl === BRIDGE_CONTROL || ctrl === BRIDGE_KEEP_CONTROL || !isPhilipsWireless(f)) continue;
    f.control = BRIDGE_CONTROL;
    f.dimmable = true;
    if (str(f.colorMode) && str(f.colorMode) !== "单色") f.tunable = true;
    delete f.circuit;
    delete f.circuitId;
    n += 1;
  }
  return n;
}
