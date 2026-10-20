/**
 * 平面画布上拖家具「边界」的换算（宽 / 深）。
 *
 * 2026-10-16：「家具的边界也需要是可调整的」。空间能拖右下角改长宽，家具以前只有
 * 语义调整面板里填数字。这里做 8 个把手（4 角 + 4 边）：拖某条边 → 只改那一个尺寸，
 * **对面那条边钉住不动**（所以中心跟着挪「被拖那条边位移的一半」）；家具带朝向时，先把
 * 指针位移转到家具自己的坐标系里再算，拖起来才跟手。
 *
 * 单位：x/y 是设计单位（26/米），widthM/depthM 是米 —— 换算只在这里做一次。
 * 尺寸口径与后端 validate_design 一致：0.05–20 米。
 * 纯函数、不 import 其它模块：node 能直接跑测试（与 furnitureEdits.ts / roomPolygon.ts 同一约束）。
 */
export type FurnHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export const FURN_MIN_M = 0.05;
export const FURN_MAX_M = 20;
export const UNITS_PER_M = 26;

/** 把手在家具自身坐标系里的方位：su＝沿「宽」（±1 或 0）、sv＝沿「深」（±1 或 0）。 */
export const FURN_HANDLES: { handle: FurnHandle; su: number; sv: number }[] = [
  { handle: "nw", su: -1, sv: -1 }, { handle: "n", su: 0, sv: -1 }, { handle: "ne", su: 1, sv: -1 },
  { handle: "w", su: -1, sv: 0 }, { handle: "e", su: 1, sv: 0 },
  { handle: "sw", su: -1, sv: 1 }, { handle: "s", su: 0, sv: 1 }, { handle: "se", su: 1, sv: 1 },
];

const round = (v: number, n = 2) => Math.round(v * 10 ** n) / 10 ** n;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function resizeFurniture(
  row: { x: number; y: number; widthM?: number; depthM?: number; rotation?: number },
  handle: FurnHandle,
  dx: number,
  dy: number,
  unitsPerMeter = UNITS_PER_M,
): { x: number; y: number; widthM: number; depthM: number } {
  const a = ((Number(row.rotation) || 0) * Math.PI) / 180;
  const per = unitsPerMeter || UNITS_PER_M;
  // 世界位移（设计单位）→ 家具自身坐标（米）；SVG 的 rotate 取反，画布 y 向下与图纸同向
  const lu = (dx * Math.cos(a) + dy * Math.sin(a)) / per;
  const lv = (-dx * Math.sin(a) + dy * Math.cos(a)) / per;
  let w = Number(row.widthM) || .6;
  let d = Number(row.depthM) || .6;
  const { su, sv } = FURN_HANDLES.find(h => h.handle === handle) || { su: 0, sv: 0 };
  let du = 0;                                   // 中心位移（米）：对面那条边钉住 → 半个尺寸变化
  let dv = 0;
  if (su) { const nw = clamp(w + su * lu, FURN_MIN_M, FURN_MAX_M); du = (su * (nw - w)) / 2; w = nw; }
  if (sv) { const nd = clamp(d + sv * lv, FURN_MIN_M, FURN_MAX_M); dv = (sv * (nd - d)) / 2; d = nd; }
  const wx = (du * Math.cos(a) - dv * Math.sin(a)) * per;
  const wy = (du * Math.sin(a) + dv * Math.cos(a)) * per;
  return { x: round(row.x + wx), y: round(row.y + wy), widthM: round(w), depthM: round(d) };
}
