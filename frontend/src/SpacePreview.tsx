/** 空间确认进入门窗；完整核对空间与门窗后可明确选择直接进入画布。 */
import { useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, Loader2, MousePointer2, PencilRuler, Plus, Trash2 } from "lucide-react";
import { api, uid, roomTypes, type Obj } from "./types";
import { Button } from "./ui";
import { Plan, type Selection } from "./Plan";
import { SceneModel3D } from "./SceneModel3D";
import { wipeNotice, wipeRecognizedRooms } from "./spaceWipe";
import { boundary, spaceShell, withSpaceShell, snapBoundary } from "./spaceGeometry";
import { withRoomPolygon } from "./roomPolygon";
import { FurniturePanel, createFurniture, furnitureFromModel, pointInSpace } from "./FurniturePanel";
import { withFurniturePolygon, deleteFurniturePolygon } from "./furniturePolygon";
import { revealFlash } from "./reveal";
import { DrawingProgress, type EditingPhase } from "./DrawingProgress";
import type { ReactNode } from "react";

export function SpacePreviewLayer({
  id,
  project,
  design,
  onChange,
  beforeReview,
  onConfirmed,
  confirmSpaces,
  confirmRooms,
  initialPhase,
  previewContent,
  loadPlanBackground = true,
  backgroundRect,
  geometryPath,
  notify,
  onClose,
  job,
  floor = 1,
  background = "",
}: {
  id: string;
  project: Obj;
  design: Obj;
  onChange: (d: Obj, history?: boolean) => void;
  beforeReview?: () => Promise<unknown>;
  onConfirmed?: () => Promise<unknown>;
  confirmSpaces?: () => Promise<unknown>;
  confirmRooms?: () => Promise<unknown>;
  initialPhase?: EditingPhase;
  previewContent?: ReactNode;
  loadPlanBackground?: boolean;
  backgroundRect?: { x: number; y: number; w: number; h: number } | null;
  geometryPath?: string;
  notify: (s: string) => void;
  onClose: () => void;
  /** 生成进度（state=idle/running/done/error）；done 之后才给「确认 / 修改」。 */
  job: Obj;
  /** 当前楼层（多层的项目只显示本层的空间）。 */
  floor?: number;
  /** 改边界时铺在下面的底图（对着图纸改，最准）。 */
  background?: string;
}) {
  // 项目已经确认过还进这个界面（画布上「空间预览 / 修改空间与门窗」）＝回来改东西：
  // 默认落在「修改空间」，进度条也不会再退回「三维预览 29%」那种跟所在环节对不上的显示。
  const alreadyConfirmed = design.spaceDefinition?.status === "confirmed";
  const startingPhase: EditingPhase = initialPhase
    || (alreadyConfirmed ? "spaces"
      : (["spaces", "openings", "furniture"].includes(design.spaceDefinition?.workflowStep) ? design.spaceDefinition.workflowStep : "review"));
  const [phase, setPhase] = useState<EditingPhase>(startingPhase);
  const [tab, setTab] = useState<"preview" | "edit" | "furniture">(startingPhase === "review" ? "preview" : startingPhase === "furniture" ? "furniture" : "edit");
  // 底图摆在设计坐标的哪一块（后端按图纸外接框算好）：给 Plan 之后，边界就压在图纸上了。
  const [planBg, setPlanBg] = useState<Obj | null>(null);
  const [legacyFurniture, setLegacyFurniture] = useState<Obj[]>([]);
  const [legacyAvailable, setLegacyAvailable] = useState(false);
  const [legacyLoading, setLegacyLoading] = useState(loadPlanBackground && !Array.isArray(design.furniture));
  const [legacyRetry, setLegacyRetry] = useState(0);
  useEffect(() => {
    if (!loadPlanBackground) return;
    setLegacyLoading(!Array.isArray(design.furniture));
    let dead = false;
    let tries = 0;
    const tick = async () => {
      try {
        const s: Obj = await api(`/lighting3d/${id}`);
        if (dead) return;
        setLegacyFurniture(furnitureFromModel(s?.furniture || [], design.rooms || []));
        setLegacyAvailable(true);
        setLegacyLoading(false);
        if (s?.plan_background) {
          setPlanBg(s.plan_background);
          return;
        }
      } catch {
        // 家具摘要暂不可用时仍允许确认空间；未读取到的家具不写空数组覆盖。
        if (!dead) setLegacyLoading(false);
      }
      if (!dead && (tries += 1) < 6) window.setTimeout(tick, 2500);
    };
    void tick();
    return () => {
      dead = true;
    };
  }, [id, loadPlanBackground, legacyRetry, job?.state]);
  const [selection, setSelection] = useState<Selection>(null);
  const [tool, setTool] = useState("select");
  // 绘制画布的滚轮缩放：显示当前倍数，「适应画布」把它还原。
  const [viewZoom, setViewZoom] = useState(1);
  const [viewReset, setViewReset] = useState(0);
  // 家具（2026-10-16）：家具调整也在这个界面里做，和空间确认同一处；画布上只动家具，
  // 空间操作一律不在这层（空间走「修改空间」，editableRooms 关掉）。
  const [furnSel, setFurnSel] = useState("");
  const [placingFurn, setPlacingFurn] = useState("");
  const [movingFurn, setMovingFurn] = useState(false);
  const furnTool = placingFurn || movingFurn ? "place-furniture" : tool;
  /** 画布上点一下：放新家具，或把选中的家具挪过去（与画布家具调整同一套规则）。 */
  const placeFurniture = (p: { x: number; y: number }) => {
    const room = rooms.find((r) => (r.floor || 1) === floor && pointInSpace(r, p.x, p.y));
    if (!room) { notify("请在空间内单击家具位置"); return; }
    const rows = (editorDesign.furniture || []) as Obj[];
    if (movingFurn && furnSel) {
      commitDesign({ ...editorDesign, furniture: rows.map(f => f.id === furnSel ? { ...f, ...p, roomId: room.id, floor } : f) });
    } else if (placingFurn) {
      const item = createFurniture(placingFurn, room, p.x, p.y);
      commitDesign({ ...editorDesign, furniture: [...rows, item] });
      setFurnSel(item.id);
    }
    setMovingFurn(false); setPlacingFurn(""); setTool("select");
  };
  /** 画完一圈家具轮廓：选中了就重画它的边界，没选就按这圈点新增一件（类型＝面板里选的放置类型）。 */
  const applyFurnPolygon = (pts: { x: number; y: number }[]) => {
    if (pts.length < 3) return;
    const rows = (editorDesign.furniture || []) as Obj[];
    try {
      if (furnSel) {
        const base = rows.find(f => f.id === furnSel);
        if (base) {
          const updated = { ...withFurniturePolygon(base, pts), roomId: base.roomId };
          commitDesign({ ...editorDesign, furniture: rows.map(f => f.id === furnSel ? updated : f) });
          notify(`已按画的轮廓改「${base.kind}」的边界，可继续拖顶点微调`);
        }
      } else {
        const kind = placingFurn || "沙发";
        const room = rooms.find(r => pointInSpace(r, pts[0].x, pts[0].y));
        const item = withFurniturePolygon(createFurniture(kind, room || { id: "", heightM: 3 } as Obj, pts[0].x, pts[0].y), pts);
        commitDesign({ ...editorDesign, furniture: [...rows, item] });
        setFurnSel(item.id);
        notify(`已按轮廓新增「${kind}」${room ? `（${room.name}）` : "（未归属空间）"}，可拖顶点继续改`);
      }
    } catch (e: any) { notify(e.message); }
    setPlacingFurn(""); setMovingFurn(false); setTool("select");
  };
  // 选中空间（列表聚焦或画布点选）→ 那一行拉进视野闪一下；球在列表下方也要看得见（口径③）。
  useEffect(() => {
    if (tab !== "edit" || selection?.kind !== "rooms" || !selection.id) return;
    revealFlash(document.querySelector(`[data-room-row="${selection.id}"]`) as HTMLElement | null);
  }, [selection?.kind, selection?.id, tab]);
  // 正在按底图重画哪个空间的边界（空＝按底图新建一个）。
  const [redrawRoom, setRedrawRoom] = useState<Obj | null>(null);
  const [heightRoom, setHeightRoom] = useState<Obj | null>(null);
  const [heightError, setHeightError] = useState("");
  const [mergeTarget, setMergeTarget] = useState("");
  const [geometryBusy, setGeometryBusy] = useState(false);
  const editorDesign = { ...design, furniture: design.furniture ?? (legacyAvailable ? legacyFurniture : undefined) };
  const commitDesign = (next: Obj, history?: boolean) => onChange(withSpaceShell({
    ...next, furniture: (next.furniture ?? (legacyAvailable ? legacyFurniture : undefined))?.map((f: Obj) => {
      const room = (next.rooms || []).find((r: Obj) => (r.floor || 1) === (f.floor || 1) && pointInSpace(r, f.x, f.y));
      return { ...f, roomId: room?.id || "" };
    }),
    spaceDefinition: { ...(next.spaceDefinition || {}), status: "previewing", workflowStep: phase,
      editingFloor: floor, ...(phase === "spaces" ? { roomsConfirmedAt: "", openingsConfirmedAt: "" } : {}) },
  }), history);
  const removeRoom = (rid: string, base: Obj = editorDesign) => {
    commitDesign({ ...base, rooms: (base.rooms || []).filter((r: Obj) => r.id !== rid),
      openings: (base.openings || []).filter((o: Obj) => o.roomId !== rid),
      furniture: (base.furniture || []).map((f: Obj) => f.roomId === rid ? { ...f, roomId: "" } : f),
      fixtures: (base.fixtures || []).map((f: Obj) => f.roomId === rid ? { ...f, roomId: "" } : f),
      devices: (base.devices || []).map((d: Obj) => d.roomId === rid ? { ...d, roomId: "" } : d) });
    setSelection(null);
  };
  useEffect(() => {
    if (tool !== "draw-poly") return;
    const cancel = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setTool("select"); setRedrawRoom(null); notify("绘制已取消；已删除的旧空间不会恢复，可重新新建空间"); }
    };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, [tool]);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState("");
  // 切换回预览时重挂三维视图：改完名字/边界，预览要立刻是新样子。
  const [visit, setVisit] = useState(0);
  const rooms = ((design?.rooms || []) as Obj[]).filter((r) => (r.floor || 1) === floor);
  const state = String(job?.state || "running");
  const pct = Math.round((Number(job?.pct) || 0) * 100);

  useEffect(() => {
    if (tab === "preview") setVisit((v) => v + 1);
  }, [tab]);

  /** 在底图上画完一圈多边形：选中空间就替换它的边界，没选就新建一个空间。 */
  const applyPolygon = (pts: { x: number; y: number }[]) => {
    if (pts.length < 3) return;
    let geometry: Obj;
    try { geometry = withRoomPolygon({}, pts); }
    catch (e: any) { notify(e.message); return; }
    const originalHeightM = redrawRoom?.originalHeightM || 3;
    const newRoom: Obj = { ...(redrawRoom || {}), ...geometry, id: uid(),
      name: redrawRoom?.name || "新空间", type: redrawRoom?.type || "新空间",
      spaceCode: redrawRoom?.spaceCode || "x", floor,
      originalHeightM, heightM: redrawRoom?.heightM || Math.min(Number(project?.ceilingNet) || originalHeightM, originalHeightM),
      color: redrawRoom?.color || "#e6e3d8", source: "manual" };
    delete newRoom.cadRoomId;
    setHeightRoom(newRoom); setHeightError("");
    setTool("select");
    setRedrawRoom(null);
  };
  const saveHeight = () => {
    if (!heightRoom) return;
    const original = Number(heightRoom.originalHeightM), finished = Number(heightRoom.heightM);
    if (!Number.isFinite(original) || !Number.isFinite(finished) || original < .5 || original > 20 || finished < .5 || finished > original) {
      setHeightError("完成面层高须在 0.5 米至原始层高之间，原始层高须在 0.5–20 米之间"); return;
    }
    const saved: Obj = { ...heightRoom, name: String(heightRoom.name || "").trim() || "新空间", heightCalibrated: true };
    const exists = (design.rooms || []).some((r: Obj) => r.id === saved.id);
    commitDesign({ ...design, rooms: exists
      ? design.rooms.map((r: Obj) => r.id === saved.id ? saved : r) : [...(design.rooms || []), saved] });
    setSelection({ kind: "rooms", id: saved.id }); setHeightRoom(null);
    notify(`已保存「${saved.name}」及层高，墙体已按多边形边界生成`);
  };
  const drawOpening = (start: NonNullable<ReturnType<typeof snapBoundary>>, end: NonNullable<ReturnType<typeof snapBoundary>>, type: string) => {
    const a = Math.min(start.t, end.t), b = Math.max(start.t, end.t);
    if ((design.openings || []).some((o: Obj) => o.roomId === start.roomId && o.edgeIndex === start.edgeIndex && a < o.end && b > o.start)) {
      notify("该段边界已有门窗，请换一段或先删除已有门窗"); return;
    }
    const room = rooms.find(r => r.id === start.roomId)!;
    const h = Number(room.heightM) || 3;
    const opening = { id: uid(), roomId: start.roomId, edgeIndex: start.edgeIndex, start: a, end: b,
      type, source: "manual", floor, x: start.x, y: start.y, width: Math.hypot(end.x - start.x, end.y - start.y),
      sillHeight: type === "门" ? 0 : Math.min(.9, h / 3), heightM: Math.min(type === "门" ? 2.1 : 1.5, h - (type === "门" ? 0 : Math.min(.9, h / 3))) };
    commitDesign({ ...design, openings: [...(design.openings || []), opening] });
    notify(`已绘制${type}，其余边界自动生成墙体`); setTool("select");
  };
  const beginDrawing = (redraw = false) => {
    if (tool === "draw-poly") { setTool("select"); setRedrawRoom(null); return; }
    const target = redraw && selection?.kind === "rooms" ? rooms.find(r => r.id === selection.id) : null;
    const { design: cleaned, removed, names, removedOutlineCount } = wipeRecognizedRooms(editorDesign, floor);
    if (target) removeRoom(target.id, cleaned);
    else if (cleaned !== design) commitDesign(cleaned);
    setSelection(null); setRedrawRoom(target || null); setTool("draw-poly");
    notify(wipeNotice(removed.length, names, removedOutlineCount));
  };

  const rename = (rid: string, name: string) =>
    commitDesign({
      ...design,
      rooms: ((design?.rooms || []) as Obj[]).map((r) => (r.id === rid ? { ...r, name } : r)),
    });

  const alterGeometry = async (action: "merge" | "split") => {
    if (selection?.kind !== "rooms") return;
    setGeometryBusy(true);
    try {
      const result = await api<Obj>(geometryPath || `/projects/${id}/space-definition/geometry`, {
        method: "POST", body: JSON.stringify({ design: editorDesign, action, id: selection.id, otherId: mergeTarget }),
      });
      commitDesign(result); setSelection(null); setMergeTarget("");
      notify(action === "merge" ? "已按多边形边界合并空间" : "已拆分空间，请核对各空间名称与层高");
    } catch (e: any) { notify(e.message); }
    finally { setGeometryBusy(false); }
  };

  const editSpaces = () => {
    onChange({ ...editorDesign, spaceDefinition: { ...design.spaceDefinition, status: "previewing",
      workflowStep: "spaces", editingFloor: floor, roomsConfirmedAt: "", openingsConfirmedAt: "" } });
    setPhase("spaces"); setTab("edit"); setTool("select"); setSelection(null);
  };
  /** 门窗核对完 → 进「修改家具」这一步（2026-10-16：确认门窗之后是修改家具，改完点确认才进画布）。 */
  const editFurniture = (note = "这一步核对家具，确认后进入画布") => {
    onChange({ ...editorDesign, spaceDefinition: { ...design.spaceDefinition, status: "previewing",
      workflowStep: "furniture", editingFloor: floor } });
    setPhase("furniture"); setTab("furniture"); setTool("select"); setSelection(null);
    setFurnSel(""); setPlacingFurn(""); setMovingFurn(false);
    notify(note);
  };
  const validateRooms = () => {
    if (!(design.rooms || []).length) { notify("请先绘制或导入至少一个空间"); editSpaces(); return false; }
    const blank = (design.rooms || []).find((r: Obj) => !String(r.name || "").trim());
    if (blank) {
      notify("还有空间没填名字：请先在「修改空间」里补上"); editSpaces(); return false;
    }
    return true;
  };
  const confirm = async (direct = false) => {
    if (confirming || !validateRooms()) return;
    setConfirming(true); setConfirmError("");
    try {
      // 新识别的家具一并写入设计，进入画布后仍可逐件调整。
      if (!Array.isArray(design.furniture) && legacyAvailable) onChange(editorDesign);
      await beforeReview?.();
      // ① 空间阶段：确认空间 → 去绘制门窗
      if ((phase === "review" || phase === "spaces") && !direct) {
        if (confirmRooms) await confirmRooms();
        else {
          onChange({ ...editorDesign, spaceDefinition: { ...design.spaceDefinition, status: "previewing",
            workflowStep: "openings", editingFloor: floor, roomsConfirmedAt: new Date().toISOString(), openingsConfirmedAt: "" } });
          await beforeReview?.();
        }
        setPhase("openings"); setTab("edit"); setTool("select"); setSelection(null);
        notify("空间已保存，请绘制或核对门窗，完成后核对家具");
        return;
      }
      // ② 门窗阶段（以及预览页的「直接」快捷）：先落到「修改家具」，不直接进画布
      if (phase !== "furniture") {
        if (direct && confirmRooms) { await confirmRooms(); await beforeReview?.(); }
        editFurniture(direct ? "空间与门窗按原样通过；这一步核对家具，确认后进入画布"
          : "门窗已核对：这一步核对家具，确认后进入画布");
        return;
      }
      // ③ 家具这一步点确认＝真正确认空间/门窗/家具，才进画布
      if (confirmSpaces) await confirmSpaces();
      else await api(`/lighting3d/${id}/confirm`, {
          method: "POST", body: JSON.stringify({ reviewer: (project as Obj)?.designer || "设计师" }),
        });
      await onConfirmed?.();
      notify("空间、门窗与家具已确认，已进入画布");
      onClose();
    } catch (e: any) {
      setConfirmError(`确认失败：${e.message}`);
      notify(`确认失败：${e.message}`);
    } finally {
      setConfirming(false);
    }
  };

  return (
    <div className="space-preview-overlay" role="dialog" aria-label="空间预览">
      <div className="space-preview-panel" data-phase={phase}>
        <header>
          <div>
            <h3>{tab === "furniture" ? "修改家具 · 确认后进入画布" : phase === "review" ? "识别完成 · 三维预览" : phase === "spaces" ? "修改空间 · 确认空间" : "绘制门窗 · 确认进入画布"}</h3>
            <p>
              {tab === "furniture" ? "选中家具后可拖位置、拖边或拖角改宽深（对面那条边钉住），也可以拖顶点、加/删边界点、按多边形重画轮廓——跟空间一个编辑方式；右侧可改类型/朝向，也能复制、删除、恢复矩形。核对完点右下「确认家具，进入画布」。这一页只动家具，空间操作走「修改空间」。"
                : phase === "review" ? "先核对三维中的空间。确认空间后进入门窗绘制；空间和门窗全部正确时可跳过绘制直接去核对家具；核对完家具才进入画布。"
                : phase === "spaces" ? "单击多边形拐点，点回起点闭合；逐空间标定层高。确认空间后进入门窗绘制。"
                : "在墙边单击门窗两端绘制洞口，其余边界自动生成墙体。门窗正确或无需补画时，点「确认门窗」进入家具核对。"}
            </p>
          </div>
          <div className="space-preview-tabs">
            <button
              className={tab === "preview" ? "on" : ""}
              onClick={async () => { try { await beforeReview?.(); setTab("preview"); } catch (e: any) { notify(`保存失败：${e.message}`); } }}
              disabled={state !== "done"}
            >
              三维预览
            </button>
            <button
              className={tab === "edit" && phase === "spaces" ? "on" : ""}
              onClick={editSpaces}
              disabled={state !== "done"}
            >
              修改空间
            </button>
            <button className={tab === "edit" && phase === "openings" ? "on" : ""}
              disabled={state !== "done" || (phase !== "openings" && !alreadyConfirmed)}
              onClick={() => { setPhase("openings"); setTab("edit"); setTool("select"); }}>绘制门窗</button>
            <button className={tab === "furniture" ? "on" : ""}
              disabled={state !== "done" || (phase !== "furniture" && !alreadyConfirmed)}
              onClick={() => { setPhase("furniture"); setTab("furniture"); setTool("select"); setPlacingFurn(""); setMovingFurn(false); }}>修改家具</button>
          </div>
        </header>
        <DrawingProgress project={project} design={design} job={job} phase={phase} confirmed={alreadyConfirmed}
          onStep={step => {
            if (step === "review") setTab("preview");
            if (step === "spaces") editSpaces();
            if (step === "openings" && phase === "openings") { setTab("edit"); setTool("select"); }
          }} />

        {legacyLoading && state === "done" ? (
          <div className="space-preview-progress"><p><Loader2 size={14} /> 正在载入已有家具…</p>
            <Button onClick={() => setLegacyRetry(v => v + 1)}>重新载入已有家具</Button></div>
        ) : state === "running" || state === "idle" ? (
          <div className="space-preview-progress">
            <p><Loader2 size={14} /> {job.recognizing === false ? "正在载入当前步骤…" : `图纸识别与三维生成中… ${pct}%`}　{job?.stage || ""}</p>
            <div className="bar"><i style={{ width: `${pct}%` }} /></div>
            <p className="subtle">
              识别完成后显示三维预览，核对空间后可直接确认或进入修改。
            </p>
          </div>
        ) : state === "error" ? (
          <div className="space-preview-progress">
            <p className="task-error"><AlertCircle size={14} /> 生成失败：{job?.error || job?.message || "未知原因"}</p>
            <p className="subtle">可以在项目里「图纸与底图」重新导入，或到三维页重试。</p>
          </div>
        ) : tab === "preview" ? (
          <div className="space-preview-view">
            {previewContent || <SceneModel3D
              key={`preview-${visit}`}
              projectId={id}
              hasDxf={loadPlanBackground && (project.files || []).some((f: Obj) => String(f.type || "").toUpperCase() === "DXF")}
              design={editorDesign as any}
              floor={floor}
            />}
          </div>
        ) : (
          <div className="space-preview-edit">
            <div className="space-preview-canvas">
              <div className="space-preview-canvas-tools">
                <Button variant={tool === "select" ? "primary" : ""} onClick={() => { if (tab === "furniture") { setPlacingFurn(""); setMovingFurn(false); } setTool("select"); }}>
                  <MousePointer2 size={14} /> {tab === "furniture" ? "选择家具" : phase === "spaces" ? "选择 / 移动边界" : "选择门窗"}
                </Button>
                {tab === "furniture" && <>
                <Button disabled={!furnSel} variant={tool === "add-furn-point" ? "primary" : ""}
                  onClick={() => { setTool(tool === "add-furn-point" ? "select" : "add-furn-point"); setPlacingFurn(""); setMovingFurn(false); }}>
                  <Plus size={12} /> 增加边界点
                </Button>
                <Button disabled={!furnSel} variant={tool === "delete-furn-point" ? "primary" : ""}
                  onClick={() => { setTool(tool === "delete-furn-point" ? "select" : "delete-furn-point"); setPlacingFurn(""); setMovingFurn(false); }}>
                  <Trash2 size={12} /> 删除边界点
                </Button>
                <Button variant={tool === "draw-furn-poly" ? "primary" : ""}
                  onClick={() => { setTool(tool === "draw-furn-poly" ? "select" : "draw-furn-poly"); setPlacingFurn(""); setMovingFurn(false); }}>
                  <MousePointer2 size={12} />
                  {tool === "draw-furn-poly" ? "取消绘制" : furnSel ? "重画选中家具轮廓（多边形）" : "画新家具轮廓（多边形）"}
                </Button>
                <Button disabled={!furnSel} onClick={() => { const row = (editorDesign.furniture || []).find((f: Obj) => f.id === furnSel);
                  if (!row || !row.points) return;
                  commitDesign({ ...editorDesign, furniture: (editorDesign.furniture || []).map((f: Obj) => f.id === furnSel ? deleteFurniturePolygon(f) : f) });
                  notify(`已把「${row.kind}」恢复成矩形边界（宽深可继续调）`); }}>恢复矩形边界</Button>
                </>}
                {tab === "edit" && phase === "spaces" && <>
                <Button disabled={selection?.kind !== "rooms"} variant={tool === "add-room-point" ? "primary" : ""}
                  onClick={() => setTool("add-room-point")}><Plus size={12} /> 增加边界点</Button>
                <Button disabled={selection?.kind !== "rooms"} variant={tool === "delete-room-point" ? "primary" : ""}
                  onClick={() => setTool("delete-room-point")}><Trash2 size={12} /> 删除边界点</Button>
                <Button
                  variant={tool === "draw-poly" ? "primary" : ""}
                  onClick={() => beginDrawing()}
                >
                  <MousePointer2 size={12} />
                  {tool === "draw-poly"
                    ? "取消绘制"
                    : "按底图新建空间（多边形）"}
                </Button>
                <Button disabled={selection?.kind !== "rooms"} onClick={() => beginDrawing(true)}>重画选中空间</Button>
                <select aria-label="合并目标空间" value={mergeTarget} onChange={e => setMergeTarget(e.target.value)}>
                  <option value="">选择合并目标</option>
                  {rooms.filter(r => r.id !== selection?.id).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
                <Button disabled={selection?.kind !== "rooms" || !mergeTarget || geometryBusy} onClick={() => alterGeometry("merge")}>合并空间</Button>
                <Button disabled={selection?.kind !== "rooms" || geometryBusy} onClick={() => alterGeometry("split")}>拆分空间</Button>
                </>}
                {tab === "edit" && phase === "openings" && <>
                <Button disabled={!rooms.length} variant={tool === "draw-door" ? "primary" : ""} onClick={() => { setTool("draw-door"); notify("在同一条空间边界上依次单击门洞两端"); }}>绘制门</Button>
                <Button disabled={!rooms.length} variant={tool === "draw-window" ? "primary" : ""} onClick={() => { setTool("draw-window"); notify("在同一条空间边界上依次单击窗洞两端"); }}>绘制窗</Button>
                </>}
                <span className="space-preview-zoom" data-testid="draw-zoom">
                  {Math.round(viewZoom * 100)}%
                  <Button onClick={() => setViewReset(v => v + 1)} disabled={viewZoom === 1}>适应画布</Button>
                </span>
                <span className="subtle">
                  {tab === "furniture" ? (movingFurn ? "移动家具：在空间内单击新位置 · Esc 取消"
                    : placingFurn ? "放置家具：在空间内单击落位 · Esc 取消"
                    : tool === "add-furn-point" ? "点选中家具的某条边 → 在那条边上增加一个顶点"
                    : tool === "delete-furn-point" ? "点选中家具的某个顶点删除它；至少保留 3 个点"
                    : tool === "draw-furn-poly" ? (furnSel ? "单击各拐点重画选中家具的轮廓，点回第一个点收口 · Esc 取消"
                      : "单击各拐点画一件新家具的轮廓，点回第一个点收口 · Esc 取消")
                    : "单击选中家具：拖动位置；拖边或拖角改宽深（对面那条边钉住）；拖顶点、加点、删点跟空间一样")
                    : tool === "add-room-point" ? "点击选中空间的边界线增加拐点，再切回选择工具拖动点"
                    : tool === "delete-room-point" ? "点击选中空间的顶点删除；至少保留3个点"
                    : tool === "draw-poly"
                    ? "单击各拐点，点击第一个点闭合空间；闭合后标定层高。Esc 取消"
                    : tool === "draw-door" || tool === "draw-window" ? "在空间边界上单击洞口的两端，自动吸附；其余部分自动生成墙体"
                    : phase === "openings" ? "空间范围已保存；补画或核对门窗后确认进入画布。需要改边界可返回修改空间。"
                    : "按底图新建空间会清除旧识别空间及墙线、门窗、标注，保留手绘内容；拖动顶点可改形状"}
                  {" · 滚轮缩放底图，空白处按住拖动平移"}
                  {phase === "openings" && tab !== "furniture" ? " · 空间边界已固化" : tab === "furniture" ? " · 空间与门窗已固化" : ""}
                </span>
              </div>
              <Plan
                design={editorDesign as any}
                floor={floor}
                selection={selection}
                onSelect={setSelection}
                onChange={(v: Obj, h?: boolean) => {
                  // 上一级固化（2026-10-17）：门窗阶段锁定空间与墙；家具阶段再锁门窗。
                  // 画布上固化层已不接收指针，这里再兜一层：保存时一律还原成进入本级时的样子。
                  const locked = tab === "furniture" || phase === "furniture"
                    ? { rooms: design.rooms, walls: design.walls, openings: design.openings }
                    : phase === "openings" ? { rooms: design.rooms, walls: design.walls } : {};
                  commitDesign({ ...v, ...locked }, h);
                }}
                onPolygon={applyPolygon}
                onOpening={drawOpening}
                onEditError={notify}
                tool={tab === "furniture" ? furnTool : tool}
                onPlacePoint={tab === "furniture" ? placeFurniture : undefined}
                selectedFurnitureId={furnSel}
                onFurnitureSelect={setFurnSel}
                editableFurniture={tab === "furniture"}
                onFurnPolygon={tab === "furniture" ? applyFurnPolygon : undefined}
                zoom={1}
                wheelZoom
                viewReset={viewReset}
                onViewZoom={setViewZoom}
                stage={tab === "furniture" ? "furniture" : phase === "openings" ? "openings" : "spaces"}
                showGrid={false}
                showStructureLayer={false}
                showOpeningLayer
                showFixtureLayer={false}
                showDeviceLayer={false}
                showLights={false}
                showFurniture={false}
                showCanonicalFurniture={tab === "furniture"}
                editableRooms={tab === "edit" && phase === "spaces"}
                showLabels
                background={(planBg?.url as string) || background}
                backgroundRect={
                  planBg
                    ? { x: Number(planBg.x), y: Number(planBg.y), w: Number(planBg.w), h: Number(planBg.h) }
                    : backgroundRect || null
                }
                readonly={false}
                projectArea={Number(project?.area) || 100}
                planMasked={false}
              />
            </div>
            <aside className="space-preview-rooms">
              {tab === "furniture" ? <FurniturePanel design={editorDesign as Obj} floor={floor} selected={furnSel}
                onSelect={setFurnSel} onChange={(v: Obj) => commitDesign(v as Obj)}
                placing={placingFurn} moving={movingFurn}
                onMove={() => { setMovingFurn(v => !v); setPlacingFurn(""); setTool("select"); }}
                onPlace={(kind: string) => { setPlacingFurn(kind); setMovingFurn(false); setTool(kind ? "place-furniture" : "select"); }} />
              : phase === "spaces" ? <>
              <h4>空间名称（直接改）</h4>
              {rooms.map((r) => (
                <div key={r.id} className="space-preview-row" data-room-row={r.id}>
                  <input
                    list="space-preview-names"
                    value={r.name || ""}
                    placeholder="空间名称"
                    onChange={(e) => rename(r.id, e.target.value)}
                    onFocus={() => {
                      setTool("select");
                      setSelection({ kind: "rooms", id: r.id } as Selection);
                    }}
                  />
                  <button type="button" className="space-preview-delete" aria-label={`删除空间 ${r.name}`} onClick={() => {
                    setTool("select"); setRedrawRoom(null); removeRoom(r.id); notify(`已删除「${r.name}」空间`);
                  }}><Trash2 size={12} /> 删除空间</button>
                  <small>
                    {Number(r.area) > 0 ? `${Math.round(Number(r.area))} m²` : "面积待校核"}
                    {selection?.kind === "rooms" && selection.id === r.id ? " · 已在画布选中（可拖边界）" : ""}
                  </small>
                  <small>原始 {r.originalHeightM || project.ceiling || 3} m · 完成面 {r.heightM || 3} m</small>
                  <Button onClick={() => { setHeightRoom({ ...r, originalHeightM: r.originalHeightM || project.ceiling || 3 }); setHeightError(""); }}>标定层高</Button>
                </div>
              ))}
              {!rooms.length && <p className="subtle">还没有空间：点「按底图新建空间」，单击拐点并点回起点闭合。</p>}
              <datalist id="space-preview-names">{roomTypes.map(name => <option key={name} value={name} />)}</datalist>
              </> : <>
              <h4>门窗</h4>
              {(spaceShell(design, floor).openings).map((o: Obj) => <div className="space-preview-opening" key={o.id}>
                <b>{rooms.find(r => r.id === o.roomId)?.name} · {o.type}</b>
                <small>宽 {(o.width / 26).toFixed(2)} m</small>
                <label>洞口高度 m<input aria-label={`${o.type}洞口高度 m`} type="number" min=".1" step=".1" value={o.heightM}
                  onChange={e => commitDesign({ ...design, openings: design.openings.map((x: Obj) => x.id === o.id ? { ...x, heightM: +e.target.value } : x) })} /></label>
                {o.type === "窗" && <label>窗台高度 m<input aria-label="窗台高度 m" type="number" min="0" step=".1" value={o.sillHeight}
                  onChange={e => commitDesign({ ...design, openings: design.openings.map((x: Obj) => x.id === o.id ? { ...x, sillHeight: +e.target.value } : x) })} /></label>}
                <Button onClick={() => commitDesign({ ...design, openings: design.openings.filter((x: Obj) => x.id !== o.id) })}>删除{o.type}</Button>
              </div>)}
              {!spaceShell(design, floor).openings.length && <p className="subtle">尚无门窗。单击墙边两端绘制；本层无需门窗时也可直接确认。</p>}
              </>}
            </aside>
          </div>
        )}

        <footer>
          {confirmError && <p role="alert" className="task-error">{confirmError}</p>}
          {state === "done" && tab === "edit" ? (
            <Button onClick={async () => { try { await beforeReview?.(); setTab("preview"); } catch (e: any) { notify(`保存失败：${e.message}`); } }}>
              <PencilRuler size={14} /> 看三维预览
            </Button>
          ) : state === "done" ? (
            <Button onClick={phase === "openings" ? () => setTab("edit") : editSpaces}>
              <PencilRuler size={14} /> {phase === "review" ? "空间不正确，修改空间" : phase === "openings" ? "返回门窗绘制" : "返回空间修改"}
            </Button>
          ) : null}
          {phase === "openings" && <Button disabled={confirming} onClick={editSpaces}>返回修改空间</Button>}
          {phase === "furniture" && <Button disabled={confirming} onClick={() => { setPhase("openings"); setTab("edit"); setTool("select"); }}>返回绘制门窗</Button>}
          {phase === "review" && <Button disabled={state !== "done" || confirming || legacyLoading}
            onClick={() => void confirm(true)}>空间和门窗正确，直接去修改家具</Button>}
          <Button variant="primary" disabled={state !== "done" || confirming || legacyLoading} onClick={() => void confirm()}>
            <CheckCircle2 size={14} /> {confirming ? "确认中…" : phase === "furniture" ? "确认家具，进入画布" : phase === "openings" ? "确认门窗，下一步修改家具" : "确认空间，下一步绘制门窗"}
          </Button>
          <Button onClick={onClose}>{state === "done" ? "稍后再确认" : "关闭"}</Button>
        </footer>
      </div>
      {heightRoom && <div className="space-height-backdrop">
        <form role="dialog" aria-label="标定空间层高" className="space-height-dialog" onSubmit={e => { e.preventDefault(); saveHeight(); }}>
          <h3>标定空间层高</h3>
          <label>空间名称<input aria-label="空间名称" list="space-preview-names" value={heightRoom.name} onChange={e => setHeightRoom({ ...heightRoom, name: e.target.value })} /></label>
          <label>原始层高 m<input aria-label="原始层高 m" type="number" min=".5" max="20" step=".1" required value={heightRoom.originalHeightM}
            onChange={e => setHeightRoom({ ...heightRoom, originalHeightM: +e.target.value })} /></label>
          <label>完成面层高 m<input aria-label="完成面层高 m" type="number" min=".5" max={heightRoom.originalHeightM} step=".1" required value={heightRoom.heightM}
            onChange={e => setHeightRoom({ ...heightRoom, heightM: +e.target.value })} /></label>
          <p>原始层高默认 3 米；完成面层高用于生成该空间的墙体和门窗。</p>
          {heightError && <p role="alert">{heightError}</p>}
          <Button type="submit" variant="primary">保存空间与层高</Button>
          <Button onClick={() => setHeightRoom(null)}>取消</Button>
        </form>
      </div>}
    </div>
  );
}
