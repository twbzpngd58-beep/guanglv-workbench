/**
 * 设备落位规则：面板贴墙、遥控器（时光之轮）坐家具顶面。
 *
 * 2026-10-16 口径：
 *  ① 「添加面板时可以设置其高度，贴在空间中，都是在墙面上的」——墙装面板的高度由
 *     device.installHeight 决定（没设就用墙高中上部的默认值，见 ./wallMount）。
 *  ② 「时光之轮除外」——它是 CITRON 世聪的蓝牙旋钮遥控器（磁吸无线充电、不含底座），
 *     只是**产品库挂在面板类目下**，所以老代码把它当墙装面板吸到墙上了。
 *     它应当「直接在家具或空间中可见」：点在家具上（比如茶几）就出现在茶几顶面，
 *     点在空间里就落在地面。
 *
 * 纯判断 + 纯几何：**不 import 任何东西**（和 ./furniturePolygon 一样，node 直接可测）。
 */

/** 设计单位/米（与后端 DESIGN_UNITS_PER_M 同口径）。 */
const UNITS_PER_M = 26;

/** 桌面/家具上用的遥控器（时光之轮）：不走墙装。 */
export function isTabletopDevice(dev: any): boolean {
  const s = `${dev?.name || ""} ${dev?.series || ""} ${dev?.model || ""} ${dev?.productId || ""}`;
  return /时光之轮|遥控器|SC-BLE-SK/.test(s);
}

/** 这件家具在平面上的轮廓点（有轮廓用轮廓，没有就用朝向后的矩形四角）。 */
function outlineOf(row: any): { x: number; y: number }[] {
  if (Array.isArray(row?.points) && row.points.length >= 3) {
    return row.points.map((p: any) => ({ x: +p.x, y: +p.y }));
  }
  const w = +row.widthM * UNITS_PER_M / 2, d = +row.depthM * UNITS_PER_M / 2;
  if (!(w > 0) || !(d > 0)) return [];
  const a = ((+(row.rotation || 0)) * Math.PI) / 180;
  const ca = Math.cos(a), sa = Math.sin(a);
  return [[-w, -d], [w, -d], [w, d], [-w, d]].map(([dx, dy]) => ({
    x: +row.x + dx * ca - dy * sa,
    y: +row.y + dx * sa + dy * ca,
  }));
}

/** 点是否落在这件家具上（射线法，轮廓已含朝向）。 */
function furnitureHas(row: any, x: number, y: number): boolean {
  const pts = outlineOf(row);
  if (pts.length < 3) return false;
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * 落在哪件家具上：返回它**顶面高度（米）**，没压在任何家具上返回 null。
 * 多件重叠时取最高的那件（遥控器坐在最上面那层）。
 */
export function furnitureTopAt(furniture: any[] | undefined, x: number, y: number, floor = 1): number | null {
  let top: number | null = null;
  for (const row of furniture || []) {
    if (!row || row.hidden) continue;
    if (+(row.floor || 1) !== floor) continue;
    if (!furnitureHas(row, x, y)) continue;
    const h = +row.heightM;
    if (!Number.isFinite(h) || h <= 0) continue;
    top = top === null ? h : Math.max(top, h);
  }
  return top;
}

/** 遥控器/桌面设备的落位高度（米）：家具顶面；家具外面＝地面。 */
export function tabletopY(furniture: any[] | undefined, x: number, y: number, floor = 1): number {
  return furnitureTopAt(furniture, x, y, floor) ?? 0;
}
