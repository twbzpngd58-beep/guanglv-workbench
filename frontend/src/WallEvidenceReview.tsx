import { useRef, useState } from "react";
import { Obj } from "./types";
import { Button } from "./ui";

export function WallEvidenceReview({
  result,
  background,
  busy,
  onAnalyze,
}: {
  result: Obj;
  background: string;
  busy: boolean;
  onAnalyze: (boxes: Obj[]) => Promise<unknown>;
}) {
  const [boxes, setBoxes] = useState<Obj[]>(result.exclusions || []);
  const [draw, setDraw] = useState(false);
  const [evidence, setEvidence] = useState(true);
  const [draft, setDraft] = useState<Obj | null>(null);
  const start = useRef<Obj | null>(null);
  function point(event: React.PointerEvent<SVGSVGElement>) {
    const svg = event.currentTarget,
      matrix = svg.getScreenCTM();
    if (!matrix) return { x: 0, y: 0 };
    const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(
      matrix.inverse(),
    );
    return {
      x: Math.max(0, Math.min(800, p.x)),
      y: Math.max(0, Math.min(660, p.y)),
    };
  }
  const updated =
    JSON.stringify(boxes) !== JSON.stringify(result.exclusions || []);
  return (
    <section className="wall-evidence-review" data-fid="D-18">
      <h3>墙带候选检查 / 家具排除</h3>
      <p>
        绿色为参与空间划分的墙带候选，不代表已确认墙体。检查床、沙发、柜子是否仍被选中；若有，开启框选，在家具内部拖出红色排除区。不要框到真实墙线或门窗。
      </p>
      <div className="wall-review-controls">
        <label>
          <input
            type="checkbox"
            checked={evidence}
            onChange={(e) => setEvidence(e.target.checked)} data-fid="D-18"
          />
          显示墙带候选层
        </label>
        <label>
          <input
            aria-label="框选家具排除区"
            type="checkbox"
            disabled={busy}
            checked={draw}
            onChange={(e) => setDraw(e.target.checked)} data-fid="D-19"
          />
          框选家具排除区
        </label>
        <Button
          disabled={busy || !boxes.length}
          onClick={() => setBoxes((v) => v.slice(0, -1))} fid="D-19"
        >
          撤销最后一个排除区
        </Button>
        <Button disabled={busy || !boxes.length} onClick={() => setBoxes([])} fid="D-19">
          清空排除区
        </Button>
      </div>
      <svg
        className="wall-evidence-canvas"
        role="img"
        aria-label="家具排除画布"
        viewBox="0 0 800 660"
        style={{
          touchAction: draw ? "none" : "pan-y",
          cursor: draw ? "crosshair" : "default",
        }}
        onPointerDown={(e) => {
          if (!draw || busy || boxes.length >= 40) return;
          start.current = point(e);
          setDraft(null);
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!start.current) return;
          const p = point(e),
            a = start.current;
          setDraft({
            x: Math.min(a.x, p.x),
            y: Math.min(a.y, p.y),
            width: Math.abs(p.x - a.x),
            height: Math.abs(p.y - a.y),
          });
        }}
        onPointerUp={(e) => {
          if (!start.current) return;
          const p = point(e),
            a = start.current;
          const box = {
            x: Math.min(a.x, p.x),
            y: Math.min(a.y, p.y),
            width: Math.abs(p.x - a.x),
            height: Math.abs(p.y - a.y),
          };
          if (box.width >= 3 && box.height >= 3) setBoxes((v) => [...v, box]);
          start.current = null;
          setDraft(null);
        }}
        onPointerCancel={() => {
          start.current = null;
          setDraft(null);
        }}
      >
        <image
          href={background}
          x="25"
          y="25"
          width="750"
          height="610"
          preserveAspectRatio="xMidYMid meet"
        />
        {evidence && <path className="wall-mask-path" fillRule="evenodd" d={(result.wallEvidenceContours || []).map((pts:Obj[])=>pts.length ? `M${pts.map(v=>`${v.x},${v.y}`).join('L')}Z` : '').join(' ')} fill="#7d6036" fillOpacity=".55" stroke="#7d6036" strokeWidth=".5"/>}
        {(result.unresolvedRegions || []).map((v: Obj, i: number) => (
          <g key={i}>
            <rect
              x={v.x}
              y={v.y}
              width={v.width}
              height={v.height}
              fill="none"
              stroke="#bc751f"
              strokeWidth="2"
              strokeDasharray="6 4"
            />
            <text x={v.x + 3} y={v.y + 16} fontSize="12" fill="#965911">
              待人工划分
            </text>
          </g>
        ))}
        {[...boxes, ...(draft ? [draft] : [])].map((b, i) => (
          <rect
            key={i}
            x={b.x}
            y={b.y}
            width={b.width}
            height={b.height}
            fill="#dd5050"
            fillOpacity=".22"
            stroke="#c44444"
            strokeWidth="2"
          />
        ))}
      </svg>
      <p className="wall-exclusion-count">
        家具排除区：{boxes.length} / 40{" "}
        {updated ? "· 未保存，请重新分析" : "· 已保存设置"}
      </p>
      <p>
        已抑制 {result.wallEvidence?.suppressedInkPixels?.toLocaleString() ?? 0}{" "}
        个细线像素（不是识别出的家具数量）。几何规则无法保证区分贴墙柜体与墙体；存疑请上传不含家具的建筑底图或人工绘制。
      </p>
      {!!result.unresolvedRegions?.length && (
        <div className="notice">
          {result.unresolvedRegions.length} 个区域未生成房间：无法在 8
          个点内可靠拟合，请人工划分。黄色虚线只是待处理范围，不是房间边界。
        </div>
      )}
      <Button disabled={busy} onClick={() => onAnalyze(boxes)} fid="D-20">
        保存排除区并重新识别
      </Button>
      <p>
        只更新识别草稿，不覆盖已有设计。框选错误可撤销/清空后重新分析；原始图像不修改。
      </p>
    </section>
  );
}
