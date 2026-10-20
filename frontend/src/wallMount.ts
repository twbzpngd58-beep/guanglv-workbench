/**
 * 墙面安装：把面板这类墙装设备吸附到最近一段墙上。
 *
 * 老板 2026-10-14：面板加进设计后，三维模型里面板悬浮在半空中。面板是装在墙上的，
 * 必须贴着墙面、正面朝室内。这里只做纯几何（不依赖 three.js，方便 node 直接测）：
 * 给定设备的世界坐标与墙段列表，返回吸附后的坐标、安装高度与朝向角。
 */
export type WallSeg = { ax: number; az: number; bx: number; bz: number; t?: number; h?: number };

export type WallMount = {
  /** 吸附点（世界坐标，已按墙厚 + 板厚沿墙面法线推离墙面） */
  x: number; z: number;
  /** 安装高度（板中心） */
  y: number;
  /** three.js 的 rotation.y：让板的正面（局部 +Z）朝室内 */
  rotY: number;
  /** 命中的墙段序号与设备到墙的距离（世界单位），给测试与排查用 */
  index: number; distance: number;
  wallHeight: number; wallThickness: number;
};

/** 统一保留 3 位小数，顺带把 -0 收敛成 0（否则矩阵/断言里会冒出 -0） */
const round3 = (v: number) => {
  const r = Math.round(v * 1000) / 1000;
  return r === 0 ? 0 : r;
};

/** 面板安装高度：墙面中上部；墙被剖切得矮时跟着降，板顶不越出墙面。 */
export function mountHeight(wallHeight: number): number {
  const h = Number.isFinite(wallHeight) && wallHeight > 0 ? wallHeight : 1.5;
  return round3(Math.max(0.85, Math.min(1.35, h * 0.7)));
}

/**
 * 把 (wx, wz) 处的墙装设备吸到最近的墙段上。
 * 返回 null ＝ 没有可用墙面（没有墙段 / 墙段退化成点），调用方保留原位。
 */
export function wallMount(
  wx: number,
  wz: number,
  depth: number,
  walls: WallSeg[] = [],
  opts: { height?: number; gap?: number } = {},
): WallMount | null {
  if (!Number.isFinite(wx) || !Number.isFinite(wz)) return null;
  let best: {
    d: number; px: number; pz: number; dx: number; dz: number;
    len: number; t: number; h: number; i: number;
  } | null = null;

  for (let i = 0; i < walls.length; i += 1) {
    const s = walls[i];
    const ax = +s.ax, az = +s.az, bx = +s.bx, bz = +s.bz;
    if (![ax, az, bx, bz].every(Number.isFinite)) continue;
    const dx = bx - ax, dz = bz - az;
    const len2 = dx * dx + dz * dz;
    if (len2 < 1e-4) continue;
    // 设备点在墙段上的投影（夹在两端点之间：不许投到墙外的延长线上）
    const k = Math.max(0, Math.min(1, ((wx - ax) * dx + (wz - az) * dz) / len2));
    const px = ax + dx * k, pz = az + dz * k;
    const d = Math.hypot(wx - px, wz - pz);
    if (best && d >= best.d) continue;
    best = {
      d, px, pz, dx, dz, len: Math.sqrt(len2),
      t: Number(s.t) || 0.12, h: Number(s.h) || 1.5, i,
    };
  }
  if (!best) return null;

  // 墙面法线（两选一）：取朝向设备原来所在那一侧的那条，面板才贴在设备所在房间里。
  let nx = -best.dz / best.len, nz = best.dx / best.len;
  const toward = (wx - best.px) * nx + (wz - best.pz) * nz;
  // 设备正好压在墙线上时（toward≈0）取朝场心（户型内部）的一侧。
  const side = Math.abs(toward) > 1e-6
    ? (toward > 0 ? 1 : -1)
    : ((-best.px) * nx + (-best.pz) * nz >= 0 ? 1 : -1);
  nx *= side;
  nz *= side;

  const gap = opts.gap ?? 0.006;
  const off = Math.max(0.03, best.t) / 2 + Math.max(0.01, depth) / 2 + gap;
  return {
    x: round3(best.px + nx * off),
    z: round3(best.pz + nz * off),
    y: round3(opts.height ?? mountHeight(best.h)),
    rotY: round3(Math.atan2(nx, nz)),
    index: best.i,
    distance: round3(best.d),
    wallHeight: best.h,
    wallThickness: best.t,
  };
}
