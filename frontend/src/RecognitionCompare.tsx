import { useState } from "react";
import { Obj, Design } from "./types";
import { Button } from "./ui";
import { floorLabel } from "./floors";
import { confirmDanger } from "./dangerConfirm";

function points(room: Obj | undefined): Obj[] {
  if (!room) return [];
  return room.points?.length
    ? room.points
    : [
        { x: room.x, y: room.y },
        { x: room.x + room.width, y: room.y },
        { x: room.x + room.width, y: room.y + room.height },
        { x: room.x, y: room.y + room.height },
      ];
}

function sameBoundary(a: Obj[], b: Obj[]) {
  if (a.length !== b.length) return false;
  return [b, [...b].reverse()].some((ordered) =>
    ordered.some((_, start) =>
      a.every((v, i) => {
        const other = ordered[(start + i) % ordered.length];
        return Math.abs(v.x - other.x) < 0.01 && Math.abs(v.y - other.y) < 0.01;
      }),
    ),
  );
}

export function RecognitionCompare({
  result,
  design,
  background,
  busy,
  basements = 0,
  onReplace,
}: {
  result: Obj;
  design: Design;
  background?: string;
  busy: boolean;
  /** 项目地下层数，与顶部 1F/2F 标签同源。 */
  basements?: number;
  onReplace: (candidateId: string, roomId: string) => Promise<unknown>;
}) {
  const [candidateId, setCandidateId] = useState(result.rooms[0]?.id || "");
  const [targetId, setTargetId] = useState("");
  const [showRaw, setShowRaw] = useState(false);
  const candidate =
    result.rooms.find((v: Obj) => v.id === candidateId) || result.rooms[0];
  if (!candidate) return null;
  // 只列识别所在楼层的画布房间，避免跨层误替换。
  const recognizedFloor = Number(result.floor ?? candidate.floor) || 1;
  const floorRooms = design.rooms.filter(
    (v) => (Number(v.floor) || 1) === recognizedFloor,
  );
  // 只识别到名称、没有边界的候选（0 → 0 点）不做前后对比。
  const hasBoundary = !!(candidate.points?.length || candidate.rawPoints?.length);
  const target = floorRooms.find((v) => v.id === targetId);
  const raw = { ...candidate, points: candidate.rawPoints || candidate.points };
  const before = !showRaw && target ? target : raw;
  const all = [...points(before), ...points(candidate)];
  const minX = Math.min(...all.map((v) => v.x)) - 15,
    minY = Math.min(...all.map((v) => v.y)) - 15;
  const width = Math.max(...all.map((v) => v.x)) - minX + 15,
    height = Math.max(...all.map((v) => v.y)) - minY + 15;
  const viewBox = `${minX} ${minY} ${width} ${height}`;
  const changed = !sameBoundary(points(before), points(candidate));
  const done = result.replacements?.find(
    (v: Obj) => v.candidateId === candidate.id,
  );
  function drawing(room: Obj, title: string, color: string) {
    return (
      <figure>
        <figcaption>
          {title} · {points(room).length} 个边界点
        </figcaption>
        <svg role="img" aria-label={title} viewBox={viewBox}>
          {background && (
            <image
              href={background}
              x="25"
              y="25"
              width="750"
              height="610"
              preserveAspectRatio="xMidYMid meet"
              opacity=".65"
            />
          )}
          <polygon
            points={points(room)
              .map((v) => `${v.x},${v.y}`)
              .join(" ")}
            fill={color}
            fillOpacity=".26"
            stroke={color}
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
          {points(room).map((v, i) => (
            <circle
              key={i}
              cx={v.x}
              cy={v.y}
              r={Math.max(width, height) * 0.006}
              fill={color}
            />
          ))}
        </svg>
      </figure>
    );
  }
  return (
    <section className="boundary-compare" data-fid="D-16">
      <h3>边界前后对比 · 确认后才替换画布</h3>
      <p>
        选择候选空间与画布房间，两侧使用相同缩放和原图。不会自动猜测并覆盖你改过的房间。
      </p>
      <div className="boundary-selectors">
        <label>
          候选空间
          <select
            aria-label="对比候选空间"
            value={candidate.id}
            onChange={(e) => {
              setCandidateId(e.target.value);
              setTargetId("");
            }}
          >
            {result.rooms.map((v: Obj) => (
              <option key={v.id} value={v.id}>
                {v.name} ·{" "}
                {v.regularizationStats?.beforeVertices ??
                  v.rawPoints?.length ??
                  v.points.length}{" "}
                → {v.points.length} 点
                {v.regularizationStats?.changed === false ? " · 未规整" : ""}
              </option>
            ))}
          </select>
        </label>
        <label>
          替换哪个画布房间
          <select
            aria-label="替换目标房间"
            value={targetId}
            onChange={(e) => setTargetId(e.target.value)}
          >
            <option value="">不替换，仅查看识别前后</option>
            {floorRooms.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name} · {floorLabel(v.floor, basements)}
                {v.source === "manual" ? " · 手工修改" : ""}
              </option>
            ))}
          </select>
        </label>
      </div>
      {!hasBoundary && (
        <p className="boundary-change-status">
          「{candidate.name}」只识别到名称、没有边界，无可对比的轮廓；请在画布上手动画边界。
        </p>
      )}
      {hasBoundary && target && (
        <label className="boundary-raw-toggle">
          <input
            type="checkbox"
            checked={showRaw}
            onChange={(e) => setShowRaw(e.target.checked)}
          />
          左侧查看识别原始边界（取消则显示当前画布）
        </label>
      )}
      {hasBoundary && (
        <>
          <div className="boundary-panels">
            {drawing(
              before,
              !showRaw && target ? "当前画布边界" : "识别原始边界",
              "#c87932",
            )}
            {drawing(candidate, "优化后候选边界", "#8f6e3d")}
          </div>
          <p className="boundary-change-status">
            {changed
              ? `边界点 ${points(before).length} → ${points(candidate).length}；轮廓有变化，请对照原图检查。`
              : "当前对比没有变化。该空间可能无需规整，或因偏离原图/侵入相邻空间而保留原轮廓。"}
            {done ? ` 已用于替换「${done.roomName}」。` : ""}
          </p>
        </>
      )}
      <p>
        仅替换所选房间轮廓；保留名称、ID、楼层、面积、灯具及情景关联。灯位不会自动移动，面积与灯位需重新校核；复核签名失效，可在版本记录恢复。
      </p>
      {result.algorithmVersion !== "wall-evidence-v4" && <p>这是旧版识别草稿，请先点击文件旁的「重新识别空间」生成新版。</p>}
      <Button
        disabled={
          busy ||
          !hasBoundary ||
          !target ||
          !!done ||
          result.simulated ||
          sameBoundary(points(target), points(candidate))
        }
        onClick={async () => {
          if (!target) return;
          const ok = await confirmDanger({
            title: `用「${candidate.name}」的候选轮廓替换「${target.name}」？`,
            detail:
              "保留名称、ID 与灯具关联；人工修改过的边界会被替换，面积、灯位及相邻边界需要重新复核。",
            confirmText: "确认替换",
          });
          if (ok) onReplace(candidate.id, target.id);
        }} fid="D-17"
      >
        {done ? "该候选已替换到画布" : "确认替换所选空间"}
      </Button>
    </section>
  );
}
