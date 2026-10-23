import { CheckCircle2, Circle, Loader2 } from "lucide-react";
import type { Obj } from "./types";

export const DRAWING_STEPS = [
  { id: "upload", label: "导入图纸" },
  { id: "recognition", label: "识别空间" },
  { id: "review", label: "三维预览" },
  { id: "spaces", label: "确认空间" },
  { id: "openings", label: "绘制门窗" },
  { id: "furniture", label: "修改家具" },
  { id: "canvas", label: "画布" },
] as const;
export type DrawingStep = typeof DRAWING_STEPS[number]["id"];
export type EditingPhase = "review" | "spaces" | "openings" | "furniture";

export function drawingStep(project: Obj, design: Obj, job?: Obj | null): DrawingStep {
  if (job?.state === "running" && job.recognizing !== false) return "recognition";
  const definition = design.spaceDefinition || {};
  if (definition.status === "confirmed") return "canvas";
  if (["upload", "recognition", "review", "spaces", "openings", "furniture"].includes(definition.workflowStep)) return definition.workflowStep;
  if ((design.rooms || []).length) return "review";
  return (project.files || []).length || design.baseFileId ? "recognition" : "upload";
}

export function DrawingProgress({ project, design, job, phase, confirmed, onStep, blockedSteps }: {
  project: Obj; design: Obj; job?: Obj | null; phase?: DrawingStep;
  /** 项目已经确认过空间/门窗/家具：进度条按「已进入画布」算。
   *  否则在已确认的项目里打开空间预览（改空间/改家具）时，进度条会跟着编辑相位退回
   *  「三维预览 29%」「修改家具 71%」，跟项目实际所在的环节对不上（现场 2026-10-16 报）。 */
  confirmed?: boolean;
  onStep?: (step: DrawingStep) => void;
  /** 有写库副作用、批 1 不接线的步骤：直接灰掉，不给误触（统筹 2026-10-20 签字 §4）。 */
  blockedSteps?: DrawingStep[];
}) {
  const recognizing = job?.state === "running" && job.recognizing !== false;
  const settled = !!confirmed || design.spaceDefinition?.status === "confirmed";
  const current: DrawingStep = recognizing ? "recognition"
    : settled ? "canvas"
    : (phase || drawingStep(project, design, job));
  const index = DRAWING_STEPS.findIndex(s => s.id === current);
  const completed = current === "canvas" ? DRAWING_STEPS.length : index;
  const fraction = current === "recognition" && recognizing
    ? Math.max(0, Math.min(1, +job.pct || 0)) : 0;
  const percent = Math.round((completed + fraction) / DRAWING_STEPS.length * 100);
  return <section className="drawing-progress" aria-label="导图建模流程" data-current-step={current}>
    <div className="drawing-progress-heading">
      <b>导图建模进度</b>
      <span role="status" data-fid="D-14">{current === "canvas" ? "已进入画布" : `当前：${DRAWING_STEPS[index].label}`} · {percent}%</span>
    </div>
    <div className="drawing-progress-track" role="progressbar" aria-label="导图建模进度"
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} data-fid="D-14">
      <i style={{width:`${percent}%`}} />
    </div>
    <ol>{DRAWING_STEPS.map((s, i) => {
      const done = i < completed, active = s.id === current;
      return <li key={s.id} data-step={s.id} data-state={done ? "completed" : active ? "current" : "pending"}>
        <button type="button" disabled={!onStep || i > index || !!blockedSteps?.includes(s.id)} onClick={() => onStep?.(s.id)}
          aria-current={active ? "step" : undefined} data-fid="D-15">
          {active && recognizing ? <Loader2 className="spin" size={14} /> : done ? <CheckCircle2 size={14} /> : <Circle size={14} />}
          <span>{i + 1} · {s.label}</span>
        </button>
      </li>;
    })}</ol>
  </section>;
}
