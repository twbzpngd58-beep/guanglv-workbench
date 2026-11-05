/**
 * 图片底图描图辅助：墙带引导线 → 吸附点、正交锁、实时长度读数。
 *
 * 为什么要有这一层：图片底图没有矢量墙线，鼠标全凭手稳，描出来的边界是抖的；
 * 后端其实已经算出了墙带候选（recognition.wall_evidence），只是画布一直没用它。
 * 这里把那批折线变成「点上去就落在墙上」的吸附索引，纯几何、**不 import 任何东西**
 * （和 ./deviceMount、./furniturePolygon 一样，node 直接可测）。
 *
 * 三条要记住的口径：
 *  ① 引导线是**几何候选**不是真相：贴墙柜体、双线家具也可能被算成墙带。所以吸附只在
 *     有线的地方生效，界面上必须能一键关掉、关掉后回到自由描图。
 *  ② 斜墙不逼成正交：正交锁只把「差一点就横平竖直」的点扶正（位移 > 容差就放弃扶正，
 *     保住墙上那个真实点）。
 *  ③ 长度按 26 设计单位＝1 米（后端 DESIGN_UNITS_PER_M）换算。图片没标定过，
 *     这个读数就是证据本身：门量出 723 而实长 900 → 说明该做尺度标定了。
 */

/** 设计单位/米（与后端 DESIGN_UNITS_PER_M、deviceMount.UNITS_PER_M 同口径）。 */
export const UNITS_PER_M = 26;

type Obj = Record<string, any>;

export type TracePoint = { x: number; y: number };

/** 吸附到的是什么：顶点（墙角）／墙带边（垂足）／扶正后的点／没吸附。 */
export type SnapKind = "vertex" | "edge" | "ortho" | "none";

export type SnapResult = {
  x: number;
  y: number;
  kind: SnapKind;
  /** 吸附前鼠标在哪：给界面画一条「你点的 → 落到的」短线，让人知道点被改了。 */
  from: TracePoint;
  /** 位移了多少设计单位（kind=none 时为 0）。 */
  moved: number;
  /** 命中的墙带边角度（度，0–180），只有 kind=edge 有。 */
  edgeAngle?: number;
};

export type TraceIndex = {
  /** 顶点：已有空间的角 + 墙带折线的角 + 墙角（两带正交相交处）。描到同一个角上应该重合，不该差半堵墙。 */
  vertices: TracePoint[];
  /** 墙带边：无限延一点点（0.15 段长），好让边界超出图像墨线时还能贴住那条线。 */
  edges: { x1: number; y1: number; x2: number; y2: number; angle: number; len: number; ring: number }[];
  /** 参与计算的墙带条数：给界面说「引导线 N 条」。 */
  lines: number;
};

const num = (v: unknown, d = 0) => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : d;
};

/** 0–180 度（直线没有方向）：正交判断与「这条墙是不是基本横/竖」都按它算。 */
export function lineAngleDeg(x1: number, y1: number, x2: number, y2: number): number {
  const a = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
  const b = ((a % 180) + 180) % 180;
  return Math.round(b * 100) / 100;
}

/** 与最近 axis（0 或 90）的夹角，0–45：>阈值就算斜墙。 */
export function axisDeviation(angleDeg: number): number {
  const a = ((angleDeg % 180) + 180) % 180;
  return Math.min(Math.abs(a), Math.abs(a - 90), Math.abs(a - 180));
}

/**
 * 把后端墙带折线 + 现有空间角点摊成一张吸附索引。
 * guides 用 wall_guide 的 contours（[[{x,y},…],…]），空数组就是「没引导线」＝不吸附。
 */
export function buildTraceIndex(
  guides: { x: number; y: number }[][] | undefined | null,
  rooms: Obj[] = [],
  floor?: number,
): TraceIndex {
  const vertices: TracePoint[] = [];
  const edges: TraceIndex["edges"] = [];
  const seen = new Set<string>();
  const pushVertex = (x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const k = `${Math.round(x * 100)}:${Math.round(y * 100)}`;
    if (seen.has(k)) return;
    seen.add(k);
    vertices.push({ x, y });
  };
  const pushEdge = (x1: number, y1: number, x2: number, y2: number, ring: number) => {
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (!(len > 1e-6)) return;
    edges.push({ x1, y1, x2, y2, len, ring, angle: lineAngleDeg(x1, y1, x2, y2) });
  };

  (guides || []).forEach((line, ring) => {
    const pts = Array.isArray(line) ? line : [];
    if (pts.length < 2) return;
    for (let i = 0; i < pts.length; i += 1) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      if (!p || !q) continue;
      pushVertex(num(p.x), num(p.y));
      pushEdge(num(p.x), num(p.y), num(q.x), num(q.y), ring);
    }
  });
  // 已有空间的角：改一个角、隔壁共用这条墙的房间也吸到同一个点上。
  for (const room of rooms || []) {
    const pts = Array.isArray(room?.points) ? room.points : null;
    if (floor != null && num(room?.floor || 1) !== floor) continue;
    if (pts && pts.length >= 3) pts.forEach((p: TracePoint) => pushVertex(num(p.x), num(p.y)));
    else if (room?.x != null) {
      const x = num(room.x), y = num(room.y), w = num(room.width), h = num(room.height);
      if (w > 1 && h > 1) [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].forEach(([a, b]) => pushVertex(a, b));
    }
  }
  // 墙角：墙带只画到「这堵墙自己的尽头」，两堵墙相交的那个角不在任何一条边上——
  // 只吸边的话拐角会顺着墙面滑开半堵墙（DXF 实测差 ~100 mm）。把不同墙带的近正交边
  // 求交点补成顶点，拐点才真落在角上。
  const CROSS_MIN_LEN = 20;     // 设计单位（≈0.8 米）：洞口封边那种短边不当墙角候选
  const CROSS_LIMIT = 240;      // 只拿最长的几百条边求交：全量两两求交在大图纸上是几百万对
  const long = edges.filter((e) => e.len >= CROSS_MIN_LEN).sort((a, b) => b.len - a.len).slice(0, CROSS_LIMIT);
  for (let i = 0; i < long.length; i += 1) {
    for (let j = i + 1; j < long.length; j += 1) {
      const a = long[i], b = long[j];
      if (a.ring === b.ring) continue;
      const da = Math.abs(a.angle - b.angle);
      const perp = Math.min(da, 180 - da);
      if (perp < 60 || perp > 120) continue;
      const hit = lineCross(a, b);
      if (hit) pushVertex(hit.x, hit.y);
    }
  }
  return { vertices, edges, lines: (guides || []).length };
}

/** 两条线的交点；只在「各自外延 15% 以内」才算数（与 footOnSegment 同一口径），不然会把远处的平行墙当角。 */
function lineCross(a: TraceIndex["edges"][number], b: TraceIndex["edges"][number]): TracePoint | null {
  const dx = a.x2 - a.x1, dy = a.y2 - a.y1;
  const ex = b.x2 - b.x1, ey = b.y2 - b.y1;
  const den = dx * ey - dy * ex;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((b.x1 - a.x1) * ey - (b.y1 - a.y1) * ex) / den;
  const s = ((b.x1 - a.x1) * dy - (b.y1 - a.y1) * dx) / den;
  if (t < -0.15 || t > 1.15 || s < -0.15 || s > 1.15) return null;
  return { x: a.x1 + dx * t, y: a.y1 + dy * t };
}

type Closest = { at: TracePoint; d: number; angle?: number };

function nearestVertex(index: TraceIndex, p: TracePoint, tol: number): Closest | null {
  let best: Closest | null = null;
  for (const v of index.vertices) {
    const d = Math.hypot(v.x - p.x, v.y - p.y);
    if (d <= tol && (!best || d < best.d)) best = { at: v, d };
  }
  return best;
}

/** 点到这条墙带所在直线的垂足（允许超出端点 15%：墨线短一截也要贴得住）。 */
export function footOnSegment(p: TracePoint, e: TraceIndex["edges"][number]): { at: TracePoint; d: number; t: number } {
  const dx = e.x2 - e.x1, dy = e.y2 - e.y1;
  const l2 = dx * dx + dy * dy;
  const tRaw = l2 > 0 ? ((p.x - e.x1) * dx + (p.y - e.y1) * dy) / l2 : 0;
  const t = Math.max(-0.15, Math.min(1.15, tRaw));
  const at = { x: e.x1 + dx * t, y: e.y1 + dy * t };
  return { at, d: Math.hypot(p.x - at.x, p.y - at.y), t };
}

function nearestEdge(index: TraceIndex, p: TracePoint, tol: number): Closest | null {
  let best: Closest | null = null;
  for (const e of index.edges) {
    const hit = footOnSegment(p, e);
    // 垂足落在端点外太多＝其实该吸的是那个端点，别把斜线上的投影当垂足。
    if (hit.t < 0 || hit.t > 1) continue;
    if (hit.d <= tol && (!best || hit.d < best.d)) best = { at: hit.at, d: hit.d, angle: e.angle };
  }
  return best;
}

/**
 * 正交锁：把「差一点就横平竖直」的点扶正。
 * 位移超过 tol 就扶不动（斜墙保住墙上的真点），与吸附结果同理——先贴墙，再谈正交。
 */
export function squareUp(prev: TracePoint, p: TracePoint, tol: number): { at: TracePoint; axis: "h" | "v" } | null {
  const dx = p.x - prev.x, dy = p.y - prev.y;
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return null;
  // 走得更远的那个方向为主轴：把另一个分量收回到上一点的坐标上。
  if (Math.abs(dx) >= Math.abs(dy)) {
    const shift = Math.abs(dy);
    if (shift > tol) return null;
    return { at: { x: p.x, y: prev.y }, axis: "h" };
  }
  const shift = Math.abs(dx);
  if (shift > tol) return null;
  return { at: { x: prev.x, y: p.y }, axis: "v" };
}

/**
 * 一个绘制点该落在哪：顶点 > 墙带垂足 > 正交扶正 > 原样。
 * prev 给正交锁用（多边形的上一点）；alt 为 true 时这一笔不吸附（临时自由描）。
 */
export function snapTracePoint(
  index: TraceIndex,
  p: TracePoint,
  opts: { tol: number; prev?: TracePoint | null; ortho?: boolean; alt?: boolean; onVertices?: boolean },
): SnapResult {
  const tol = Math.max(0, num(opts.tol));
  const out = (at: TracePoint, kind: SnapKind, angle?: number): SnapResult => ({
    x: at.x, y: at.y, kind, from: p, moved: Math.hypot(at.x - p.x, at.y - p.y), edgeAngle: angle,
  });
  if (opts.alt || tol <= 0) {
    if (!opts.alt && opts.ortho && opts.prev) {
      const sq = squareUp(opts.prev, p, tol);
      if (sq) return out(sq.at, "ortho");
    }
    return out(p, "none");
  }
  const vertex = opts.onVertices === false ? null : nearestVertex(index, p, tol);
  if (vertex) return out(vertex.at, "vertex");
  const edge = nearestEdge(index, p, tol);
  if (edge) {
    // 贴住墙之后还能扶正：这条墙本来就基本横平竖直时，把垂足压回正交线上。
    if (opts.ortho && opts.prev && axisDeviation(edge.angle ?? 0) <= 6) {
      const sq = squareUp(opts.prev, edge.at, tol);
      if (sq) return out(sq.at, "ortho");
    }
    return out(edge.at, "edge", edge.angle);
  }
  if (opts.ortho && opts.prev) {
    const sq = squareUp(opts.prev, p, tol);
    if (sq) return out(sq.at, "ortho");
  }
  return out(p, "none");
}

/** 两点间画布距离（尺度标定要把它交给后端换算系数）。 */
export function canvasDistance(a: TracePoint, b: TracePoint): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** 折线长（画布单位）：灯带、标定第二点用同一种量法。 */
export function polylineUnits(points: TracePoint[]): number {
  let len = 0;
  for (let i = 1; i < (points || []).length; i += 1) {
    len += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return len;
}

/**
 * 画布单位 → 人话长度。26 单位＝1 米，所以没标定的图片量出来的数会「不像话」，
 * 这正是要给人看见的证据；界面把它和实长一起摆出来，差太多就提示去标定。
 */
export function formatTraceLength(units: number, unitsPerM: number = UNITS_PER_M): string {
  const per = num(unitsPerM, UNITS_PER_M) || UNITS_PER_M;
  const mm = (num(units) / per) * 1000;
  if (!Number.isFinite(mm) || mm <= 0) return "0 mm";
  if (mm < 1000) return `${Math.round(mm)} mm`;
  return `${Math.round(mm / 100) / 10} m`;
}

/** 多边形面积（㎡，按 26 单位/米）：标定预览里「每个空间多大」就地给。 */
export function polygonAreaM2(points: TracePoint[], unitsPerM: number = UNITS_PER_M): number {
  const pts = (points || []).filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
  if (pts.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < pts.length; i += 1) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    sum += a.x * b.y - b.x * a.y;
  }
  const per = num(unitsPerM, UNITS_PER_M) || UNITS_PER_M;
  return Math.abs(sum) / 2 / (per * per);
}

/**
 * 引导线该不该被当成「这张图还没标定」的信号：
 * 描一条门洞/墙，量到的实长与常识值差太远，就该先标定。纯提示，不拦人。
 */
export function calibrationHint(measuredMm: number, expectedMm: number): string {
  if (!(measuredMm > 0) || !(expectedMm > 0)) return "";
  const ratio = measuredMm / expectedMm;
  if (ratio > 0.94 && ratio < 1.06) return "";
  return `量到 ${Math.round(measuredMm)} mm，实长 ${Math.round(expectedMm)} mm（差 ${Math.round((ratio - 1) * 100)}%）——先做尺度标定，边界与门窗才对得上米`;
}
