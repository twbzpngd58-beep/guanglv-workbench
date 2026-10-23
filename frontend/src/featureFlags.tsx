import React, { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Eye, EyeOff, Focus, Hash, RotateCcw, Search, X } from "lucide-react";
import { FEATURES, FEATURE_MAP, FEATURE_MODULES, FID_RE, MODULE_LABEL, type FeatureDef } from "./features";
import "./featureIds.css";

const STORAGE_KEY = "gv.featureIds.v1";
const CHANGE_EVENT = "gv-feature-ids-change";

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
    const hidden = state.hidden.includes(id)
      ? state.hidden.filter((x) => x !== id)
      : [...state.hidden, id];
    write({ ...state, hidden });
  },
  setHidden(id: string, hiddenIt: boolean) {
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

function featureNodes(id: string) {
  return Array.from(document.querySelectorAll<HTMLElement>(`[data-fid="${id}"]`)).filter(
    (el) => el.offsetParent !== null || getComputedStyle(el).position === "fixed",
  );
}

function flashFeature(id: string) {
  const nodes = featureNodes(id);
  if (!nodes.length) return;
  const el = nodes[0];
  el.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
  el.classList.add("gv-fid-flash");
  window.setTimeout(() => el.classList.remove("gv-fid-flash"), 1600);
}

/* ------------------------------- 功能清单面板 ------------------------------- */

function FeatureManager({ onClose }: { onClose: () => void }) {
  const s = useFeatureState();
  const [query, setQuery] = useState("");
  const [hiddenOnly, setHiddenOnly] = useState(false);
  const [msg, setMsg] = useState("");
  const [unknown, setUnknown] = useState<string[]>([]);

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
    if (featureStore.isHidden(id)) {
      setMsg(`${id} 当前是隐藏状态：先点「恢复」再定位。`);
      return;
    }
    if (!featureNodes(id).length) {
      setMsg(`当前页面没有 ${id} 的入口：它可能在另一个页签/项目里，或这个页面还没渲染到它。`);
      return;
    }
    onClose();
    window.setTimeout(() => flashFeature(id), 220);
  };

  return (
    <div className="gv-fid-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="gv-fid-modal" role="dialog" aria-modal="true" aria-label="功能编号与隐藏">
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
                return (
                  <div className={"gv-fid-row" + (hidden ? " is-hidden" : "")} key={f.id}>
                    <span className="gv-fid-chip">{f.id}</span>
                    <div className="gv-fid-meta">
                      <b>{f.name}</b>
                      <small>{f.desc}</small>
                    </div>
                    <div className="gv-fid-acts">
                      <button title="在界面上找到它" onClick={() => doLocate(f.id)}>
                        <Focus size={13} /> 定位
                      </button>
                      <button className={hidden ? "on" : ""} onClick={() => hide(f.id)}>
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
          <span className="gv-fid-msg">{msg}</span>
          <span className="gv-fid-sp" />
          <span className="gv-fid-note">隐藏只影响本机当前浏览器；Shift + F 随时打开本清单</span>
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

/* ------------------------------- 全局运行时 ------------------------------- */

export function FeatureRuntime() {
  const s = useFeatureState();
  const [open, setOpen] = useState(false);

  // 编号徽标：用独立浮层绘制，避免 ::after 被 overflow / 层叠上下文裁掉。
  useEffect(() => {
    if (!s.numbered) return;
    const layer = document.createElement("div");
    layer.className = "gv-fid-layer";
    document.body.appendChild(layer);
    let raf = 0;
    let signature = "";
    const paint = () => {
      raf = 0;
      const rows: string[] = [];
      const nodes: HTMLElement[] = [];
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
        rows.push(`${id}|${Math.round(left)}|${Math.round(top)}|${above ? 1 : 0}`);
        nodes.push(el);
      });
      const sig = rows.join(";");
      if (sig === signature) return;
      signature = sig;
      const frag = document.createDocumentFragment();
      for (const row of rows) {
        const [id, left, top, above] = row.split("|");
        const badge = document.createElement("span");
        badge.className = "gv-fid-badge";
        badge.textContent = id;
        badge.style.left = `${left}px`;
        badge.style.top = `${top}px`;
        badge.style.transform = above === "1" ? "translateY(-100%)" : "none";
        frag.appendChild(badge);
      }
      layer.replaceChildren(frag);
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(paint);
    };
    paint();
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
      {s.entry && (
        <div className="gv-fid-pill">
          <button
            className={"gv-fid-pillbtn" + (s.numbered ? " on" : "")}
            onClick={() => featureStore.toggleNumbered()}
            title={s.numbered ? "关闭编号徽标" : "显示编号徽标"}
          >
            <Hash size={13} /> 编号
          </button>
          <i className="gv-fid-pillsp" />
          <button className="gv-fid-pillbtn" onClick={() => setOpen(true)} title="打开功能清单（Shift + F）">
            功能清单
            {s.hidden.length > 0 && <em>{s.hidden.length}</em>}
          </button>
        </div>
      )}
      {open && <FeatureManager onClose={() => setOpen(false)} />}
    </>
  );
}

/* --------------------------- 设置页里的入口卡片 --------------------------- */

export function FeatureAdminCard() {
  const s = useFeatureState();
  const [open, setOpen] = useState(false);
  return (
    <section className="white-panel gv-fid-card">
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
        每个功能都有一个固定编号（如 L-07）。打开清单可按编号搜索、定位、隐藏或恢复功能；隐藏只影响本机当前浏览器，
        随时可以一键恢复。快捷键 Shift + F 打开清单。
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
