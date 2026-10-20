/**
 * 「按底图新建空间」＝不认旧的那套识别结果。
 *
 * 老板 2026-10-14 口径：「在画布中选择了按底图新建空间，旧有的被识别的空间要全量删除。」
 * 所以点下这个工具的那一刻，先把**本层所有识别/自动来源**的空间、墙线、门窗、标注全量删掉，只留手绘的
 * （与既有口径一致：「人工绘制空间和灯具不会被删除」；识别空间要恢复就重新导入图纸
 * 再生成一次）。
 *
 * 纯函数、不 import 其它模块：`node --experimental-strip-types` 能直接跑测试
 * （与 roomPolygon.ts / wallMount.ts / furnitureEdits.ts 同一约束）。
 */
export type WipeObj = {
  id?: string;
  name?: string;
  source?: string;
  floor?: number;
  roomId?: string;
  [k: string]: unknown;
};

export type WipeDesign = {
  rooms?: WipeObj[];
  walls?: WipeObj[];
  openings?: WipeObj[];
  texts?: WipeObj[];
  fixtures?: WipeObj[];
  devices?: WipeObj[];
  furniture?: WipeObj[];
  [k: string]: unknown;
};

/** 手绘空间：Plan / SpacePreview 手画、拖动改边界之后都会标 source=manual。 */
export function isHandDrawnRoom(r: WipeObj | null | undefined): boolean {
  return r?.source === "manual" || (r?.source === "outsourcing-approved" && r?.geometrySource === "manual");
}

/**
 * 本层里「识别/自动」来源的空间——就是所有非 manual 的：
 * cad / cad-3d / cad-preview / cad-confirmed / semantic-vision / image-analysis /
 * semantic-labels / fixture-code … 后端以后再加新来源也一律算「识别的」。
 */
export function recognizedRooms<T extends WipeObj>(rooms: T[] | undefined, floor = 1): T[] {
  return (rooms || []).filter((r) => Number(r?.floor ?? 1) === floor && !isHandDrawnRoom(r));
}

/**
 * 全量删掉本层识别空间及独立的墙线、门窗、标注。
 * 即使旧版已经删空 rooms，也要继续清理残留图层。
 * 挂在这些空间上的灯具/设备只把 roomId 解除（回到「未归属」），**不删灯具/设备**——
 * 与「删除空间」按钮同一个口径。
 */
export function wipeRecognizedRooms(
  design: WipeDesign,
  floor = 1,
): { design: WipeDesign; removed: WipeObj[]; names: string[]; removedOutlineCount: number } {
  const all = (design?.rooms || []) as WipeObj[];
  const removed = recognizedRooms(all, floor);
  let removedOutlineCount = 0;
  const outlines: Partial<WipeDesign> = {};
  for (const key of ["walls", "openings", "texts"] as const) {
    const rows = design[key];
    if (!rows) continue;
    const kept = rows.filter((x) => Number(x.floor ?? 1) !== floor || isHandDrawnRoom(x));
    if (kept.length !== rows.length) {
      removedOutlineCount += rows.length - kept.length;
      outlines[key] = kept;
    }
  }
  if (!removed.length && !removedOutlineCount) return { design, removed, names: [], removedOutlineCount };
  const gone = new Set(removed.map((r) => String(r.id)));
  const detach = (rows: WipeObj[] | undefined) =>
    (rows || []).map((x) => (gone.has(String(x.roomId)) ? { ...x, roomId: "" } : x));
  return {
    design: {
      ...design,
      ...outlines,
      ...(removed.length ? {
        rooms: all.filter((r) => !gone.has(String(r.id))),
        fixtures: detach(design?.fixtures),
        devices: detach(design?.devices),
        ...(design.furniture ? { furniture: detach(design.furniture) } : {}),
      } : {}),
    },
    removed,
    names: removed.map((r) => String(r?.name ?? "").trim() || "未命名空间"),
    removedOutlineCount,
  };
}

/** 点完这个工具之后给用户看的那句话（面板与测试共用一份，省得文案两处漂）。 */
export function wipeNotice(n: number, names: string[], outlineCount = 0): string {
  const outlineNotice = outlineCount ? `已清除 ${outlineCount} 处旧识别墙线、门窗和标注；` : "";
  if (!n) return outlineNotice + "在底图上描一圈＝新建一个空间：单击拐点，点击第一个点闭合";
  const head = names.slice(0, 3).join("、") + (names.length > 3 ? "…" : "");
  return (
    `已全量删除 ${n} 个识别出来的旧空间（${head}），手绘空间保留；` + outlineNotice +
    "现在按底图描一圈＝新建空间：单击拐点，点击第一个点闭合"
  );
}
