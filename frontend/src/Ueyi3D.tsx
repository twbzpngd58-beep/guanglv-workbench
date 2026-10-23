/**
 * 三维灯光场景 = 「优邑珺和」那套渲染内核。
 *
 * 现场 2026-10-19 拍板：**编辑只在二维完成**，三维只负责看效果；
 * 演示只出现在「智能情景」页，交付文件同理。
 *
 * 内核、面板、情景、昼夜、视角全部是参考文件原样搬过来的那份
 * （见 backend/scene3d/shell.html 顶部说明），这里只做两件事：
 *   1. 用 iframe 把 /scene3d/shell.html 嵌进来；
 *   2. 把当前情景的每盏灯状态翻译成回路亮度，postMessage 给内核，让三维跟着情景变。
 *
 * 为什么要有第 2 件：内核默认按它自己的预置（全开 / 会客…）亮灯，跟设计里的情景没有关系。
 * 不接这一步，左栏切情景、右栏拖回路，三维纹丝不动 —— 看着像坏了。
 */
import { useEffect, useMemo, useRef, useState } from "react";

type States = Record<string, { on?: boolean; brightness?: number } | undefined>;

export function Ueyi3D({
  projectId,
  floor,
  states,
  back = false,
  onBack2D,
}: {
  projectId: string;
  floor: number;
  /** 当前情景的灯具状态（草稿也算），用来驱动三维的回路亮度。 */
  states?: States;
  /** 空态是否给「回二维平面图」键（N1）：有二维可回才给，无情景空页传 false。 */
  back?: boolean;
  /** 空态点「回二维平面图」时由外层切回二维。 */
  onBack2D?: () => void;
}) {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const [circuitOf, setCircuitOf] = useState<Record<string, string> | null>(null);
  const src = `/scene3d/shell.html?project=${encodeURIComponent(projectId)}&floor=${floor}&back=${back ? 1 : 0}`;

  // 灯具 id → 内核回路名（后端算好的，跟场景数据同源）
  useEffect(() => {
    let dead = false;
    setCircuitOf(null);
    fetch(`/api/lighting3d/${encodeURIComponent(projectId)}/ueyi-scene.json?floor=${floor}`)
      .then((r) => r.json())
      .then((j) => {
        if (!dead && j && !j.error) setCircuitOf(j.fixture_circuits || {});
      })
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [projectId, floor]);

  // N1：内核空态里的「回二维平面图」。只认本页 origin 发来的 guanglv:back2d。
  useEffect(() => {
    if (!onBack2D) return;
    const on = (e: MessageEvent) => {
      if (e.origin !== location.origin) return;
      if ((e.data as { type?: string } | null)?.type === "guanglv:back2d") onBack2D();
    };
    window.addEventListener("message", on);
    return () => window.removeEventListener("message", on);
  }, [onBack2D]);

  // 情景 → 每个回路一条 0..1 的亮度
  const levels = useMemo(() => {
    if (!circuitOf || !states) return null;
    const acc: Record<string, { sum: number; n: number }> = {};
    Object.entries(states).forEach(([fid, st]) => {
      const name = circuitOf[fid];
      if (!name) return;
      const lit = !!st?.on;
      const lv = lit ? Math.max(0, Math.min(100, Number(st?.brightness) || 0)) / 100 : 0;
      const cur = acc[name] || { sum: 0, n: 0 };
      acc[name] = { sum: cur.sum + lv, n: cur.n + 1 };
    });
    const out: Record<string, number> = {};
    Object.entries(acc).forEach(([name, v]) => {
      out[name] = v.n ? v.sum / v.n : 0;
    });
    // 内核里存在、但这份情景没提到的回路 → 关掉（不然会停在它自己的预置里）
    Object.values(circuitOf).forEach((name) => {
      if (out[name] === undefined) out[name] = 0;
    });
    return out;
  }, [circuitOf, states]);

  const push = () => {
    const w = frame.current?.contentWindow;
    if (!w || !levels) return;
    w.postMessage({ type: "guanglv:levels", levels }, location.origin);
  };

  // 拖滑块时 states 每帧都在变：错开 60ms，别把内核刷爆
  useEffect(() => {
    if (!levels) return;
    const t = window.setTimeout(push, 60);
    return () => window.clearTimeout(t);
  }, [levels]);

  return (
    <div className="scene-model-3d" aria-label="三维灯光场景" data-fid="V-24">
      <iframe
        ref={frame}
        key={`${projectId}-${floor}`}
        className="scene-model-iframe"
        src={src}
        title="三维灯光场景"
        onLoad={() => {
          // 内核起来要时间（解析 776KB 引擎 + 建墙），错开几次总有一次落到
          [400, 1200, 2600, 4500].forEach((ms) => window.setTimeout(push, ms));
        }}
      />
    </div>
  );
}
