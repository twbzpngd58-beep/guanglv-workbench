/**
 * 家具固定样式的唯一真源（33 类）。
 *
 * 为什么要有这个文件：家具在**两处**渲染——主画布的「3D 模型」（SceneModel3D.tsx）和
 * 三维页引擎（lighting3d_page/lighting3d.js）。以前一边是一个纯方盒、另一边才有形状，
 * 于是「改了引擎，主画布还是矩形框」。现在两处都调这里，改一次两边同时生效。
 *
 * 约定：
 *   · 单位米；构件坐标＝**家具局部坐标**（原点在占地中心，y 从地面起算，y 给的是构件中心高）；
 *   · 家具的「背面」统一朝 -Z（靠背／床头／柜门另一侧），再由 furnitureYaw 贴着最近的墙转正；
 *   · 材质档 m：1 木 / 2 布 / 3 白 / 4 金属。
 *   · w×d 是图纸量出来的占地（米），渲染时只用它缩放，不改朝向以外的比例。
 */
export type FurnPart = {
  k: "box" | "cyl";
  m: number;
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  r: number;
};

const B = (m: number, x: number, y: number, z: number, w: number, h: number, d: number): FurnPart =>
  ({ k: "box", m, x, y, z, w, h, d, r: 0 });
const C = (m: number, x: number, y: number, z: number, r: number, h: number): FurnPart =>
  ({ k: "cyl", m, x, y, z, w: 0, h, d: 0, r });
/** 四条腿（自动内缩，桌/椅/柜脚） */
function LEGS(m: number, w: number, d: number, h: number, inset = 0.06): FurnPart[] {
  const t = Math.min(0.06, Math.min(w, d) * 0.12);
  const ix = Math.max(0, w / 2 - inset - t / 2), iz = Math.max(0, d / 2 - inset - t / 2);
  return [[-ix, -iz], [ix, -iz], [-ix, iz], [ix, iz]].map(([x, z]) => B(m, x, h / 2, z, t, h, t));
}
/** 门缝（每 0.6m 一扇）：在 -Z 正面拉几条细竖线 */
function DOORS(m: number, w: number, h: number, z: number, top = 0.08): FurnPart[] {
  const n = Math.max(1, Math.round(w / 0.6)), out: FurnPart[] = [];
  for (let i = 1; i < n; i += 1) {
    out.push(B(m, -w / 2 + (w * i) / n, top + (h - top) / 2, z, 0.012, h - top, 0.012));
  }
  return out;
}

/** 图纸里的旧类型名 → 新类型（老项目 store 里还留着旧名字） */
const ALIAS: Record<string, string> = {
  "柜": "矮柜", "衣柜": "到顶柜", "电视": "电视柜", "桌": "餐桌", "毯": "地毯",
  "架": "书架", "斗柜": "矮柜", "边柜": "矮柜", "餐边高柜": "餐边柜",
};

/** 每类的固定高度（米）。到顶柜不用这个值：高度＝项目「吊顶后层高 − 0.05」，由后端算好传进来。 */
export const FURN_HEIGHT: Record<string, number> = {
  "沙发": 0.85, "贵妃沙发": 0.85, "单人沙发": 0.80, "茶几": 0.45, "边几": 0.55, "电视柜": 0.45,
  "餐桌": 0.76, "圆餐桌": 0.76, "餐椅": 0.88, "凳": 0.45, "岛台": 0.90, "吧台": 1.05,
  "吊柜": 0.80, "餐边柜": 0.90, "冰箱": 1.80, "灶台": 0.89, "水槽": 0.89,
  "床": 0.50, "婴儿床": 0.92, "床头柜": 0.55, "梳妆台": 0.75,
  "矮柜": 0.88, "到顶柜": 2.40, "鞋柜": 1.10, "书架": 1.90,
  "洗衣机": 0.90, "马桶": 0.78, "浴缸": 0.58, "台盆": 0.85,
  "植物": 0.95, "地毯": 0.03, "钢琴": 1.05, "通用": 0.50,
};

/** 背面该贴墙的类型（靠背／床头／柜门另一侧）。其余（茶几/餐桌/岛台/地毯…）不转向。 */
export const FURN_BACK_KINDS = new Set([
  "沙发", "贵妃沙发", "单人沙发", "床", "婴儿床", "床头柜", "梳妆台", "电视柜", "餐边柜",
  "矮柜", "到顶柜", "鞋柜", "书架", "吊柜", "冰箱", "马桶", "台盆", "钢琴", "洗衣机", "通用",
]);

export function furnKind(kind?: string): string {
  const k = String(kind || "").trim();
  if (FURN_HEIGHT[k] !== undefined) return k;
  return ALIAS[k] || "通用";
}

/** 家具构件表：kind + 占地 w×d + 高度 h → 构件清单（两处渲染器都吃这个）。 */
export function furnitureParts(kind?: string, w = 0.6, d = 0.6, h = 0.5): FurnPart[] {
  const k = furnKind(kind);
  const W = Math.max(0.2, +w || 0.6), D = Math.max(0.2, +d || 0.6), H = Math.max(0.04, +h || 0.5);
  const min = Math.min(W, D), max = Math.max(W, D);
  switch (k) {
    case "沙发":
    case "单人沙发":
    case "贵妃沙发": {
      const seat = k === "单人沙发" ? 0.34 : 0.32;
      const out: FurnPart[] = [
        B(2, 0, seat / 2, 0, W, seat, D),                                       // 座箱
        B(2, 0, seat + 0.09, 0.02, Math.max(0.2, W - 0.16), 0.14, Math.max(0.2, D - 0.14)), // 坐垫
        B(2, 0, 0.45, -D / 2 + 0.08, W, 0.55, 0.16),                            // 靠背
        B(2, -W / 2 + 0.08, 0.24, 0, 0.16, 0.48, D),                            // 左扶手
        B(2, W / 2 - 0.08, 0.24, 0, 0.16, 0.48, D),                             // 右扶手
      ];
      if (k === "贵妃沙发") {                                                   // 末端躺位（L 型）
        const cw = Math.max(0.5, Math.min(0.95, W * 0.36)), cd = Math.max(0.4, D * 0.55);
        out.push(B(2, W / 2 - cw / 2, seat / 2, D / 2 - cd / 2, cw, seat, cd));
        out.push(B(2, W / 2 - cw / 2, seat + 0.09, D / 2 - cd / 2, cw - 0.1, 0.14, cd - 0.1));
      }
      return out;
    }
    case "床":
      return [
        B(1, 0, 0.15, 0, W, 0.30, D),                                           // 床体
        B(2, 0, 0.38, D * 0.04, W * 0.94, 0.16, D * 0.86),                      // 床垫
        B(1, 0, 0.45, -D / 2 + 0.05, W, 0.60, 0.10),                            // 床头板
        ...(W > 1.2 ? [                                                        // 两只枕头
          B(3, -W * 0.21, 0.51, -D * 0.26, W * 0.3, 0.10, D * 0.16),
          B(3, W * 0.21, 0.51, -D * 0.26, W * 0.3, 0.10, D * 0.16),
        ] : []),
      ];
    case "婴儿床":
      return [
        B(3, 0, 0.30, 0, W, 0.12, D),
        B(1, 0, 0.28, -D / 2, W, 0.55, 0.06), B(1, 0, 0.28, D / 2, W, 0.55, 0.06),
        B(1, -W / 2, 0.28, 0, 0.06, 0.55, D), B(1, W / 2, 0.28, 0, 0.06, 0.55, D),
      ];
    case "茶几":
      return [B(1, 0, 0.40, 0, W, 0.05, D), ...LEGS(1, W, D, 0.38, 0.08)];
    case "边几":
      return [B(1, 0, 0.52, 0, W, 0.04, D), C(3, 0, 0.25, 0, Math.min(0.05, min * 0.1), 0.5), C(3, 0, 0.02, 0, min * 0.35, 0.04)];
    case "餐桌":
    case "桌": {
      const out = [B(1, 0, 0.735, 0, W, 0.05, D), ...LEGS(1, W, D, 0.72, 0.12)];
      if (max > 1.8) {                                                         // 长桌加两条中腿
        const t = Math.min(0.06, min * 0.12);
        [-0.15, 0.15].forEach((f) => out.push(B(1, max === W ? W * f : 0, 0.36, max === W ? 0 : D * f, t, 0.72, t)));
      }
      return out;
    }
    case "圆餐桌":
      return [
        C(1, 0, 0.735, 0, min / 2, 0.05),
        C(1, 0, 0.35, 0, Math.max(0.05, min * 0.06), 0.70),
        C(1, 0, 0.02, 0, min * 0.3, 0.04),
      ];
    case "餐椅":
    case "椅":
      return [
        B(2, 0, 0.44, 0, W * 0.92, 0.06, D * 0.92),
        B(2, 0, 0.66, -D / 2 + 0.04, W * 0.92, 0.46, 0.06),
        ...LEGS(1, W * 0.92, D * 0.92, 0.44, 0.04),
      ];
    case "凳": {
      if (max / min > 2.2) {                                                   // 长条凳
        return [
          B(1, 0, 0.44, 0, W, 0.06, D),
          B(1, -W / 2 + Math.min(0.15, W * 0.1), 0.21, 0, 0.06, 0.42, D * 0.8),
          B(1, W / 2 - Math.min(0.15, W * 0.1), 0.21, 0, 0.06, 0.42, D * 0.8),
        ];
      }
      return [C(2, 0, 0.45, 0, min / 2, 0.06), ...LEGS(1, W, D, 0.42, 0.05)];
    }
    case "岛台":                                                               // 台面外挑 + 柜体内缩 + 踢脚
      return [
        B(3, 0, 0.42, 0, Math.max(0.3, W - 0.12), 0.84, Math.max(0.3, D - 0.12)),
        B(3, 0, 0.875, 0, W, 0.05, D),
        B(4, 0, 0.05, 0, Math.max(0.2, W - 0.24), 0.10, Math.max(0.2, D - 0.24)),
      ];
    case "吧台":
      return [
        B(3, 0, 0.50, 0, Math.max(0.3, W - 0.10), 1.00, Math.max(0.3, D - 0.10)),
        B(3, 0, 1.025, 0, W, 0.05, D),
        B(4, 0, 0.30, -D / 2 + 0.06, Math.max(0.2, W - 0.3), 0.04, 0.04),
      ];
    case "吊柜":
      return [
        B(1, 0, 1.45 + H / 2, 0, W, H, Math.min(D, 0.35)),
        ...DOORS(3, W, H, -Math.min(D, 0.35) / 2 - 0.01, 0.06).map((p) => ({ ...p, y: 1.45 + H / 2 - (H / 2 - p.y) })),
      ];
    case "餐边柜":
      return [
        B(1, 0, 0.44, 0, W, 0.84, D), B(1, 0, 0.86, 0, W, 0.04, D),
        ...DOORS(3, W, 0.84, -D / 2 - 0.008, 0.08),
        B(1, 0, 1.85, 0, W, 0.80, Math.min(D, 0.35)),
      ];
    case "电视柜":
      return [
        B(1, 0, 0.21, 0, W, 0.42, D), B(1, 0, 0.435, 0, W, 0.03, D),
        ...LEGS(3, W, D, 0.06, 0.05),
      ];
    case "冰箱":
      return [
        B(4, 0, H / 2, 0, W, H, D),
        B(3, 0, H / 2, -D / 2 - 0.006, 0.02, H * 0.9, 0.012),
        B(3, W * 0.3, H * 0.62, -D / 2 - 0.02, 0.03, 0.3, 0.03),
      ];
    case "灶台":
      return [
        B(3, 0, 0.43, 0, W, 0.86, D), B(3, 0, 0.885, 0, W, 0.05, D),
        C(4, -W * 0.18, 0.915, 0, Math.max(0.06, min * 0.16), 0.03),
        C(4, W * 0.18, 0.915, 0, Math.max(0.06, min * 0.16), 0.03),
      ];
    case "水槽":
      return [B(3, 0, 0.43, 0, W, 0.86, D), B(3, 0, 0.885, 0, W, 0.05, D), B(4, 0, 0.86, 0, W * 0.6, 0.06, D * 0.6)];
    case "床头柜":
      return [B(1, 0, 0.27, 0, W, 0.54, D), B(1, 0, 0.555, 0, W, 0.03, D), B(3, 0, 0.36, -D / 2 - 0.008, W * 0.8, 0.012, 0.012)];
    case "梳妆台":
      return [
        B(1, 0, 0.735, 0, W, 0.05, D), ...LEGS(1, W, D, 0.71, 0.06),
        B(3, 0, 1.15, -D / 2 + 0.03, Math.min(W * 0.8, 0.9), 0.9, 0.04),
      ];
    case "矮柜":
    case "鞋柜": {
      const base = k === "鞋柜" ? 0.15 : 0.08;                                  // 鞋柜底下留空
      const box = H - base - 0.04;
      const dd = Math.min(D, k === "鞋柜" ? 0.35 : D);
      return [
        B(1, 0, base + box / 2, 0, W, box, dd),
        B(1, 0, base + box + 0.02, 0, W, 0.04, dd + 0.02),
        // 门缝抬高到踢脚之上（鞋柜底下那道空格不能有门缝）
        ...DOORS(3, W, box, -dd / 2 - 0.008, 0.06).map((p) => ({ ...p, y: p.y + base })),
      ];
    }
    case "到顶柜":
      return [
        B(1, 0, 0.10 + (H - 0.10) / 2, 0, W, H - 0.10, D),                      // 柜体（下面留 0.1 踢脚）
        B(1, 0, H - 0.025, 0, W, 0.05, D),                                       // 顶部收口条
        B(3, 0, 0.05, 0, Math.max(0.2, W - 0.16), 0.10, Math.max(0.2, D - 0.10)),
        ...DOORS(3, W, H - 0.10, -D / 2 - 0.008, 0.10),
      ];
    case "书架": {
      const out: FurnPart[] = [
        B(1, 0, H / 2, 0, W, H, D),
        B(1, -W / 2 + 0.01, H / 2, 0, 0.02, H * 0.96, D), B(1, W / 2 - 0.01, H / 2, 0, 0.02, H * 0.96, D),
      ];
      for (let y = 0.35; y < H - 0.1; y += 0.35) out.push(B(3, 0, y, 0, W * 0.94, 0.035, D * 0.92));
      return out;
    }
    case "洗衣机":
      // 门在原版里画在了**顶面**（y=H+0.015），一眼就假——洗衣机门在正面（现场 2026-10-16）。
      return [
        B(4, 0, H / 2, 0, W, H, D),
        B(3, 0, H * 0.46, -D / 2 - 0.02, W * 0.62, H * 0.52, 0.04),        // 正面舱门
        C(3, 0, H / 2, -D / 2 - 0.045, Math.max(0.05, min * 0.22), 0.03),   // 门圈
        B(3, 0, H + 0.01, 0, W * 0.96, 0.03, D * 0.96),                     // 顶盖缝
      ];
    case "马桶":
      // 日常马桶：水箱到 0.78 + 便座 + 便器（现场 2026-10-16「机器画的和日常马桶差异太大」）
      return [
        B(3, 0, 0.39, -D / 2 + 0.10, W * 0.92, 0.78, 0.20),                 // 水箱
        C(3, 0, 0.20, D * 0.06, Math.max(0.14, min * 0.36), 0.40),          // 便器
        C(3, 0, 0.415, D * 0.06, Math.max(0.15, min * 0.38), 0.035),        // 便座
      ];
    case "浴缸":
      return [B(3, 0, H / 2, 0, W, H, D), B(4, 0, H - 0.04, 0, Math.max(0.1, W - 0.16), 0.10, Math.max(0.1, D - 0.16))];
    case "台盆":
      return [
        B(1, 0, 0.36, 0, W, 0.72, D), B(3, 0, 0.745, 0, W * 1.02, 0.05, D * 1.02),
        C(4, 0, 0.83, 0, Math.max(0.12, min * 0.3), 0.12),
      ];
    case "植物":
      return [
        C(1, 0, 0.175, 0, min * 0.3, 0.35),
        C(2, 0, 0.62, 0, min * 0.46, 0.55),
        C(2, 0, 1.0, 0, min * 0.33, 0.35),
      ];
    case "地毯":
      return [B(2, 0, 0.011, 0, W, 0.02, D)];
    case "钢琴":
      return [B(1, 0, H / 2, 0, W, H, D), B(3, 0, H + 0.03, D * 0.24, W * 0.86, 0.05, D * 0.16)];
    default:
      return [B(1, 0, H / 2, 0, W, H, D)];
  }
}

export type WallLike = {
  x0?: number; z0?: number; x1?: number; z1?: number;
  ax?: number; az?: number; bx?: number; bz?: number;
};

type Seg = { x0: number; z0: number; x1: number; z1: number };

const normSeg = (s: WallLike): Seg => ({
  x0: Number(s.x0 ?? s.ax), z0: Number(s.z0 ?? s.az),
  x1: Number(s.x1 ?? s.bx), z1: Number(s.z1 ?? s.bz),
});

function ptSegDist(px: number, pz: number, x0: number, z0: number, x1: number, z1: number): number {
  const dx = x1 - x0, dz = z1 - z0;
  const l2 = dx * dx + dz * dz;
  const t = l2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((px - x0) * dx + (pz - z0) * dz) / l2));
  return Math.hypot(px - (x0 + t * dx), pz - (z0 + t * dz));
}

/** 一条边到最近墙的距离（边上等距取 5 个点，够判「背面朝哪堵墙」） */
function edgeWallDist(ax: number, az: number, bx: number, bz: number, walls: Seg[]): number {
  let best = Infinity;
  for (let i = 0; i <= 4; i += 1) {
    const px = ax + ((bx - ax) * i) / 4, pz = az + ((bz - az) * i) / 4;
    for (const w of walls) {
      const d = ptSegDist(px, pz, w.x0, w.z0, w.x1, w.z1);
      if (d < best) best = d;
    }
  }
  return best;
}

/**
 * 家具朝向：让「背面」贴最近的那堵墙，返回 { yaw, w, d }。
 *
 * 只取 0/90/180/270 四个轴方向；走 90/270 时把 w/d 对调，**占地和图纸完全一致**（不是把家具转出原位）。
 * 背面永远取**长边**（床头顶墙、沙发靠背贴墙、柜子背板贴墙都符合这个常识），所以：
 * 图纸 w 是长边 → 只在「背朝 -z / 背朝 +z」里选；d 是长边 → 只在「背朝 ±x」里选。
 * 最近的墙还超过 maxDist（居中摆放：岛台/餐桌/茶几…）或这类家具没有背面 → 原样不动。
 */
export function furnitureYaw(
  x: number, z: number, w: number, d: number, walls: WallLike[], kind?: string,
  opts: { maxDist?: number } = {},
): { yaw: number; w: number; d: number } {
  const still = { yaw: 0, w, d };
  if (!FURN_BACK_KINDS.has(furnKind(kind))) return still;
  const segs = (walls || []).map(normSeg)
    .filter((s) => [s.x0, s.z0, s.x1, s.z1].every(Number.isFinite));
  if (!segs.length) return still;
  const maxDist = opts.maxDist ?? 1.2;
  const long = Math.max(w, d);
  const along = long === w && w >= d;                    // 背面是沿 x 的那条长边
  const cands = along
    ? [
        { yaw: 0, w, d, ax: x - w / 2, az: z - d / 2, bx: x + w / 2, bz: z - d / 2 },
        { yaw: Math.PI, w, d, ax: x - w / 2, az: z + d / 2, bx: x + w / 2, bz: z + d / 2 },
      ]
    : [
        { yaw: Math.PI / 2, w: d, d: w, ax: x - w / 2, az: z - d / 2, bx: x - w / 2, bz: z + d / 2 },
        { yaw: -Math.PI / 2, w: d, d: w, ax: x + w / 2, az: z - d / 2, bx: x + w / 2, bz: z + d / 2 },
      ];
  let best: { yaw: number; w: number; d: number; dist: number } | null = null;
  for (const c of cands) {
    const dist = edgeWallDist(c.ax, c.az, c.bx, c.bz, segs);
    if (!best || dist < best.dist) best = { yaw: c.yaw, w: c.w, d: c.d, dist };
  }
  if (!best || best.dist > maxDist) return still;
  return { yaw: best.yaw, w: best.w, d: best.d };
}

/** 两处渲染器共用的入口：React 侧直接 import，引擎侧读 window.GUANGLV_FURN（同一个浏览器全局，零副本）。 */
export const FURN_API = {
  heights: FURN_HEIGHT,
  backKinds: Array.from(FURN_BACK_KINDS),
  parts: furnitureParts,
  yaw: furnitureYaw,
};

if (typeof window !== "undefined") {
  (window as unknown as { GUANGLV_FURN?: typeof FURN_API }).GUANGLV_FURN = FURN_API;
}
