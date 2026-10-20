/**
 * 家具边界＝多边形（老板 2026-10-16：「家具要像空间一样的编辑方式，可以修改边界、多边形绘制、
 * 删除、增加/删除点」）。
 *
 * 数据口径：家具行 `points` 存**世界坐标**（设计单位，与空间 points 同一套），不带旋转——
 * 二维上画成什么形状就是什么形状。没画过多边形的家具照旧只有 x/y + widthM/depthM + rotation，
 * 由 `furniturePoints` 按朝向折成 4 个角点（和画布上那个旋转矩形完全重合）。
 *
 * ⚠️ 这个模块**不 import 任何东西**：`scripts/test-furniture-polygon.mjs` 用 node 直接跑 .ts，
 * 跨文件的无扩展名 import 解析不了（roomPolygon / furnitureResize 同一约束）。校验逻辑与
 * roomPolygon 保持同一口径（≥3 点、不重合、不自交、有面积），改动要一起改。
 */

export type FurnPoint = { x: number; y: number };

/** 设计单位 / 米（与 UNITS、DESIGN_UNITS_PER_M 一致） */
export const FURN_UNITS = 26;
export const FURN_MIN_POINTS = 3;
/** 家具尺寸口径：与后端 validate_design 一致（0.05–20 米） */
export const FURN_MIN_M = 0.05;
export const FURN_MAX_M = 20;

const r2 = (v: number) => Math.round(v * 100) / 100;
const near = (a: FurnPoint, b: FurnPoint) => Math.hypot(a.x - b.x, a.y - b.y) < 1e-6;

/** 家具边界点（世界坐标）：画过多边形就用它；否则按 x/y/宽深/朝向折成 4 个角。 */
export function furniturePoints(row: any): FurnPoint[] {
  const raw = Array.isArray(row?.points) ? row.points : [];
  if (raw.length >= 3) {
    const pts = raw
      .map((v: any) => ({ x: Number(v?.x), y: Number(v?.y) }))
      .filter((v: FurnPoint) => Number.isFinite(v.x) && Number.isFinite(v.y));
    if (pts.length >= 3) {
      if (pts.length > 3 && near(pts[0], pts[pts.length - 1])) pts.pop();
      return pts;
    }
  }
  const w = (Number(row?.widthM) || 0.6) * FURN_UNITS;
  const d = (Number(row?.depthM) || 0.6) * FURN_UNITS;
  const a = ((Number(row?.rotation) || 0) * Math.PI) / 180;
  const cos = Math.cos(a), sin = Math.sin(a);
  const cx = Number(row?.x) || 0, cy = Number(row?.y) || 0;
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => ({
    x: r2(cx + ((sx * w) / 2) * cos - ((sy * d) / 2) * sin),
    y: r2(cy + ((sx * w) / 2) * sin + ((sy * d) / 2) * cos),
  }));
}

/** 有没有画过的多边形（false＝还是矩形/朝向那套）。 */
export function hasFurniturePolygon(row: any): boolean {
  return Array.isArray(row?.points) && row.points.length >= 3;
}

function check(points: FurnPoint[]) {
  if (points.length < FURN_MIN_POINTS) throw new Error("家具边界至少保留3个点");
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i], b = points[(i + 1) % points.length];
    if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) throw new Error("边界坐标无效");
    if (near(a, b)) throw new Error("边界点不能重合");
  }
  const cross = (a: FurnPoint, b: FurnPoint, c: FurnPoint) =>
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  for (let i = 0; i < points.length; i += 1)
    for (let j = i + 1; j < points.length; j += 1) {
      if (j === i + 1 || (i === 0 && j === points.length - 1)) continue;
      const a = points[i], b = points[(i + 1) % points.length];
      const c = points[j], d = points[(j + 1) % points.length];
      if (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0)
        throw new Error("边界不能交叉，请调整顶点");
    }
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i], b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  if (Math.abs(sum) < 1e-6) throw new Error("边界必须围成有效面积");
}

/** 把一圈点写回家具行：外接框回写 x/y/宽深（米），来源标成人工改过。 */
export function withFurniturePolygon(row: any, points: FurnPoint[]): any {
  const pts = points.map((p) => ({ x: r2(p.x), y: r2(p.y) }));
  if (pts.length > 3 && near(pts[0], pts[pts.length - 1])) pts.pop();
  check(pts);
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  // x/y 与矩形口径一致＝**中心**（不是外接框左上角）：恢复矩形、改宽深、面板坐标字段都不用换算法。
  const x = (Math.min(...xs) + Math.max(...xs)) / 2, y = (Math.min(...ys) + Math.max(...ys)) / 2;
  let sum = 0;
  for (let i = 0; i < pts.length; i += 1) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    sum += a.x * b.y - b.x * a.y;
  }
  const next: any = {
    ...row,
    points: pts,
    x: r2(x), y: r2(y),
    widthM: Math.min(FURN_MAX_M, Math.max(FURN_MIN_M, r2((Math.max(...xs) - Math.min(...xs)) / FURN_UNITS))),
    depthM: Math.min(FURN_MAX_M, Math.max(FURN_MIN_M, r2((Math.max(...ys) - Math.min(...ys)) / FURN_UNITS))),
    area: Math.round((Math.abs(sum) / 2 / (FURN_UNITS * FURN_UNITS)) * 10) / 10,
    source: "manual",
  };
  // 早期有代码把「空间口径」的 width/height 写进了家具行，留着会让人（和读数据的代码）以为它是个空间。
  delete next.width;
  delete next.height;
  return next;
}

/** 把点投影到 a→b 这段边界上（加点的落点用）。 */
export function projectToFurnEdge(p: FurnPoint, a: FurnPoint, b: FurnPoint): FurnPoint {
  const dx = b.x - a.x, dy = b.y - a.y, dd = dx * dx + dy * dy;
  const t = dd ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / dd)) : 0;
  return { x: r2(a.x + t * dx), y: r2(a.y + t * dy) };
}

/** 在第 edge 段边界上（两个顶点之间）插一个点。 */
export function insertFurniturePoint(row: any, edge: number, point: FurnPoint): any {
  const pts = furniturePoints(row);
  const a = pts[edge], b = pts[(edge + 1) % pts.length];
  if (!a || !b) throw new Error("请选择有效边界线");
  const p = projectToFurnEdge(point, a, b);
  if (Math.min(Math.hypot(p.x - a.x, p.y - a.y), Math.hypot(p.x - b.x, p.y - b.y)) < 1e-5)
    throw new Error("请在边界线上、两个顶点之间增加点");
  pts.splice(edge + 1, 0, p);
  return withFurniturePolygon(row, pts);
}

/** 删掉第 index 个顶点（矩形家具会先折成 4 个角再删，所以也就变成多边形了）。 */
export function deleteFurniturePoint(row: any, index: number): any {
  const pts = furniturePoints(row);
  if (pts.length <= FURN_MIN_POINTS) throw new Error("家具边界至少保留3个点，不能再删除");
  if (index < 0 || index >= pts.length) throw new Error("请选择有效顶点");
  pts.splice(index, 1);
  return withFurniturePolygon(row, pts);
}

/** 面板按钮用：在最长的边上插一个中点（不用在画布上瞄准）。 */
export function addFurnitureMidpoint(row: any): any {
  const pts = furniturePoints(row);
  let best = 0, bestLen = -1;
  for (let i = 0; i < pts.length; i += 1) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len > bestLen) { bestLen = len; best = i; }
  }
  const a = pts[best], b = pts[(best + 1) % pts.length];
  return insertFurniturePoint(row, best, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
}

/** 拖某个顶点：只挪它，外接框跟着重算。 */
export function moveFurniturePoint(row: any, index: number, dx: number, dy: number): any {
  const pts = furniturePoints(row);
  if (!pts[index]) return row;
  pts[index] = { x: r2(pts[index].x + dx), y: r2(pts[index].y + dy) };
  try { return withFurniturePolygon(row, pts); } catch { return row; }
}

/** 恢复成矩形（丢掉多边形，回到宽深＋朝向那套）。 */
export function deleteFurniturePolygon(row: any): any {
  const next = { ...row };
  delete next.points;
  delete next.area;
  return next;
}

/** 改宽/改深时把已画的多边形按比例缩放（否则填数字对多边形不生效）。 */
export function scaleFurniturePolygon(row: any, widthM: number, depthM: number): any {
  const w = Number(widthM) || 0, d = Number(depthM) || 0;
  if (!hasFurniturePolygon(row) || !(w > 0) || !(d > 0))
    return { ...row, widthM: w > 0 ? w : row.widthM, depthM: d > 0 ? d : row.depthM };
  const pts = furniturePoints(row);
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const bw = Math.max(...xs) - Math.min(...xs) || 1, bh = Math.max(...ys) - Math.min(...ys) || 1;
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const sx = (w * FURN_UNITS) / bw, sy = (d * FURN_UNITS) / bh;
  return withFurniturePolygon(row, pts.map((p) => ({ x: cx + (p.x - cx) * sx, y: cy + (p.y - cy) * sy })));
}

/** 整件平移（复制家具、拖整件时用）。 */
export function translateFurniturePolygon(row: any, dx: number, dy: number): any {
  if (!hasFurniturePolygon(row)) return row;
  // 平移后必须重算 x/y＝新外接框中心（只挪点、不重算 x/y 就会把不变量弄坏）。
  return withFurniturePolygon(row, furniturePoints(row).map((p) => ({ x: r2(p.x + dx), y: r2(p.y + dy) })));
}

/** 拖矩形把手（furnitureResize 算好新的 x/y/宽/深）时要一并作用到多边形上：
 *  先按新宽深等比缩放，再平移到新中心——对面那条边仍然是钉住的。 */
export function resizeFurniturePolygon(row: any, x: number, y: number, widthM: number, depthM: number): any {
  const next = { ...row, x: Number(x), y: Number(y), widthM: Number(widthM), depthM: Number(depthM) };
  if (!hasFurniturePolygon(row)) return next;
  const scaled = scaleFurniturePolygon(row, Number(widthM), Number(depthM));
  const dx = Number(x) - Number(row.x || 0), dy = Number(y) - Number(row.y || 0);
  return withFurniturePolygon(next, scaled.points.map((p: FurnPoint) => ({ x: p.x + dx, y: p.y + dy })));
}

/** 改朝向：矩形家具照旧只改 rotation；画过多边形的把轮廓一起转（围绕中心），
 *  二维看到的形状与三维那只盒子的摆向始终一致。 */
export function setFurnitureRotation(row: any, deg: number): any {
  const target = (((Number(deg) || 0) % 360) + 360) % 360;
  const next = { ...row, rotation: target };
  if (!hasFurniturePolygon(row)) return next;
  const delta = ((target - (Number(row.rotation) || 0)) * Math.PI) / 180;
  const cos = Math.cos(delta), sin = Math.sin(delta);
  const cx = Number(row.x) || 0, cy = Number(row.y) || 0;
  return withFurniturePolygon(next, furniturePoints(row).map((p) => ({
    x: cx + (p.x - cx) * cos - (p.y - cy) * sin,
    y: cy + (p.x - cx) * sin + (p.y - cy) * cos,
  })));
}

/**
 * 家具行的「规范形态」（不变量：有 points 就以 points 为准）。
 *
 * 这条不变量必须被**每一个写家具的代码路径**守住：x/y 是**轮廓外接框的中心**，宽深是外接框的米数。
 * 一旦破了（老板 2026-10-16 的 `text` 项目就是：三维页「语义调整」把 x/y 覆盖成了图纸里的老位置，
 * 轮廓却留在新位置），三维那只盒子就会画到别处、甚至穿出墙体——二维看轮廓是好的，越看越像「形状全错」。
 * 渲染（三维盒子/二维标签）、面板读数、复制、改宽深/朝向，进这行数据前都先过一遍这个函数。
 */
/** 「轮廓本身就是它的形状」的大类：柜类 / 沙发 / 岛台吧台 / 地毯。
 *
 *  老板 2026-10-16 报「马桶跟日常马桶差异太大」：马桶是**设计过的器物**，图纸里那圈轮廓
 *  只是它被识别出来的占地（他那件 12 点、占外接框 0.57、还非凸——和我按轮廓画出来的
 *  L 形柜子形态指标几乎一样，**光看形状分不开**）。所以只能按「类」判：
 *  器物类一律用标准造型（马桶＝水箱＋便座），只有「占地即形状」的大类才按轮廓挤出。
 */
const FOOTPRINT_KIND = /柜|沙发|岛台|吧台|地毯|案台|工作台|岛柜/;

/** 轮廓是否「基本就是个矩形」（占外接框 ≥ 0.9 且凸）：是的话标准造型更好看，不用挤出。 */
function outlineNearBox(pts: { x: number; y: number }[]): boolean {
  if (pts.length < 3) return true;
  let area2 = 0;
  const xs: number[] = [], ys: number[] = [];
  let sign = 0, convex = true;
  for (let i = 0; i < pts.length; i += 1) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    area2 += a.x * b.y - b.x * a.y;
    xs.push(a.x); ys.push(a.y);
    const c = pts[(i + 2) % pts.length];
    const cr = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cr) > 1e-6) {
      const sg = cr > 0 ? 1 : -1;
      if (sign === 0) sign = sg;
      else if (sg !== sign) convex = false;
    }
  }
  const area = Math.abs(area2) / 2;
  const box = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
  return convex && box > 0 && area / box >= 0.9;
}

/** 这件家具的三维外形要不要按画的轮廓挤出？（马桶、浴缸、床这类一律走标准造型） */
export function outlineDrivesShape(row: any): boolean {
  if (!hasFurniturePolygon(row)) return false;
  if (!FOOTPRINT_KIND.test(String(row?.kind || ""))) return false;
  return !outlineNearBox(furniturePoints(row));
}

export function normalizeFurniture(row: any): any {
  if (!hasFurniturePolygon(row)) return row;
  try { return withFurniturePolygon(row, furniturePoints(row)); } catch { return row; }
}
