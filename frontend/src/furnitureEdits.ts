/**
 * 语义调整面板的家具编辑逻辑（纯函数，node 可直接跑）。
 *
 * 兼容旧 CAD 家具覆盖表；结构化家具由摘要映射为 extra，后端同步写回 design.furniture。
 *   图纸识别出来的件：kind / rot / 宽深 覆盖 + 删除名单（按序号）
 *   工作台手动加的件：extra 列表（带 id、坐标、宽深、朝向）
 * 后端 furniture_of 把它们与解析结果合并；三维页引擎与主画布都只吃合并后的清单。
 *
 * ⚠️ 这个模块**不 import 别的东西**：node 直接跑 .ts 测的时候，跨文件的**无扩展名** import 解析不了
 * （仓库里 test-room-polygon / test-wall-mount 也是这个约束）。所以旧名字映射在这里另存一份，
 * 由 test-furniture-edits.mjs 与 furnitureModels 的那份逐条比对，防止漂移。
 */

const KIND_ALIAS: Record<string, string> = {
  "柜": "矮柜", "衣柜": "到顶柜", "电视": "电视柜", "桌": "餐桌", "毯": "地毯",
  "架": "书架", "斗柜": "矮柜", "边柜": "矮柜", "餐边高柜": "餐边柜",
};

export const KIND_ALIAS_TABLE: Record<string, string> = { ...KIND_ALIAS };

export type FurnRow = {
  /** 图纸识别件＝序号（字符串）；手动添加的＝自己生成的 id */
  key: string;
  extra: boolean;
  kind: string;
  w: number;
  d: number;
  rot: number;
  /** 米，三维引擎坐标系（添加/复制要用） */
  x: number;
  z: number;
  removed: boolean;
  /** 近似归属空间（按空间外接矩形算），给「按房间筛」用 */
  room: string;
};

export type RoomLike = { id: string; name?: string; bbox?: number[] };

/** 手动添加时的默认占地（米）：按常见尺寸给一个起点，加完可以改 */
export const DEFAULT_SIZE: Record<string, [number, number]> = {
  "沙发": [2.1, 0.9], "贵妃沙发": [2.4, 1.6], "单人沙发": [0.9, 0.9], "茶几": [1.1, 0.6],
  "边几": [0.5, 0.5], "电视柜": [1.8, 0.45], "餐桌": [1.6, 0.85], "圆餐桌": [1.3, 1.3],
  "餐椅": [0.45, 0.5], "凳": [0.4, 0.4], "岛台": [1.8, 0.9], "吧台": [1.6, 0.5],
  "吊柜": [1.6, 0.35], "餐边柜": [1.6, 0.45], "冰箱": [0.7, 0.7], "灶台": [0.75, 0.6],
  "水槽": [0.8, 0.5], "床": [1.8, 2.0], "婴儿床": [0.7, 1.3], "床头柜": [0.45, 0.4],
  "梳妆台": [1.0, 0.45], "矮柜": [1.6, 0.45], "到顶柜": [2.4, 0.6], "鞋柜": [1.0, 0.35],
  "书架": [1.8, 0.35], "洗衣机": [0.6, 0.6], "马桶": [0.4, 0.7], "浴缸": [1.7, 0.75],
  "台盆": [0.8, 0.5], "植物": [0.6, 0.6], "地毯": [2.4, 1.6], "钢琴": [1.5, 0.6],
  "通用": [0.8, 0.6],
};

/** 旧名字 → 新类型（与 furnitureModels.furnKind 同表） */
export function furnKind(kind?: string): string {
  const k = String(kind || "").trim();
  if (DEFAULT_SIZE[k]) return k;
  return KIND_ALIAS[k] || "通用";
}

export function defaultSize(kind: string): [number, number] {
  return DEFAULT_SIZE[furnKind(kind)] || [0.8, 0.6];
}

export function roomOf(x: number, z: number, rooms: RoomLike[] = []): string {
  const hit = (rooms || []).find((r) => Array.isArray(r.bbox) && r.bbox.length === 4
    && x >= Number(r.bbox[0]) && x <= Number(r.bbox[2])
    && z >= Number(r.bbox[1]) && z <= Number(r.bbox[3]));
  return hit ? String(hit.name || hit.id) : "";
}

export function roomNames(rows: FurnRow[], rooms: RoomLike[] = []): string[] {
  const out = (rooms || []).map((r) => String(r.name || r.id)).filter(Boolean);
  for (const r of rows) if (r.room && !out.includes(r.room)) out.push(r.room);
  return out;
}

/** 摘要 + 已有覆盖 → 面板里的一行行（含被删掉的件，才能「恢复」） */
export function rowsFromSummary(summary: any): FurnRow[] {
  const rooms: RoomLike[] = summary?.rooms || [];
  const rots = summary?.furn_rots || {};
  const sizes = summary?.furn_sizes || {};
  const hidden = new Set((summary?.furn_hidden || []).map(String));
  const rows: FurnRow[] = [];
  for (const f of summary?.furniture || []) {
    const extra = !!f.extra;
    const key = String(extra ? f.id : f.i);
    const sz = sizes[key] || {};
    const x = Number(f.x) || 0, z = Number(f.z) || 0;
    rows.push({
      key, extra, kind: String(f.kind || "通用"),
      w: Number(sz.w) > 0 ? Number(sz.w) : Number(f.w) || 0.6,
      d: Number(sz.d) > 0 ? Number(sz.d) : Number(f.d) || 0.6,
      rot: Number(rots[key] ?? f.rot ?? 0) || 0,
      x, z,
      removed: !!f.hidden || hidden.has(key),
      room: roomOf(x, z, rooms),
    });
  }
  return rows;
}

export function setKind(rows: FurnRow[], key: string, kind: string): FurnRow[] {
  return rows.map((r) => (r.key === key ? { ...r, kind: furnKind(kind) } : r));
}

export function setSize(rows: FurnRow[], key: string, w: number, d: number): FurnRow[] {
  return rows.map((r) => (r.key === key
    ? { ...r,
        w: Number.isFinite(w) && w >= 0.3 && w <= 12 ? w : r.w,
        d: Number.isFinite(d) && d >= 0.3 && d <= 12 ? d : r.d }
    : r));
}

export function rotateRow(rows: FurnRow[], key: string): FurnRow[] {
  return rows.map((r) => (r.key === key ? { ...r, rot: ((r.rot || 0) + 90) % 360 } : r));
}

export function removeRow(rows: FurnRow[], key: string, removed = true): FurnRow[] {
  return rows.map((r) => (r.key === key ? { ...r, removed } : r));
}

/** 手动添加一件：落在所选空间中心（同一位置已有时向右挪 0.15m，免得叠在一起） */
export function addRow(rows: FurnRow[], kind: string, room: string, rooms: RoomLike[] = []): FurnRow[] {
  const k = furnKind(kind);
  const [w, d] = defaultSize(k);
  const hit = (rooms || []).find((r) => String(r.name || r.id) === room);
  let x = rows.length ? rows[rows.length - 1].x : 0;
  let z = rows.length ? rows[rows.length - 1].z : 0;
  if (hit && Array.isArray(hit.bbox) && hit.bbox.length === 4) {
    x = (Number(hit.bbox[0]) + Number(hit.bbox[2])) / 2;
    z = (Number(hit.bbox[1]) + Number(hit.bbox[3])) / 2;
  }
  const clash = rows.filter((r) => Math.abs(r.x - x) < 0.05 && Math.abs(r.z - z) < 0.05).length;
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  return [...rows, {
    key: `fx-${Date.now().toString(36)}-${rows.length}`, extra: true, kind: k, w, d, rot: 0,
    x: r3(x + clash * 0.15), z, removed: false, room,
  }];
}

/** 在三维里点选的位置上放一件（x/z 是米，与图纸同一坐标系） */
export function addRowAt(rows: FurnRow[], kind: string, x: number, z: number): FurnRow[] {
  const k = furnKind(kind);
  const [w, d] = defaultSize(k);
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  return [...rows, {
    key: `fx-${Date.now().toString(36)}-${rows.length}`, extra: true, kind: k, w, d, rot: 0,
    x: r3(Number(x) || 0), z: r3(Number(z) || 0), removed: false, room: "",
  }];
}

/** 复制一件（挪 0.2m，改类型/尺寸都在副本上做） */
export function dupRow(rows: FurnRow[], key: string): FurnRow[] {
  const src = rows.find((r) => r.key === key);
  if (!src) return rows;
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  return [...rows, {
    ...src, key: `fx-${Date.now().toString(36)}-${rows.length}`, extra: true,
    x: r3(src.x + 0.2), removed: false,
  }];
}

/** 同类一起改（22 件「椅」一次改完） */
export function batchChange(rows: FurnRow[], from: string, to: string): FurnRow[] {
  const target = furnKind(to);
  return rows.map((r) => (!r.removed && (from === "*" || r.kind === from) ? { ...r, kind: target } : r));
}

/** 面板行 → 保存给后端的覆盖表（与 /confirm 的字段一一对应） */
export function payloadFromRows(rows: FurnRow[]) {
  const kinds: Record<string, string> = {};
  const rots: Record<string, number> = {};
  const sizes: Record<string, { w: number; d: number }> = {};
  const hidden: string[] = [];
  const extra: any[] = [];
  for (const r of rows) {
    if (r.extra) {
      if (r.removed) continue;
      extra.push({ id: r.key, kind: r.kind, x: r.x, z: r.z, w: r.w, d: r.d, rot: r.rot || 0 });
      continue;
    }
    if (r.removed) {
      hidden.push(r.key);
      continue;
    }
    kinds[r.key] = r.kind;
    rots[r.key] = r.rot || 0;
    sizes[r.key] = { w: r.w, d: r.d };
  }
  return { furn_kinds: kinds, furn_rots: rots, furn_sizes: sizes, furn_hidden: hidden, furn_extra: extra };
}
