/**
 * 三维灯光场景 = 「优邑珺和」那套渲染内核。
 *
 * 现场 2026-10-19 拍板：**编辑只在二维完成**，三维只负责看效果；
 * 演示只出现在「智能情景」页，交付文件同理。
 *
 * 内核、面板、情景、昼夜、视角全部是参考文件原样搬过来的那份
 * （见 backend/scene3d/shell.html 顶部说明），这里只做三件事：
 *   1. 用 iframe 把 /scene3d/ref/two.html 嵌进来；
 *   2. 把当前情景的每盏灯状态翻译成回路亮度，postMessage 给内核，让三维跟着情景变；
 *   3. 把项目真实情景列表发给内核，替换它写死的全开 / 会客 / 观影… 预置，
 *      并把内核里点情景的选择回写给工作台。
 *
 * 为什么要有第 2、3 件：内核默认按它自己的预置亮灯、列情景，跟设计里的情景没有关系。
 * 不接这一步，左栏切情景、右栏拖回路、三维里点情景，两边都对不上 —— 看着像坏了。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pencil } from "lucide-react";

type States = Record<string, { on?: boolean; brightness?: number } | undefined>;

export function Ueyi3D({
  projectId,
  floor,
  states,
  scenes,
  sceneId,
  focusFixture,
  onPickScene,
  back = false,
  onBack2D,
}: {
  projectId: string;
  floor: number;
  /** 当前情景的灯具状态（草稿也算），用来驱动三维的回路亮度。 */
  states?: States;
  /** 项目里实际存在的情景；传了就把内核写死的预置换成这些。 */
  scenes?: { id?: string; name?: string; description?: string; states?: States }[];
  /** 当前选中的情景 id。 */
  sceneId?: string;
  /** 要定位的灯具（点右栏的灯具编号）：三维里定点打光并居中。 */
  focusFixture?: { id: string; token: number; code?: string } | null;
  /** 在三维面板里点了某个情景：外层据此切换当前情景。 */
  onPickScene?: (id: string) => void;
  /** 空态是否给「回二维平面图」键（N1）：有二维可回才给，无情景空页传 false。 */
  back?: boolean;
  /** 空态点「回二维平面图」时由外层切回二维。 */
  onBack2D?: () => void;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const frame = useRef<HTMLIFrameElement | null>(null);
  const [isFull, setIsFull] = useState(false);
  const [circuitOf, setCircuitOf] = useState<Record<string, string> | null>(null);
  // 2.0.0：优邑呈现（零渲染 / 带渲染），场景由后端 /api/lighting3d/refnight 注入
  const src = `/scene3d/ref/two.html?project=${encodeURIComponent(projectId)}&floor=${floor}`;

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

  // V-24 快捷键转发（1.6.0）：焦点在页面任意位置都能用 M/N/C 控制三维；
  // 输入框 / 文本域 / 可编辑区聚焦时不转发（打字优先）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
      const t = e.target as HTMLElement | null;
      const tag = (t?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || (t && t.isContentEditable)) return;
      const k = String(e.key || "").toLowerCase();
      if (k !== "m" && k !== "n" && k !== "c") return;
      const win = frame.current?.contentWindow;
      if (!win) return;
      e.preventDefault();
      win.postMessage({ type: "guanglv:v24key", key: k }, location.origin);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 全屏时外层标题栏不可见，给一个明确的「回二维编辑」入口；
  // 编辑仍只在二维完成（2026-10-19 定稿），三维只负责看效果。
  useEffect(() => {
    const on = () => setIsFull(!!box.current && document.fullscreenElement === box.current);
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);

  // 情景 → 每个回路一条 0..1 的亮度
  const levelsFor = (src?: States) => {
    if (!circuitOf || !src) return null;
    const acc: Record<string, { sum: number; n: number }> = {};
    Object.entries(src).forEach(([fid, st]) => {
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
  };
  const levels = useMemo(() => levelsFor(states), [circuitOf, states]);
  // 逐个灯一条 0..1：三维内核按回路分组，只发回路平均值会让「调一盏灯」点亮整条回路
  // （现场 2026-11-04：CoCo 的 C01 只有 1 盏，一开关整层都跟着变）。有逐灯值就按逐灯上。
  const lampLevelsFor = (src?: States) => {
    if (!circuitOf || !src) return null;
    const out: Record<string, number> = {};
    Object.entries(src).forEach(([fid, st]) => {
      if (!circuitOf[fid]) return;
      out[fid] = st?.on ? Math.max(0, Math.min(100, Number(st?.brightness) || 0)) / 100 : 0;
    });
    Object.keys(circuitOf).forEach((fid) => {
      if (out[fid] === undefined) out[fid] = 0;
    });
    return out;
  };
  const lampLevels = useMemo(() => lampLevelsFor(states), [circuitOf, states]);
  // 三维「完整」模式的面板要用项目自己的情景，不能用内核写死的全开/会客/观影…
  // 当前情景如果正在草稿里改过，用草稿状态覆盖，保证三维与右栏看到的是同一份。
  const scenePayload = useMemo(() => {
    if (!circuitOf || !scenes?.length) return [];
    return scenes.map((s) => ({
      id: String(s.id || ""),
      name: String(s.name || ""),
      note: s.description || "",
      levels: levelsFor(s.id === sceneId ? states : s.states) || {},
    }));
  }, [circuitOf, scenes, sceneId, states]);

  // iframe onLoad 的重试计时器可能在切情景之后才落地。闭包里抓的会是挂载时那份状态，
  // 晚到一次就把三维刷回旧情景；所以推送一律读 ref 里的最新值。
  const latest = useRef({ levels, lampLevels, sceneId: "", scenePayload, focusFixture });
  latest.current = { levels, lampLevels, sceneId: sceneId || "", scenePayload, focusFixture };

  const push = useCallback(() => {
    const w = frame.current?.contentWindow;
    const d = latest.current;
    if (!w || !d.levels) return;
    w.postMessage(
      { type: "guanglv:levels", levels: d.levels, lampLevels: d.lampLevels || {}, sceneId: d.sceneId },
      location.origin,
    );
  }, []);

  const pushScenes = useCallback(() => {
    const w = frame.current?.contentWindow;
    const d = latest.current;
    if (!w || !d.scenePayload.length) return;
    w.postMessage(
      { type: "guanglv:scenes", scenes: d.scenePayload, activeId: d.sceneId || d.scenePayload[0].id },
      location.origin,
    );
  }, []);

  const pushFocus = useCallback(() => {
    const w = frame.current?.contentWindow;
    const d = latest.current;
    if (!w || !d.focusFixture?.id) return;
    w.postMessage(
      {
        type: "guanglv:focus-fixture",
        id: d.focusFixture.id,
        token: d.focusFixture.token,
        code: d.focusFixture.code || "",
      },
      location.origin,
    );
  }, []);

  // 拖滑块时 states 每帧都在变：错开 60ms，别把内核刷爆
  useEffect(() => {
    if (!levels) return;
    const t = window.setTimeout(push, 60);
    return () => window.clearTimeout(t);
  }, [levels, lampLevels, sceneId]);

  useEffect(() => {
    if (!scenePayload.length) return;
    const t = window.setTimeout(pushScenes, 60);
    return () => window.clearTimeout(t);
  }, [scenePayload, sceneId]);

  // 点右栏灯具编号：等内核就绪后由 onLoad 重试补发，避免加载中点了个空。
  useEffect(() => {
    if (!focusFixture?.id) return;
    const t = window.setTimeout(pushFocus, 80);
    return () => window.clearTimeout(t);
  }, [focusFixture]);

  // 三维面板点情景 → 通知外层切换当前情景，左右两边保持同一份选择。
  useEffect(() => {
    if (!onPickScene) return;
    const on = (e: MessageEvent) => {
      if (e.origin !== location.origin) return;
      if (e.source !== frame.current?.contentWindow) return;
      const d = e.data as { type?: string; sceneId?: string } | null;
      if (d?.type === "guanglv:pick-scene" && typeof d.sceneId === "string") onPickScene(d.sceneId);
    };
    window.addEventListener("message", on);
    return () => window.removeEventListener("message", on);
  }, [onPickScene]);

  return (
    <div ref={box} className="scene-model-3d" aria-label="三维灯光场景">
      <iframe
        ref={frame}
        key={`${projectId}-${floor}`}
        className="scene-model-iframe"
        src={src}
        title="三维灯光场景"
        onLoad={() => {
          // 内核起来要时间（解析 776KB 引擎 + 建墙），错开几次总有一次落到
          [400, 1200, 2600, 4500].forEach((ms) =>
            window.setTimeout(() => {
              push();
              pushScenes();
              pushFocus();
            }, ms),
          );
        }}
      />
      {isFull && onBack2D && (
        <button
          type="button"
          className="scene-3d-edit"
          onClick={() => {
            void document.exitFullscreen?.().catch(() => {});
            onBack2D();
          }}
        >
          <Pencil size={14} /> 回二维编辑此情景
        </button>
      )}
    </div>
  );
}
