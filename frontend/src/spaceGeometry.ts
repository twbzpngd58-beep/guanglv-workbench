/** Space geometry uses design units (26 = 1 metre); elevations are metres. */
type Item = Record<string, any>;
export type SpacePoint = { x: number; y: number };
export type BoundarySnap = { roomId: string; edgeIndex: number; t: number; x: number; y: number; distance: number };
export function boundary(room: Item): SpacePoint[] {
  if (room.source === "fixture-code" || room.source === "semantic-labels") return [];
  const pts = room.points?.length >= 3 ? room.points.map((p: SpacePoint) => ({ x: +p.x, y: +p.y })) :
    +room.width > 1 && +room.height > 1 ? [
      { x: +room.x, y: +room.y }, { x: +room.x + +room.width, y: +room.y },
      { x: +room.x + +room.width, y: +room.y + +room.height }, { x: +room.x, y: +room.y + +room.height },
    ] : [];
  if (pts.length > 3 && Math.hypot(pts[0].x - pts.at(-1).x, pts[0].y - pts.at(-1).y) < 1e-6) pts.pop();
  return pts;
}
export function containsPoint(room: Item, x: number, y: number): boolean {
  const pts = boundary(room);
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[j], b = pts[i], dx = b.x-a.x, dy = b.y-a.y;
    const length = Math.hypot(dx,dy);
    if (length > 0 && Math.abs((x-a.x)*dy-(y-a.y)*dx)/length < 1e-6 &&
        x >= Math.min(a.x,b.x)-1e-6 && x <= Math.max(a.x,b.x)+1e-6 &&
        y >= Math.min(a.y,b.y)-1e-6 && y <= Math.max(a.y,b.y)+1e-6) return true;
    if ((a.y > y) !== (b.y > y) && x < (b.x-a.x)*(y-a.y)/(b.y-a.y)+a.x) inside = !inside;
  }
  return inside;
}

/** A scanline midpoint stays inside concave rooms where the box centre may not. */
export function interiorPoint(room: Item): SpacePoint {
  const pts = boundary(room);
  if (!pts.length) return { x: +room.x || 0, y: +room.y || 0 };
  const rows = [...new Set(pts.map(p => p.y))].sort((a,b) => a-b);
  let best = { x: pts[0].x, y: pts[0].y }, width = -1;
  for (let i=1; i<rows.length; i++) {
    const y=(rows[i]+rows[i-1])/2, cuts:number[]=[];
    pts.forEach((a,j)=>{
      const b=pts[(j+1)%pts.length];
      if ((a.y>y)!==(b.y>y)) cuts.push(a.x+(b.x-a.x)*(y-a.y)/(b.y-a.y));
    });
    cuts.sort((a,b)=>a-b);
    for (let j=1;j<cuts.length;j+=2) if (cuts[j]-cuts[j-1]>width) {
      width=cuts[j]-cuts[j-1];best={x:(cuts[j]+cuts[j-1])/2,y};
    }
  }
  return best;
}

/** 第二行标注要往下错开，但薄凹形房把「内部点 +20」错到隔壁地上去了（现场 2026-11-04 实测 5 间）。
 *  往下放不下就往上，上下都放不下就留在内部点。与 backend/space_geometry.py 的 offset_inside 同一口径，改动要一起改。 */
export function offsetInside(room: Item, x: number, y: number, dy: number): SpacePoint {
  if (containsPoint(room, x, y + dy)) return { x, y: y + dy };
  if (containsPoint(room, x, y - dy)) return { x, y: y - dy };
  return { x, y };
}

/** 洞口 → 画布几何。识别与手绘的门窗都只存「挂在哪条边界、占哪一段」，坐标由所属空间边界现推。 */
export function openingPlacement(design: Item, o: Item): Item | null {
  const type = o.type || o.kind || "门";
  if (o.x != null && o.y != null && o.width != null)
    return { x: +o.x, y: +o.y, width: +o.width, rotation: +o.rotation || 0, type };
  const room = (design.rooms || []).find((r: Item) => r.id === o.roomId);
  const pts = room ? boundary(room) : [];
  const a = pts[o.edgeIndex], b = pts[(o.edgeIndex + 1) % pts.length];
  if (!room || !a || !b) return null;
  const start = +o.start || 0, end = +o.end || 0, len = Math.hypot(b.x - a.x, b.y - a.y);
  if (!(end > start) || len <= 1e-6) return null;
  return { x: a.x + (b.x - a.x) * start, y: a.y + (b.y - a.y) * start,
    width: len * (end - start),
    rotation: Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI, type };
}

/** 洞口沿自己那条边滑到端点外：按「到这条边所在直线的垂距」判定它还在墙上，把 t 夹进 [0,1]。 */
function slideOnOwnEdge(room: Item, o: Item, mid: SpacePoint, width: number, tolerance: number): BoundarySnap | null {
  const pts = boundary(room);
  const a = pts[o.edgeIndex], b = pts[(o.edgeIndex + 1) % pts.length];
  if (!a || !b) return null;
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
  if (len < width || len <= 1e-6) return null;
  const perp = Math.abs((mid.x - a.x) * dy - (mid.y - a.y) * dx) / len;
  if (perp > tolerance) return null;
  const t = Math.max(0, Math.min(1, ((mid.x - a.x) * dx + (mid.y - a.y) * dy) / (len * len)));
  return { roomId: room.id, edgeIndex: o.edgeIndex, t, x: a.x + t * dx, y: a.y + t * dy, distance: perp };
}

/** 拖洞口：贴到最近的墙边并回写 edgeIndex/start/end——三维与成品图按区间开洞，只改 x/y 会两层不一致。
 *  1 米内没有放得下它的墙边就当脱离墙体：留下坐标、去掉挂接，这样它不再在墙上开洞。 */
export function moveOpening(design: Item, o: Item, x: number, y: number, rotation: number): Item {
  // 图纸判读的洞口只挂了边界区间、没有存 width：以前这里 Math.max(1, +o.width||0) 会凭空当成 1 单位，
  // 一拖就把 1 m 的门缩成 38 mm。米数先从区间折算，折不出来再用存量，都不成立就不动它。
  const width = +openingPlacement(design, o)?.width || +o.width || 0;
  if (!(width > 0)) return { ...o, x, y };
  const rad = (Number(rotation) || 0) * Math.PI / 180;
  const mid = { x: x + (width / 2) * Math.cos(rad), y: y + (width / 2) * Math.sin(rad) };
  // 先只在它原来那间房的边界上找：隔壁房共用这条墙，直接全图找最近会把门「跳」到隔壁的边上，
  // 位移比手拖的还大，看着像拖飞了。原房 1 米内没有边才换房。
  const owner = (design.rooms || []).find((r: Item) => r.id === o.roomId);
  // 沿墙滑过墙角：手拖到端点外，但还在墙的延长线上。这时夹在端点继续挂着，别抹掉挂接——
  // 抹掉之后它不再在墙上开洞，用户看见的只是「门拖一下就没了」。
  // 这条判定要放在吸附之前：拖过墙角 1 m 以上时，自己这条边的垂距仍是 0，而隔壁那条垂直边
  // 到落点的距离更小，先吸附就会把门窗「拐」到侧墙上（门跟着拐了弯，米数却没变，看着像拖飞）。
  let hit = (owner && slideOnOwnEdge(owner, o, mid, width, 26)) || null;
  // minEdgeLength=width：只挂到放得下这条洞口的边上。吸到比它短的边会把洞口缩成整条边
  // （4.33 m 的门被拖成 2.05 m），门窗的米数是产品口径，不能被一次拖动静默改掉。
  if (!hit) hit = (owner && snapBoundary([owner], mid, +(o.floor || 1), 26, width))
    || snapBoundary(design.rooms || [], mid, +(o.floor || 1), 26, width);
  if (!hit) return { ...o, x, y, edgeIndex: undefined, start: undefined, end: undefined, roomId: "" };
  const room = (design.rooms || []).find((r: Item) => r.id === hit.roomId);
  const pts = room ? boundary(room) : [];
  const a = pts[hit.edgeIndex], b = pts[(hit.edgeIndex + 1) % pts.length];
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (!a || !b || len <= 1e-6) return { ...o, x, y };
  const frac = width / len;
  const start = Math.max(0, Math.min(1 - frac, hit.t - frac / 2));
  return { ...o, roomId: hit.roomId, edgeIndex: hit.edgeIndex, start, end: start + frac,
    x: a.x + (b.x - a.x) * start, y: a.y + (b.y - a.y) * start, width: len * frac,
    rotation: Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI };
}

export function remapOpenings(design: Item, oldRoom: Item, nextRoom: Item): Item[] {
  const old = boundary(oldRoom), next = boundary(nextRoom);
  return (design.openings || []).flatMap((o: Item) => {
    if (o.roomId !== oldRoom.id || !Number.isInteger(o.edgeIndex)) return [o];
    const a=old[o.edgeIndex], b=old[(o.edgeIndex+1)%old.length];
    if (!a || !b) return [];
    const ends=[o.start,o.end].map(t=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t}));
    const matches:Item[]=[];
    next.forEach((u,index)=>{
      const v=next[(index+1)%next.length], dx=v.x-u.x,dy=v.y-u.y,len=Math.hypot(dx,dy);
      if (len<1e-6 || ends.some(p=>Math.abs((p.x-u.x)*dy-(p.y-u.y)*dx)/len>.01)) return;
      const ts=ends.map(p=>((p.x-u.x)*dx+(p.y-u.y)*dy)/(len*len));
      const start=Math.max(0,Math.min(...ts)),end=Math.min(1,Math.max(...ts));
      if (end-start<1e-6) return;
      matches.push({...o,id:matches.length?`${o.id}-part-${index}`:o.id,edgeIndex:index,start,end,
        x:u.x+dx*start,y:u.y+dy*start,width:len*(end-start),rotation:Math.atan2(dy,dx)*180/Math.PI});
    });
    return matches;
  });
}
export function snapBoundary(rooms: Item[], p: SpacePoint, floor: number, tolerance: number, minEdgeLength = 0): BoundarySnap | null {
  let best: BoundarySnap | null = null;
  for (const room of rooms.filter(r => +(r.floor || 1) === floor)) {
    const pts = boundary(room);
    pts.forEach((a, edgeIndex) => {
      const b = pts[(edgeIndex + 1) % pts.length], dx = b.x - a.x, dy = b.y - a.y;
      if (Math.hypot(dx, dy) < minEdgeLength) return;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
      const x = a.x + t * dx, y = a.y + t * dy, distance = Math.hypot(x - p.x, y - p.y);
      if (distance <= tolerance && (!best || distance < best.distance)) best = { roomId: room.id, edgeIndex, t, x, y, distance };
    });
  }
  return best;
}
/** Rebuild walls from polygon edges. Door/window intervals leave real holes, with lintels and sills. */
export function spaceShell(design: Item, floor?: number): { walls: Item[]; openings: Item[] } {
  const walls: Item[] = [], openings: Item[] = [];
  for (const room of (design.rooms || []).filter((r: Item) => floor == null || +(r.floor || 1) === floor)) {
    const pts = boundary(room), h = +(room.heightM || 3);
    pts.forEach((a, edgeIndex) => {
      const b = pts[(edgeIndex + 1) % pts.length], dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
      if (len < 1e-6) return;
      // 挂在边界上的洞口一律开洞（含图纸判读的 source=cad，2026-11-04 裁定），与后端 design_geometry 同口径。
      const cuts = (design.openings || []).filter((o: Item) => Number.isInteger(o.edgeIndex))
        .flatMap((o: Item) => {
          const owner = (design.rooms || []).find((r: Item) => r.id === o.roomId);
          if (!owner || +(owner.floor || 1) !== +(room.floor || 1)) return [];
          const outline = boundary(owner), u = outline[o.edgeIndex], v = outline[(o.edgeIndex + 1) % outline.length];
          if (!u || !v) return [];
          const p = { x: u.x + (v.x - u.x) * o.start, y: u.y + (v.y - u.y) * o.start };
          const q = { x: u.x + (v.x - u.x) * o.end, y: u.y + (v.y - u.y) * o.end };
          if (Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len > .01 ||
              Math.abs((q.x - a.x) * dy - (q.y - a.y) * dx) / len > .01) return [];
          const ts = [p, q].map(c => ((c.x - a.x) * dx + (c.y - a.y) * dy) / (len * len));
          return [{ ...o, start: Math.max(0, Math.min(...ts)), end: Math.min(1, Math.max(...ts)) }];
        })
        .sort((c: Item, d: Item) => c.start - d.start);
      const segment = (s: number, e: number, bottomM = 0, top = h, openingId = "") => {
        if (e - s < 1e-6 || top - bottomM < 1e-6) return;
        walls.push({ id: `space-wall-${room.id}-${edgeIndex}-${walls.length}`, source: "space-boundary",
          roomId: room.id, edgeIndex, floor: +(room.floor || 1),
          x: a.x + dx * s, y: a.y + dy * s, x2: a.x + dx * e, y2: a.y + dy * e,
          heightM: top - bottomM, bottomM, thicknessM: .12, openingId });
      };
      let cursor = 0;
      for (const cut of cuts) {
        if (!(cut.end > cut.start) || cut.start < cursor - 1e-6) continue;
        segment(cursor, cut.start);
        const sill = cut.type === "门" ? 0 : Math.max(0, Math.min(h, +(cut.sillHeight || 0)));
        const top = Math.min(h, sill + +(cut.heightM || (cut.type === "门" ? 2.1 : 1.5)));
        segment(cut.start, cut.end, 0, sill, cut.id);
        segment(cut.start, cut.end, top, h, cut.id);
        if (cut.roomId === room.id) openings.push({ ...cut, x: a.x + dx * cut.start, y: a.y + dy * cut.start,
          x2: a.x + dx * cut.end, y2: a.y + dy * cut.end, width: len * (cut.end - cut.start),
          rotation: Math.atan2(dy, dx) * 180 / Math.PI, sillHeight: sill, heightM: top - sill, floor: +(room.floor || 1) });
        cursor = cut.end;
      }
      segment(cursor, 1);
    });
  }
  return { walls, openings };
}
export function withSpaceShell<T extends Item>(design: T): T {
  const shell = spaceShell(design);
  const owned = new Set(shell.openings.map(o => o.id));
  return { ...design,
    walls: [...(design.walls || []).filter((w: Item) => w.source !== "space-boundary"), ...shell.walls],
    openings: [...(design.openings || []).filter((o: Item) => !owned.has(o.id)), ...shell.openings],
  };
}
/** 墙装设备（面板 / 温控器）在二维上的落位（现场 2026-10-17：二维放面板，三维不能悬浮）：
 *  吸到落点所在空间（没有就全层）最近的一段边界上，返回吸附点与离墙距离（设计单位）。
 *  离墙超过 maxDistance 返回 null——调用方提示「面板要放在墙边」。 */
export function snapToWall(rooms: Item[], p: SpacePoint, floor: number, maxDistance: number): BoundarySnap | null {
  const own = rooms.filter(r => +(r.floor || 1) === floor && boundary(r).length >= 3 && containsPoint(r, p.x, p.y));
  return snapBoundary(own.length ? own : rooms, p, floor, maxDistance);
}
/** 0.6 m：面板离墙线超过这个距离不让放（设计单位 26 = 1 m）。 */
export const WALL_SNAP_MAX = 0.6 * 26;
