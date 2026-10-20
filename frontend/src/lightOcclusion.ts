/**
 * 光斑遮挡（老板 2026-10-17「光斑不能穿过墙体、门、家具表面」）。
 *
 * 光斑原来是一整个圆，半径一大就铺到隔壁、铺进柜子里。这里从灯位向四周打射线，
 * 碰到下面这些就停，得到一圈「看得见的范围」，画布只在这圈里面画光斑：
 *  - 灯所在空间的边界（门洞也算：门口那一段同样挡住，光斑不会从门口漏到走廊）；
 *  - 本层墙体；
 *  - 高家具（≥ 1.8 m，比如到顶柜、衣柜）的轮廓：落地高柜挡光，矮家具（床、茶几）照到的是它的顶面，不挡。
 * 射线算法与传感器的探测范围裁剪是同一套（sensors.coveragePolygon）。
 */
import type { Obj } from "./types";
import { coveragePolygon, roomPolygon } from "./sensors";
import { containsPoint } from "./spaceGeometry";
import { furniturePoints } from "./furniturePolygon";

type Point = { x: number; y: number };

/** 到这个高度的家具当墙处理（米）。 */
export const OCCLUDING_FURNITURE_M = 1.8;

const floorOf = (o: Obj, rooms: Obj[]) =>
  Number.isFinite(+o?.floor) && o?.floor != null
    ? +o.floor
    : +(rooms.find((r) => r.id === o?.roomId)?.floor ?? 1);

function pointIn(poly: Point[], x: number, y: number) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** 点所在的空间：先认 roomId（且点确实在里面），否则按位置找本层哪个空间包住它。 */
export function roomAt(rooms: Obj[], item: Obj): Obj | null {
  const floor = floorOf(item, rooms);
  const x = +item?.x, y = +item?.y;
  const own = rooms.find((r) => r.id === item?.roomId);
  if (own && roomPolygon(own) && containsPoint(own, x, y)) return own;
  return rooms.find((r) => +(r.floor || 1) === floor && roomPolygon(r) && containsPoint(r, x, y)) || own || null;
}

/** 挡光的线段：本层墙 + 高家具轮廓（灯就在这件家具里面时不算它）。 */
export function lightObstacles(design: Obj, item: Obj): Obj[] {
  const rooms: Obj[] = design.rooms || [];
  const floor = floorOf(item, rooms);
  const walls = (design.walls || []).filter((w: Obj) => w?.floor == null || +w.floor === floor);
  const x = +item?.x, y = +item?.y;
  for (const f of design.furniture || []) {
    if (!f || f.hidden || +(f.floor || 1) !== floor || !(+f.heightM >= OCCLUDING_FURNITURE_M)) continue;
    const pts = furniturePoints(f);
    if (pts.length < 3 || pointIn(pts, x, y)) continue;
    pts.forEach((a, i) => {
      const b = pts[(i + 1) % pts.length];
      walls.push({ x: a.x, y: a.y, x2: b.x, y2: b.y });
    });
  }
  return walls;
}

/** 以灯位为原点、半径 radius 内看得见的范围（相对坐标多边形）；没有任何遮挡几何时返回 null（照旧画整圆）。 */
export function lightPoolPolygon(design: Obj, fixture: Obj, radius: number): Point[] | null {
  if (!(radius > 0)) return null;
  const room = roomAt(design.rooms || [], fixture);
  const poly = roomPolygon(room);
  // 2026-10-17：**只要有空间边界就必须裁**，裁不动也不能退回整圆。
  // 原来把空间边界交给 coveragePolygon 的内部判定（灯不在多边形里就不把边界当遮挡），
  // 灯被拖到墙线上/边界外一点点时整圈不裁 → 光斑铺过墙、铺到户型外面（老板看到的就是这个）。
  // 现在把「空间边界（闭口，门洞同样挡）＋ 本层墙 ＋ 高柜」合成一套遮挡段，一次打射线：
  // 灯不在空间里也按该空间裁，宁可裁紧一点，也不许穿墙。
  const segs: Obj[] = (lightObstacles(design, fixture) || []).slice();
  if (poly && poly.length >= 3) {
    for (let i = 0; i < poly.length; i += 1) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      segs.push({ x: a.x, y: a.y, x2: b.x, y2: b.y });
    }
  } else if (room) {
    const x = Number(room.x), y = Number(room.y);
    const w = Number(room.width), h = Number(room.height);
    if (w > 0 && h > 0 && Number.isFinite(x) && Number.isFinite(y)) {
      // 空间只有外接框（识别出来的草稿空间）：按框裁，保证光斑不出这间。
      segs.push(
        { x, y, x2: x + w, y2: y },
        { x: x + w, y, x2: x + w, y2: y + h },
        { x, y: y + h, x2: x + w, y2: y + h },
        { x, y, x2: x, y2: y + h },
      );
    }
  }
  if (!segs.length) return null;
  return coveragePolygon(
    { x: +fixture.x, y: +fixture.y, range: radius, fov: 360 },
    { roomPolygon: null, walls: segs },
  );
}

/** 同上，SVG 路径（绝对坐标），给 <clipPath> 用。 */
export function lightPoolClipPath(design: Obj, fixture: Obj, radius: number): string | null {
  const poly = lightPoolPolygon(design, fixture, radius);
  if (!poly) return null;
  const ox = +fixture.x, oy = +fixture.y;
  return "M " + poly.map((p) => `${(p.x + ox).toFixed(2)} ${(p.y + oy).toFixed(2)}`).join(" L ") + " Z";
}
