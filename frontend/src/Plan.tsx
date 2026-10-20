import { useEffect, useRef, useState } from "react";
import {
  decorativeHaloRadiusUnits,
  defaultBeamAngle,
  isDecorativeLight,
  spotRadiusUnits,
} from "./codes";
import type { Design, Obj } from "./types";
import { clone } from "./types";
import { roomPoints, insertRoomPoint, deleteRoomPoint, withRoomPolygon } from "./roomPolygon";
import { snapBoundary, remapOpenings, containsPoint, type SpacePoint } from "./spaceGeometry";
import { coveragePath, manualCoverage, obstaclesFor, sensorSectorPath } from "./sensors";
import { lightPoolClipPath } from "./lightOcclusion";
import { useSceneFade } from "./sceneFade";
import { ghostFixturesOnFloor, isVoidRoom, voidLabel } from "./voids";
import { FURN_HANDLES, resizeFurniture, type FurnHandle } from "./furnitureResize";
import { furniturePoints, hasFurniturePolygon, insertFurniturePoint, deleteFurniturePoint,
  moveFurniturePoint, resizeFurniturePolygon, normalizeFurniture } from "./furniturePolygon";

/** Lamp glow colour, blended across the warm-to-cool range so it never jumps. */
/** 光斑暖黄配色：色温只做轻微冷暖微调，本体始终是暖黄发光。 */
/** 灯带反光：浅色（低饱和、高明度），就像灯光洗在墙面/家具上的浅层反光。 */
function stripReflectColour(cct: number): string {
  const c = Number.isFinite(cct) ? cct : 3000;
  if (c < 3200) return "#f5edda";
  if (c < 4400) return "#f2f0e6";
  return "#e9e7e5";
}

function warmSpotColour(cct: number): string {
  const stops: Array<[number, [number, number, number]]> = [
    [1800, [255, 169, 63]],
    [2700, [255, 192, 106]],
    [3000, [255, 203, 128]],
    [3500, [255, 215, 154]],
    [4000, [255, 226, 180]],
    [5000, [255, 236, 205]],
    [6500, [255, 244, 224]],
  ];
  const c = Number.isFinite(cct) ? cct : 3000;
  let lo = stops[0];
  let hi = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i += 1) {
    if (c >= stops[i][0] && c <= stops[i + 1][0]) {
      lo = stops[i];
      hi = stops[i + 1];
      break;
    }
  }
  const span = Math.max(1, hi[0] - lo[0]);
  const t = Math.min(1, Math.max(0, (c - lo[0]) / span));
  const r = Math.round(lo[1][0] + (hi[1][0] - lo[1][0]) * t);
  const g = Math.round(lo[1][1] + (hi[1][1] - lo[1][1]) * t);
  const b = Math.round(lo[1][2] + (hi[1][2] - lo[1][2]) * t);
  return `rgb(${r}, ${g}, ${b})`;
}

/** 灯带几何：优先用 stripPath（可多段），否则按灯位 + 长度/朝向推一条直线。
 * 26 画布单位 = 1 米（沿用旧约定）。
 */
export function stripPoints(f: Obj): Obj[] {
  if (Array.isArray(f.stripPath) && f.stripPath.length > 1) return f.stripPath;
  const len = Math.max(30, (Number(f.length) || 1) * 26);
  const rad = ((Number(f.stripRotation) || 0) * Math.PI) / 180;
  return [
    { x: f.x, y: f.y },
    { x: f.x + len * Math.cos(rad), y: f.y + len * Math.sin(rad) },
  ];
}

function glowColour(cct: number): string {
  const t = Math.max(0, Math.min(1, (Number(cct || 3000) - 2700) / (5500 - 2700)));
  const warm = [246, 193, 113];
  const cool = [213, 228, 255];
  const mix = warm.map((v, i) => Math.round(v + (cool[i] - v) * t));
  return `rgb(${mix.join(",")})`;
}

/** 是否彩色灯具（含彩色灯带）：单色 / 双色按色温走暖黄，彩色用自身颜色。 */
function isColourFixture(f: Obj): boolean {
  return !!f && (f.colored === true || f.colorMode === "彩色");
}
function fixtureHex(f: Obj): string {
  return (f && f.colorHex) || "#ff5aa8";
}
/** 光斑 / 发光颜色：彩色灯具用指定颜色，其余按色温暖黄。 */
function fixtureLightColour(f: Obj, cct: number): string {
  return isColourFixture(f) ? fixtureHex(f) : warmSpotColour(cct || 3000);
}
function fixtureGlowColour(f: Obj, cct: number): string {
  return isColourFixture(f) ? fixtureHex(f) : glowColour(cct);
}
/** 灯带反光颜色：彩色灯带用带透明度的自身颜色。 */
function fixtureReflectColour(f: Obj, cct: number): string {
  if (isColourFixture(f)) {
    const hex = fixtureHex(f).replace("#", "");
    const r = parseInt(hex.slice(0, 2), 16) || 255;
    const g = parseInt(hex.slice(2, 4), 16) || 90;
    const b = parseInt(hex.slice(4, 6), 16) || 168;
    return `rgba(${r}, ${g}, ${b}, 0.42)`;
  }
  return stripReflectColour(cct);
}

export type Selection = {
  kind: "rooms" | "fixtures" | "walls" | "openings" | "devices";
  id: string;
} | null;
interface Props {
  design: Design;
  mini?: boolean;
  scene?: Obj;
  floor?: number;
  selection?: Selection;
  onSelect?: (s: Selection) => void;
  onChange?: (d: Design, history?: boolean) => void;
  /** 布灯落点：在画布上点击时回调该点的模型坐标（「点哪放哪」）。 */
  onPlacePoint?: (p: { x: number; y: number }) => void;
  /** 灯带折线（§十.10 口径②，实测 2026-10-12 认可）：每点一下回调一个拐点坐标。 */
  onStripPoint?: (x: number, y: number) => void;
  /** 画多边形（在底图上描空间边界，实测 2026-10-14）：点拐点、点回起点或双击收口后回调这一圈点。 */
  onPolygon?: (points: { x: number; y: number }[]) => void;
  onOpening?: (start: NonNullable<ReturnType<typeof snapBoundary>>, end: NonNullable<ReturnType<typeof snapBoundary>>, type: string) => void;
  onEditError?: (message: string) => void;
  selectedFurnitureId?: string;
  onFurnitureSelect?: (id: string) => void;
  /** 家具边界编辑（2026-10-16「家具要像空间一样的编辑方式」）：显示顶点、可拖点/加点/删点。 */
  editableFurniture?: boolean;
  /** 多边形绘制完成（画家具轮廓，世界坐标点）：与空间的 onPolygon 同一套交互。 */
  onFurnPolygon?: (points: { x: number; y: number }[]) => void;
  tool?: string;
  zoom?: number;
  /** 滚轮缩放底图（2026-10-17：导入图纸后绘制空间/门窗/家具时要能滚轮放大缩小）：
   *  以光标为中心缩放；中键拖动、或选择工具下在空白处拖动＝平移。 */
  wheelZoom?: boolean;
  /** 值变化＝把滚轮缩放与平移还原到适应画布。 */
  viewReset?: number;
  onViewZoom?: (zoom: number) => void;
  /** 绘制分级（2026-10-17：完成一级进入下一级，上一级固化）：
   *  spaces＝只动空间；openings＝空间/墙固化，只画门窗；furniture＝空间/墙/门窗固化，只动家具。
   *  固化的层不接收指针（点在它的边界上也不会选中或拖动它），保存时也会被还原。 */
  stage?: "spaces" | "openings" | "furniture";
  showFurniture?: boolean;
  showCanonicalFurniture?: boolean;
  editableRooms?: boolean;
  showLights?: boolean;
  /** 图层：灯具层（关掉＝隐藏所有灯具，只留下设备，方便单独动面板/传感器）。 */
  showFixtureLayer?: boolean;
  /** 图层：设备层（关掉＝隐藏面板/传感器/网关等，面板与灯具叠在一起时靠它认灯、拖灯）。 */
  showDeviceLayer?: boolean;
  /** 空间范围核对只显示底图和空间边界，隐藏独立的墙线、门窗、标注叠加。 */
  showStructureLayer?: boolean;
  showOpeningLayer?: boolean;
  showLabels?: boolean;
  showGrid?: boolean;
  showSource?: boolean;
  background?: string;
  /** 底图在设计坐标里的摆放矩形（给 DXF 底图用：不给就按老规矩铺在左上角那块）。
   *  有它就顺带把视野收到这块上，图纸和空间边界才看得清、对得准。 */
  backgroundRect?: { x: number; y: number; w: number; h: number } | null;
  readonly?: boolean;
  /** 底图与空间：布灯前的灰色蒙版（导入图纸后显示，确定后消失）。 */
  planMasked?: boolean;
  /** 项目建筑面积，仅用于把光束角理论值换算成画布上的光斑观感。 */
  projectArea?: number;
  /** 全部开启/关闭触发的场景内缓变：值递增即按渐变时间过渡。 */
  fadeTick?: number;
  /** 小人漫游：非空时在这张画布上画出小人（只画在漫游楼层）。 */
  roam?: { x: number; y: number } | null;
  /** 小人漫游：这张画布是否接受「按住拖动小人」。多层项目里每层画布都开着，
   *  这样在哪一层起手都能开始漫游（小人随后跟到那一层）。 */
  roamArmed?: boolean;
  /** 挑空（贯通）提示：画布角上的一句话，例如「本层挑空处另有 1 盏灯（B1，随情景同步）」。 */
  voidNote?: string;
  /** 正在手动调整探测范围的设备 id：显示可拖顶点。 */
  coverageEdit?: string | null;
  /** 手动调整时被选中的顶点序号（-1 = 未选）：选中后才能定向删除。 */
  coveragePointSel?: number;
  onCoveragePointSelect?: (index: number) => void;
  onRoamMove?: (x: number, y: number) => void;
  /** 定位：非空时把画布平移到该点居中（token 变化触发一次）。 */
  focus?: { x: number; y: number; token: number } | null;
}
export function Plan({
  design,
  mini = false,
  scene,
  floor = 1,
  selection = null,
  onSelect,
  onChange,
  onPlacePoint,
  onStripPoint,
  onPolygon,
  onOpening,
  onEditError,
  selectedFurnitureId = "",
  onFurnitureSelect,
  editableFurniture = false,
  onFurnPolygon,
  tool = "select",
  zoom: zoomProp = 1,
  wheelZoom = false,
  viewReset = 0,
  onViewZoom,
  stage,
  showFurniture = true,
  showCanonicalFurniture = showFurniture,
  editableRooms = true,
  showLights = true,
  showFixtureLayer = true,
  showDeviceLayer = true,
  showStructureLayer = true,
  showOpeningLayer = false,
  showLabels = true,
  showGrid = true,
  showSource = false,
  background,
  backgroundRect,
  readonly = false,
  planMasked = false,
  projectArea = 100,
  fadeTick = 0,
  roam = null,
  roamArmed = false,
  voidNote = "",
  coverageEdit = null,
  coveragePointSel = -1,
  onCoveragePointSelect,
  onRoamMove,
  focus = null,
}: Props) {
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<any>(null);
  // 画多边形的两种用途：draw-poly＝空间边界；draw-furn-poly＝家具轮廓（2026-10-16）。
  const polyDrawing = tool === "draw-poly" || tool === "draw-furn-poly";
  // 正在画的多边形（在底图上描边界）：点一下落一个点，点回起点或双击收口。
  const [poly, setPoly] = useState<{ x: number; y: number }[]>([]);
  const [openingStart, setOpeningStart] = useState<NonNullable<ReturnType<typeof snapBoundary>> | null>(null);
  const [openingHover, setOpeningHover] = useState<SpacePoint | null>(null);
  useEffect(() => { setOpeningStart(null); setOpeningHover(null); }, [tool]);
  useEffect(() => { if (!polyDrawing) setPoly([]); }, [tool]);
  useEffect(() => {
    const cancel = (e: KeyboardEvent) => { if (e.key === "Escape") { setPoly([]); setOpeningStart(null); setOpeningHover(null); } };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, []);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [wheelScale, setWheelScale] = useState(1);
  const zoom = zoomProp * wheelScale;
  const view = useRef({ pan, zoom, wheelScale });
  view.current = { pan, zoom, wheelScale };
  useEffect(() => { if (wheelZoom) { setWheelScale(1); setPan({ x: 0, y: 0 }); } }, [viewReset]);
  useEffect(() => { if (wheelZoom) onViewZoom?.(wheelScale); }, [wheelScale]);
  /** 当前绘制级别下这一类对象是否已固化（不可选、不可拖）。 */
  const frozen = (kind?: string) => !!stage && !!kind && (
    kind === "walls" ||
    (kind === "rooms" && stage !== "spaces") ||
    (kind === "openings" && stage !== "openings") ||
    (kind === "furniture" && stage !== "furniture"));
  // 滚轮缩放：React 的 onWheel 是被动监听，拦不住页面滚动，所以挂原生非被动监听。
  useEffect(() => {
    const element = svg.current;
    if (!element || !wheelZoom || mini) return;
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const m = element.getScreenCTM();
      if (!m) return;
      const pt = element.createSVGPoint();
      pt.x = ev.clientX; pt.y = ev.clientY;
      const at = pt.matrixTransform(m.inverse());
      const { pan: p0, zoom: z0, wheelScale: w0 } = view.current;
      const w1 = Math.max(0.5, Math.min(12, w0 * Math.exp(-ev.deltaY * 0.0015)));
      if (w1 === w0) return;
      const k = w1 / w0;
      // 光标下的那一点缩放前后不动
      setPan({ x: at.x - (at.x - p0.x) * k, y: at.y - (at.y - p0.y) * k });
      setWheelScale(w1);
      void z0;
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [wheelZoom, mini]);
  const [polyHover, setPolyHover] = useState<{ x: number; y: number } | null>(null);
  // Control points are screen-pixel sized, not CAD units: fitting/zooming must not enlarge them.
  const [unitsPerPixel, setUnitsPerPixel] = useState(1);
  useEffect(() => {
    const element = svg.current;
    if (!element) return;
    const measure = () => {
      const m = element.getScreenCTM();
      if (m) setUnitsPerPixel(1 / Math.max(0.00001, Math.hypot(m.a, m.b) * zoom));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element); measure();
    return () => observer.disconnect();
  }, [zoom, backgroundRect?.x, backgroundRect?.y, backgroundRect?.w, backgroundRect?.h]);
  useEffect(() => { if (!polyDrawing) setPolyHover(null); }, [tool]);
  const night = !!scene;
  // 定位到某盏灯：把该点平移到可视区（820×690）中央；只认 token，改缩放不重定位。
  const focusRef = useRef(zoom);
  focusRef.current = zoom;
  useEffect(() => {
    if (!focus) return;
    const z = focusRef.current || 1;
    setPan({ x: 410 - Number(focus.x || 0) * z, y: 345 - Number(focus.y || 0) * z });
  }, [focus?.token]);
  // Scene switching is a gradual cross-fade, never a hard cut: lamp level and
  // colour temperature ease from the outgoing scene to the incoming one over the
  // incoming scene's own 渐变时间（口径统一到「切到哪个情景用哪个情景的渐变时间」，见 sceneFade.ts）。
  // Thumbnails and the first paint show the target at once.
  const sceneStates = useSceneFade(scene, { fadeTick, animate: !mini });

  const rooms = design.rooms.filter((r) => r.floor === floor);
  // 按灯具编号建立的空间只作归组，没有边界，不在画布上画。
  // 无边界空间（source=fixture-code / semantic-labels，或没有真实几何）不绘制：
  // 空间由名称与灯具编号定位，画布只画真正的户型轮廓。
  const drawableRooms = rooms.filter(
    (r) =>
      r.source !== "fixture-code" &&
      r.source !== "semantic-labels" &&
      (Array.isArray(r.points) && r.points.length > 2
        ? true
        : Number(r.width) > 1 && Number(r.height) > 1),
  );
  const fixtures = design.fixtures.filter((r) => r.floor === floor);
  // 挑空（贯通）灯具：归在别的楼层、但挑空通到本层 → 本层淡显一份，免得切层后以为灯不见了。
  const ghostFixtures = mini
    ? []
    : ghostFixturesOnFloor(
        design,
        floor,
        (o: Obj) =>
          Number.isFinite(o?.floor)
            ? Number(o.floor)
            : design.rooms.find((r: Obj) => r.id === o?.roomId)?.floor ?? 1,
      );
  // 探测范围的裁剪几何（②空间边界 + ③墙体）：整张图上只算一次上下文。
  const coverageCtx = {
    rooms: design.rooms,
    walls: design.walls,
    floorOf: (o: Obj) =>
      Number.isFinite(o?.floor)
        ? Number(o.floor)
        : design.rooms.find((r: Obj) => r.id === o?.roomId)?.floor ?? 1,
  };
  // 面板/传感器与灯具叠在同一个点上时（床头柜既有灯又有面板就是这种），
  // 设备标记往右上错开一点并拉一条引线回到真实位置，演示与拖动都不会认错对象。
  const fixturePoints = fixtures.map((f: Obj) => ({
    x: Number(f.x) || 0,
    y: Number(f.y) || 0,
  }));
  // 只用到 clientX/clientY：拖动的 move 现在是 window 上的原生事件
  const pos = (e: { clientX: number; clientY: number }) => {
    const s = svg.current!;
    const pt = s.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const m = s.getScreenCTM();
    if (!m) return { x: 0, y: 0 };
    const p = pt.matrixTransform(m.inverse());
    return { x: (p.x - pan.x) / zoom, y: (p.y - pan.y) / zoom };
  };
  // 合成事件或指针已释放时 setPointerCapture 会抛错，包一层避免中断交互。
  // 拖动期间的指针事件改为挂在 window 上。
  // 原因：pointer capture 在拖动过程中的重渲染里会被浏览器释放（lostpointercapture），
  // 之后的 pointermove 不再送达画布 —— 表现就是「拖到一半停住 / 松手后位置对不上」，
  // 缩放或平移过画布之后尤其明显（真实踩过：4 步拖动只收到 2 次移动）。
  const capture = (_id: number) => {
    const onMove = (ev: PointerEvent) => move(ev);
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      end();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };
  function down(
    e: React.PointerEvent,
    kind?: Selection extends infer _
      ? "rooms" | "walls" | "fixtures" | "openings" | "devices" | "furniture"
      : never,
    id?: string,
    handle?: string,
    index?: number,
  ) {
    if (mini) return;
    e.stopPropagation();
    // 已固化的上一级：当作点在空白处（不选中、不拖动它）。
    if (frozen(kind)) { kind = undefined; id = undefined; handle = undefined; }
    // 可缩放的绘制画布：中键随时平移（画多边形、画门窗途中也行），不打断当前工具。
    if (wheelZoom && e.button === 1) {
      e.preventDefault();
      drag.current = { pan: true, start: { x: e.clientX, y: e.clientY }, pan0: pan };
      capture(e.pointerId);
      return;
    }
    if (tool === "add-room-point" || tool === "delete-room-point") {
      if (readonly || !editableRooms || !onChange || e.button !== 0) return;
      if (kind !== "rooms" || !id || selection?.id !== id) {
        if (kind === "rooms" && id) onSelect?.({ kind, id });
        return;
      }
      if ((tool === "add-room-point" && handle !== "edge") ||
          (tool === "delete-room-point" && handle !== "point")) return;
      const next = clone(design), room = next.rooms.find(r => r.id === id);
      if (!room) return;
      try {
        const updated = tool === "add-room-point" ? insertRoomPoint(room, index!, pos(e)) : deleteRoomPoint(room, index!);
        next.openings = remapOpenings(next, room, updated);
        next.rooms = next.rooms.map(r => r.id === id ? updated : r);
        onChange(next, true);
      } catch (err: any) { onEditError?.(err.message); }
      return;
    }
    // 家具边界加/删点（2026-10-16：家具也像空间一样加点、删点）。
    if (tool === "add-furn-point" || tool === "delete-furn-point") {
      if (readonly || !editableFurniture || !onChange || e.button !== 0) return;
      if (kind !== "furniture" || !id || selectedFurnitureId !== id) {
        if (kind === "furniture" && id) onFurnitureSelect?.(id);
        return;
      }
      if ((tool === "add-furn-point" && handle !== "edge") ||
          (tool === "delete-furn-point" && handle !== "furn-point")) return;
      const next = clone(design) as Design;
      const row = (next.furniture || []).find((f) => f.id === id);
      if (!row) return;
      try {
        const updated = tool === "add-furn-point"
          ? insertFurniturePoint(row, index!, pos(e))
          : deleteFurniturePoint(row, index!);
        next.furniture = (next.furniture || []).map((f) => (f.id === id ? updated : f));
        onChange(next, true);
      } catch (err: any) { onEditError?.(err.message); }
      return;
    }
    // 漫游模式：按住画布任意位置拖动小人（本层画布都可以起手）。
    if (roamArmed || roam) {
      const rp = pos(e);
      onRoamMove?.(rp.x, rp.y);
      drag.current = { roam: true };
      capture(e.pointerId);
      return;
    }
    if (tool === "pan") {
      drag.current = {
        pan: true,
        start: { x: e.clientX, y: e.clientY },
        pan0: pan,
      };
      capture(e.pointerId);
      return;
    }
    // 布灯 / 添加设备·窗帘模式：点哪落哪——把落点坐标交回 Workspace，随后弹窗确认。
    if ((tool === "place-lamp" || tool === "place-device" || tool === "place-furniture") && !readonly) {
      onPlacePoint?.(pos(e));
      return;
    }
    // 画多边形（实测 2026-10-14：在 DXF 底图上描边界）：点一下落一个点，
    // 点回起点（或双击）收口 → onPolygon 把这一圈点交回去。
    if (polyDrawing && !readonly) {
      if (e.button !== 0 || e.detail > 1) return;
      const q = pos(e);
      if (poly.length >= 3 && Math.hypot(q.x - poly[0].x, q.y - poly[0].y) < 6 * unitsPerPixel) {
        if (tool === "draw-furn-poly") onFurnPolygon?.(poly);
        else onPolygon?.(poly);
        setPoly([]);
        return;
      }
      setPoly((v) => {
        const last = v[v.length - 1];
        return last && Math.hypot(q.x - last.x, q.y - last.y) < 2 * unitsPerPixel ? v : [...v, q];
      });
      setPolyHover(q);
      return;
    }
    if ((tool === "draw-door" || tool === "draw-window") && !readonly) {
      if (e.button !== 0) return;
      const q = snapBoundary(design.rooms, pos(e), floor, 12 * unitsPerPixel);
      if (!q) { onEditError?.("请在空间边界上点击门窗的两端"); return; }
      if (!openingStart) { setOpeningStart(q); return; }
      if (q.roomId !== openingStart.roomId || q.edgeIndex !== openingStart.edgeIndex) {
        onEditError?.("门窗两端须在同一条空间边界上"); return;
      }
      if (Math.hypot(q.x - openingStart.x, q.y - openingStart.y) < 2 * unitsPerPixel) {
        onEditError?.("门窗宽度太小，请重新点击另一端"); return;
      }
      onOpening?.(openingStart, q, tool === "draw-door" ? "门" : "窗");
      setOpeningStart(null); setOpeningHover(null);
      return;
    }
    // 灯带折线（§十.10 口径②）：点一下加一个拐点，长度按折线自动量。
    if (tool === "draw-strip" && !readonly) {
      onStripPoint?.(pos(e).x, pos(e).y);
      return;
    }
    // 选择工具下在空白处按住拖动＝平移（点一下仍是取消选中）。
    if (wheelZoom && !kind && tool === "select" && e.button === 0) {
      onSelect?.(null);
      if (stage === "furniture") onFurnitureSelect?.("");
      drag.current = { pan: true, start: { x: e.clientX, y: e.clientY }, pan0: pan };
      capture(e.pointerId);
      return;
    }
    // 家具不是「空间选择」那一类（选中走 selectedFurnitureId），这里只把空间/灯具/设备/门窗交给 onSelect。
    if (kind && id && kind !== "furniture") onSelect?.({ kind, id });
    else if (!kind) onSelect?.(null);
    // 光斑/灯带句柄属于“调外观”，只读的情景画布也要放行；灯体本身仍不能拖。
    const spotHandle = /^(spot|strip)-/.test(handle ?? "");
    if ((readonly && !spotHandle) || !kind || !id || (kind === "rooms" && !editableRooms)) return;
    if (handle === "strip-cast") {
      // 点击切换灯带照射方向（反光侧翻转）。
      const dd = clone(design);
      const obj = dd.fixtures.find((v) => v.id === id);
      if (obj) obj.stripCast = obj.stripCast === "left" ? "right" : "left";
      onChange?.(dd, true);
      return;
    }
    drag.current = {
      kind,
      id,
      start: pos(e),
      base: clone(design),
      handle,
      index,
      moved: false,
    };
    capture(e.pointerId);
  }
  function move(e: { clientX: number; clientY: number }) {
    const dr = drag.current;
    if (!dr) return;
    if (dr.roam) {
      const rp = pos(e);
      onRoamMove?.(rp.x, rp.y);
      return;
    }
    if (dr.pan) {
      const matrix = svg.current?.getScreenCTM();
      const scaleX = matrix ? 1 / matrix.a : 1;
      const scaleY = matrix ? 1 / matrix.d : 1;
      setPan({
        x: dr.pan0.x + (e.clientX - dr.start.x) * scaleX,
        y: dr.pan0.y + (e.clientY - dr.start.y) * scaleY,
      });
      return;
    }
    const p = pos(e);
    const dx = p.x - dr.start.x,
      dy = p.y - dr.start.y;
    if (Math.abs(dx) + Math.abs(dy) < 1) return;
    const d = clone(dr.base) as Design;
    const obj = d[dr.kind as "rooms"].find((v) => v.id === dr.id)!;
    if (dr.handle === "resize") {
      obj.width = Math.max(30, obj.width + dx);
      obj.height = Math.max(30, obj.height + dy);
      if (obj.points) {
        obj.points = obj.points.map((v: Obj) => ({
          x:
            obj.x +
            ((v.x - obj.x) * obj.width) /
              dr.base.rooms.find((r: Obj) => r.id === obj.id).width,
          y:
            obj.y +
            ((v.y - obj.y) * obj.height) /
              dr.base.rooms.find((r: Obj) => r.id === obj.id).height,
        }));
      }
    } else if (dr.handle === "cov-point") {
      // 手动调整探测范围：拖顶点（坐标是相对传感器的，移动传感器时范围跟着走）
      const pts = Array.isArray(obj.coveragePoints) ? obj.coveragePoints : [];
      if (pts[dr.index]) {
        pts[dr.index] = {
          x: Math.round((Number(pts[dr.index].x) + dx) * 10) / 10,
          y: Math.round((Number(pts[dr.index].y) + dy) * 10) / 10,
        };
        obj.coveragePoints = pts;
      }
    } else if (dr.handle === "point") {
      obj.points = roomPoints(obj);
      obj.points[dr.index].x += dx;
      obj.points[dr.index].y += dy;
      const xs = obj.points.map((v: Obj) => v.x),
        ys = obj.points.map((v: Obj) => v.y);
      obj.x = Math.min(...xs);
      obj.y = Math.min(...ys);
      obj.width = Math.max(...xs) - obj.x;
      obj.height = Math.max(...ys) - obj.y;
      try { Object.assign(obj, withRoomPolygon(obj, obj.points)); }
      catch { return; }
    } else if (dr.handle === "end") {
      obj.x2 += dx;
      obj.y2 += dy;
    } else if (dr.handle === "strip-start" || dr.handle === "strip-end") {
      // 拖灯带两端：改长度与方向，并回写 length（米）。
      const base = stripPoints(obj);
      const pts = base.map((v: Obj) => ({ x: v.x, y: v.y }));
      const idx = dr.handle === "strip-start" ? 0 : pts.length - 1;
      // 拖任一端改长度与角度（灯带可旋转）。
      pts[idx] = { x: pts[idx].x + dx, y: pts[idx].y + dy };
      obj.stripPath = pts;
      if (idx === 0) {
        obj.x = pts[0].x;
        obj.y = pts[0].y;
      }
      // 折线灯带：长度按各段之和（只量首尾弦长会把折线算短）。
      let len = 0;
      for (let i = 1; i < pts.length; i += 1) {
        len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      }
      obj.length = Math.round((len / 26) * 100) / 100;
    } else if (dr.handle === "strip-size") {
      // 灯带光斑大小：沿垂直于灯带（细线）的方向拖动。
      const pts = stripPoints(obj);
      const a = pts[0], b = pts[pts.length - 1];
      const dl = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const sideSign = obj.stripCast === "left" ? -1 : 1;
      const nx = -Math.sin(ang) * sideSign;
      const ny = Math.cos(ang) * sideSign;
      const d = dx * nx + dy * ny;
      const base = Number(obj.spotScale) > 0 ? Number(obj.spotScale) : 1;
      obj.spotScale = Math.min(8, Math.max(0.2, Math.round((base + d / 90) * 100) / 100));
    } else if (dr.handle === "spot-size") {
      // 图上调光斑大小：沿光斑自身长轴方向拖动，换算成「光斑大小 ×」倍数。
      const baseR =
        (isDecorativeLight(obj.type)
          ? decorativeHaloRadiusUnits(obj.type, projectArea)
          : spotRadiusUnits(
              obj.installHeight,
              obj.beamAngle ?? defaultBeamAngle(obj.type),
              projectArea,
            )) || 1;
      const rad = ((Number(obj.spotRotation) || 0) * Math.PI) / 180;
      const along = dx * Math.cos(rad) + dy * Math.sin(rad);
      const cur = Number(obj.spotScale) > 0 ? Number(obj.spotScale) : 1;
      obj.spotScale = Math.min(
        4,
        Math.max(0.2, Math.round((cur + along / baseR) * 100) / 100),
      );
    } else if (dr.handle === "spot-shape" || dr.handle === "spot-rotate") {
      // 图上调光斑：把指针位移换算到光斑自身的旋转坐标系。
      const baseR = spotRadiusUnits(
        obj.installHeight,
        obj.beamAngle ?? defaultBeamAngle(obj.type),
        projectArea,
      );
      const rad = ((Number(obj.spotRotation) || 0) * Math.PI) / 180;
      const lx = dx * Math.cos(rad) + dy * Math.sin(rad);
      const ly = -dx * Math.sin(rad) + dy * Math.cos(rad);
      if (dr.handle === "spot-shape") {
        const sc = Number(obj.spotScale) > 0 ? Number(obj.spotScale) : 1;
        obj.spotRatio = Math.min(5, Math.max(0.2, Math.round((ly / (baseR * sc)) * 1000) / 1000));
      } else {
        const vx = dr.start.x - obj.x + dx;
        const vy = dr.start.y - obj.y + dy;
        const deg = (Math.atan2(vy, vx) * 180) / Math.PI - 180;
        obj.spotRotation = ((Math.round(deg) % 360) + 360) % 360;
      }
    } else if (dr.handle === "furn-point") {
      // 拖家具的多边形顶点（2026-10-16）：只挪这一个点，外接框（x/y/宽深）跟着重算。
      const base = ((dr.base as Obj).furniture || []).find((v: Obj) => v.id === dr.id) as Obj;
      if (!base) return;
      Object.assign(obj, moveFurniturePoint(base, dr.index, dx, dy));
      obj.roomId = d.rooms.find(r => +(r.floor || 1) === +(obj.floor || 1) && containsPoint(r, obj.x, obj.y))?.id || "";
    } else if (typeof dr.handle === "string" && dr.handle.startsWith("furn-")) {
      // 家具边界（2026-10-16）：8 个把手 → 只改宽/深，对面那条边钉住；换算在 furnitureResize.ts。
      const base = ((dr.base as Obj).furniture || []).find((v: Obj) => v.id === dr.id) as Obj;
      if (!base) return;
      const moved = resizeFurniture(base as never, dr.handle.slice(5) as FurnHandle, dx, dy);
      // 画成多边形的家具：宽深变了要一并缩放多边形，否则拖把手对形状不生效。
      Object.assign(obj, hasFurniturePolygon(base)
        ? resizeFurniturePolygon(base, moved.x, moved.y, moved.widthM, moved.depthM)
        : moved);
      obj.roomId = d.rooms.find(r => +(r.floor || 1) === +(obj.floor || 1) && containsPoint(r, obj.x, obj.y))?.id || "";
    } else {
      obj.x += dx;
      obj.y += dy;
      if (dr.kind === "furniture") obj.roomId = d.rooms.find(r => +(r.floor || 1) === +(obj.floor || 1) && containsPoint(r, obj.x, obj.y))?.id || "";
      if (obj.x2 !== undefined) {
        obj.x2 += dx;
        obj.y2 += dy;
      }
      if (obj.points)
        obj.points = obj.points.map((v: Obj) => ({ x: v.x + dx, y: v.y + dy }));
      if (dr.kind === "fixtures" && obj.stripPath)
        obj.stripPath = obj.stripPath.map((v: Obj) => ({ x: v.x + dx, y: v.y + dy }));
      if (dr.kind === "rooms") {
        for (const rows of [d.fixtures, d.devices, d.furniture || []]) {
          rows.filter((f) => f.roomId === obj.id).forEach((f) => {
            f.x += dx; f.y += dy;
            if (f.stripPath) f.stripPath = f.stripPath.map((p: Obj) => ({ x: p.x + dx, y: p.y + dy }));
          });
        }
      }
    }
    onChange?.(d, !dr.moved);
    dr.moved = true;
  }
  const end = () => {
    drag.current = null;
  };
  const cursor = mini
    ? "default"
    : tool === "draw-poly"
      ? "default"
    : tool === "pan"
      ? "grab"
      : tool === "place-lamp" || tool === "place-device" || tool === "draw-strip"
        ? "crosshair"
        : "default";
  // 有底图矩形时把视野收到它上面（留 5% 边），否则沿用固定的 820×690 画布口径。
  const bgPad = backgroundRect ? Math.max(backgroundRect.w, backgroundRect.h) * 0.05 : 0;
  // 没有底图时，视野收到本层空间的外接框（2026-10-17 text：户型只占 820×690 画布左上一角，
  // 灯和编号挤成一团，没法布灯）。没有空间时仍是固定画布。
  const fitBox = (() => {
    if (mini || backgroundRect || background) return null;
    const pts = design.rooms.filter((r) => +(r.floor || 1) === floor).flatMap((r) => roomPoints(r));
    if (pts.length < 3) return null;
    const xs = pts.map((p) => +p.x), ys = pts.map((p) => +p.y);
    const x0 = Math.min(...xs), y0 = Math.min(...ys), w = Math.max(...xs) - x0, h = Math.max(...ys) - y0;
    if (!(w > 20 && h > 20)) return null;
    const pad = Math.max(w, h) * 0.06;
    // 补成与画布同比例（820:690）再居中：画布元素本身按这个比例排版，比例不同会被裁掉一截。
    let bw = w + pad * 2, bh = h + pad * 2;
    if (bw / bh > 820 / 690) bh = bw * 690 / 820; else bw = bh * 820 / 690;
    const cx = x0 + w / 2, cy = y0 + h / 2;
    return [cx - bw / 2, cy - bh / 2, bw, bh].map((v) => Math.round(v * 10) / 10).join(" ");
  })();
  return (
    <svg
      ref={svg}
      className={"floor-plan " + (mini ? "mini-plan" : "")}
      viewBox={
        mini
          ? "35 25 720 640"
          : backgroundRect
            ? [backgroundRect.x - bgPad, backgroundRect.y - bgPad,
               backgroundRect.w + bgPad * 2, backgroundRect.h + bgPad * 2].join(" ")
            : fitBox || "0 0 820 690"
      }
      onDoubleClick={(e) => e.preventDefault()}
      style={{
        cursor,
        touchAction: "none",
        background: night ? "#2a241a" : undefined,
      }}
      onPointerDown={(e) => down(e)}
      onPointerMove={(e) => {
        if (polyDrawing && !readonly) setPolyHover(pos(e));
        if (openingStart) setOpeningHover(pos(e));
      }}
      onPointerLeave={() => setPolyHover(null)}
      aria-label={mini ? "项目户型预览" : "可编辑户型画布"}
    >
      <defs>
        <pattern
          id={mini ? "grid-mini" : "grid"}
          width="20"
          height="20"
          patternUnits="userSpaceOnUse"
        >
          <circle cx="1" cy="1" r=".6" fill={night ? "#4d463c" : "#cccac6"} />
        </pattern>
        {/* 挑空（贯通）填充：斜线，一眼看出楼板是开的 */}
        <pattern
          id={mini ? "void-mini" : "void"}
          width="12"
          height="12"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <line x1="0" y1="0" x2="0" y2="12" stroke={night ? "#83796c" : "#b2aea9"} strokeWidth="3" />
        </pattern>
        <pattern
          id={mini ? "wood-mini" : "wood"}
          width="17"
          height="60"
          patternUnits="userSpaceOnUse"
        >
          <path
            d="M0 0V60M17 0V60M0 30H17"
            stroke="#9c977f"
            strokeWidth=".35"
            opacity=".25"
          />
        </pattern>
        <filter id="lampGlow" x="-200%" y="-200%" width="500%" height="500%">
          <feGaussianBlur stdDeviation="14" />
        </filter>
      </defs>
      {!mini && showGrid && (
        <rect width="100%" height="100%" fill="url(#grid)" />
      )}
      <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
        {background && (
          <>
            <image
              href={background}
              x={backgroundRect ? backgroundRect.x : 25}
              y={backgroundRect ? backgroundRect.y : 25}
              width={backgroundRect ? backgroundRect.w : 750}
              height={backgroundRect ? backgroundRect.h : 610}
              opacity={night ? 0.88 : 1}
              // 矩形就是按这张图的外接框算的，所以直接铺满、不要等比留白
              preserveAspectRatio={backgroundRect ? "none" : "xMidYMid meet"}
            />
            {/* 智能情景：底图压暗成深灰底，暖光才能像参考图那样发出来。 */}
            {night && (
              <rect
                x="0"
                y="0"
                width="820"
                height="690"
                fill="#3a3631"
                opacity="0.66"
                pointerEvents="none"
              />
            )}
            {/* 布灯完成前：底图上罩一层灰色蒙版，点「确定」后消失，只留底图。 */}
            {!night && planMasked && (
              <rect
                x="0"
                y="0"
                width="820"
                height="690"
                fill="#95908a"
                opacity="0.5"
                pointerEvents="none"
              />
            )}
          </>
        )}
        {poly.length > 0 && (
          <g pointerEvents="none">
            <polyline points={poly.map((v) => `${v.x},${v.y}`).join(" ")} fill="none"
              stroke="#c98a2e" strokeWidth="0.8" vectorEffect="non-scaling-stroke" />
            {polyHover && (
              <path d={`M ${poly[poly.length - 1].x} ${poly[poly.length - 1].y} L ${polyHover.x} ${polyHover.y} L ${poly[0].x} ${poly[0].y}`}
                fill="none" stroke="#c98a2e" strokeWidth="0.7" strokeDasharray="3 3"
                vectorEffect="non-scaling-stroke" data-polygon-rubberband="true" />
            )}
            {poly.map((v, i) => (
              <circle key={i} cx={v.x} cy={v.y} r={(i === 0 ? 2 : 1.5) * unitsPerPixel}
                fill={i === 0 ? "#ffffff" : "#c98a2e"} stroke="#c98a2e" strokeWidth="0.6" vectorEffect="non-scaling-stroke" />
            ))}
          </g>
        )}
        {openingStart && (
          <g pointerEvents="none" data-opening-rubberband="true">
            <circle cx={openingStart.x} cy={openingStart.y} r={3 * unitsPerPixel} fill="#287eaa" />
            {openingHover && <line x1={openingStart.x} y1={openingStart.y} x2={openingHover.x} y2={openingHover.y}
              stroke="#287eaa" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeDasharray="4 3" />}
          </g>
        )}
        {drawableRooms.map((r) => {
          const selected = selection?.id === r.id;
          const points = r.points?.map((v: Obj) => `${v.x},${v.y}`).join(" ");
          const color = showSource
            ? r.source === "manual"
              ? "#dedbd4"
              : r.source === "cad"
                ? "#d8e7ef"
                : "#f5e5c7"
            : r.color;
          const isRecognitionRoom = r.source === "semantic-vision" || r.source === "image-analysis";
          // With a base drawing on the canvas every region stays translucent so
          // that drawing remains the primary visual reference.
          const draftOverlay = !!background;
          return (
            <g
              key={r.id}
              data-object-type="room"
              data-object-id={r.id}
              onPointerDown={(e) => down(e, "rooms", r.id)}
              pointerEvents={frozen("rooms") ? "none" : undefined}
              style={{ cursor: mini || frozen("rooms") ? "default" : "move" }}
            >
              {points ? (
                <polygon
                  points={points}
                  fillOpacity={draftOverlay ? 0.055 : 1}
                  fill={night ? "#403b33" : color}
                  stroke={selected ? "#8c6c3c" : "#746e65"}
                  strokeWidth={selected ? 1 : 0.7}
                  vectorEffect="non-scaling-stroke"
                />
              ) : (
                <rect
                  x={r.x}
                  y={r.y}
                  width={r.width}
                  height={r.height}
                  fill={night ? "#403b33" : color}
                  fillOpacity={draftOverlay ? 0.055 : 1}
                  stroke={selected ? "#8c6c3c" : "#746e65"}
                  strokeWidth={selected ? 1 : 0.7}
                  vectorEffect="non-scaling-stroke"
                />
              )}
              {!points && (
                <rect
                  x={r.x + 3}
                  y={r.y + 3}
                  width={r.width - 6}
                  height={r.height - 6}
                  fill={`url(#${mini ? "wood-mini" : "wood"})`}
                  pointerEvents="none"
                />
              )}
              {isVoidRoom(r) && (
                <>
                  <rect
                    data-void="1"
                    x={r.x + 3}
                    y={r.y + 3}
                    width={Math.max(0, r.width - 6)}
                    height={Math.max(0, r.height - 6)}
                    fill={`url(#${mini ? "void-mini" : "void"})`}
                    pointerEvents="none"
                  />
                  <rect
                    x={r.x + 3}
                    y={r.y + 3}
                    width={Math.max(0, r.width - 6)}
                    height={Math.max(0, r.height - 6)}
                    fill="none"
                    stroke={night ? "#aea699" : "#8e8270"}
                    strokeDasharray="6 4"
                    strokeWidth="2"
                    pointerEvents="none"
                  />
                  <text
                    x={r.x + r.width / 2}
                    y={r.y + (mini ? 18 : 22)}
                    textAnchor="middle"
                    fontSize={mini ? 10 : 11}
                    fill={night ? "#c6bfb3" : "#665d50"}
                    pointerEvents="none"
                  >
                    {voidLabel(r)}
                  </text>
                </>
              )}
              {showFurniture && !Array.isArray(design.furniture) && !isRecognitionRoom && r.width > 120 && r.height > 140 && (
                <Furniture room={r} night={night} />
              )}
              <text
                x={r.x + r.width / 2}
                y={r.y + r.height - (mini ? 13 : 17)}
                textAnchor="middle"
                fontSize={mini ? 12 : 13}
                fill={night ? "#cac6c0" : "#666057"}
                pointerEvents="none"
              >
                {r.name}
                {!mini && (r.area > 0 ? ` · ${r.area} m²` : " · 面积待校核")}
              </text>
              {showSource && (
                <text x={r.x + 8} y={r.y + 19} fontSize="10" fill="#706659">
                  {r.source === "manual"
                    ? "人工修正"
                    : r.source === "cad"
                      ? "CAD 解析"
                    : isRecognitionRoom ? "AI 空间草稿" : "示例 / 模拟"}
                </text>
              )}
              {selected && !mini && !readonly && editableRooms && ["select", "add-room-point", "delete-room-point"].includes(tool) && (
                <>
                  {!r.points?.length && (
                    <rect x={r.x + r.width - 2 * unitsPerPixel} y={r.y + r.height - 2 * unitsPerPixel}
                      width={4 * unitsPerPixel} height={4 * unitsPerPixel} fill="white" stroke="#88693a"
                      strokeWidth="0.7" vectorEffect="non-scaling-stroke" style={{ cursor: "nwse-resize" }}
                      onPointerDown={(e) => down(e, "rooms", r.id, "resize")} />
                  )}
                  {tool === "add-room-point" && roomPoints(r).map((v, i, pts) => (
                    <line key={`edge-${i}`} data-room-edge={i}
                      x1={v.x} y1={v.y} x2={pts[(i+1)%pts.length].x} y2={pts[(i+1)%pts.length].y}
                      stroke="transparent" strokeWidth="12" vectorEffect="non-scaling-stroke"
                      onPointerDown={(e) => down(e, "rooms", r.id, "edge", i)} />
                  ))}
                  {roomPoints(r).map((v: Obj, i: number) => (
                    <g key={i} data-room-vertex={i} style={{ cursor: "default" }} onPointerDown={(e) => down(e, "rooms", r.id, "point", i)}>
                      <circle cx={v.x} cy={v.y} r={6 * unitsPerPixel} fill="transparent" stroke="none" />
                      <circle cx={v.x} cy={v.y} r={2 * unitsPerPixel} fill="white" stroke="#88693a"
                        strokeWidth="0.7" vectorEffect="non-scaling-stroke" />
                    </g>
                  ))}
                </>
              )}
            </g>
          );
        })}
        {showCanonicalFurniture && (design.furniture || []).filter(f => +(f.floor || 1) === floor).map(raw => {
          // 规范形态：有轮廓的件 x/y＝轮廓外接框中心（破了这条不变量的老数据在这里被扶正）
          const f = normalizeFurniture(raw);
          const width = +f.widthM * 26, depth = +f.depthM * 26, selected = selectedFurnitureId === f.id;
          // 画过多边形就按多边形画（点存世界坐标，不叠 rotate）；没画过仍是可改宽深的矩形。
          const poly = hasFurniturePolygon(f) ? furniturePoints(f) : null;
          return <g key={f.id} data-object-type="furniture" data-object-id={f.id}
            transform={poly ? undefined : `translate(${f.x} ${f.y}) rotate(${f.rotation || 0})`}
            pointerEvents={frozen("furniture") ? "none" : undefined}
            // 2026-10-16：画布上家具一律锁定——只有灯具与设备可挪动。俯视图里灯具
            // 压在家具上，随手一拖就把家具拖走了。editableFurniture 只在「调整家具」与
            // 「导入图纸 → 家具」这两处为真，别处点得中、拖不动。
            style={{ cursor: readonly || !editableFurniture ? "default" : "move" }} onPointerDown={e => {
              if (tool !== "select") { down(e); return; }
              e.stopPropagation(); onFurnitureSelect?.(f.id);
              if (readonly || !editableFurniture) return;
              drag.current = { kind: "furniture", id: f.id, start: pos(e), base: clone(design), moved: false };
              capture(e.pointerId);
            }}>
            {poly ? (
              <polygon data-furn-polygon="1" points={poly.map((v: Obj) => `${v.x},${v.y}`).join(" ")}
                fill={selected ? "#e7c89f" : "#d9cbb6"} fillOpacity=".85" stroke={selected ? "#ad6c25" : "#9a856a"}
                strokeWidth={selected ? 1.5 : .7} vectorEffect="non-scaling-stroke" />
            ) : (
              <rect x={-width / 2} y={-depth / 2} width={width} height={depth} rx={Math.min(3, width / 10)}
                fill={selected ? "#e7c89f" : "#d9cbb6"} fillOpacity=".85" stroke={selected ? "#ad6c25" : "#9a856a"}
                strokeWidth={selected ? 1.5 : .7} vectorEffect="non-scaling-stroke" />
            )}
            {!poly && <path d={`M ${-width * .4} ${-depth * .35} H ${width * .4}`} stroke="#8e785c" strokeWidth="2" vectorEffect="non-scaling-stroke" />}
            <text x={poly ? f.x : 0} y={poly ? f.y : 0} textAnchor="middle" dominantBaseline="central"
              fontSize={Math.max(6, Math.min(10, width / 5))} fill="#5e503d" pointerEvents="none">{f.kind}</text>
            {selected && !readonly && editableFurniture && !mini && tool === "select" && !poly && FURN_HANDLES.map(({ handle, su, sv }) => (
              <g key={handle} data-furn-handle={handle}
                style={{ cursor: su && sv ? "nwse-resize" : su ? "ew-resize" : "ns-resize" }}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  onFurnitureSelect?.(f.id);
                  drag.current = { kind: "furniture", id: f.id, start: pos(e), base: clone(design),
                    handle: `furn-${handle}`, moved: false };
                  capture(e.pointerId);
                }}>
                {/* 透明大块＝好抓；中间小方块＝看得见 */}
                <rect x={(su * width) / 2 - 6 * unitsPerPixel} y={(sv * depth) / 2 - 6 * unitsPerPixel}
                  width={12 * unitsPerPixel} height={12 * unitsPerPixel} fill="transparent" stroke="none" />
                <rect x={(su * width) / 2 - 2 * unitsPerPixel} y={(sv * depth) / 2 - 2 * unitsPerPixel}
                  width={4 * unitsPerPixel} height={4 * unitsPerPixel} fill="white" stroke="#ad6c25"
                  strokeWidth="0.9" vectorEffect="non-scaling-stroke" />
              </g>
            ))}
          </g>;
        })}
        {showCanonicalFurniture && (() => {
          const f = (design.furniture || []).find((v: Obj) => v.id === selectedFurnitureId && +(v.floor || 1) === floor);
          if (!f || !editableFurniture || readonly || mini) return null;
          if (!["select", "add-furn-point", "delete-furn-point"].includes(tool)) return null;
          const pts = furniturePoints(f);
          return <g data-furn-edit-overlay={f.id}>
            {tool === "add-furn-point" && pts.map((v: Obj, i: number) => {
              const b = pts[(i + 1) % pts.length];
              return <line key={`fe-${i}`} data-furn-edge={i} x1={v.x} y1={v.y} x2={b.x} y2={b.y}
                stroke="transparent" strokeWidth="12" vectorEffect="non-scaling-stroke"
                onPointerDown={(e) => down(e, "furniture", f.id, "edge", i)} />;
            })}
            {pts.map((v: Obj, i: number) => (
              <g key={`fv-${i}`} data-furn-vertex={i} style={{ cursor: "default" }}
                onPointerDown={(e) => down(e, "furniture", f.id, "furn-point", i)}>
                <circle cx={v.x} cy={v.y} r={6 * unitsPerPixel} fill="transparent" stroke="none" />
                <circle cx={v.x} cy={v.y} r={2 * unitsPerPixel} fill="white" stroke="#ad6c25"
                  strokeWidth="0.7" vectorEffect="non-scaling-stroke" />
              </g>
            ))}
          </g>;
        })()}
        {showStructureLayer && design.walls
          .filter((w) => w.floor === floor && !w.openingId)
          .map((w) => (
            <g
              key={w.id}
              data-object-type="wall"
              data-object-id={w.id}
              onPointerDown={(e) => down(e, "walls", w.id)}
              pointerEvents={frozen("walls") ? "none" : undefined}
              style={{ cursor: "move" }}
            >
              <line
                x1={w.x}
                y1={w.y}
                x2={w.x2}
                y2={w.y2}
                stroke="transparent"
                strokeWidth="18"
              />
              <line
                x1={w.x}
                y1={w.y}
                x2={w.x2}
                y2={w.y2}
                stroke={selection?.id === w.id ? "#a68047" : "#655e53"}
                strokeWidth="5"
              />
              {selection?.id === w.id && !readonly && (
                <circle
                  cx={w.x2}
                  cy={w.y2}
                  r="6"
                  fill="white"
                  stroke="#88693a"
                  onPointerDown={(e) => down(e, "walls", w.id, "end")}
                />
              )}
            </g>
          ))}
        {(showStructureLayer || showOpeningLayer) && design.openings
          .filter((o) => o.floor === floor && (showStructureLayer || (o.source === "manual" && o.roomId)))
          .map((o) => (
            <g
              key={o.id}
              data-object-type="opening"
              data-object-id={o.id}
              transform={`translate(${o.x} ${o.y}) rotate(${o.rotation || 0})`}
              onPointerDown={(e) => down(e, "openings", o.id)}
              pointerEvents={frozen("openings") ? "none" : undefined}
              style={{ cursor: frozen("openings") ? "default" : "move" }}
            >
              <rect
                x="-4"
                y="-8"
                width={o.width + 8}
                height="16"
                fill="transparent"
              />
              <path
                d={`M0 0H${o.width}`}
                stroke={
                  selection?.id === o.id
                    ? "#a47f46"
                    : o.type === "门"
                      ? "#b19776"
                      : "#948b7d"
                }
                strokeWidth="6"
              />
              {o.type === "门" ? (
                <path
                  d={`M0 0V${-o.width} A${o.width} ${o.width} 0 0 1 ${o.width} 0`}
                  fill="none"
                  stroke="#a79071"
                  strokeWidth="1.2"
                />
              ) : (
                <path
                  d={`M0 -4H${o.width}M0 4H${o.width}`}
                  stroke="#86b4ba"
                  strokeWidth="1"
                />
              )}
            </g>
          ))}
        {showStructureLayer && design.texts.map((t) => (
          <text
            key={t.id}
            x={t.x}
            y={t.y}
            fontSize="10"
            fill="#787065"
            pointerEvents="none"
          >
            {t.text}
          </text>
        ))}
        {showLights &&
          showFixtureLayer &&
          fixtures.map((f) => {
            const st = sceneStates[f.id];
            const lit = night && st?.on;
            // 光斑：半角光束角理论值换算到画布单位；被选中的灯即使没开情景也画，方便调光束角时对比。
            const beam = f.beamAngle ?? defaultBeamAngle(f.type);
            // 装饰型灯具（吊灯/吸顶灯/壁灯/落地灯/台灯/镜前灯）不做定向照射：光斑只是画法上的
            // 「光晕」，基准按类型取（不涉及光束角/安装高度），大小同样可用「光斑大小 ×」调。
            const decorative = isDecorativeLight(f.type);
            const baseSpotRadius = decorative
              ? decorativeHaloRadiusUnits(f.type, projectArea)
              : spotRadiusUnits(f.installHeight, beam, projectArea);
            // 图上可调：缩放（大小）、长短轴比（形状）、旋转（朝向），存在灯具上，随项目保存。
            const spotRatio = Number(f.spotRatio) > 0 ? Number(f.spotRatio) : 1;
            // 光斑大小：定向＝理论外径（安装高度 × 光束角），装饰＝类型光晕基准；再乘「光斑大小 ×」（默认 1）。
            // 两种都可放大 / 缩小，也可在图上直接拖光斑边缘的橙色圆点。
            const spotScale = Number(f.spotScale) > 0 ? Number(f.spotScale) : 1;
            const spotRadius = baseSpotRadius * spotScale;
            // 放置灯具时只留灯具图标、不铺光斑（2026-10-16：「放置灯具的时候不需要有光斑体现，
             // 但需要有灯具图标，方便移动」）——图标本来就画在光斑之上，去掉光斑就不挡它了。
            const showSpot = !mini && tool !== "place-lamp"
              && f.type !== "灯带" && f.type !== "窗帘" && (lit || selection?.id === f.id);
            const spotEditing = !mini && !!onChange && selection?.id === f.id;
            // 暖黄发光：中心最亮，向外漫射衰减，随亮度层层加深。
            const spotColour = fixtureLightColour(f, st?.cct ?? 3000);
            // 编辑时（底图选中、未开情景）光斑要明显；夜间情景走 screen 加法发光。
            // 调整光斑大小时（底图选中）亮度按 100% 显示。
            const spotStrength = lit ? 0.5 + 0.34 * (st!.brightness / 100) : 0.84;
            // 光斑不穿墙、门、高柜（2026-10-17）：从灯位打射线裁出看得见的范围，只在里面画。
            const spotClip = showSpot ? lightPoolClipPath(design, f, spotRadius * Math.max(1, spotRatio) * 1.02) : null;
            return (
              <g
                key={f.id}
                data-object-type="fixture"
                data-object-id={f.id}
                onPointerDown={(e) => down(e, "fixtures", f.id)}
                style={{ cursor: mini ? "default" : "move" }}
              >
                {showSpot && (
                  <>
                    {/* 光斑表现：暖黄发光光池，中心最亮 → 中晕 → 外层漫射；三层叠加出明暗层次，
                        全部径向渐隐、边缘模糊无硬边，像面状光晕铺洒在地面。 */}
                    {spotClip && <clipPath id={`spot-clip-${f.id}`} clipPathUnits="userSpaceOnUse">
                      <path d={spotClip} />
                    </clipPath>}
                    <g clipPath={spotClip ? `url(#spot-clip-${f.id})` : undefined} pointerEvents="none" data-spot-clipped={spotClip ? "1" : undefined}>
                    <g
                    pointerEvents="none"
                    style={night ? { mixBlendMode: "screen" } : undefined}
                    transform={`translate(${f.x} ${f.y}) scale(1 ${spotRatio})`}
                  >
                    <defs>
                      <radialGradient id={`spot-core-${f.id}`} cx="50%" cy="50%" r="50%">
                        <stop offset="0%" stopColor={spotColour} stopOpacity={spotStrength} />
                        <stop offset="40%" stopColor={spotColour} stopOpacity={spotStrength * 0.62} />
                        <stop offset="75%" stopColor={spotColour} stopOpacity={spotStrength * 0.2} />
                        <stop offset="100%" stopColor={spotColour} stopOpacity="0" />
                      </radialGradient>
                      <radialGradient id={`spot-mid-${f.id}`} cx="50%" cy="50%" r="50%">
                        <stop offset="0%" stopColor={spotColour} stopOpacity={spotStrength * 0.55} />
                        <stop offset="50%" stopColor={spotColour} stopOpacity={spotStrength * 0.4} />
                        <stop offset="78%" stopColor={spotColour} stopOpacity={spotStrength * 0.18} />
                        <stop offset="92%" stopColor={spotColour} stopOpacity={spotStrength * 0.06} />
                        <stop offset="100%" stopColor={spotColour} stopOpacity="0" />
                      </radialGradient>
                      <radialGradient id={`spot-wash-${f.id}`} cx="50%" cy="50%" r="50%">
                        <stop offset="0%" stopColor={spotColour} stopOpacity={spotStrength * 0.3} />
                        <stop offset="55%" stopColor={spotColour} stopOpacity={spotStrength * 0.19} />
                        <stop offset="85%" stopColor={spotColour} stopOpacity={spotStrength * 0.07} />
                        <stop offset="100%" stopColor={spotColour} stopOpacity="0" />
                      </radialGradient>
                    </defs>
                    {/* 外径＝标称光斑直径（标签与手柄读的就是这个外径），中心不单独变大。 */}
                    <circle cx={0} cy={0} r={spotRadius} fill={`url(#spot-wash-${f.id})`} />
                    <circle cx={0} cy={0} r={spotRadius * 0.85} fill={`url(#spot-mid-${f.id})`} />
                    <circle cx={0} cy={0} r={spotRadius * 0.5} fill={`url(#spot-core-${f.id})`} />
                    {/* 光束角数值改在画布外的固定读数（.canvas-lamp-badge）显示，
                        不随缩放/平移变化；这里只保留光斑本身。 */}
                  </g>
                  </g>
                  {spotEditing && (
                    // 选中该灯时用虚线标出地面光斑外径，右端橙色圆点可直接拖大 / 拖小（＝「光斑大小 ×」）：
                    // 外径 = 2 × 安装高度 × tan(光束角 ÷ 2) × 光斑大小倍数。
                    <g
                      transform={`translate(${f.x} ${f.y}) scale(1 ${spotRatio})`}
                      pointerEvents="none"
                    >
                      <circle cx={0} cy={0} r={spotRadius} fill="none" stroke="#c98a2e" strokeWidth="1.2" strokeDasharray="5 4" opacity="0.9" />
                      <line x1={0} y1={0} x2={spotRadius} y2={0} stroke="#c98a2e" strokeWidth="1" strokeDasharray="4 4" opacity="0.8" />
                      {!mini && (
                        <circle
                          cx={spotRadius}
                          cy={0}
                          r={7}
                          fill="#ffffff"
                          stroke="#c98a2e"
                          strokeWidth="2.5"
                          style={{ cursor: "ew-resize", pointerEvents: "auto" }}
                          onPointerDown={(e) => {
                            e.stopPropagation();
                            down(e, "fixtures", f.id, "spot-size");
                          }}
                        />
                      )}
                    </g>
                  )}
                  </>
                )}
                {lit && f.type !== "灯带" && f.type !== "窗帘" && (
                  <circle
                    cx={f.x}
                    cy={f.y}
                    r={18 + st.brightness * 0.3}
                    fill={fixtureGlowColour(f, st.cct)}
                    opacity={st.brightness / 115}
                    filter="url(#lampGlow)"
                    pointerEvents="none"
                  />
                )}
                {f.type === "窗帘" ? (
                  <>
                    {(() => {
                      const path = stripPoints(f);
                      const p0 = path[0];
                      const p1 = path[path.length - 1];
                      const len = Math.max(12, Math.hypot(p1.x - p0.x, p1.y - p0.y));
                      const ang =
                        (Math.atan2(p1.y - p0.y, p1.x - p0.x) * 180) / Math.PI;
                      const mx = (p0.x + p1.x) / 2;
                      const my = (p0.y + p1.y) / 2;
                      // 窗帘＝矩形条块：细线外框 + 内部色块进度条（单电机单向 / 双电机双向）。
                      const T = 12;
                      // 开度 0-100：0＝全闭（帘布铺满），100＝全开（收拢到电机端）。
                      const open = lit ? (st?.brightness ?? 100) : 0;
                      const fabric = Math.max(
                        0.04,
                        1 - Math.min(100, Math.max(0, open)) / 100,
                      );
                      const dual = f.curtainMotor === "双电机";
                      const left = -len / 2;
                      const half = len / 2;
                      const edge = night ? "#6f6247" : "#a99b83";
                      const cloth = night ? "#c9a86a" : "#b08a4f";
                      const fold = night ? "#8d7746" : "#87683a";
                      const foldW = 3;
                      return (
                        <g transform={`translate(${mx} ${my}) rotate(${ang})`}>
                          <rect
                            x={left}
                            y={-T / 2}
                            width={len}
                            height={T}
                            fill="none"
                            stroke={edge}
                            strokeWidth={1}
                            pointerEvents="none"
                          />
                          <g pointerEvents="none">
                            {dual ? (
                              <>
                                <rect x={left} y={-T / 2 + 1} width={half * fabric} height={T - 2} fill={cloth} opacity={0.52} />
                                <rect x={half - half * fabric} y={-T / 2 + 1} width={half * fabric} height={T - 2} fill={cloth} opacity={0.52} />
                                <rect x={left + half * fabric - foldW} y={-T / 2 + 1} width={foldW} height={T - 2} fill={fold} opacity={0.85} />
                                <rect x={half - half * fabric} y={-T / 2 + 1} width={foldW} height={T - 2} fill={fold} opacity={0.85} />
                              </>
                            ) : (
                              <>
                                <rect x={left} y={-T / 2 + 1} width={len * fabric} height={T - 2} fill={cloth} opacity={0.52} />
                                <rect x={left + len * fabric - foldW} y={-T / 2 + 1} width={foldW} height={T - 2} fill={fold} opacity={0.85} />
                              </>
                            )}
                          </g>
                          {/* 透明命中块：让窗帘可以点选、可以整体拖动 */}
                          <rect
                            x={left}
                            y={-T / 2}
                            width={len}
                            height={T}
                            fill="none"
                            pointerEvents="all"
                          />
                        </g>
                      );
                    })()}
                    {!mini && !readonly && selection?.id === f.id && (
                      <g>
                        <circle
                          cx={stripPoints(f)[0].x}
                          cy={stripPoints(f)[0].y}
                          r={8}
                          fill="#ffffff"
                          stroke="#a68047"
                          strokeWidth="2.5"
                          style={{ cursor: "crosshair" }}
                          onPointerDown={(e) => down(e, "fixtures", f.id, "strip-start")}
                        />
                        <circle
                          cx={stripPoints(f)[stripPoints(f).length - 1].x}
                          cy={stripPoints(f)[stripPoints(f).length - 1].y}
                          r={8}
                          fill="#ffffff"
                          stroke="#c98a2e"
                          strokeWidth="2.5"
                          style={{ cursor: "crosshair" }}
                          onPointerDown={(e) => down(e, "fixtures", f.id, "strip-end")}
                        />
                      </g>
                    )}
                  </>
                ) : f.type === "灯带" ? (
                  <>
                    {(() => {
                      const path = stripPoints(f);
                      const points = path.map((v: Obj) => `${v.x},${v.y}`).join(" ");
                      // 灯带本体＝细线；光线＝单侧「浅色反光」叠在邻近家具/墙面上（洗墙/柜）。
                      const barOn = !mini && (lit || selection?.id === f.id);
                      const reflectColour = fixtureReflectColour(f, st?.cct ?? 3000);
                      // 编辑时（底图选中、未开情景）反光要明显；夜间情景走 screen 加法。
                      // 调整光斑大小时亮度按 100% 显示。
                      const reflectStrength = lit ? 0.3 + 0.28 * (st!.brightness / 100) : 0.58;
                      // 光斑大小（反光洗墙宽度）可调：默认 90 画布单位 ×「光斑大小 ×」。
                      const reflectWidth = 90 * (Number(f.spotScale) > 0 ? Number(f.spotScale) : 1);
                      const castRight = f.stripCast !== "left";
                      return <>
                        {barOn && path.slice(0, -1).map((p, i) => {
                          const q = path[i + 1];
                          const len = Math.max(1, Math.hypot(q.x - p.x, q.y - p.y));
                          const ang = (Math.atan2(q.y - p.y, q.x - p.x) * 180) / Math.PI;
                          const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
                          // 反光在灯带一侧：贴近灯带处最亮，向外洗墙方向渐渐淡出。
                          const yTop = castRight ? 4 : -(reflectWidth + 4);
                          const y1 = castRight ? "0" : "1";
                          const y2 = castRight ? "1" : "0";
                          return (
                            <g
                              key={"refl" + i}
                              pointerEvents="none"
                              style={night ? { mixBlendMode: "screen" } : undefined}
                              transform={`translate(${mx} ${my}) rotate(${ang})`}
                            >
                              <defs>
                                <linearGradient id={`reflect-${f.id}-${i}`} x1="0" y1={y1} x2="0" y2={y2}>
                                  <stop offset="0%" stopColor={reflectColour} stopOpacity={reflectStrength} />
                                  <stop offset="100%" stopColor={reflectColour} stopOpacity="0" />
                                </linearGradient>
                                <linearGradient id={`reflectend-${f.id}-${i}`} x1="0" y1="0" x2="1" y2="0">
                                  <stop offset="0%" stopColor="#000000" />
                                  <stop offset="2%" stopColor="#ffffff" />
                                  <stop offset="98%" stopColor="#ffffff" />
                                  <stop offset="100%" stopColor="#000000" />
                                </linearGradient>
                                <mask id={`reflectmask-${f.id}-${i}`} maskUnits="userSpaceOnUse" x={-len / 2} y={-reflectWidth - 6} width={len} height={2 * reflectWidth + 12}>
                                  <rect x={-len / 2} y={-reflectWidth - 6} width={len} height={2 * reflectWidth + 12} fill={`url(#reflectend-${f.id}-${i})`} />
                                </mask>
                              </defs>
                              <rect x={-len / 2} y={yTop} width={len} height={reflectWidth} fill={`url(#reflect-${f.id}-${i})`} mask={`url(#reflectmask-${f.id}-${i})`} />
                            </g>
                          );
                        })}
                        <polyline points={points} fill="none" stroke={selection?.id === f.id ? "#88693a" : "#d8a75b"} strokeWidth={mini ? 2 : 3} strokeLinecap="round" />
                        {path.map((v: Obj, i: number) => <circle key={i} cx={v.x} cy={v.y} r={mini ? 2 : 3} fill="#fff8d6" stroke="#a4824b" />)}
                        {spotEditing && (
                          // 两端＝长度；中间绿色手柄＝光斑大小，水平拖动（左/右），不是上/下空间方向。
                          <>
                            <circle cx={path[0].x} cy={path[0].y} r={8} fill="#ffffff" stroke="#a68047" strokeWidth="2.5" style={{ cursor: "crosshair" }} onPointerDown={(e) => { e.stopPropagation(); down(e, "fixtures", f.id, "strip-start"); }} />
                            <circle cx={path[path.length - 1].x} cy={path[path.length - 1].y} r={8} fill="#ffffff" stroke="#c98a2e" strokeWidth="2.5" style={{ cursor: "crosshair" }} onPointerDown={(e) => { e.stopPropagation(); down(e, "fixtures", f.id, "strip-end"); }} />
                            {(() => {
                              const p0 = path[0], p1 = path[path.length - 1];
                              const mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2;
                              const dl = Math.hypot(p1.x - p0.x, p1.y - p0.y) || 1;
                              const ang = Math.atan2(p1.y - p0.y, p1.x - p0.x);
                              const sideSign = castRight ? 1 : -1;
                              const ox = -Math.sin(ang) * sideSign, oy = Math.cos(ang) * sideSign;
                              const off = 90 * (Number(f.spotScale) > 0 ? Number(f.spotScale) : 1);
                              const hx = mx + ox * off, hy = my + oy * off;
                              return (
                                <g>
                                  <line x1={mx} y1={my} x2={hx} y2={hy} stroke="#a68047" strokeWidth="1" strokeDasharray="4 3" opacity="0.7" />
                                  <circle cx={hx} cy={hy} r={7} fill="#ffffff" stroke="#a68047" strokeWidth="2.5" style={{ cursor: "ns-resize" }} onPointerDown={(e) => { e.stopPropagation(); down(e, "fixtures", f.id, "strip-size"); }} />
                                </g>
                              );
                            })()}
                            {(() => {
                              const p0 = path[0], p1 = path[path.length - 1];
                              const dl = Math.hypot(p1.x - p0.x, p1.y - p0.y) || 1;
                              const ang = Math.atan2(p1.y - p0.y, p1.x - p0.x);
                              const sideSign = castRight ? -1 : 1;
                              const ox = -Math.sin(ang) * sideSign, oy = Math.cos(ang) * sideSign;
                              const mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2;
                              const dx2 = ox * 34, dy2 = oy * 34;
                              return (
                                <g>
                                  <line x1={mx} y1={my} x2={mx + dx2} y2={my + dy2} stroke="#a68047" strokeWidth="1" strokeDasharray="3 4" opacity="0.7" />
                                  <rect x={mx + dx2 - 6} y={my + dy2 - 6} width={12} height={12} rx={2} fill="#ffffff" stroke="#a68047" strokeWidth="2.5" style={{ cursor: "pointer" }} onPointerDown={(e) => down(e, "fixtures", f.id, "strip-cast")} />
                                </g>
                              );
                            })()}
                          </>
                        )}
                      </>;
                    })()}
                  </>
                ) : (
                  <>
                    {selection?.id === f.id && <circle cx={f.x} cy={f.y} r="13" fill="none" stroke="#88693a" strokeWidth="2" />}
                    <circle cx={f.x} cy={f.y} r={mini ? 4 : 6} fill={night && !lit ? "#69635a" : isColourFixture(f) ? fixtureHex(f) : "#e8bc73"} stroke={night ? "#d7b680" : isColourFixture(f) ? fixtureHex(f) : "#a4824b"} strokeWidth="1.3" />
                    <circle cx={f.x} cy={f.y} r="2" fill="#fff8d6" />
                  </>
                )}
                {!mini && showLabels && (
                  <text
                    x={f.type === "窗帘" ? f.x : f.x + 10}
                    y={f.type === "窗帘" ? f.y - 11 : f.y + 4}
                    fontSize="9"
                    fill={night ? "#c9c5be" : "#8c877f"}
                    pointerEvents="none"
                  >
                    {f.code}
                  </text>
                )}
              </g>
            );
          })}
        {/* 漫游时传感器范围圈不属于「设备层」：关掉设备层也照样画，
            否则会以为漫游坏了（看不见探测圈、也不知道小人在走哪个传感器）。 */}
        {!mini &&
          !showDeviceLayer &&
          (roamArmed || roam) &&
          design.devices
            .filter(
              (dev: Obj) =>
                dev.type === "传感器" &&
                Number(dev.range) > 0 &&
                (Number.isFinite(dev.floor)
                  ? dev.floor
                  : design.rooms.find((r: Obj) => r.id === dev.roomId)?.floor ?? 1) === floor,
            )
            .map((dev: Obj) => {
              const room = design.rooms.find((r: Obj) => r.id === dev.roomId);
              const dx = dev.x != null ? Number(dev.x) : room ? room.x + room.width / 2 : 0;
              const dy = dev.y != null ? Number(dev.y) : room ? room.y + room.height / 2 : 0;
              // 有空间边界/墙体时画裁剪后的范围；否则设了视场角画扇形、没设画整圆。
              const clip = coveragePath(dev, obstaclesFor(dev, coverageCtx));
              const ring = clip || sensorSectorPath(dev);
              const ringStyle = {
                fill: "#a68047",
                fillOpacity: 0.06,
                stroke: "#a68047",
                strokeOpacity: 0.5,
                strokeDasharray: "4 4",
                strokeWidth: 1,
                pointerEvents: "none" as const,
              };
              return ring ? (
                <path
                  key={"ring-" + dev.id}
                  d={ring}
                  transform={`translate(${dx} ${dy})`}
                  {...ringStyle}
                />
              ) : (
                <circle
                  key={"ring-" + dev.id}
                  cx={dx}
                  cy={dy}
                  r={Number(dev.range)}
                  {...ringStyle}
                />
              );
            })}
        {!mini &&
          showDeviceLayer &&
          design.devices
            // 设备/面板按楼层显示：优先自身的 floor，老数据回退到所属空间的楼层。
            .filter(
              (dev: Obj) =>
                (Number.isFinite(dev.floor)
                  ? dev.floor
                  : design.rooms.find((r: Obj) => r.id === dev.roomId)?.floor ?? 1) === floor,
            )
            .map((dev: Obj) => {
            const room = design.rooms.find((r: Obj) => r.id === dev.roomId);
            const dx = dev.x != null ? Number(dev.x) : room ? room.x + room.width / 2 : 0;
            const dy = dev.y != null ? Number(dev.y) : room ? room.y + room.height / 2 : 0;
            const sel = selection?.id === dev.id;
            const color =
              dev.type === "传感器"
                ? "#a68047"
                : dev.type === "窗帘"
                  ? "#8b6f4a"
                  : dev.type === "面板"
                    ? "#4a6f8b"
                    : "#8b7f5f";
            // 与灯具重叠的设备：**只把标签错开**，标记本体永远钉在真实坐标上——
            // 挪标记会在松手时因为重叠判定翻转而“跳一下”，缩放时错位量还会跟着放大，
            // 看起来就像“放好的面板自己又挪了地方”。标签错开 + 引线已经足够分清谁是谁。
            const clash = fixturePoints.some(
              (p) => Math.hypot(p.x - dx, p.y - dy) < 18,
            );
            const ox = clash ? 22 : 0;
            const oy = clash ? -18 : 0;
            const isPanel = dev.type === "面板";
            // 探测范围：整圆或扇形（视场角 < 360°）
            const rangeRing =
              dev.type === "传感器" && Number(dev.range) > 0
                ? coveragePath(dev, obstaclesFor(dev, coverageCtx)) || sensorSectorPath(dev)
                : null;
            return (
              <g
                key={dev.id}
                data-object-type="device"
                data-object-id={dev.id}
                transform={`translate(${dx} ${dy})`}
                onPointerDown={(e) => down(e, "devices", dev.id)}
                style={{ cursor: "move" }}
              >
                {dev.type === "传感器" &&
                  Number(dev.range) > 0 &&
                  (rangeRing ? (
                    <path
                      d={rangeRing}
                      fill="#a68047"
                      fillOpacity="0.06"
                      stroke="#a68047"
                      strokeOpacity="0.5"
                      strokeDasharray="4 4"
                      strokeWidth="1"
                      pointerEvents="none"
                    />
                  ) : (
                    <circle
                      cx={0}
                      cy={0}
                      r={Number(dev.range)}
                      fill="#a68047"
                      fillOpacity="0.06"
                      stroke="#a68047"
                      strokeOpacity="0.5"
                      strokeDasharray="4 4"
                      strokeWidth="1"
                      pointerEvents="none"
                    />
                  ))}
                {coverageEdit === dev.id &&
                  (manualCoverage(dev) || []).map((p: Obj, i: number) => {
                    const picked = coveragePointSel === i;
                    return (
                      <circle
                        key={`cov-${i}`}
                        data-cov-point={i}
                        data-cov-picked={picked ? "1" : "0"}
                        cx={Number(p.x)}
                        cy={Number(p.y)}
                        r={picked ? 9 : 6}
                        fill={picked ? "#a68047" : "#ffffff"}
                        stroke={picked ? "#ffffff" : "#a68047"}
                        strokeWidth="2.5"
                        style={{ cursor: "crosshair" }}
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          // 先选中（面板上就能定向删这个点），再进入拖拽
                          onCoveragePointSelect?.(i);
                          down(e, "devices", dev.id, "cov-point", i);
                        }}
                      />
                    );
                  })}
                {clash && (
                  <line
                    x1={0}
                    y1={0}
                    x2={ox}
                    y2={oy}
                    stroke="#4a6f8b"
                    strokeWidth="1"
                    strokeDasharray="3 2"
                    opacity="0.75"
                    pointerEvents="none"
                  />
                )}
                {/* 标记本体永远钉在真实坐标上（不错位）：松手不会跳、缩放也不会看着漂 */}
                <g data-device-marker="1">
                  {sel && (
                    <circle cx={0} cy={0} r="15" fill="none" stroke="#88693a" strokeWidth="2" />
                  )}
                  {isPanel ? (
                    // 面板＝圆角方章，和灯具的圆点一眼分得开；标出按键数。
                    <>
                      <rect
                        x={-9}
                        y={-9}
                        width={18}
                        height={18}
                        rx={5}
                        fill="#ffffff"
                        opacity="0.92"
                      />
                      <rect
                        x={-9}
                        y={-9}
                        width={18}
                        height={18}
                        rx={5}
                        fill="none"
                        stroke={color}
                        strokeWidth="2.4"
                      />
                      <text
                        x={0}
                        y={3.2}
                        textAnchor="middle"
                        fontSize="8.5"
                        fontWeight="600"
                        fill={color}
                        pointerEvents="none"
                      >
                        {Number(dev.keys) > 0 ? `${Number(dev.keys)}键` : "面"}
                      </text>
                    </>
                  ) : (
                    <>
                      <circle cx={0} cy={0} r="9" fill={color} opacity="0.92" />
                      {dev.type === "传感器" && (
                        <>
                          <path d="M -4.5 2 A 5.5 5.5 0 0 1 4.5 2" fill="none" stroke="#ffffff" strokeWidth="1.4" />
                          <circle cx={0} cy={0} r="1.8" fill="#ffffff" />
                        </>
                      )}
                      {dev.type !== "传感器" && (
                        <text x={0} y={3.5} textAnchor="middle" fontSize="8" fill="#ffffff" pointerEvents="none">
                          {(dev.type || "设备").slice(0, 1)}
                        </text>
                      )}
                    </>
                  )}
                </g>
                {!mini && showLabels && (
                  <g transform={`translate(${ox} ${oy})`} data-device-label-group="1">
                    <text
                      x={0}
                      y={clash ? (isPanel ? 3 : 4) : isPanel ? 20 : 21}
                      textAnchor="middle"
                      fontSize="8"
                      fill={night ? "#c9c5be" : "#6b6255"}
                      pointerEvents="none"
                    >
                      {dev.code || dev.name}
                    </text>
                  </g>
                )}
              </g>
            );
          })}
        {/* 挑空灯具在别的楼层：本层淡显（只读，跟随情景），并在角上说明 */}
        {!mini &&
          ghostFixtures.map(({ fixture: f, fromFloor, roomName }) => {
            const lit = night && sceneStates[f.id]?.on;
            return (
              <g key={"ghost-" + f.id} data-ghost="1" pointerEvents="none" opacity="0.42">
                <circle
                  cx={f.x}
                  cy={f.y}
                  r={mini ? 4 : 6}
                  fill={lit ? "#e8bc73" : "#bebbb6"}
                  stroke="#8e8270"
                  strokeDasharray="3 3"
                  strokeWidth="1.6"
                />
                <text
                  x={f.x + 9}
                  y={f.y - 9}
                  fontSize="9"
                  fill={night ? "#c9c5be" : "#6b6255"}
                >
                  {f.code} · 挑空（{roomName}）
                </text>
              </g>
            );
          })}
        {!mini && voidNote && (
          <text
            data-void-note="1"
            x={812}
            y={680}
            textAnchor="end"
            fontSize="11"
            fill={night ? "#c9c5be" : "#665d50"}
            pointerEvents="none"
          >
            {voidNote}
          </text>
        )}
        {roam && !mini && (
          // data-testid：二维漫游小人的抓手（e2e 用它读/拖小人；三维不渲染小人）。
          <g data-testid="roam-person" transform={`translate(${roam.x} ${roam.y})`} pointerEvents="none">
            <circle cx={0} cy={0} r={17} fill="#f0d9a8" opacity={0.18} />
            <circle cx={0} cy={-8} r={5.5} fill="#f7e7c2" stroke="#2a2113" strokeWidth={1.2} />
            <rect x={-6} y={-2} width={12} height={16} rx={5} fill="#f7e7c2" stroke="#2a2113" strokeWidth={1.2} />
            <text x={0} y={-20} textAnchor="middle" fontSize={9} fill="#d2cec8">
              小人（拖动我）
            </text>
          </g>
        )}
        {!rooms.length && !design.walls.length && !background && !mini && (
          <g pointerEvents="none">
            <rect
              x="285"
              y="230"
              width="250"
              height="170"
              rx="24"
              fill="#eae8e4"
              stroke="#dbd8d4"
              strokeDasharray="6 6"
            />
            <path
              d="M380 270h60v60h-60zM390 280v25h40"
              stroke="#aea9a2"
              strokeWidth="3"
              fill="none"
            />
            <text
              x="410"
              y="359"
              textAnchor="middle"
              fontSize="16"
              fill="#6b6154"
            >
              从一个空间开始
            </text>
            <text
              x="410"
              y="381"
              textAnchor="middle"
              fontSize="11"
              fill="#95918c"
            >
              导入图纸作底图，或点击「新建空间」
            </text>
          </g>
        )}
      </g>
      {!mini && (
        <g pointerEvents="none">
          <path
            d="M765 55v-23m-5 7 5-7 5 7"
            stroke="#908b84"
            strokeWidth="1.3"
          />
          <text x="765" y="24" textAnchor="middle" fontSize="10" fill="#908b84">
            N
          </text>
          <path d="M30 647v7h100v-7M80 650v4" stroke="#908b84" fill="none" />
          <text x="30" y="671" fontSize="10" fill="#908b84">
            画布单位 · 非施工比例
          </text>
        </g>
      )}
    </svg>
  );
}
function Furniture({ room: r, night }: { room: Obj; night: boolean }) {
  const x = r.x,
    y = r.y,
    w = r.width,
    h = r.height;
  const fill = night ? "#676055" : "#f3f1e7",
    stroke = night ? "#81786c" : "#b1ada7";
  return (
    <g stroke={stroke} strokeWidth="1.3" fill={fill} pointerEvents="none">
      {["主卧", "次卧", "儿童房"].includes(r.type) ? (
        <>
          <rect
            x={x + w * 0.23}
            y={y + h * 0.22}
            width={w * 0.54}
            height={h * 0.57}
            rx="4"
          />
          <rect
            x={x + w * 0.23}
            y={y + h * 0.19}
            width={w * 0.54}
            height="12"
            rx="2"
          />
          <rect
            x={x + w * 0.26}
            y={y + h * 0.25}
            width={w * 0.21}
            height="25"
            rx="4"
          />
          <rect
            x={x + w * 0.52}
            y={y + h * 0.25}
            width={w * 0.21}
            height="25"
            rx="4"
          />
          <path d={`M${x + w * 0.23} ${y + h * 0.48}h${w * 0.54}`} />
          <rect
            x={x + w * 0.06}
            y={y + h * 0.23}
            width={w * 0.12}
            height="29"
            rx="2"
          />
          <rect
            x={x + w * 0.82}
            y={y + h * 0.23}
            width={w * 0.12}
            height="29"
            rx="2"
          />
        </>
      ) : r.type === "客厅" ? (
        <>
          <rect
            x={x + w * 0.15}
            y={y + h * 0.15}
            width={w * 0.67}
            height="57"
            rx="7"
          />
          <rect
            x={x + w * 0.15}
            y={y + h * 0.15}
            width="15"
            height="64"
            rx="4"
          />
          <rect
            x={x + w * 0.82 - 15}
            y={y + h * 0.15}
            width="15"
            height="64"
            rx="4"
          />
          <path
            d={`M${x + w * 0.38} ${y + h * 0.15}v55M${x + w * 0.6} ${y + h * 0.15}v55`}
          />
          <rect
            x={x + w * 0.19}
            y={y + h * 0.43}
            width={w * 0.58}
            height={h * 0.37}
            rx="3"
            fill={night ? "#575045" : "#d7d5c5"}
            stroke="none"
          />
          <rect
            x={x + w * 0.33}
            y={y + h * 0.48}
            width={w * 0.3}
            height="44"
            rx="18"
          />
          <circle cx={x + w * 0.7} cy={y + h * 0.58} r="21" />
          <rect
            x={x + w * 0.2}
            y={y + h * 0.85}
            width={w * 0.55}
            height="10"
            rx="2"
            fill={night ? "#60584d" : "#b6b2ac"}
          />
        </>
      ) : r.type === "餐厅" ? (
        <>
          <rect
            x={x + w * 0.22}
            y={y + h * 0.33}
            width={w * 0.56}
            height={h * 0.35}
            rx="23"
          />
          {[0.3, 0.55].map((v, i) => (
            <g key={i}>
              <rect
                x={x + w * v}
                y={y + h * 0.2}
                width="30"
                height="23"
                rx="7"
              />
              <rect
                x={x + w * v}
                y={y + h * 0.7}
                width="30"
                height="23"
                rx="7"
              />
            </g>
          ))}
          <circle cx={x + w * 0.5} cy={y + h * 0.5} r="11" fill="#b1aba2" />
        </>
      ) : (
        <>
          <rect x={x + 14} y={y + 22} width={w - 28} height="28" rx="3" />
          <rect x={x + 14} y={y + 22} width="28" height={h * 0.6} rx="3" />
        </>
      )}
      <g
        transform={`translate(${x + w - 22} ${y + 24})`}
        fill={night ? "#7f7464" : "#9e978d"}
        stroke="none"
      >
        <circle r="11" opacity=".65" />
        <ellipse rx="5" ry="12" transform="rotate(35)" />
        <ellipse rx="5" ry="12" transform="rotate(-35)" />
      </g>
    </g>
  );
}
