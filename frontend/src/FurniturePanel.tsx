import { useEffect, useRef, useState } from "react";
import { type Obj, uid } from "./types";
import { revealFlash } from "./reveal";
import { defaultSize } from "./furnitureEdits";
import { FURN_HEIGHT } from "./furnitureModels";
import { containsPoint } from "./spaceGeometry";
import { hasFurniturePolygon, addFurnitureMidpoint, deleteFurniturePoint, deleteFurniturePolygon,
  scaleFurniturePolygon, setFurnitureRotation, translateFurniturePolygon, normalizeFurniture } from "./furniturePolygon";

export const pointInSpace = containsPoint;

export function createFurniture(kind: string, room: Obj, x: number, y: number): Obj {
  const [widthM, depthM] = defaultSize(kind);
  const heightM = kind === "到顶柜" ? Math.max(.5, +(room.heightM || 3) - .05) : FURN_HEIGHT[kind] || .5;
  return { id: uid(), roomId: room.id, floor: +(room.floor || 1), kind, x, y,
    widthM, depthM, heightM, rotation: 0, source: "manual" };
}

/** 设计画布的范围（设计单位）：与后端 validate_design 的 10000 同一口径（＝±384m）。
 *  图纸里的杂线/远端图块会把「家具」甩到几百米外，那种行一旦进设计，整份设计都存不下（422）。 */
const DESIGN_EXTENT = 10000;

/** Imported furniture is migrated on the first edit, retaining stable object IDs. */
export function furnitureFromModel(rows: Obj[], rooms: Obj[]): Obj[] {
  return rows.filter(f => !f.hidden).map((f, index) => {
    const x = +f.x * 26, y = +f.z * 26;
    const room = rooms.find(r => pointInSpace(r, x, y));
    return { id: `cad-furniture-${f.id || f.i || index}`, kind: f.kind || "通用",
      roomId: room?.id || "", floor: +(room?.floor || 1), x, y,
      widthM: +f.w || .6, depthM: +f.d || .6, heightM: +f.h || FURN_HEIGHT[f.kind] || .5,
      rotation: ((-(+f.rot || 0)) % 360 + 360) % 360, source: "cad" };
  })
    // 画布外 / 坐标读不出来的（NaN）一律不写进设计：它们本来就画不出来，还会让保存与确认整份失败。
    .filter(f => Number.isFinite(f.x) && Number.isFinite(f.y)
      && Math.abs(f.x) <= DESIGN_EXTENT && Math.abs(f.y) <= DESIGN_EXTENT);
}

export function FurniturePanel({ design, floor, selected, onSelect, onChange, onPlace, onMove, moving = false, placing = "", readonly = false }: {
  design: Obj; floor: number; selected: string; onSelect: (id: string) => void;
  onChange: (design: Obj) => void; onPlace: (kind: string) => void; placing?: string; readonly?: boolean;
  onMove?: () => void; moving?: boolean;
}) {
  // 面板里一律看「规范形态」：有轮廓的件 x/y＝轮廓外接框中心（2026-10-16 那件到顶柜，
  // 存的是被覆盖过的老 x/y，面板照着它显示、三维照着它画，才会「形状全错、穿墙」）。
  const rows: Obj[] = (design.furniture || []).filter((f: Obj) => +(f.floor || 1) === floor)
    .map((f: Obj) => normalizeFurniture(f));
  const item = rows.find(f => f.id === selected);
  const rooms: Obj[] = (design.rooms || []).filter((r: Obj) => +(r.floor || 1) === floor);
  const [boundaryError, setBoundaryError] = useState("");
  const patch = (fields: Obj) => {
    if (!item || readonly) return;
    let next = { ...item, ...fields };
    // 画过多边形的家具（2026-10-16）：宽深/朝向/坐标都得一并作用到多边形上，
    // 否则面板里填数字、转 90° 对画布上的形状不生效（只有外接框在动）。
    if (hasFurniturePolygon(item)) {
      const sizeChanged = ("widthM" in fields && +next.widthM !== +item.widthM)
        || ("depthM" in fields && +next.depthM !== +item.depthM);
      if (sizeChanged)
        next = scaleFurniturePolygon(next, next.widthM, next.depthM);
      if ("rotation" in fields)
        next = setFurnitureRotation(next, next.rotation);
      if ("x" in fields || "y" in fields)
        next = translateFurniturePolygon(next, +next.x - +item.x, +next.y - +item.y);
    }
    if ("x" in fields || "y" in fields) next.roomId = rooms.find(r => pointInSpace(r, next.x, next.y))?.id || next.roomId;
    // 最后再规范一次：无论改的是坐标/宽深/朝向/所属空间，写回去的都是「x/y＝轮廓中心」的规整数据。
    next = normalizeFurniture(next);
    setBoundaryError("");
    onChange({ ...design, furniture: (design.furniture || []).map((f: Obj) => f.id === item.id ? next : f) });
  };
  const editBoundary = (fn: () => void) => {
    try { fn(); } catch (e: any) { setBoundaryError(e.message); }
  };
  // 选中一件家具（画布点选或列表点选）→ 这块字段拉进视野并闪一下（2026-10-16 口径②）。
  const fieldsRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!item) return;
    revealFlash(fieldsRef.current);
  }, [item?.id]);
  useEffect(() => { setBoundaryError(""); }, [item?.id]);
  const polygon = item ? hasFurniturePolygon(item) : false;
  const vertices = item ? (polygon ? item.points.length : 4) : 0;
  return <section className="space-furniture-panel">
    <h4>家具 · {rows.length} 件</h4>
    <p className="subtle">选类型后在空间内单击放置；拖动可移动，尺寸与朝向单独保存。</p>
    {!readonly && <select aria-label="放置家具类型" value={placing} disabled={!rooms.length}
      onChange={e => onPlace(e.target.value)}>
      <option value="">选择家具，点击画布放置…</option>
      {Object.keys(FURN_HEIGHT).map(kind => <option key={kind}>{kind}</option>)}
    </select>}
    <div className="space-furniture-list">{rows.map(f => <button type="button" key={f.id}
      className={selected === f.id ? "on" : ""} onClick={() => onSelect(f.id)}>
      {f.kind} · {rooms.find(r => r.id === f.roomId)?.name || "未归属"}
    </button>)}</div>
    {item && <div className="space-furniture-fields" key={item.id} ref={fieldsRef}>
      <label>家具类型<select aria-label="家具类型" value={item.kind} disabled={readonly} onChange={e => patch({ kind: e.target.value })}>
        {Object.keys(FURN_HEIGHT).map(kind => <option key={kind}>{kind}</option>)}
      </select></label>
      {([["x", "家具横坐标 m"], ["y", "家具纵坐标 m"]] as const).map(([key, label]) =>
        <label key={key}>{label}<input aria-label={label} type="number" step=".1" disabled={readonly}
          defaultValue={+(item[key] / 26).toFixed(3)} key={`${item.id}-${item[key]}`} onBlur={e => {
            const value = +e.target.value;
            if (Number.isFinite(value)) patch({ [key]: value * 26 });
          }} /></label>)}
      <label>所属空间<select aria-label="家具所属空间" disabled={readonly} value={item.roomId}
        onChange={e => {
          const room=rooms.find(r=>r.id===e.target.value);
          // 2026-10-16：改「所属空间」**只改归属，位置不动**。
          // 原来这里还会把家具挪到该空间的内部点（...interiorPoint(room)）——多边形件被挪走后
          // 与轮廓脱钩，正是「改了归属形状就错」的另一半。
          patch(room ? {roomId:room.id} : {roomId:""});
        }}>
        <option value="">未归属</option>{rooms.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
      </select></label>
      {([["widthM", "家具宽度 m"], ["depthM", "家具深度 m"], ["heightM", "家具高度 m"]] as const).map(([key, label]) =>
        <label key={key}>{label}<input aria-label={label} type="number" min=".05" max="20" step=".05" disabled={readonly}
          defaultValue={item[key]} key={`${item.id}-${item[key]}`} onBlur={e => {
            const value = +e.target.value;
            if (Number.isFinite(value) && value >= .05 && value <= 20) patch({ [key]: value });
            else e.target.value = String(item[key]);
          }} /></label>)}
      <label>家具朝向 °<input aria-label="家具朝向 °" type="number" step="15" disabled={readonly}
        defaultValue={item.rotation || 0} key={item.rotation || 0} onBlur={e => {
          const value = +e.target.value;
          if (Number.isFinite(value)) patch({ rotation: (value % 360 + 360) % 360 });
        }} /></label>
      {/* 边界＝多边形（2026-10-16：家具要像空间一样改边界、加/删点） */}
      <p className="subtle" data-furn-vertices={vertices}>
        {polygon ? `边界：多边形 · ${vertices} 个顶点（改宽深＝按轮廓等比缩放）`
          : "边界：矩形（5 个点起就是多边形，画布上可直接拖角点）"}
      </p>
      {polygon && <p className="subtle">多边形家具：二维按画的轮廓画；朝向 ° 只决定三维里那只盒子的摆向。</p>}
      {boundaryError && <p role="alert" className="task-error">{boundaryError}</p>}
      {!readonly && <div className="space-furniture-actions">
        {onMove && <button type="button" onClick={onMove}>{moving ? "取消移动家具" : "在画布中移动家具"}</button>}
        <button type="button" onClick={() => editBoundary(() => patch(addFurnitureMidpoint(item)))}>增加边界点</button>
        <button type="button" onClick={() => editBoundary(() =>
          patch(deleteFurniturePoint(item, (polygon ? item.points.length : 4) - 1)))}>删除边界点</button>
        {polygon && <button type="button" onClick={() => onChange({ ...design, furniture: (design.furniture || []).map((f: Obj) => f.id === item.id ? deleteFurniturePolygon(f) : f) })}>恢复矩形边界</button>}
        <button type="button" onClick={() => patch({ rotation: ((item.rotation || 0) + 90) % 360 })}>旋转 90°</button>
        <button type="button" onClick={() => {
          const copy = translateFurniturePolygon(
            { ...item, id: uid(), x: +item.x + 5.2, y: +item.y + 5.2, source: "manual" }, 5.2, 5.2);
          onChange({ ...design, furniture: [...(design.furniture || []), copy] }); onSelect(copy.id);
        }}>复制家具</button>
        <button type="button" onClick={() => {
          onChange({ ...design, furniture: (design.furniture || []).filter((f: Obj) => f.id !== item.id) }); onSelect("");
        }}>删除家具</button>
      </div>}
    </div>}
  </section>;
}
