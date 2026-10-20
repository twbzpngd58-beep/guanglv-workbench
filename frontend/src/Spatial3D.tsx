import type { Design, Obj } from "./types";
import { useSceneFade } from "./sceneFade";

type Selection = { kind: "rooms" | "fixtures" | "devices" | "walls" | "openings"; id: string } | null;

/** Projected design preview: actual room boundaries only, never infer walls from a raster. */
export function Spatial3D({
  design, floor, background, scene, selection, onSelect, onPlacePoint,
}: {
  design: Design;
  floor: number;
  background?: string;
  scene?: Obj;
  selection?: Selection;
  onSelect?: (s: Selection) => void;
  onPlacePoint?: (point: { x: number; y: number }) => void;
}) {
  const rooms = design.rooms.filter((r) => (r.floor || 1) === floor && Number(r.width) > 2 && Number(r.height) > 2);
  // 情景切换也要缓变（同一套渐变口径），缩略图不播过渡、直接到位。
  const sceneStates = useSceneFade(scene, { animate: false });
  const fixtures = design.fixtures.filter((f) => (f.floor || 1) === floor && Number.isFinite(Number(f.x)) && Number.isFinite(Number(f.y)));
  const devices = design.devices.filter((d) => (d.floor || 1) === floor && Number.isFinite(Number(d.x)) && Number.isFinite(Number(d.y)));
  const pts = (r: Obj) => Array.isArray(r.points) && r.points.length >= 3
    ? r.points.map((p: Obj) => `${Number(p.x)},${Number(p.y)}`).join(" ")
    : `${r.x},${r.y} ${r.x + r.width},${r.y} ${r.x + r.width},${r.y + r.height} ${r.x},${r.y + r.height}`;
  const corners = (r: Obj) => Array.isArray(r.points) && r.points.length >= 3
    ? r.points.map((p: Obj) => ({ x: Number(p.x), y: Number(p.y) }))
    : [{ x: +r.x, y: +r.y }, { x: +r.x + +r.width, y: +r.y },
       { x: +r.x + +r.width, y: +r.y + +r.height },
       { x: +r.x, y: +r.y + +r.height }];
  return (
    <div className="spatial3d" aria-label="三维空间示意画布">
      <div className="spatial3d-hint">{rooms.length ? "3D 空间示意 · 房间高度按层高展示" : "彩平图透视预览 · 房间缺少边界，未生成虚构墙体"}</div>
      <div className="spatial3d-perspective">
        <svg viewBox="0 0 820 690" role="img" aria-label="可点击灯具、面板和传感器的空间模型"
          onClick={(e) => {
            if (!onPlacePoint || e.target !== e.currentTarget) return;
            const pt = e.currentTarget.createSVGPoint();
            pt.x = e.clientX; pt.y = e.clientY;
            const local = pt.matrixTransform(e.currentTarget.getScreenCTM()!.inverse());
            onPlacePoint({ x: local.x, y: local.y });
          }}>
          <rect width="820" height="690" fill="#26342e" onClick={(e) => {
            if (!onPlacePoint) return;
            const svg = e.currentTarget.ownerSVGElement!;
            const pt = svg.createSVGPoint();
            pt.x = e.clientX; pt.y = e.clientY;
            const local = pt.matrixTransform(svg.getScreenCTM()!.inverse());
            onPlacePoint({ x: local.x, y: local.y });
          }} />
          {background && <image href={background} x="0" y="0" width="820" height="690"
            preserveAspectRatio="xMidYMid meet" opacity=".87" pointerEvents="none" />}
          {rooms.map((r) => (
            <g key={r.id} className="spatial3d-room" onClick={() => onSelect?.({ kind: "rooms", id: r.id })}>
              <polygon points={pts(r)} fill={r.color || "#647967"} fillOpacity=".18"
                stroke={selection?.id === r.id ? "#ffe0a4" : "#abd0bc"} strokeWidth="2" />
              {corners(r).map((p, i, all) => {
                const next = all[(i + 1) % all.length];
                const rise = Math.max(15, Math.min(90, Number(r.heightM || 2.8) * 16));
                return <polygon key={i}
                  points={`${p.x},${p.y} ${next.x},${next.y} ${next.x},${next.y-rise} ${p.x},${p.y-rise}`}
                  fill="#8da99a" fillOpacity=".24" stroke="#c9d9d0" strokeOpacity=".55" />;
              })}
              <text x={Number(r.x) + Number(r.width) / 2} y={Number(r.y) + 15}
                textAnchor="middle" fill="#fff" fontSize="12">{r.name}</text>
            </g>
          ))}
          {fixtures.map((f) => {
            const state = sceneStates[f.id];
            const on = scene ? Boolean(state?.on) : true;
            return <g key={f.id} className="spatial3d-marker" onClick={() => onSelect?.({ kind: "fixtures", id: f.id })}>
              {on && <circle cx={f.x} cy={f.y} r={Math.max(8, Number(state?.brightness || 65) / 3)}
                fill="#ffcf8d" opacity=".3" />}
              <circle cx={f.x} cy={f.y} r="8" fill={on ? "#ffe4a8" : "#63716e"}
                stroke={selection?.id === f.id ? "#fff" : "#18241d"} strokeWidth="2" />
              <title>{f.code} · {f.name || f.type}</title>
            </g>;
          })}
          {devices.map((dev) => <g key={dev.id} className="spatial3d-marker"
            onClick={() => onSelect?.({ kind: "devices", id: dev.id })}>
            <rect x={Number(dev.x) - 10} y={Number(dev.y) - 9} width="20" height="18" rx="4"
              fill={dev.type === "面板" ? "#4aaabb" : "#88b983"}
              stroke={selection?.id === dev.id ? "#fff" : "#183330"} strokeWidth="2" />
            <title>{dev.code} · {dev.type} · {dev.brand || "品牌待选"} {dev.series || ""} {dev.model || ""}</title>
          </g>)}
        </svg>
      </div>
    </div>
  );
}
