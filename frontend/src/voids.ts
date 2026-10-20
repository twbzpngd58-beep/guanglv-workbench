// 别墅挑空 / 中庭（贯通区）：工作台里原本没有这个概念，只能靠「层高填高一点」暗示，
// 于是有三个坑：① 图上/业主页看不出这里是通的；② 挑空面积被当使用面积；
// ③ 挑空吊灯只归一层，业主切到另一层就「看不见灯」。
// 这里统一表达：空间标 isVoid（挑空）+ voidLevels（贯通层数，向上贯通），
// 层高 heightM 填贯通总高，挑空区不计使用面积，挑空灯具按贯通高度安装、
// 并在贯通覆盖的其它楼层上「淡显」，避免演示与交付时灯消失。
import type { Obj } from "./types";

export const VOID_MIN_LEVELS = 2;

/** 是不是挑空/贯通空间。 */
export function isVoidRoom(room?: Obj | null): boolean {
  return !!room && room.isVoid === true;
}

/** 贯通层数（默认 2：本级 + 上面一层）。 */
export function voidLevelsOf(room?: Obj | null): number {
  const n = Math.round(Number(room?.voidLevels));
  return Number.isFinite(n) && n >= 1 ? Math.min(6, n) : VOID_MIN_LEVELS;
}

/** 挑空覆盖的楼层（自下而上：自身楼层 + 向上贯通的层）。 */
export function voidFloorsOf(room?: Obj | null): number[] {
  if (!isVoidRoom(room)) return [];
  const base = Number.isFinite(room?.floor) ? Number(room?.floor) : 1;
  const out: number[] = [];
  for (let i = 0; i < voidLevelsOf(room); i += 1) out.push(base + i);
  return out;
}

/** 挑空空间里布灯的默认安装高度：按贯通总高给（层高 − 0.6），避免光斑算小。
 *  非挑空空间返回 null（沿用原来的 2.8m 默认）。 */
export function voidInstallHeight(room?: Obj | null): number | null {
  if (!isVoidRoom(room)) return null;
  const h = Number(room?.heightM);
  const total = Number.isFinite(h) && h > 0 ? h : 5.6;
  return Math.max(2.2, Math.round((total - 0.6) * 10) / 10);
}

/** 挑空空间的一句话说明（画布标注、属性面板、交付页共用）。 */
export function voidLabel(room?: Obj | null): string {
  if (!isVoidRoom(room)) return "";
  const h = Number(room?.heightM);
  const height = Number.isFinite(h) && h > 0 ? `${Math.round(h * 100) / 100}m` : "";
  return `挑空${height ? " " + height : ""} · 贯通 ${voidLevelsOf(room)} 层`;
}

/** 使用面积 / 挑空面积（挑空不计使用面积）。 */
export function areaSummary(rooms: Obj[]): { used: number; voidArea: number } {
  let used = 0;
  let voidArea = 0;
  (rooms || []).forEach((r) => {
    const a = Number(r?.area) || 0;
    if (isVoidRoom(r)) voidArea += a;
    else used += a;
  });
  return { used: Math.round(used * 10) / 10, voidArea: Math.round(voidArea * 10) / 10 };
}

/** 本层需要「淡显」的其它楼层挑空灯具（挑空贯通到本层、灯却归在另一层）。 */
export function ghostFixturesOnFloor(
  design: Obj,
  floorNo: number,
  floorOf: (o: Obj) => number,
): { fixture: Obj; fromFloor: number; roomName: string }[] {
  const out: { fixture: Obj; fromFloor: number; roomName: string }[] = [];
  const rooms = design?.rooms || [];
  (design?.fixtures || []).forEach((f: Obj) => {
    const room = rooms.find((r: Obj) => r.id === f.roomId);
    if (!isVoidRoom(room)) return;
    const own = floorOf(f);
    if (own === floorNo) return; // 自己那层正常画，不重复
    if (!voidFloorsOf(room).includes(floorNo)) return;
    out.push({ fixture: f, fromFloor: own, roomName: room?.name || "挑空" });
  });
  return out;
}
