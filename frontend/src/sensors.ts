// 传感器探测范围：默认整圆（360°），可设「视场角 + 朝向」→ 扇形。
//
// 为什么要这一层：真机本来就不是全向圆（毫米波雷达常见 120° 视场，红外是锥形），
// 而工作台原来的判定是纯距离（Math.hypot <= range），半径一大就必然穿墙——
// 隔壁房间、楼上楼下的走动都会点灯。贴墙装、只朝走道一侧是最常用的防穿墙手段，
// 所以这里让视场角/朝向既能画出来，也参与漫游判定与交付页判定。
// 默认 360° ＝ 与改造前行为完全一致（零回归）。
import type { Obj } from "./types";

/** 视场角档位：360 整圆；其余为扇形（真机常见 120°/90°）。 */
export const FOV_OPTIONS = [360, 270, 180, 120, 90];

/** 26 画布单位 = 1 米（沿用工作台约定），用于把距离翻译成人话。 */
export const UNITS_PER_METRE = 26;

export function sensorShape(s: Obj) {
  const range = Number(s?.range) > 0 ? Number(s.range) : 80;
  const fovRaw = Number(s?.fov);
  const fov =
    Number.isFinite(fovRaw) && fovRaw > 0 ? Math.min(360, Math.max(5, fovRaw)) : 360;
  const headingRaw = Number(s?.heading);
  const heading = Number.isFinite(headingRaw) ? ((headingRaw % 360) + 360) % 360 : 0;
  return { range, fov, heading, sector: fov < 359.5 };
}

/** 目标点是否落在探测范围内（整圆或扇形；传 opts 时再按空间边界/墙体裁剪）：
 *  画布、漫游演示、交付页共用同一套判定。
 *  角度用画布坐标系（y 向下，0° 指向 +x，顺时针），与真机正对图纸右侧装法一致。 */
export function sensorCovers(s: Obj, x: number, y: number, opts?: CoverageOpts): boolean {
  // 手动调过的范围优先：视场角/半径不再参与；但墙仍然挡（2026-10-17：感应不能穿墙）——
  // 手拖的顶点越过了墙，墙后那块也不算覆盖。
  if (hasManualCoverage(s)) return manualCovers(s, x, y) && sensorCoversWithGeometry(s, x, y, opts);
  const { range, fov, heading, sector } = sensorShape(s);
  if (!(range > 0)) return false;
  const dx = Number(x) - (Number(s?.x) || 0);
  const dy = Number(y) - (Number(s?.y) || 0);
  const d = Math.hypot(dx, dy);
  if (d > range) return false;
  if (sector && d >= 0.5) {
    const deg = (Math.atan2(dy, dx) * 180) / Math.PI;
    const diff = (((deg - heading + 540) % 360) + 360) % 360 - 180;
    if (Math.abs(diff) > fov / 2) return false;
  }
  // 有空间边界/墙体时再过一道遮挡：隔墙的目标不算覆盖（②③）
  return sensorCoversWithGeometry(s, x, y, opts);
}

/** 扇形路径（SVG d）；整圆返回 null，交给 <circle> 画。 */
export function sensorSectorPath(s: Obj): string | null {
  const { range, fov, heading, sector } = sensorShape(s);
  if (!sector || !(range > 0)) return null;
  const a0 = ((heading - fov / 2) * Math.PI) / 180;
  const a1 = ((heading + fov / 2) * Math.PI) / 180;
  const steps = Math.max(6, Math.round(fov / 6));
  const pts: string[] = ["M 0 0"];
  for (let i = 0; i <= steps; i += 1) {
    const a = a0 + ((a1 - a0) * i) / steps;
    pts.push(`L ${(Math.cos(a) * range).toFixed(2)} ${(Math.sin(a) * range).toFixed(2)}`);
  }
  pts.push("Z");
  return pts.join(" ");
}

/** 距离 → 人话（0.5 m / 3.1 m）。 */
export const metres = (units: number) =>
  `${(Math.round((Number(units) || 0) / UNITS_PER_METRE * 10) / 10).toFixed(1)} m`;

/**
 * 穿墙提醒（只提示、不阻断）。
 *
 * 多数项目没有墙体几何（空间＝名称＋灯具编号，没有边界），所以这里用「探测范围够到的、
 * 属于别的空间的灯具/设备」当代理指标：够到隔壁空间的设备，就说明这个范围很可能穿墙了。
 * 跨空间联动是允许的（工作台里就有「走廊传感器也点楼梯间灯」这种故意设计），所以只提醒。
 */
export function sensorCoverageIssues(
  sensor: Obj,
  fixtures: Obj[],
  devices: Obj[],
  floorOf: (o: Obj) => number,
  spaceOf: (o: Obj) => string,
) {
  const floor = floorOf(sensor);
  const own = spaceOf(sensor) || "";
  const hits = new Map<string, number>();
  const scan = (o: Obj) => {
    if (!o || o.id === sensor.id) return;
    if (o.type === "窗帘") return;
    if (floorOf(o) !== floor) return;
    const name = spaceOf(o);
    if (!name || name === own || name === "未分配空间") return;
    const x = Number(o.x);
    const y = Number(o.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (!sensorCovers(sensor, x, y)) return;
    const d = Math.hypot(x - (Number(sensor.x) || 0), y - (Number(sensor.y) || 0));
    const cur = hits.get(name);
    if (cur == null || d < cur) hits.set(name, d);
  };
  (fixtures || []).forEach(scan);
  (devices || []).forEach(scan);
  const spaces = Array.from(hits, ([name, distance]) => ({ name, distance })).sort(
    (a, b) => a.distance - b.distance,
  );
  const nearest = spaces.length ? spaces[0].distance : Infinity;
  // 一键收窄：留 2 单位余量，最小 20 单位（约 0.8 m）——别把范围缩到不可用。
  const suggestRange = Number.isFinite(nearest) ? Math.max(20, Math.round(nearest - 2)) : 80;
  return { spaces, nearest, suggestRange };
}

/* ── ②③ 按「空间边界 + 墙体」裁剪探测范围 ────────────────────────────────
 *
 * 几何现实（先查过全库）：25 个项目 design.walls 全是 0 面墙，别墅那套 51 个空间
 * 还是无边界空间（都挂在 400,320）。所以这里做成「有几何才裁剪、没有就退回整圆/扇形」：
 *   · 空间边界：传感器所属空间有真实轮廓（points 多边形，或 width/height>1 的矩形）时，
 *     探测范围不越出本空间 —— 隔壁房间的走动天然被排除（②）；
 *   · 墙体：本层墙体线段当遮挡，射线求交裁掉墙后区域（③，导入 CAD 或手绘墙即生效）。
 * 判定与绘制共用同一套「最近障碍距离」，所以画面上看到的范围和实际触发范围一致。
 */

export type Point = { x: number; y: number };
export type Seg = { x1: number; y1: number; x2: number; y2: number };
export type CoverageOpts = { roomPolygon?: Point[] | null; walls?: Obj[] | null };

const EPS = 0.001;

/** 空间轮廓：优先 points 多边形；其次矩形四角；无边界空间（宽高 ≤1）返回 null。 */
export function roomPolygon(room?: Obj | null): Point[] | null {
  if (!room) return null;
  const raw = Array.isArray(room.points) ? room.points : [];
  const pts = raw
    .map((p: any) => ({ x: Number(p?.x), y: Number(p?.y) }))
    .filter((p: Point) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (pts.length >= 3) return pts;
  const x = Number(room.x);
  const y = Number(room.y);
  const w = Number(room.width);
  const h = Number(room.height);
  if (!(w > 1 && h > 1) || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
}

function polygonSegs(poly: Point[]): Seg[] {
  const out: Seg[] = [];
  for (let i = 0; i < poly.length; i += 1) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    out.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
  }
  return out;
}

function pointInPolygon(poly: Point[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 射线 (ox,oy) + t·(dx,dy) 与所有线段的最近交点距离；没有交点返回 max。 */
function rayHit(
  ox: number,
  oy: number,
  dx: number,
  dy: number,
  segs: Seg[],
  max: number,
): number {
  let best = max;
  for (const s of segs) {
    const sx = s.x2 - s.x1;
    const sy = s.y2 - s.y1;
    const den = dx * sy - dy * sx;
    if (Math.abs(den) < 1e-9) continue; // 平行
    const ax = s.x1 - ox;
    const ay = s.y1 - oy;
    const t = (ax * sy - ay * sx) / den;
    const u = (ax * dy - ay * dx) / den;
    if (t > EPS && t < best && u >= -EPS && u <= 1 + EPS) best = t;
  }
  return best;
}

/** 有效的遮挡线段：传感器在空间内时才用该空间边界；墙体按楼层过滤（老数据无楼层则全用）。 */
export function obstacleSegs(sensor: Obj, opts?: CoverageOpts): Seg[] {
  const segs: Seg[] = [];
  const poly = opts?.roomPolygon;
  if (poly && poly.length >= 3) {
    const ox = Number(sensor?.x) || 0;
    const oy = Number(sensor?.y) || 0;
    // 传感器不在这个空间里（或放在边界上）就别拿它当遮挡，否则范围会被整片吃掉
    if (pointInPolygon(poly, ox, oy)) segs.push(...polygonSegs(poly));
  }
  for (const w of opts?.walls || []) {
    const x1 = Number(w?.x);
    const y1 = Number(w?.y);
    const x2 = Number(w?.x2);
    const y2 = Number(w?.y2);
    if (![x1, y1, x2, y2].every((v) => Number.isFinite(v))) continue;
    if (Math.hypot(x2 - x1, y2 - y1) < 0.5) continue; // 忽略退化的短线
    segs.push({ x1, y1, x2, y2 });
  }
  return segs;
}

/** 从项目数据里取这个传感器的裁剪几何（Plan、漫游、导出共用）。 */
export function obstaclesFor(
  sensor: Obj,
  ctx: { rooms?: Obj[]; walls?: Obj[]; floorOf?: (o: Obj) => number },
): CoverageOpts {
  const floor = ctx.floorOf ? ctx.floorOf(sensor) : 1;
  // 先认 roomId；roomId 过期（传感器被拖到别的空间、或空间重画过）时按位置找包住它的空间，
  // 否则边界裁剪整个丢掉，范围就从门口漏出去了。
  const sx = Number(sensor?.x), sy = Number(sensor?.y);
  const holds = (r: Obj) => { const poly = roomPolygon(r); return !!poly && pointInPolygon(poly, sx, sy); };
  const own = (ctx.rooms || []).find((r) => r?.id === sensor?.roomId) || null;
  const room = own && holds(own) ? own
    : (ctx.rooms || []).find((r) => (r?.floor == null || Number(r.floor) === floor) && holds(r)) || own;
  const walls = (ctx.walls || []).filter(
    (w) => w?.floor == null || Number(w.floor) === floor,
  );
  return { roomPolygon: roomPolygon(room), walls };
}

function normalizeInto(value: number, start: number, span: number): number | null {
  const v = (((value - start) % 360) + 360) % 360;
  if (span >= 359.9) return v;
  return v <= span ? v : null;
}

/** 裁剪后的探测范围多边形（以传感器为原点的相对坐标）；没有几何可裁时返回 null
 *  —— 调用方继续画整圆/扇形，行为与改造前一致。 */
export function coveragePolygon(s: Obj, opts?: CoverageOpts): Point[] | null {
  const segs = obstacleSegs(s, opts);
  if (!segs.length) return null;
  const { range, fov, heading, sector } = sensorShape(s);
  if (!(range > 0)) return null;
  const ox = Number(s?.x) || 0;
  const oy = Number(s?.y) || 0;
  const span = sector ? fov : 360;
  const a0 = sector ? heading - fov / 2 : heading;

  // 均匀采样 + 障碍端点方向补采样（墙角不被圆角化）
  const steps = Math.min(180, Math.max(16, Math.round(span / 3)));
  const offs: number[] = [];
  for (let i = 0; i <= steps; i += 1) offs.push((span * i) / steps);
  for (const seg of segs) {
    for (const p of [
      { x: seg.x1, y: seg.y1 },
      { x: seg.x2, y: seg.y2 },
    ]) {
      const d = Math.hypot(p.x - ox, p.y - oy);
      if (d > range || d < 0.5) continue;
      const ang = (Math.atan2(p.y - oy, p.x - ox) * 180) / Math.PI;
      const off = normalizeInto(ang, a0, span);
      if (off == null) continue;
      offs.push(Math.max(0, off - 0.08), Math.min(span, off + 0.08));
    }
  }
  offs.sort((a, b) => a - b);

  const pts: Point[] = [{ x: 0, y: 0 }];
  let last = Number.NaN;
  for (const off of offs) {
    if (Number.isFinite(last) && off - last < 0.01) continue;
    last = off;
    const rad = ((a0 + off) * Math.PI) / 180;
    const dx = Math.cos(rad);
    const dy = Math.sin(rad);
    const r = Math.min(range, rayHit(ox, oy, dx, dy, segs, range));
    pts.push({ x: dx * r, y: dy * r });
  }
  return pts.length >= 4 ? pts : null;
}

/** 裁剪后的范围路径（相对坐标，放进已 translate 到传感器位置的 <g> 里用）。 */
export function coveragePath(s: Obj, opts?: CoverageOpts): string | null {
  const manual = manualCoveragePath(s);
  if (manual) return manual;
  const poly = coveragePolygon(s, opts);
  if (!poly) return null;
  return (
    "M " + poly.map((p) => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" L ") + " Z"
  );
}

/** 有没有几何可用（空间边界或墙体），用于给设计师一句说明。 */
export function coverageGeometry(sensor: Obj, opts?: CoverageOpts): string {
  if (hasManualCoverage(sensor)) return "手动调整的范围";
  const hasRoom = !!(opts?.roomPolygon && opts.roomPolygon.length >= 3);
  const walls = (opts?.walls || []).length;
  if (hasRoom && walls) return `空间边界 + ${walls} 面墙`;
  if (hasRoom) return "本空间边界";
  if (walls) return `${walls} 面墙`;
  return "";
}

/** 判定：在半径 + 视场角内，且中间没有空间边界/墙体挡着（所以不会隔墙触发）。 */
export function sensorCoversWithGeometry(
  s: Obj,
  x: number,
  y: number,
  opts?: CoverageOpts,
): boolean {
  const ox = Number(s?.x) || 0;
  const oy = Number(s?.y) || 0;
  const dx = Number(x) - ox;
  const dy = Number(y) - oy;
  const d = Math.hypot(dx, dy);
  const segs = obstacleSegs(s, opts);
  if (segs.length && d > 0.5) {
    const hit = rayHit(ox, oy, dx / d, dy / d, segs, sensorShape(s).range);
    if (hit < d - 0.5) return false; // 视线被墙/边界挡住
  }
  return true;
}

/* ── 手动调整探测范围（优先级最高）────────────────────────────────────────
 *
 * 图纸几何常常不全（库里 25 个项目 0 面墙、别墅空间还没边界），所以「视场角 + 朝向」
 * 只能粗调；真正贴合现场的是在图上**手动拖顶点**把范围改成实际形状。
 * 一旦 `sensor.coveragePoints` 有 ≥3 个点，就以它为准：画布、漫游判定、业主页都用它，
 * 半径/视场角不再参与（点「恢复按视场角」清空即可回到参数化）。坐标是相对传感器的，
 * 所以移动传感器时范围跟着走。
 */

/** 手动范围（相对传感器的多边形）；不足 3 个点视为没调过。 */
export function manualCoverage(s: Obj): Point[] | null {
  const raw = Array.isArray(s?.coveragePoints) ? s.coveragePoints : [];
  const pts = raw
    .map((p: any) => ({ x: Number(p?.x), y: Number(p?.y) }))
    .filter((p: Point) => Number.isFinite(p.x) && Number.isFinite(p.y));
  return pts.length >= 3 ? pts : null;
}

export const hasManualCoverage = (s: Obj) => !!manualCoverage(s);

/** 手动范围路径（相对坐标，放进已 translate 到传感器的 <g>）。 */
export function manualCoveragePath(s: Obj): string | null {
  const pts = manualCoverage(s);
  if (!pts) return null;
  return "M " + pts.map((p) => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" L ") + " Z";
}

/** 把当前参数化范围（整圆/扇形/几何裁剪）固化成一组可拖顶点：
 *  「先按视场角生成，再拖顶点微调」是最顺手的路径。 */
export function coverageSeed(s: Obj, opts?: CoverageOpts): Point[] {
  const poly = coveragePolygon(s, opts);
  if (poly) return poly.slice(1).map((p) => ({ x: +p.x.toFixed(1), y: +p.y.toFixed(1) }));
  const { range, fov, heading, sector } = sensorShape(s);
  const span = sector ? fov : 360;
  const a0 = sector ? heading - fov / 2 : heading;
  const steps = Math.min(48, Math.max(12, Math.round(span / 10)));
  const out: Point[] = [];
  for (let i = 0; i < steps; i += 1) {
    const rad = ((a0 + (span * i) / steps) * Math.PI) / 180;
    out.push({
      x: +((Math.cos(rad) * range).toFixed(1)),
      y: +((Math.sin(rad) * range).toFixed(1)),
    });
  }
  return out;
}

/** 在最长的边上插一个中点（加点不会让形状突然变形）。 */
export function insertCoveragePoint(pts: Point[]): Point[] {
  if (!pts.length) return pts;
  let best = 0;
  let bestLen = -1;
  for (let i = 0; i < pts.length; i += 1) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len > bestLen) {
      bestLen = len;
      best = i;
    }
  }
  const a = pts[best];
  const b = pts[(best + 1) % pts.length];
  const mid = { x: +((a.x + b.x) / 2).toFixed(1), y: +((a.y + b.y) / 2).toFixed(1) };
  return [...pts.slice(0, best + 1), mid, ...pts.slice(best + 1)];
}

/** 判定是否落在手动范围内（相对坐标 + 点在多边形内）。 */
export function manualCovers(s: Obj, x: number, y: number): boolean {
  const pts = manualCoverage(s);
  if (!pts) return false;
  return pointInPolygon(pts, Number(x) - (Number(s?.x) || 0), Number(y) - (Number(s?.y) || 0));
}

/** 探测范围（绝对设计坐标多边形）：手动范围 > 按空间边界 / 墙裁剪 > 整圆 / 扇形，
 *  与 sensorCovers 判定同一套几何——三维漫游把它铺在地面上（2026-10-17）。 */
export function coverageAbsolute(s: Obj, design: { rooms?: Obj[]; walls?: Obj[] }): Point[] | null {
  const ox = Number(s?.x) || 0, oy = Number(s?.y) || 0;
  const floor = Number.isFinite(+s?.floor) && s?.floor != null ? +s.floor
    : +((design.rooms || []).find((r) => r?.id === s?.roomId)?.floor ?? 1);
  const opts = obstaclesFor(s, { rooms: design.rooms, walls: design.walls, floorOf: () => floor });
  const rel = manualCoverage(s) || coveragePolygon(s, opts)?.slice(1) || coverageSeed(s, opts);
  return rel && rel.length >= 3 ? rel.map((p) => ({ x: p.x + ox, y: p.y + oy })) : null;
}
