import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  ChevronLeft,
  Clock3,
  Eye,
  EyeOff,
  Focus,
  Hash,
  Info,
  Loader2,
  RotateCcw,
  Search,
  X,
} from "lucide-react";
import { FEATURES, FEATURE_MAP, FEATURE_MODULES, FID_RE, MODULE_LABEL, type FeatureDef } from "./features";
import { confirmDanger } from "./dangerConfirm";
import "./featureIds.css";

const STORAGE_KEY = "gv.featureIds.v1";
const CHANGE_EVENT = "gv-feature-ids-change";
const OPEN_EVENT = "gv-feature-open";
const TOAST_EVENT = "gv-feature-toast";
// 管理界面自身不可隐藏：隐藏后清单/详情会看不见，等于把入口锁死。
const PROTECTED = new Set(["S-70", "S-71"]);

export type FeatureState = { hidden: string[]; numbered: boolean; entry: boolean };

const EMPTY: FeatureState = { hidden: [], numbered: false, entry: true };

function sanitize(raw: unknown): FeatureState {
  const data = (raw || {}) as { hidden?: unknown; numbered?: unknown };
  const hidden = Array.isArray(data.hidden)
    ? [...new Set(data.hidden.filter((x): x is string => typeof x === "string" && FID_RE.test(x)))]
    : [];
  return { hidden, numbered: data.numbered === true, entry: (data as { entry?: unknown }).entry !== false };
}

function read(): FeatureState {
  try {
    return sanitize(JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"));
  } catch {
    return EMPTY;
  }
}

let state: FeatureState = read();
const listeners = new Set<() => void>();

function write(next: FeatureState) {
  state = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* 隐私模式下写不进去也不影响当前会话 */
  }
  listeners.forEach((fn) => fn());
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export const featureStore = {
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  snapshot(): FeatureState {
    return state;
  },
  refresh() {
    state = read();
    listeners.forEach((fn) => fn());
  },
  setNumbered(numbered: boolean) {
    write({ ...state, numbered });
  },
  setEntry(entry: boolean) {
    write({ ...state, entry });
  },
  toggleNumbered() {
    write({ ...state, numbered: !state.numbered });
  },
  isHidden(id: string) {
    return state.hidden.includes(id);
  },
  toggleHidden(id: string) {
    if (PROTECTED.has(id)) return;
    const hidden = state.hidden.includes(id)
      ? state.hidden.filter((x) => x !== id)
      : [...state.hidden, id];
    write({ ...state, hidden });
  },
  setHidden(id: string, hiddenIt: boolean) {
    if (PROTECTED.has(id)) return;
    const already = state.hidden.includes(id);
    if (already === hiddenIt) return;
    write({
      ...state,
      hidden: hiddenIt ? [...state.hidden, id] : state.hidden.filter((x) => x !== id),
    });
  },
  restoreAll() {
    write({ ...state, hidden: [] });
  },
};

export function useFeatureState(): FeatureState {
  return useSyncExternalStore(featureStore.subscribe, featureStore.snapshot, featureStore.snapshot);
}

/* ------------------------------ 功能改动记录 ------------------------------ */

export type FeatureToast = { text: string; ids: string[]; kind: "hide" | "show" | "info" };

export type FeatureChange = {
  at: string;
  ids: string[];
  title: string;
  detail?: string;
  before?: string;
  after?: string;
};

let historyRows: FeatureChange[] | null = null;
let historyLoading: Promise<FeatureChange[]> | null = null;

function normalizeHistory(raw: unknown): FeatureChange[] {
  const data = (raw || {}) as { entries?: unknown };
  const entries = Array.isArray(data.entries) ? data.entries : [];
  const rows: FeatureChange[] = [];
  for (const item of entries) {
    if (!item || typeof item !== "object") continue;
    const e = item as Record<string, unknown>;
    const ids = Array.isArray(e.ids) ? e.ids.filter((x): x is string => typeof x === "string") : [];
    const title = typeof e.title === "string" ? e.title.trim() : "";
    const at = typeof e.at === "string" ? e.at.trim() : "";
    if (!ids.length || !title || !at) continue;
    rows.push({
      at,
      ids,
      title,
      detail: typeof e.detail === "string" ? e.detail : "",
      before: typeof e.before === "string" ? e.before : "",
      after: typeof e.after === "string" ? e.after : "",
    });
  }
  rows.sort((a, b) => (a.at < b.at ? 1 : -1));
  return rows;
}

function loadHistory(): Promise<FeatureChange[]> {
  if (historyRows) return Promise.resolve(historyRows);
  if (!historyLoading) {
    historyLoading = fetch("/api/features/history", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { entries: [] }))
      .then((d) => {
        historyRows = normalizeHistory(d);
        return historyRows;
      })
      .catch(() => {
        historyRows = [];
        return historyRows;
      });
  }
  return historyLoading;
}

function changesOf(id: string, rows: FeatureChange[]): FeatureChange[] {
  return rows.filter((e) => e.ids.includes("*") || e.ids.includes(id));
}

function useHistory(): FeatureChange[] {
  const [rows, setRows] = useState<FeatureChange[]>(historyRows || []);
  useEffect(() => {
    let alive = true;
    loadHistory().then((r) => {
      if (alive) setRows(r);
    });
    return () => {
      alive = false;
    };
  }, []);
  return rows;
}

type VersionRow = { id: string; tag?: string; createdAt?: string; current?: boolean };

function useVersions(active: boolean): VersionRow[] {
  const [rows, setRows] = useState<VersionRow[]>([]);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    fetch("/api/app/versions", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { versions: [] }))
      .then((d) => {
        if (alive) setRows(Array.isArray(d?.versions) ? d.versions : []);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [active]);
  return rows;
}

function stamp(s?: string) {
  return (s || "").replace("T", " ").slice(0, 16);
}

function featureNodes(id: string) {
  return Array.from(document.querySelectorAll<HTMLElement>(`[data-fid="${id}"]`)).filter(
    (el) => el.offsetParent !== null || getComputedStyle(el).position === "fixed",
  );
}

function locateFeature(id: string): boolean {
  const nodes = featureNodes(id);
  if (!nodes.length) return false;
  const el = nodes[0];
  el.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
  el.classList.add("gv-fid-flash");
  window.setTimeout(() => el.classList.remove("gv-fid-flash"), 1600);

  // 浮动编号标签：定位后 2.8 秒内跟着目标走，避免只闪一下看不清。
  const tag = document.createElement("div");
  tag.className = "gv-fid-locatetag";
  tag.dataset.fid = "S-76";
  tag.textContent = `${id} · ${FEATURE_MAP.get(id)?.name || ""}`;
  document.body.appendChild(tag);
  const place = () => {
    const r = el.getBoundingClientRect();
    const top = r.top > 64 ? r.top - 32 : Math.min(r.bottom + 10, window.innerHeight - 40);
    tag.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 260))}px`;
    tag.style.top = `${top}px`;
  };
  place();
  const timer = window.setInterval(place, 300);
  window.setTimeout(() => {
    window.clearInterval(timer);
    tag.remove();
  }, 2800);

  window.dispatchEvent(
    new CustomEvent(TOAST_EVENT, {
      detail: { text: `已定位 ${id} · ${FEATURE_MAP.get(id)?.name || ""}`, ids: [], kind: "info" },
    }),
  );
  return true;
}

/* ------------------------------- 功能清单面板 ------------------------------- */

function FeatureManager({
  onClose,
  initialDetail = "",
}: {
  onClose: () => void;
  initialDetail?: string;
}) {
  const s = useFeatureState();
  const historyRows = useHistory();
  const [query, setQuery] = useState("");
  const [hiddenOnly, setHiddenOnly] = useState(false);
  const [unknown, setUnknown] = useState<string[]>([]);
  const [presentIds, setPresentIds] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState("");
  const [detail, setDetail] = useState(initialDetail);

  useEffect(() => {
    // 当前页面有哪些功能的入口（用于行内「本页/其他页」提示与定位可用性）。
    const scan = () => {
      const ids = new Set<string>();
      document.querySelectorAll<HTMLElement>("[data-fid]").forEach((el) => {
        const id = el.dataset.fid || "";
        if (id) ids.add(id);
      });
      setPresentIds(ids);
    };
    scan();
    const timer = window.setTimeout(scan, 700);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    // 页面上出现了登记表里没有的编号：提示补登记，避免以后越用越乱。
    const ids = new Set<string>();
    document.querySelectorAll<HTMLElement>("[data-fid]").forEach((el) => {
      const id = el.dataset.fid || "";
      if (id && !FEATURE_MAP.has(id)) ids.add(id);
    });
    setUnknown([...ids].sort());
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return FEATURES.filter((f) => {
      if (hiddenOnly && !s.hidden.includes(f.id)) return false;
      if (!q) return true;
      return (
        f.id.toLowerCase().includes(q) ||
        f.name.toLowerCase().includes(q) ||
        f.desc.toLowerCase().includes(q) ||
        (MODULE_LABEL[f.module] || "").toLowerCase().includes(q)
      );
    });
  }, [query, hiddenOnly, s.hidden]);

  const grouped = useMemo(() => {
    const map = new Map<string, FeatureDef[]>();
    for (const f of filtered) {
      const list = map.get(f.module) || [];
      list.push(f);
      map.set(f.module, list);
    }
    return FEATURE_MODULES.filter((m) => map.has(m.code)).map((m) => ({
      ...m,
      rows: map.get(m.code) || [],
    }));
  }, [filtered]);

  const hide = useCallback((id: string) => featureStore.toggleHidden(id), []);

  const doLocate = (id: string) => {
    if (PROTECTED.has(id)) {
      setNotice(`${id} 是管理界面自身，不参与定位。`);
      return;
    }
    if (featureStore.isHidden(id)) {
      setNotice(`${id} 当前是隐藏状态：先点「恢复」再定位。`);
      return;
    }
    if (!locateFeature(id)) {
      setNotice(
        `当前页面没有 ${id} 的入口（可能在别的页签/项目里）。隐藏/恢复是全局的：切到对应页面就会生效。`,
      );
      return;
    }
    onClose();
  };

  if (detail) {
    return <FeatureDetailModal id={detail} onBack={() => setDetail("")} onClose={onClose} />;
  }

  return (
    <div className="gv-fid-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section
        className="gv-fid-modal"
        role="dialog"
        aria-modal="true"
        aria-label="功能编号与隐藏"
        data-fid="S-70"
      >
        <header className="gv-fid-head">
          <div className="gv-fid-title">
            <span className="gv-fid-glyph"><Hash size={15} /></span>
            <div>
              <b>功能编号与隐藏</b>
              <small>
                共 {FEATURES.length} 个功能 · 已隐藏 {s.hidden.length} 个 · 编号固定，沟通时直接说编号
              </small>
            </div>
          </div>
          <button className="gv-fid-close" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>

        <div className="gv-fid-tools">
          <label className="gv-fid-search">
            <Search size={15} />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索编号 / 名称 / 说明，如 L-07、导出、情景…"
            />
            {query && (
              <button onClick={() => setQuery("")} aria-label="清空搜索">
                <X size={14} />
              </button>
            )}
          </label>
          <label className="gv-fid-check">
            <input
              type="checkbox"
              checked={s.numbered}
              onChange={(e) => featureStore.setNumbered(e.target.checked)}
            />
            在界面上显示编号徽标
          </label>
          <label className="gv-fid-check">
            <input type="checkbox" checked={hiddenOnly} onChange={(e) => setHiddenOnly(e.target.checked)} />
            只看已隐藏
          </label>
        </div>

        {!!notice && (
          <div className="gv-fid-notice" role="status">
            <Info size={14} />
            <span>{notice}</span>
            <button onClick={() => setNotice("")} aria-label="关闭提示">
              <X size={13} />
            </button>
          </div>
        )}

        {unknown.length > 0 && (
          <div className="gv-fid-unknown">
            当前页面有 {unknown.length} 个编号还没登记：{unknown.slice(0, 16).join("、")}
            {unknown.length > 16 ? "…" : ""}（请补进 features.ts）
          </div>
        )}

        <div className="gv-fid-body">
          {grouped.length === 0 && (
            <div className="gv-fid-empty">没有匹配的功能。换个关键词，或取消「只看已隐藏」。</div>
          )}
          {grouped.map((g) => (
            <div className="gv-fid-group" key={g.code}>
              <div className="gv-fid-grouphead">
                <span className="gv-fid-mod">{g.code}</span>
                <b>{g.label}</b>
                <small>{g.desc}</small>
                <button
                  className="gv-fid-groupbtn"
                  title="整组隐藏 / 恢复"
                  onClick={() => {
                    const allHidden = g.rows.every((r) => s.hidden.includes(r.id));
                    g.rows.forEach((r) => featureStore.setHidden(r.id, !allHidden));
                  }}
                >
                  {g.rows.every((r) => s.hidden.includes(r.id)) ? "恢复本组" : "隐藏本组"}
                </button>
                <em>{g.rows.length}</em>
              </div>
              {g.rows.map((f) => {
                const hidden = s.hidden.includes(f.id);
                const changeCount = changesOf(f.id, historyRows).length;
                return (
                  <div
                    className={"gv-fid-row" + (hidden ? " is-hidden" : "")}
                    key={f.id}
                    onClick={(e) => {
                      if ((e.target as HTMLElement).closest("button")) return;
                      setDetail(f.id);
                    }}
                  >
                    <span className="gv-fid-chip">{f.id}</span>
                    <div className="gv-fid-meta">
                      <b>
                        <i
                          className={"gv-fid-dot" + (presentIds.has(f.id) ? " on" : "")}
                          title={presentIds.has(f.id) ? "当前页面有这个入口" : "当前页面没有这个入口（在别的页面）"}
                        />
                        {f.name}
                      </b>
                      <small>{f.desc}</small>
                    </div>
                    <span className="gv-fid-count" title="改动记录条数（含编号建立）">
                      改 {changeCount} 次
                    </span>
                    <div className="gv-fid-acts">
                      <button title="查看作用、改动记录与回退" onClick={() => setDetail(f.id)}>
                        <Info size={13} /> 详情
                      </button>
                      <button
                        title={
                          presentIds.has(f.id)
                            ? "在当前页面上找到它"
                            : "当前页面没有这个入口：点一下会说明它可能在哪，隐藏/恢复仍是全局生效"
                        }
                        onClick={() => doLocate(f.id)}
                      >
                        <Focus size={13} /> 定位
                      </button>
                      <button
                        className={hidden ? "on" : ""}
                        disabled={PROTECTED.has(f.id) || f.hideable === false}
                        title={
                          PROTECTED.has(f.id) || f.hideable === false
                            ? "管理界面自身不能隐藏（否则清单/详情会被一起藏掉）"
                            : hidden
                              ? "恢复显示"
                              : "在界面上隐藏这个功能"
                        }
                        onClick={() => hide(f.id)}
                      >
                        {hidden ? <Eye size={13} /> : <EyeOff size={13} />}
                        {hidden ? "恢复" : "隐藏"}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        <footer className="gv-fid-foot">
          <span className="gv-fid-note">隐藏只影响本机当前浏览器；Shift + F 随时打开本清单</span>
          <span className="gv-fid-sp" />
          <button className="gv-fid-entry" onClick={() => featureStore.setEntry(!s.entry)}>
            {s.entry ? "隐藏入口按钮" : "显示入口按钮"}
          </button>
          <button className="gv-fid-restore" onClick={() => featureStore.restoreAll()} disabled={!s.hidden.length}>
            <RotateCcw size={13} /> 全部恢复
          </button>
        </footer>
      </section>
    </div>
  );
}

/* ------------------------------- 功能详情 / 回退 ------------------------------- */

function FeatureDetailModal({ id, onBack, onClose }: { id: string; onBack: () => void; onClose: () => void }) {
  const f = FEATURE_MAP.get(id);
  const s = useFeatureState();
  const historyRows = useHistory();
  const changes = useMemo(() => changesOf(id, historyRows), [id, historyRows]);
  const versions = useVersions(true);
  const [rolling, setRolling] = useState(false);
  const [error, setError] = useState("");
  const versionById = useMemo(() => new Map(versions.map((v) => [v.id, v])), [versions]);
  const hidden = s.hidden.includes(id);

  async function rollbackTo(ch: FeatureChange) {
    if (!ch.before || rolling) return;
    const row = versionById.get(ch.before);
    if (!row) {
      setError(`本机版本库里没有快照 ${ch.before}，无法回退到这次改动前。`);
      return;
    }
    const ok = await confirmDanger({
      title: `回退到「${row.tag || row.id}」？`,
      detail:
        "按整版快照回退：程序与前端恢复到这次改动之前的快照，这次改动之后的所有改动（不只本功能）都会一起退回；" +
        "项目数据 data/ 不受影响。回退会重启服务，页面自动重连；回退前系统会自动保存当前版本。",
      confirmText: "确认回退",
    });
    if (!ok) return;

    setError("");
    setRolling(true);
    const started = Date.now();
    try {
      const r = await fetch(`/api/app/versions/${encodeURIComponent(ch.before)}/rollback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      if (!r.ok) {
        let detail = "";
        try {
          const j = await r.json();
          detail = typeof j?.detail === "string" ? j.detail : "";
        } catch {
          /* ignore */
        }
        setRolling(false);
        setError(detail || `回退请求失败（${r.status}）`);
        return;
      }
    } catch {
      /* 服务可能刚好被停掉；继续轮询 */
    }

    let sawDown = false;
    const timer = window.setInterval(async () => {
      const elapsed = Date.now() - started;
      let ok = false;
      try {
        const r = await fetch("/api/health", { cache: "no-store" });
        ok = r.ok;
      } catch {
        /* 服务重启中 */
      }
      if (!ok) sawDown = true;
      if (ok && (sawDown || elapsed > 10000)) {
        window.clearInterval(timer);
        location.reload();
        return;
      }
      if (elapsed > 90000) {
        window.clearInterval(timer);
        setRolling(false);
        setError("回退后服务 90 秒内没有回来。请查看版本库 ui-rollback.log，或双击桌面「光律-回退版本.command」。");
      }
    }, 1000);
  }

  return (
    <div className="gv-fid-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section
        className="gv-fid-modal gv-fid-detail-modal"
        role="dialog"
        aria-modal="true"
        aria-label="功能详情"
        data-fid="S-71"
      >
        <header className="gv-fid-head">
          <button className="gv-fid-back" onClick={onBack} title="返回功能清单">
            <ChevronLeft size={16} /> 清单
          </button>
          <div className="gv-fid-title">
            <span className="gv-fid-chip big">{id}</span>
            <div>
              <b>{f?.name || id}</b>
              <small>
                {MODULE_LABEL[f?.module || ""] || "未登记"} · {f?.file || "—"}
              </small>
            </div>
          </div>
          <button className="gv-fid-close" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>

        <div className="gv-fid-detail">
          <div className="gv-fid-sec">
            <h4>这个功能做什么</h4>
            <p>{f?.desc || "这个编号还没登记说明。"}</p>
            <div className="gv-fid-stats">
              <span>
                <Clock3 size={12} /> 改动 <b>{changes.length}</b> 次
              </span>
              <span>{hidden ? "当前已隐藏（界面不显示）" : "当前显示中"}</span>
            </div>
            <div className="gv-fid-detail-acts">
              <button
                onClick={() => {
                  if (!featureNodes(id).length) {
                    setError(`当前页面没有 ${id} 的入口（可能在别的页签/项目里）。隐藏/恢复是全局的：切到对应页面就会生效。`);
                    return;
                  }
                  onClose();
                  window.setTimeout(() => locateFeature(id), 220);
                }}
              >
                <Focus size={13} /> 在界面上定位
              </button>
              <button
                disabled={PROTECTED.has(id) || f?.hideable === false}
                title={
                  PROTECTED.has(id) || f?.hideable === false
                    ? "管理界面自身不能隐藏（否则清单/详情会被一起藏掉）"
                    : hidden
                      ? "恢复显示"
                      : "在界面上隐藏这个功能"
                }
                onClick={() => featureStore.toggleHidden(id)}
              >
                {hidden ? <Eye size={13} /> : <EyeOff size={13} />}
                {hidden ? "恢复显示" : "隐藏这个功能"}
              </button>
            </div>
          </div>

          <div className="gv-fid-sec">
            <h4>改动记录</h4>
            {changes.length === 0 && (
              <p className="gv-fid-hint">还没有记录。改动功能后应登记一条记录，这里就会出现次数并可回退。</p>
            )}
            <ol className="gv-fid-timeline">
              {changes.map((ch, i) => {
                const beforeRow = ch.before ? versionById.get(ch.before) : undefined;
                const canRollback = !!ch.before && !!beforeRow && !rolling;
                return (
                  <li key={`${ch.at}-${i}`}>
                    <span className="gv-fid-tl-dot" />
                    <div className="gv-fid-tl-main">
                      <div className="gv-fid-tl-head">
                        <b>{stamp(ch.at)}</b>
                        <span>{ch.title}</span>
                      </div>
                      {ch.detail && <p>{ch.detail}</p>}
                      <div className="gv-fid-tl-foot">
                        {ch.before && (
                          <span title={ch.before}>
                            改动前快照：{beforeRow ? beforeRow.tag || beforeRow.id : `${ch.before}（本机没有）`}
                          </span>
                        )}
                        <button
                          className="gv-fid-rollback"
                          data-fid="S-72"
                          disabled={!canRollback}
                          title={
                            !ch.before
                              ? "这次改动没有登记可回退的快照"
                              : !beforeRow
                                ? `本机版本库里没有快照 ${ch.before}`
                                : "整版回退到这次改动之前的快照"
                          }
                          onClick={() => void rollbackTo(ch)}
                        >
                          <RotateCcw size={12} /> 回退到这次改动前
                        </button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
            <p className="gv-fid-footnote">
              回退按「整版快照」执行：程序与前端一起回到那个时间点，项目数据 data/ 不动。回退前会自动保存当前版本，可再回退回来。
            </p>
          </div>

          {!!error && <p className="gv-fid-error">{error}</p>}
        </div>

        {rolling && (
          <div className="gv-fid-rolling" role="status" aria-live="polite">
            <Loader2 className="spin" size={22} />
            <b>正在回退版本…</b>
            <p>服务会短暂重启，页面会自动重连。</p>
          </div>
        )}
      </section>
    </div>
  );
}

/* ------------------------------- 全局运行时 ------------------------------- */

export function FeatureRuntime() {
  const s = useFeatureState();
  const [open, setOpen] = useState(false);
  const [detailId, setDetailId] = useState("");
  const [toast, setToast] = useState<FeatureToast | null>(null);
  const toastTimer = useRef<number>(0);
  const prevHidden = useRef<string[]>(s.hidden);
  const firstHiddenRun = useRef(true);

  const showToast = useCallback((t: FeatureToast) => {
    setToast(t);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3800);
  }, []);

  // 其他模块（如定位）也可以发一条提示。
  useEffect(() => {
    const onToast = (e: Event) => {
      const d = ((e as CustomEvent).detail || {}) as { text?: unknown; ids?: unknown; kind?: unknown };
      if (typeof d.text !== "string" || !d.text) return;
      showToast({
        text: d.text,
        ids: Array.isArray(d.ids) ? d.ids.filter((x): x is string => typeof x === "string") : [],
        kind: d.kind === "hide" ? "hide" : d.kind === "show" ? "show" : "info",
      });
    };
    window.addEventListener(TOAST_EVENT, onToast);
    return () => window.removeEventListener(TOAST_EVENT, onToast);
  }, [showToast]);

  // 隐藏/恢复后给一条明确反馈（含「当前页面是否已生效」），避免看不出变化。
  useEffect(() => {
    const prev = prevHidden.current;
    prevHidden.current = s.hidden;
    if (firstHiddenRun.current) {
      firstHiddenRun.current = false;
      return;
    }
    const added = s.hidden.filter((id) => !prev.includes(id));
    const removed = prev.filter((id) => !s.hidden.includes(id));
    if (added.length) {
      const one = added.length === 1;
      const id = added[0];
      const onPage = !!document.querySelector(`[data-fid="${id}"]`);
      showToast({
        text: one
          ? `已隐藏 ${id} · ${FEATURE_MAP.get(id)?.name || ""}${
              onPage ? "（当前页面已生效）" : "（当前页面没有它，切到对应页面生效）"
            }`
          : `已隐藏 ${added.length} 个功能（页面已生效）`,
        ids: added,
        kind: "hide",
      });
    } else if (removed.length) {
      showToast({
        text:
          removed.length === 1
            ? `已恢复 ${removed[0]} · ${FEATURE_MAP.get(removed[0])?.name || ""}`
            : `已恢复 ${removed.length} 个功能`,
        ids: removed,
        kind: "show",
      });
    }
  }, [s.hidden, showToast]);

  // 隐藏落成内联 display:none !important：比样式表更稳，不会被更具体的 !important 覆盖；
  // 切页/重新渲染产生的新元素由 MutationObserver 补上；恢复时还原元素原本的内联 display。
  useEffect(() => {
    const MARK = "data-gv-fid-hidden";
    const apply = () => {
      const hidden = new Set(s.hidden);
      document.querySelectorAll<HTMLElement>("[data-fid]").forEach((el) => {
        const id = el.dataset.fid || "";
        if (hidden.has(id) && !PROTECTED.has(id)) {
          if (!el.hasAttribute(MARK)) el.setAttribute(MARK, el.style.getPropertyValue("display") || "");
          if (
            el.style.getPropertyPriority("display") !== "important" ||
            el.style.getPropertyValue("display") !== "none"
          ) {
            el.style.setProperty("display", "none", "important");
          }
        } else if (el.hasAttribute(MARK)) {
          const orig = el.getAttribute(MARK) || "";
          if (orig) el.style.setProperty("display", orig);
          else el.style.removeProperty("display");
          el.removeAttribute(MARK);
        }
      });
    };
    apply();
    if (!s.hidden.length) return;
    let raf = 0;
    const schedule = () => {
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          apply();
        });
      }
    };
    const mo = new MutationObserver(schedule);
    mo.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-fid", "style"],
    });
    const timer = window.setInterval(schedule, 1200);
    return () => {
      window.clearInterval(timer);
      mo.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [s.hidden]);

  // 点编号徽标 → 打开该功能的详情（作用 + 改动记录 + 回退）。
  useEffect(() => {
    const onOpen = (e: Event) => {
      const id = (e as CustomEvent).detail;
      if (typeof id === "string" && FEATURE_MAP.has(id)) {
        setDetailId(id);
        setOpen(true);
      }
    };
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, []);

  // 编号徽标：用独立浮层绘制，避免 ::after 被 overflow / 层叠上下文裁掉。
  useEffect(() => {
    if (!s.numbered) return;
    const layer = document.createElement("div");
    layer.className = "gv-fid-layer";
    document.body.appendChild(layer);
    let raf = 0;
    let signature = "";
    const badges = new Map<string, HTMLSpanElement>();

    const paint = () => {
      raf = 0;
      // 同一编号可能出现多个元素（同一功能的多入口）：按出现顺序编号，保证点击/位置稳定。
      const entries: { key: string; id: string; left: number; top: number; above: boolean }[] = [];
      const perId = new Map<string, number>();
      document.querySelectorAll<HTMLElement>("[data-fid]").forEach((el) => {
        const id = el.dataset.fid || "";
        if (!FID_RE.test(id) || !el.isConnected) return;
        const r = el.getBoundingClientRect();
        if (r.width < 3 || r.height < 3) return;
        if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) return;
        const st = getComputedStyle(el);
        if (st.visibility === "hidden" || st.display === "none" || st.opacity === "0") return;
        const above = r.top >= 20;
        const left = Math.max(2, Math.min(r.left + 2, window.innerWidth - 60));
        const top = above ? r.top - 2 : r.top + 2;
        const n = perId.get(id) || 0;
        perId.set(id, n + 1);
        entries.push({ key: `${id}#${n}`, id, left, top, above });
      });
      const sig = entries
        .map((e) => `${e.key}:${Math.round(e.left)},${Math.round(e.top)},${e.above ? 1 : 0}`)
        .join(";");
      if (sig === signature) return;
      signature = sig;
      const alive = new Set<string>();
      for (const e of entries) {
        alive.add(e.key);
        let badge = badges.get(e.key);
        if (!badge) {
          badge = document.createElement("span");
          badge.className = "gv-fid-badge";
          badge.dataset.fid = e.id;
          badge.textContent = e.id;
          badge.title = `${e.id} · ${FEATURE_MAP.get(e.id)?.name || "未登记"}（点击查看作用与改动记录）`;
          layer.appendChild(badge);
          badges.set(e.key, badge);
        }
        badge.style.left = `${Math.round(e.left)}px`;
        badge.style.top = `${Math.round(e.top)}px`;
        badge.style.transform = e.above ? "translateY(-100%)" : "none";
      }
      for (const [key, badge] of badges) {
        if (!alive.has(key)) {
          badge.remove();
          badges.delete(key);
        }
      }
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(paint);
    };
    const onClick = (ev: MouseEvent) => {
      const badge = (ev.target as HTMLElement | null)?.closest(".gv-fid-badge") as HTMLElement | null;
      if (!badge) return;
      ev.preventDefault();
      ev.stopPropagation();
      const id = badge.dataset.fid || badge.textContent || "";
      if (FID_RE.test(id)) window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: id }));
    };
    paint();
    layer.addEventListener("click", onClick);
    const mo = new MutationObserver(schedule);
    mo.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-fid", "class", "style"],
    });
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    const timer = window.setInterval(schedule, 900);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      layer.removeEventListener("click", onClick);
      mo.disconnect();
      if (raf) cancelAnimationFrame(raf);
      layer.remove();
    };
  }, [s.numbered]);

  useEffect(() => {
    const sync = () => featureStore.refresh();
    window.addEventListener("storage", sync);
    window.addEventListener(CHANGE_EVENT, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(CHANGE_EVENT, sync);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.toLowerCase() !== "f") return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || el?.isContentEditable) return;
      e.preventDefault();
      setOpen((v) => !v);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const hideCss = s.hidden
    .filter((id) => FID_RE.test(id))
    .map((id) => `[data-fid="${id}"]`)
    .join(",");

  return (
    <>
      {hideCss && <style>{`${hideCss}{display:none !important}`}</style>}
      {s.hidden.length > 0 && (
        <div className="gv-fid-status" data-fid="S-74" role="status">
          <EyeOff size={13} />
          <span>已隐藏 {s.hidden.length} 个功能</span>
          <button
            onClick={() => {
              setDetailId("");
              setOpen(true);
            }}
          >
            查看清单
          </button>
          <button onClick={() => featureStore.restoreAll()}>全部恢复</button>
        </div>
      )}
      {toast && (
        <div className={"gv-fid-toast " + toast.kind} data-fid="S-75" role="status" aria-live="polite">
          {toast.kind === "hide" ? <EyeOff size={14} /> : toast.kind === "show" ? <Eye size={14} /> : <Info size={14} />}
          <span className="gv-fid-toast-text">{toast.text}</span>
          {toast.kind === "hide" && toast.ids.length > 0 && (
            <button
              className="gv-fid-toast-action"
              onClick={() => {
                toast.ids.forEach((id) => featureStore.setHidden(id, false));
                setToast(null);
              }}
            >
              恢复
            </button>
          )}
          <button className="gv-fid-toast-x" onClick={() => setToast(null)} aria-label="关闭提示">
            <X size={13} />
          </button>
        </div>
      )}
      {s.entry && (
        <div className="gv-fid-pill" data-fid="S-68">
          <button
            className={"gv-fid-pillbtn" + (s.numbered ? " on" : "")}
            onClick={() => featureStore.toggleNumbered()}
            title={s.numbered ? "关闭编号徽标" : "显示编号徽标"}
            data-fid="S-69"
          >
            <Hash size={13} /> 编号
          </button>
          <i className="gv-fid-pillsp" />
          <button
            className="gv-fid-pillbtn"
            onClick={() => {
              setDetailId("");
              setOpen(true);
            }}
            title="打开功能清单（Shift + F）"
            data-fid="S-70"
          >
            功能清单
            {s.hidden.length > 0 && <em>{s.hidden.length}</em>}
          </button>
        </div>
      )}
      {open && (
        <FeatureManager
          onClose={() => {
            setOpen(false);
            setDetailId("");
          }}
          initialDetail={detailId}
        />
      )}
    </>
  );
}

/* --------------------------- 设置页里的入口卡片 --------------------------- */

export function FeatureAdminCard() {
  const s = useFeatureState();
  const [open, setOpen] = useState(false);
  return (
    <section className="white-panel gv-fid-card" data-fid="S-73">
      <h3>功能编号与隐藏</h3>
      <div className="setting-row">
        <span>已登记功能</span>
        <b>{FEATURES.length} 个</b>
      </div>
      <div className="setting-row">
        <span>已隐藏</span>
        <b>{s.hidden.length} 个</b>
      </div>
      <div className="setting-row">
        <span>界面编号徽标</span>
        <b>{s.numbered ? "显示中" : "关闭"}</b>
      </div>
      <p className="body-copy">
        每个功能都有一个固定编号（如 L-07）。打开清单可按编号搜索、定位、隐藏或恢复功能；点进任一功能可以查看它的作用、
        被改过几次与每次改动的快照，并能回退到某次改动之前。隐藏只影响本机当前浏览器，随时可以一键恢复。快捷键 Shift + F 打开清单。
      </p>
      <div className="update-actions">
        <button className="btn" onClick={() => setOpen(true)}>
          打开功能清单
        </button>
        <button className="btn" onClick={() => featureStore.toggleNumbered()}>
          {s.numbered ? "关闭编号徽标" : "显示编号徽标"}
        </button>
      </div>
      {open && <FeatureManager onClose={() => setOpen(false)} />}
    </section>
  );
}
