import { useEffect, useRef, useState } from "react";
import type { Obj } from "./types";

/** 单灯在情景里的状态 → 0~1 亮度（没写进情景的灯＝0，与交付页、三维口径一致）。 */
function lampLevel(state?: Obj): number {
  if (!state || !state.on) return 0;
  const value = Number(state.brightness);
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

export function lampLevelOf(state?: Obj): number {
  return lampLevel(state);
}

/** 两个情景状态表之间插值（亮度线性过渡、色温同步过渡，'on' 按过渡中亮度判定）。 */
export function blendSceneStates(from: Obj, to: Obj, t: number): Obj {
  const ids = new Set([...Object.keys(from || {}), ...Object.keys(to || {})]);
  const out: Obj = {};
  ids.forEach((id) => {
    const a = from?.[id];
    const b = to?.[id];
    const start = lampLevel(a);
    const target = lampLevel(b);
    const level = start + (target - start) * t;
    const cctA = Number(a?.cct ?? b?.cct ?? 3000);
    const cctB = Number(b?.cct ?? a?.cct ?? 3000);
    out[id] = {
      ...(b || a || {}),
      on: level > 0.5,
      brightness: Math.round(level * 10) / 10,
      cct: Math.round(cctA + (cctB - cctA) * t),
    };
  });
  return out;
}

/**
 * 情景切换的渐变（2026-10-17：「情景模式切换时的渐变时间也失效了」）。
 *
 * 口径：**切到哪个情景，就按那个情景自己的「渐变时间」过渡**（面板上的说明也这么写，业主版交付页
 * 一直是这个口径）。原来只有二维画布有渐变、而且用的是「离开的那一情景」的时长 —— 于是用户给某个
 * 情景配了 30 秒渐变，切进去却是瞬间跳变，看起来就是渐变时间失效；三维那几套（内嵌三维 / 独立引擎）
 * 干脆完全没有渐变。
 *
 * 返回值是「当前该显示的状态表」，逐帧变化；调用方直接把它当情景状态用即可。
 */
export function useSceneFade(scene?: Obj, opts?: { fadeTick?: number; animate?: boolean }): Obj {
  const target: Obj = scene?.states || {};
  const sceneKey = scene?.id ?? "";
  const statesKey = JSON.stringify(target);
  const fadeTick = opts?.fadeTick ?? 0;
  const animate = opts?.animate !== false;
  const fadeSeconds = (() => {
    const value = Number(scene?.fade);
    return Number.isFinite(value) && value >= 0 ? Math.min(3600, value) : 1;
  })();
  const [shown, setShown] = useState<Obj>(target);
  const shownRef = useRef<Obj>(target);
  const lastScene = useRef<string | null>(null);
  const lastTick = useRef<number>(fadeTick);

  useEffect(() => {
    const to: Obj = target;
    const previous = shownRef.current;
    const first = lastScene.current === null;
    const switched = lastScene.current !== sceneKey;
    // 面板上的「全部开启 / 全部关闭」在同一情景内改灯，只递增 fadeTick 要一次缓变。
    const tickRequested = fadeTick !== lastTick.current;
    lastTick.current = fadeTick;
    lastScene.current = sceneKey;
    if (!animate || first || (!switched && !tickRequested) || fadeSeconds <= 0) {
      // 缩略图/首帧/同一情景内拖滑块/渐变 0 秒：立刻到位，不做过渡。
      shownRef.current = to;
      setShown(to);
      return;
    }
    const started = performance.now();
    let frame = 0;
    let done = false;
    const land = () => {
      if (done) return;
      done = true;
      shownRef.current = to;
      setShown(to);
    };
    // 兜底：rAF 在后台标签页会被浏览器暂停，只靠它可能永远到不了目标值（渐变了 30 秒还是原来的亮度）。
    // 定时器按「渐变时长 + 一点余量」直接落到目标值，rAF 正常跑时它只是重复设一次同样的值。
    const guard = window.setTimeout(land, fadeSeconds * 1000 + 120);
    const step = (now: number) => {
      const raw = Math.min(1, (now - started) / (fadeSeconds * 1000));
      const eased = raw * raw * (3 - 2 * raw); // smoothstep：两头缓、中间快
      const next = blendSceneStates(previous, to, eased);
      shownRef.current = next;
      setShown(next);
      if (raw < 1) frame = requestAnimationFrame(step);
      else done = true;
    };
    frame = requestAnimationFrame(step);
    return () => { cancelAnimationFrame(frame); window.clearTimeout(guard); };
    // statesKey：同一情景内改滑块时立即生效，不重新播一遍过渡。
  }, [sceneKey, statesKey, fadeSeconds, fadeTick, animate]);
  return shown;
}
