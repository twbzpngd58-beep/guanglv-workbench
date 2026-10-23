/**
 * 三维空间 · 项目的一种「建模方式」
 *
 * 口径（用户 2026-09-26 拍板）：
 *   · 新项目默认 3D；模型嵌在空间画布，交付可以无损切换 2D。
 *   · 上传 DXF → 后台生成三维模型，全程有进度条；成功/失败/失败原因都要看得见。
 *   · 家具按类型出固定样式的模型，只按图纸尺寸缩放。
 *   · 识别不可能全对：房间名（语义）与家具类型都能逐条改。
 *
 * 渲染引擎复用 lighting3d_page/lighting3d.js（挂在 /lighting3d-engine 下的静态脚本），
 * 这里只负责把画布、面板、抽屉和接口串起来。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Upload,
  Loader2,
  AlertCircle,
  CheckCircle2,
  RefreshCw,
  Table2,
  PencilRuler,
} from "lucide-react";
import { api, uid, type Project, type Obj } from "./types";
import { confirmDanger } from "./dangerConfirm";
import { SPACE_CODES, ROLE_CODES, buildFixtureCode, nextSerial, positionsForSpace } from "./codes";
import {
  addRow, addRowAt, batchChange, defaultSize, dupRow, payloadFromRows, removeRow, roomNames,
  rotateRow, rowsFromSummary, setKind, setSize, type FurnRow, type RoomLike,
} from "./furnitureEdits";

const ENGINE = "/lighting3d-engine";

// 家具固定样式的唯一真源：这里只为了确保它先于引擎脚本加载（引擎读 window.GUANGLV_FURN）。
import { FURN_HEIGHT } from "./furnitureModels";

/** 房间名候选：情景按房间名匹配（「客厅/餐厅/过道」这些关键字），所以给固定选项 + 可手填。 */
export const ROOM_NAME_PRESETS = [
  "玄关", "客厅", "餐厅", "厨房", "过道", "主卧", "次卧", "儿童房", "书房",
  "衣帽间", "主卫", "次卫", "客卫", "阳台", "生活阳台", "洗衣房", "茶室",
  "影音室", "健身房", "老人房", "保姆房", "储物间", "楼梯间", "车库",
];

let enginePromise: Promise<void> | null = null;

/** 三个引擎脚本只加载一次（three.js → OrbitControls → 引擎）。 */
function loadEngine(): Promise<void> {
  const w = window as any;
  if (w.__initLighting3D) return Promise.resolve();
  if (enginePromise) return enginePromise;
  // 内嵌模式：引擎自己不要去拉 demo 项目（数据由 React 给）。
  w.__LIGHTING3D_EMBED__ = true;
  enginePromise = new Promise((resolve, reject) => {
    const srcs = [
      `${ENGINE}/vendor/three.min.js`,
      `${ENGINE}/vendor/OrbitControls.js`,
      `${ENGINE}/lighting3d.js?v=${__APP_VERSION__}`,
    ];
    let i = 0;
    const next = () => {
      if (i >= srcs.length) return resolve();
      const s = document.createElement("script");
      s.src = srcs[i++];
      s.onload = next;
      s.onerror = () => {
        enginePromise = null;   // ⚠️ 失败的 promise 不能留着：服务重启那几秒撞上就永久坏（页面里每次进三维都报错）
        reject(new Error("三维引擎加载失败：" + s.src));
      };
      document.head.appendChild(s);
    };
    next();
  });
  return enginePromise;
}

export function Lighting3DView({
  id,
  project,
  notify,
  onClose,
  onSynced,
  onGenerated,
  onLightMove,
  previewOnly = false,
  embedded = false,
}: {
  id: string;
  project: Project;
  notify: (s: string) => void;
  onClose: () => void;
  /** 同步灯位后刷新外层项目（灯具配置页立刻看到） */
  onSynced?: () => Promise<void> | void;
  /** 三维生成（或重新解析）完成时回调：外层据此进「空间预览 → 确认空间」这一步。 */
  onGenerated?: (job: Obj) => void;
  /** 三维里拖完一盏灯：新位置（三维米坐标）交给外层写回设计。 */
  onLightMove?: (id: string, x: number, z: number) => void | Promise<void>;
  /** 纯预览：只给看三维，不出现工作台那排操作（换图纸 / 语义调整 / 布灯 / 同步 / 报价）。 */
  previewOnly?: boolean;
  embedded?: boolean;
}) {
  const [summary, setSummary] = useState<Obj | null>(null);
  const [job, setJob] = useState<Obj | null>(null);
  // 拍板 2026-10-12（本地口径）：编辑面统一在布灯画布 —— 空间一确认，三维就是只读视图。
  // 后端口径一致：空间已确认时 /lights、/circuits、/scenes 的写接口一律 409。
  const spaceConfirmed =
    ((project as any)?.design?.spaceDefinition?.status === "confirmed");
  const [err, setErr] = useState("");
  const [drawer, setDrawer] = useState<"" | "rooms" | "quote" | "edit">("");
  const [quote, setQuote] = useState<Obj | null>(null);
  const [scheme, setScheme] = useState(
    project.smart === "KNX" ? "总线" : project.smart === "无线" ? "无线" : "开闭",
  );
  const reviewed = !!(project as Obj).outsourcingReview;
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);   // 「重试」用：重跑加载引擎/数据的那段
  const fileRef = useRef<HTMLInputElement>(null);
  // 只有「这次真的在生成」才把 job 显示成进度/结果面板，避免打开旧项目就飘一个历史结果。
  const tracking = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const s: Obj = await api(`/lighting3d/${id}`);
      setSummary(s);
      const j = s.job || null;
      // 服务端还在跑（比如刚刷新过页面）就接着盯；否则只在我们自己发起过生成时才显示结果。
      if (j && j.state === "running") tracking.current = true;
      if (tracking.current && j) setJob(j);
      return s;
    } catch (e: any) {
      setErr(e.message);
      return null;
    }
  }, [id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  /* 生成中：轮询进度（进度条靠它）。 */
  const running = job?.state === "running";
  useEffect(() => {
    if (!running) return;
    const t = setInterval(async () => {
      try {
        const j: Obj = await api(`/lighting3d/${id}/job`);
        setJob(j);
        if (j.state !== "running") {
          refresh();
          if (j.state === "done") {
            Promise.resolve(onSynced?.()).catch(() => {});
            // 实测 2026-10-14：「预览界面还是这个，这是不对的」——导入/生成图纸这件事一做完，
            // 就进「空间预览」确认这一步，不再把人丢在工作台上自己去猜哪里确认空间。
            onGenerated?.(j);
          }
        }
      } catch {
        /* 轮询失败不吵，下一次接着来 */
      }
    }, 900);
    return () => clearInterval(t);
  }, [running, id, refresh]);

  /** 三维里拖完一盏灯（现场 2026-10-16「俯视图里能选中灯具但不能拖动」）：
   *  先试写三维自己的灯位（未确认的项目）；空间确认后三维写接口是 409（三维只读），
   *  灯位以**设计**为准，那条路由 onLightMove 回外层写。 */
  const applyLightMove = async (lid: string, x: number, z: number) => {
    const nx = +Number(x).toFixed(3), nz = +Number(z).toFixed(3);
    try {
      await api(`/lighting3d/${id}/lights/${lid}`, { method: "PATCH", body: JSON.stringify({ x: nx, z: nz }) });
    } catch {
      /* 空间已确认：三维只读，位置以设计为准（见 onLightMove） */
    }
    await onLightMove?.(lid, nx, nz);
  };

  /* 数据就绪（或重新生成完）→ 把三维场景交给引擎渲染。 */
  const uploadedAt = summary?.uploaded_at || "";
  const has3d = !!summary?.has3d;
  useEffect(() => {
    if (!has3d) return;
    let cancelled = false;
    (async () => {
      try {
        const d: Obj = await api(`/lighting3d/${id}/data.json`);
        if (cancelled) return;
        if (d?.error) throw new Error(d.error);
        await loadEngine();
        const w = window as any;
        if (!w.__initLighting3D) throw new Error("三维引擎没就绪");
        w.__initLighting3D(d);
        // 三维里拖完一盏灯 → 交回 React 写数据（现场 2026-10-16：三维俯视图里灯具要能挪）。
        // 现场 2026-10-17 改口径：布灯与挪灯都在 2D 平面上做，三维只看——外层不给 onLightMove 就不挂（引擎随之不拖灯）。
        if (w.__api) w.__api.onLightMove = onLightMove ? (lid: string, x: number, z: number) => { void applyLightMove(lid, x, z); } : null;
        window.dispatchEvent(new Event("resize"));
      } catch (e: any) {
        if (!cancelled) setErr("三维模型加载失败：" + e.message);
      }
    })();
    return () => {
      cancelled = true;
      const w = window as any;
      if (w.__api) w.__api.onLightMove = null;
    };
  }, [id, has3d, uploadedAt, reloadKey]);

  /* 上传 / 重新生成 */
  async function generate(file?: File | null, fileId?: string) {
    if (has3d) {
      const ok = await confirmDanger({
        title: "更换图纸会清除当前三维灯具、回路和场景编辑",
        detail: "重新生成后，三维里的灯具、回路与场景编辑需要重新布置；二维画布内容不受影响。",
        confirmText: "确认更换",
      });
      if (!ok) return;
    }
    setErr("");
    setUploading(true);
    try {
      const fd = new FormData();
      if (file) fd.append("dxf", file);
      if (fileId) fd.append("file_id", fileId);
      const r = await fetch(`/api/lighting3d/${id}/generate`, { method: "POST", body: fd });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.detail || d.error || `HTTP ${r.status}`);
      tracking.current = true;
      setJob({ state: "running", pct: 0.02, stage: "已提交", message: "" });
      notify("已开始生成三维模型");
    } catch (e: any) {
      setErr(e.message);
      setJob((j) => ({ ...(j || {}), state: "error", error: e.message }));
    } finally {
      setUploading(false);
    }
  }

  /* 按当前解析器重跑已有图纸（解析逻辑升级后不用重新上传 DXF） */
  async function regenerate() {
    const ok = await confirmDanger({
      title: "重新解析图纸会清除当前三维灯具、回路和场景编辑",
      detail: "按当前解析器重跑这张图纸；三维里的灯具、回路与场景编辑需要重新布置，二维画布内容不受影响。",
      confirmText: "确认重新解析",
    });
    if (!ok) return;
    setErr("");
    setUploading(true);
    try {
      const r = await fetch(`/api/lighting3d/${id}/regenerate`, { method: "POST" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.detail || d.error || `HTTP ${r.status}`);
      tracking.current = true;
      setJob({ state: "running", pct: 0.02, stage: "已提交", message: "" });
      notify("已按当前解析器重新生成三维模型");
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setUploading(false);
    }
  }

  /* 三维页改过灯位后：把空间 + 灯位同步进灯具配置（生成完成时后台已自动同步一次） */
  const [syncing, setSyncing] = useState(false);
  async function syncDesign() {
    setErr("");
    setSyncing(true);
    try {
      const out: Obj = await api(`/lighting3d/${id}/sync-design`, { method: "POST" });
      notify(`已同步到灯具配置：${out.rooms} 个空间 · ${out.lights} 盏灯（新增 ${out.added} / 更新 ${out.updated} / 移除 ${out.removed}）`);
      await onSynced?.();
    } catch (e: any) {
      setErr("同步灯位失败：" + (typeof e.message === "string" ? e.message : "请检查空间与灯位"));
    } finally {
      setSyncing(false);
    }
  }

  /* 项目里已上传的 DXF：不用再传一次 */
  const projectDxf = (project.files || []).find(
    (f: Obj) => f.type === "DXF" || String(f.name || "").toLowerCase().endsWith(".dxf"),
  );

  async function openDrawer(which: "rooms" | "quote") {
    setDrawer(which);
    if (which === "quote") {
      try {
        setQuote(await api(`/lighting3d/${id}/quote?scheme=${encodeURIComponent(scheme)}`));
      } catch (e: any) {
        setQuote({ error: e.message });
      }
    }
  }

  async function saveSemantics(payload: Obj) {
    setSaving(true);
    try {
      await api(`/lighting3d/${id}/confirm`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      await refresh();
      notify("已保存：房间名与家具类型都按你改的走");
      setDrawer("");
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function saved3d() {
    setReloadKey((k) => k + 1);
    await refresh();
    notify("三维编辑已保存");
  }

  const pct = Math.max(0, Math.min(1, Number(job?.pct || 0)));
  const stage = String(job?.stage || "");
  const jobError = String(job?.error || "");
  const showJobBox = uploading || running || job?.state === "error" || job?.state === "done";

  return (
    <div className={"gv3d" + (embedded ? " embedded" : "") + (previewOnly ? " previewonly" : "")}>
      <header className="gv3d-bar">
        <button className="gv3d-back" onClick={onClose} aria-label="返回工作台">
          <ArrowLeft size={19} />
        </button>
        <div className="gv3d-brand">
          <b>{project.name}</b>
          <small>
            {project.code} · 三维空间
          </small>
        </div>
        <span className="gv3d-lock" title="可切换交付为普通2D平面图，三维模型不会因切换而删除">
          主画布 · 3D 模型
        </span>
        <div className="gv3d-actions">
          {previewOnly ? (
            <span className="gv3d-preview-hint">
              预览只读 · 要改空间名字或边界请切到「修改空间」
            </span>
          ) : null}
          <input
            ref={fileRef}
            type="file"
            accept=".dxf"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) generate(f);
            }}
          />
          <button
            className="gv3d-btn"
            disabled={uploading || running}
            onClick={() => fileRef.current?.click()} data-fid="V-32"
          >
            <Upload size={15} />
            {has3d ? "换一张 DXF" : "上传 DXF 生成三维"}
          </button>
          {projectDxf && !has3d ? (
            <button
              className="gv3d-btn primary"
              disabled={uploading || running}
              onClick={() => generate(null, projectDxf.id)} data-fid="V-32"
            >
              <RefreshCw size={15} />
              用项目里的图纸生成
            </button>
          ) : null}
          <button className="gv3d-btn" disabled={!has3d} onClick={() => openDrawer("rooms")} data-fid="V-33">
            <PencilRuler size={15} />
            语义调整
          </button>
          <button className="gv3d-btn primary" disabled={!has3d} onClick={() => setDrawer("edit")}
            title={spaceConfirmed ? "空间已确认：三维只读，布灯请在布灯画布改" : ""} data-fid="V-34">
            <PencilRuler size={15} /> 布灯·回路·场景{spaceConfirmed ? "（只读）" : ""}
          </button>
          <button className="gv3d-btn" disabled={!has3d || syncing} onClick={syncDesign} data-fid="V-36">
            <RefreshCw size={15} />
            {syncing ? "同步中…" : "同步灯位到灯具配置"}
          </button>
          <button className="gv3d-btn" disabled={!has3d && !reviewed} onClick={() => openDrawer("quote")} data-fid="V-35">
            <Table2 size={15} />
            一套报价
          </button>
        </div>
      </header>

      <canvas id="c" />

      {showJobBox && (
        <div className={"gv3d-job " + (job?.state || "")}>
          <button
            className="gv3d-job-x"
            aria-label="收起提示"
            onClick={() => setJob(null)}
          >
            ✕
          </button>
          {uploading || running ? (
            <>
              <div className="gv3d-job-head">
                <Loader2 className="spin" size={16} />
                <b>正在生成三维模型…</b>
                <span>{Math.round(pct * 100)}%</span>
              </div>
              <div className="gv3d-prog">
                <i style={{ width: `${Math.max(4, pct * 100)}%` }} />
              </div>
              <small>{stage || "准备解析图纸"}</small>
              <small className="gv3d-mut">整套施工图大约 20 秒，别离开这个页面</small>
            </>
          ) : job?.state === "done" ? (
            <>
              <div className="gv3d-job-head ok">
                <CheckCircle2 size={16} />
                <b>三维模型生成成功</b>
              </div>
              <small>{job.message}</small>
              {(job.warn || []).slice(0, 6).map((w: string, i: number) => (
                <small className="gv3d-warn" key={i}>
                  {w}
                </small>
              ))}
            </>
          ) : (
            <>
              <div className="gv3d-job-head bad">
                <AlertCircle size={16} />
                <b>三维模型生成失败</b>
              </div>
              <small className="gv3d-err">{jobError || "没有拿到失败原因"}</small>
              <small className="gv3d-mut">
                常见原因：图纸不是 DXF（DWG 要先另存为 DXF）、图纸里没有墙线/吊顶、
                或文件太大。可换一张图纸再试。
              </small>
            </>
          )}
        </div>
      )}

      <div className="gv3d-roomcap" id="roomcap" style={{ display: "none" }} />

      {err && (
        <div className="gv3d-errbar">
          <AlertCircle size={15} />
          <span>{err}</span>
          <button
            className="gv3d-btn"
            disabled={uploading || running}
            onClick={() => {
              setErr("");
              setReloadKey((k) => k + 1);
            }}
          >
            <RefreshCw size={13} /> 重试
          </button>
          <small>
            如果一直失败，按 Ctrl/⌘ + Shift + R 强制刷新一次（工作台更新过之后旧页面可能对不上）
          </small>
        </div>
      )}

      {summary?.health && !running && (
        <div className={`gv3d-health ${summary.parse_stale ? "warn" : summary.health.level}`} data-fid="V-38">
          <div className="gv3d-health-head">
            <b>图纸体检</b>
            <span className="gv3d-hbadge">
              {summary.parse_stale
                ? "解析已过期"
                : summary.health.level === "ok"
                  ? "都认出来了"
                  : summary.health.level === "warn"
                    ? "有要确认的"
                    : "有没认出来的"}
            </span>
            <button
              className="gv3d-ghost"
              disabled={uploading || running}
              onClick={() => regenerate()}
              title="按当前解析器重新解析这张图纸（不用重新上传）"
            >
              <RefreshCw size={13} /> 重新体检
            </button>
          </div>
          {summary.parse_stale ? (
            <div className="gv3d-hitem bad">
              <span className="dot" />
              <span>
                这份三维是<strong>旧版解析器</strong>
                {summary.parsed_version ? `（v${summary.parsed_version}）` : ""}跑的，当前是 v
                {summary.parser_version}：墙、家具、空间名可能都是旧的，点「重新体检」重跑一遍。
              </span>
            </div>
          ) : null}
          {(summary.health.items || []).map((it: Obj) => (
            <div className={`gv3d-hitem ${it.level}`} key={it.key}>
              <span className="dot" />
              <span>
                <b>{it.label}</b>
                {it.detail}
              </span>
            </div>
          ))}
          <p className="gv3d-hnote">
            墙、空间名、家具都是从图纸自动认的：认错的在这里改（「语义调整」），别等客户看图才发现。
          </p>
        </div>
      )}

      <aside className="gv3d-panel" data-fid="V-25">
        <h1>三维空间</h1>
        <div id="pname" className="gv3d-pname" />
        <section>
          <div id="modes">
            <button data-mode="night" className="on" data-fid="V-26">
              灯光演示
            </button>
            <button data-mode="day" data-fid="V-27">白天看图</button>
          </div>
        </section>
        <section>
          <h2>情景</h2>
          <div id="scenes" />
        </section>
        <section>
          <h2>图层</h2>
          <label className="gv3d-chk">
            <input type="checkbox" id="beams" defaultChecked data-fid="V-28" /> 光锥示意
          </label>
          <label className="gv3d-chk">
            <input type="checkbox" id="cut" defaultChecked data-fid="V-29" /> 墙体剖切 1.5m
          </label>
        </section>
        <section>
          <h2>空间</h2>
          <div id="rooms" />
          <div id="roomtools" />
        </section>
        <section>
          <h2>回路</h2>
          <div id="circuits" />
          <button className="gv3d-ghost" id="reset" data-fid="V-30">
            清除手动开关
          </button>
        </section>
        <section>
          <h2>场景讲解词</h2>
          <div id="script" />
          <button className="gv3d-ghost" id="speak" data-fid="V-31">
            🔊 念一遍
          </button>
        </section>
        <footer id="status" />
      </aside>

      <div className="gv3d-hint">
        拖动旋转 · 滚轮缩放 · 点灯具或回路开关
        {!has3d && !running ? " · 先上传 DXF 生成三维模型" : ""}
      </div>
      {spaceConfirmed && (
        <div className="gv3d-readonly-note">
          空间已确认 · 三维为只读视图：布灯 / 回路 / 场景请在「布灯画布」改
        </div>
      )}

      <aside className={"gv3d-drawer" + (drawer && !previewOnly ? " open" : "")} data-fid="V-37">
        <h3>
          <span>{drawer === "quote" ? "一套报价" : drawer === "edit" ? "布灯 · 回路 · 场景" : "空间与家具 · 语义调整"}</span>
          <button className="gv3d-btn" onClick={() => setDrawer("")}>
            关闭 ✕
          </button>
        </h3>
        {drawer === "quote" ? (
          <>
            {!reviewed && quote?.priceMode !== "generic" ? <div className="gv3d-schemes">
              {["缓亮缓灭", "开闭", "无线", "总线"].map((s) => (
                <button
                  key={s}
                  className={s === scheme ? "on" : ""}
                  onClick={async () => {
                    setScheme(s);
                    try {
                      setQuote(
                        await api(`/lighting3d/${id}/quote?scheme=${encodeURIComponent(s)}`),
                      );
                    } catch (e: any) {
                      setQuote({ error: e.message });
                    }
                  }}
                >
                  {s}
                </button>
              ))}
            </div> : <p>按项目智能方案出一套报价；复核通过后仅使用已确认的灯位。</p>}
            {!quote || quote.error ? (
              <p className="gv3d-al">{quote?.error || "正在读报价…"}</p>
            ) : (
              <>
                <table className="gv3d-table">
                  <thead>
                    <tr>
                      <th>编号</th>
                      <th>产品</th>
                      <th>单价</th>
                      <th>数量</th>
                      <th>小计</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(quote.rows || []).map((r: Obj, i: number) => (
                      <tr key={i}>
                        <td>{r.code || "—"}</td>
                        <td>{r.name}</td>
                        <td>
                          {r.priceMissing || r.price == null
                            ? "—待补价"
                            : "¥" + r.price}
                          {r.priceSource ? (
                            <small style={{ display: "block", opacity: 0.65 }}>
                              {r.priceSource}
                              {r.priceVersion ? " · " + r.priceVersion : ""}
                            </small>
                          ) : null}
                        </td>
                        <td>
                          {r.qty}
                          {r.unit || ""}
                        </td>
                        <td>{r.subtotal ? "¥" + r.subtotal : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="gv3d-tot">合计 ¥{quote.total}</div>
                {quote.priceNote ? (
                  <p className="gv3d-al">{quote.priceNote}</p>
                ) : null}
                <p className="gv3d-al">{quote.note}</p>
                {(quote.warnings || []).length ? (
                  <p className="gv3d-al circuit-warn-text" role="alert">
                    回路问题 {quote.warnings.length} 条（报价单照出）：{quote.warnings.join("；")}
                  </p>
                ) : null}
                {(quote.missing || []).length ? (
                  <p className="gv3d-al">
                    {quote.missing.length} 种灯位没配上产品：
                    {quote.missing
                      .map((m: Obj) => (m.code || "（无编号）") + "×" + m.qty)
                      .join("、")}
                  </p>
                ) : null}
              </>
            )}
          </>
        ) : drawer === "edit" ? (
          <LightingEditor id={id} rooms={summary?.rooms || []} active={drawer === "edit"}
            readonly={spaceConfirmed} onSaved={saved3d} onError={setErr} />
        ) : (
          <SemanticEditor summary={summary} saving={saving} onSave={saveSemantics} />
        )}
      </aside>
    </div>
  );
}

/** Changes are keyed by persistent ids, never by array position. */
function LightingEditor({ id, rooms, active, readonly = false, onSaved, onError }: {
  id: string; rooms: Obj[]; active: boolean; readonly?: boolean; onSaved: () => void; onError: (message: string) => void;
}) {
  const [tab, setTab] = useState<"lights" | "circuits" | "scenes">("lights");
  const [lights, setLights] = useState<Obj[]>([]);
  const [circuits, setCircuits] = useState<Obj[]>([]);
  const [scenes, setScenes] = useState<Obj[]>([]);
  const [draft, setDraft] = useState<Obj>({ x: 0, z: 0, code: "", room: "", type: "", product_id: "", cct: null });
  const [busy, setBusy] = useState(false);
  const [position, setPosition] = useState("q");
  const [role, setRole] = useState("M");
  const refreshAll = useCallback(async () => {
    const [l, c, s] = await Promise.all([
      api(`/lighting3d/${id}/lights`), api(`/lighting3d/${id}/circuits`),
      api(`/lighting3d/${id}/scenes`),
    ]);
    setLights(l.lights); setCircuits(c.circuits); setScenes(s.scenes);
  }, [id]);
  useEffect(() => {
    if (active) refreshAll().catch((e: Error) => onError(e.message));
  }, [active, refreshAll, onError]);
  async function perform(work: () => Promise<unknown>) {
    setBusy(true);
    try { await work(); await refreshAll(); onSaved(); }
    catch (e: any) { onError(e.message); }
    finally { setBusy(false); }
  }
  const send = (path: string, method: string, body: Obj) =>
    api(`/lighting3d/${id}/${path}`, { method, body: JSON.stringify(body) });
  const updateCircuit = (cid: string, lid: string) => {
    const next: Obj[] = circuits.map((c: Obj) => ({ ...c,
      members: (c.members || []).filter((x: string) => x !== lid),
    }));
    const target = next.find((c) => c.id === cid);
    if (target) target.members = [...target.members, lid];
    setCircuits(next);
  };
  const nextCode = () => {
    const roomName = rooms.find((r) => r.id === draft.room)?.name || draft.room;
    const space = SPACE_CODES.find((x) => x.name === roomName)?.code || "x";
    return buildFixtureCode(space, position, nextSerial(lights, space, position, role), role);
  };
  // 拍板 2026-10-12（本地口径）：空间确认后三维只读 —— 布灯/回路/场景一律在布灯画布改。
  // 这里保留只读清点（看得见已同步的灯具、回路、场景），但不给任何写入口。
  if (readonly) {
    return <div className="gv3d-edit gv3d-readonly">
      <p className="gv3d-hint">
        空间已确认 · 三维为只读视图：布灯 / 回路 / 场景请在「布灯画布」改。
      </p>
      <p>
        当前三维里 {lights.length} 盏灯 · {circuits.filter((c) => c.id !== "__unassigned__").length} 条回路 · {scenes.length} 个场景
      </p>
    </div>;
  }
  return <div className="gv3d-edit">
    <nav data-fid="V-39">{(["lights", "circuits", "scenes"] as const).map((t) =>
      <button key={t} className={"gv3d-btn " + (tab === t ? "primary" : "")} onClick={() => setTab(t)}>
        {{ lights: "灯具", circuits: "回路", scenes: "场景" }[t]}
      </button>)}</nav>
    {tab === "lights" && <>
      <p>坐标单位米；编号格式为空间码+位置码+职能码+三位序号。色温缺失显示待补，不自动补值。</p>
      <div className="gv3d-edit-form">
        {(["room", "code", "type", "product_id", "x", "z", "cct"] as const).map((key) =>
          <label key={key}>{({ room: "空间", code: "编号", type: "灯具类型", product_id: "选型", x: "X", z: "Z", cct: "色温 K（可空）" })[key]}
            {key === "room" ? <select value={draft.room || ""} onChange={(e) =>
              setDraft({ ...draft, room: e.target.value })}>
              <option value="">请选择空间</option>
              {draft.room && !rooms.some((r) => r.id === draft.room) &&
                <option value={draft.room}>{draft.room}（旧数据）</option>}
              {rooms.map((r) => <option value={r.id} key={r.id}>{r.name} · {r.id}</option>)}
            </select> : <input value={draft[key] ?? ""} onChange={(e) => setDraft({ ...draft,
              [key]: key === "x" || key === "z" ? Number(e.target.value) :
                key === "cct" ? (e.target.value ? Number(e.target.value) : null) : e.target.value })} />}
          </label>)}
        <label>安装位置<select value={position} onChange={(e) => setPosition(e.target.value)}>
          {positionsForSpace(SPACE_CODES.find((x) => x.name ===
            (rooms.find((r) => r.id === draft.room)?.name || draft.room))?.code || "x").map((p) =>
            <option key={p.code} value={p.code}>{p.code} · {p.name}</option>)}
        </select></label>
        <label>灯光职能<select value={role} onChange={(e) => setRole(e.target.value)}>
          {ROLE_CODES.map((r) => <option key={r.code} value={r.code}>{r.code} · {r.name}</option>)}
        </select></label>
        <button className="gv3d-btn" onClick={() => setDraft({ ...draft, code: nextCode() })}>生成编号</button>
        <button className="gv3d-btn primary" disabled={busy} onClick={() => perform(async () => {
          const { id: lid, ...fields } = draft;
          const payload = { ...fields, cct_source: fields.cct == null ? "待补" : "原始" };
          await send(lid ? `lights/${lid}` : "lights", lid ? "PATCH" : "POST", payload);
          setDraft({ x: 0, z: 0, code: "", room: "", type: "", product_id: "", cct: null });
        })}>{draft.id ? "保存灯具" : "新增灯具"}</button>
      </div>
      {lights.map((l) => <div className="gv3d-edit-row" key={l.id}>
        <span>{l.code || "未编号"} · {rooms.find((r) => r.id === l.room)?.name || l.room || "未分房"} · ({l.x}, {l.z}) · {l.product_id || l.type || "未选型"} · {l.cct == null ? "色温待补" : `${l.cct}K`}</span>
        <button className="gv3d-btn" onClick={() => setDraft({ ...l })}>编辑/移动</button>
        <button className="gv3d-btn" disabled={busy} onClick={() => perform(() => send(`lights/${l.id}`, "DELETE", {}))}>删除</button>
      </div>)}
    </>}
    {tab === "circuits" && <>
      <button className="gv3d-btn" onClick={() => setCircuits([...circuits.slice(0, -1),
        { id: uid(), name: "新回路", members: [] }, circuits[circuits.length - 1]])}>新建回路</button>
      {circuits.map((c) => <div className="gv3d-edit-row" key={c.id}>
        {c.id === "__unassigned__" ? <b>未归属</b> :
          <input value={c.name} onChange={(e) => setCircuits(circuits.map((v) =>
            v.id === c.id ? { ...v, name: e.target.value } : v))} />}
        <small>{c.members.length} 盏</small>
        {c.id !== "__unassigned__" && <button className="gv3d-btn" onClick={() => setCircuits(
          circuits.filter((v) => v.id !== c.id).map((v) => v.id === "__unassigned__" ?
            { ...v, members: [...v.members, ...c.members] } : v))}>删除回路</button>}
      </div>)}
      {lights.map((l) => <label className="gv3d-edit-row" key={l.id}>{l.code || l.id}
        <select value={circuits.find((c) => c.members.includes(l.id))?.id || "__unassigned__"}
          onChange={(e) => updateCircuit(e.target.value, l.id)}>
          {circuits.map((c) => <option value={c.id} key={c.id}>{c.name}</option>)}
        </select></label>)}
      <button className="gv3d-btn primary" disabled={busy} onClick={() => perform(() => send("circuits", "PUT", { circuits }))}>保存回路和归属</button>
    </>}
    {tab === "scenes" && <>
      <p>场景按回路控制；需要单灯独立状态时，先为该灯建立独立回路。未归属灯不参与场景。</p>
      <button className="gv3d-btn" onClick={() => setScenes([...scenes, {
        id: uid(), name: "新场景", script: "", levels: {},
      }])}>新建场景</button>
      {scenes.map((s) => <section className="gv3d-edit-scene" key={s.id}>
        <input aria-label="场景名" value={s.name} onChange={(e) => setScenes(scenes.map((v) =>
          v.id === s.id ? { ...v, name: e.target.value } : v))} />
        <button className="gv3d-btn" onClick={() => setScenes(scenes.filter((v) => v.id !== s.id))}>删除</button>
        <textarea aria-label="讲解词" value={s.script} onChange={(e) => setScenes(scenes.map((v) =>
          v.id === s.id ? { ...v, script: e.target.value } : v))} />
        {circuits.filter((c) => c.id !== "__unassigned__").map((c) =>
          <label key={c.id}>{c.name} {Math.round((s.levels[c.id] || 0) * 100)}%
            <input type="range" min="0" max="100" value={Math.round((s.levels[c.id] || 0) * 100)}
              onChange={(e) => setScenes(scenes.map((v) => v.id === s.id ?
                { ...v, levels: { ...v.levels, [c.id]: Number(e.target.value) / 100 } } : v))} />
          </label>)}
      </section>)}
      <button className="gv3d-btn primary" disabled={busy} onClick={() => perform(() => send("scenes", "PUT", { scenes }))}>保存场景并更新效果</button>
    </>}
  </div>;
}

/** 房间名（语义）+ 家具类型 + 层高 + 讲解词：识别不对就在这里改。 */
function SemanticEditor({
  summary,
  saving,
  onSave,
}: {
  summary: Obj | null;
  saving: boolean;
  onSave: (payload: Obj) => void;
}) {
  const [names, setNames] = useState<Record<string, string>>({});
  // 家具：一行一件（类型 / 宽深 / 朝向 / 删除 / 复制），外加手动添加。
  const [rows, setRows] = useState<FurnRow[]>([]);
  const [roomFilter, setRoomFilter] = useState("*");
  const [batchFrom, setBatchFrom] = useState("餐椅");
  const [batchTo, setBatchTo] = useState("沙发");
  const [addKind, setAddKind] = useState("沙发");
  const [addRoom, setAddRoom] = useState("");
  const [placingKind, setPlacingKind] = useState("");
  const [ceil, setCeil] = useState("");
  const [cnet, setCnet] = useState("");
  const [scripts, setScripts] = useState<Record<string, string>>({});
  const [showFurn, setShowFurn] = useState(true);

  useEffect(() => {
    if (!summary) return;
    setNames(summary.room_names || {});
    setRows(rowsFromSummary(summary));
    setAddRoom(String((summary.rooms || [])[0]?.name || ""));
    setCeil(String(summary.ceiling ?? ""));
    setCnet(String(summary.ceiling_net ?? ""));
    setScripts(summary.scripts || {});
  }, [summary]);

  if (!summary) return <p className="gv3d-al">正在读取…</p>;
  const rooms: Obj[] = summary.rooms || [];
  const options: string[] = summary.furn_kind_options || [];
  // 下拉分组（后端给的分组表）；老接口没有就平铺
  const groups: { label: string; kinds: string[] }[] = summary.furn_kind_groups?.length
    ? summary.furn_kind_groups
    : [{ label: "全部", kinds: options }];
  const modelRooms = rooms as RoomLike[];
  const shown = roomFilter === "*" ? rows
    : rows.filter((r) => r.room === (roomFilter === "__none__" ? "" : roomFilter));
  const alive = rows.filter((r) => !r.removed).length;
  // 三维引擎就绪后才有地面拾取（点哪儿放哪儿）
  const engineReady = typeof (window as any).__api?.place === "function";

  /** 进入「在地面点位置」：引擎给半透明预览并做地面拾取，落点回调到这里就多一件。 */
  function startPlacing(kind: string) {
    const api = (window as any).__api;
    if (typeof api?.place !== "function") return;
    const [w, d] = defaultSize(kind);
    const net = Number(cnet || summary?.ceiling_net || 2.6);
    const h = kind === "到顶柜" ? Math.max(1.6, net - 0.05) : FURN_HEIGHT[kind] || 0.6;
    api.place(kind, w, d, h, 0,
      (p: { x: number; z: number }) => setRows((rs) => addRowAt(rs, kind, p.x, p.z)),
      () => setPlacingKind(""));
    setPlacingKind(kind);
  }
  function stopPlacing() {
    const api = (window as any).__api;
    if (typeof api?.placeOff === "function") api.placeOff();   // 引擎那边会回调 onEnd 清状态
    setPlacingKind("");
  }
  const scenes = ["全开", "会客", "观影", "夜灯", "全关"];

  return (
    <>
      <p className="gv3d-al">
        图纸里通常没有房间名文字，下面是按吊顶轮廓/墙线推的。改名后回路名、情景讲解词会跟着变；
        家具也一样：类型、朝向、宽深逐件可改，还能删除认错的（门弧/梁/楼梯）、复制一件、手动添置。改完点最下面「保存并应用」。
      </p>
      <h4>房间名（{rooms.length} 个）</h4>
      {rooms.length ? (
        <table className="gv3d-table">
          <thead>
            <tr>
              <th>房间</th>
              <th>面积</th>
              <th>改成</th>
            </tr>
          </thead>
          <tbody>
            {rooms.map((r) => (
              <tr key={r.id}>
                <td>{r.id}</td>
                <td>{r.area}㎡</td>
                <td>
                  <input
                    list="gv3d-room-names"
                    value={names[r.id] || r.name || ""}
                    placeholder="客厅 / 主卧 / 过道…"
                    onChange={(e) => setNames({ ...names, [r.id]: e.target.value })}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="gv3d-al">这张图没识别出房间：三维里先按整张图纸当一个大空间用。</p>
      )}
      <datalist id="gv3d-room-names">
        {ROOM_NAME_PRESETS.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>

      <h4>
        家具（{alive} 件{rows.length - alive ? ` · 已删 ${rows.length - alive}` : ""}）
        <button className="gv3d-mini" onClick={() => setShowFurn(!showFurn)}>
          {showFurn ? "收起" : "展开"}
        </button>
      </h4>
      {showFurn && (
        <>
          <div className="gv3d-furn-tools">
            <label>
              筛房间
              <select value={roomFilter} onChange={(e) => setRoomFilter(e.target.value)}>
                <option value="*">全部</option>
                {roomNames(rows, modelRooms).map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
                <option value="__none__">（没落在房间里）</option>
              </select>
            </label>
            <label>
              同类一起改
              <select value={batchFrom} onChange={(e) => setBatchFrom(e.target.value)}>
                <option value="*">全部类型</option>
                {options.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
              →
              <select value={batchTo} onChange={(e) => setBatchTo(e.target.value)}>
                {options.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
              <button className="gv3d-mini"
                onClick={() => setRows(batchChange(rows, batchFrom, batchTo))}>应用</button>
            </label>
          </div>
          {rows.length ? (
            <div className="gv3d-furns">
              {shown.map((r) => (
                <div className={"gv3d-furn" + (r.removed ? " off" : "")} key={r.key}>
                  <span className="gv3d-furn-id">{r.extra ? "＋" : Number(r.key) + 1}</span>
                  <select aria-label="家具类型" value={r.kind}
                    onChange={(e) => setRows(setKind(rows, r.key, e.target.value))}>
                    {groups.map((g) => (
                      <optgroup key={g.label} label={g.label}>
                        {g.kinds.map((k) => <option key={k} value={k}>{k}</option>)}
                      </optgroup>
                    ))}
                  </select>
                  <input className="gv3d-furn-wh" aria-label="宽（米）" value={r.w}
                    onChange={(e) => setRows(setSize(rows, r.key, Number(e.target.value), r.d))} />
                  <input className="gv3d-furn-wh" aria-label="深（米）" value={r.d}
                    onChange={(e) => setRows(setSize(rows, r.key, r.w, Number(e.target.value)))} />
                  <span className="gv3d-furn-room">{r.room || "—"}</span>
                  <button className="gv3d-mini" title="转 90°（贴另一面墙）"
                    onClick={() => setRows(rotateRow(rows, r.key))}>↻{r.rot ? ` ${r.rot}°` : ""}</button>
                  <button className="gv3d-mini" title="复制一件（往右挪 0.2m）"
                    onClick={() => setRows(dupRow(rows, r.key))}>复制</button>
                  {r.removed
                    ? <button className="gv3d-mini"
                        onClick={() => setRows(removeRow(rows, r.key, false))}>恢复</button>
                    : <button className="gv3d-mini"
                        onClick={() => setRows(removeRow(rows, r.key, true))}>删除</button>}
                </div>
              ))}
            </div>
          ) : (
            <p className="gv3d-al">
              这张图没识别出成件的家具（家具图层多是细线/填充）——三维里先只有墙体与灯位，下面可以手动加。
            </p>
          )}
          <div className="gv3d-furn-tools">
            <label>
              ＋ 添加家具
              <select value={addKind} onChange={(e) => setAddKind(e.target.value)}>
                {options.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
            </label>
            <label>
              放在
              <select value={addRoom} onChange={(e) => setAddRoom(e.target.value)}>
                {rooms.map((r) => (
                  <option key={r.id} value={String(r.name || r.id)}>{String(r.name || r.id)}</option>
                ))}
                <option value="">图纸中心</option>
              </select>
            </label>
            <button className="gv3d-mini"
              onClick={() => setRows(addRow(rows, addKind, addRoom, modelRooms))}>
              放房间中心（默认 {defaultSize(addKind)[0]}×{defaultSize(addKind)[1]}m）
            </button>
            <button className={"gv3d-mini" + (placingKind ? " on" : "")} disabled={!engineReady}
              title={engineReady ? "在三维里点一下就把家具放在那儿" : "三维引擎还没就绪"}
              onClick={() => (placingKind ? stopPlacing() : startPlacing(addKind))}>
              {placingKind ? `点击放置中：${placingKind} · 完成` : "在地面点位置"}
            </button>
          </div>
        </>
      )}

      <h4>层高</h4>
      <div className="gv3d-row">
        <label>
          原始层高
          <input value={ceil} onChange={(e) => setCeil(e.target.value)} />
        </label>
        <label>
          吊顶后层高
          <input value={cnet} onChange={(e) => setCnet(e.target.value)} />
        </label>
      </div>

      <h4>场景讲解词</h4>
      {scenes.map((s) => (
        <label className="gv3d-script" key={s}>
          <b>{s}</b>
          <textarea
            value={scripts[s] || ""}
            placeholder="这一档什么时候用、给客户说什么"
            onChange={(e) => setScripts({ ...scripts, [s]: e.target.value })}
          />
        </label>
      ))}

      {(summary.warn || []).map((w: string, i: number) => (
        <p className="gv3d-al" key={i}>
          {w}
        </p>
      ))}
      {(summary.unassigned || []).length ? (
        <p className="gv3d-al">
          有 {summary.unassigned.length} 个灯位没配上灯具编号（图纸上没有「灯具编号」图层，
          或编号离灯位太远）——报价里会缺这些灯。
        </p>
      ) : null}

      <div className="gv3d-row">
        <button
          className="gv3d-btn primary"
          disabled={saving}
          onClick={() =>
            onSave({
              room_names: Object.fromEntries(
                Object.entries(names).filter(([, v]) => String(v).trim()),
              ),
              ...payloadFromRows(rows),
              scripts: Object.fromEntries(
                Object.entries(scripts).filter(([, v]) => String(v).trim()),
              ),
              ceiling: ceil.trim(),
              ceiling_net: cnet.trim(),
            })
          } data-fid="V-40"
        >
          {saving ? <Loader2 className="spin" size={15} /> : <CheckCircle2 size={15} />}
          保存并应用
        </button>
      </div>
    </>
  );
}
