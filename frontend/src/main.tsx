import React, { useState, useEffect, useRef, useCallback } from "react";
import { createRoot } from "react-dom/client";
import {
  LayoutDashboard,
  FolderOpen,
  Lightbulb,
  Layers3,
  Settings2,
  Plus,
  Search,
  ArrowUpRight,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  MoreHorizontal,
  Upload,
  Check,
  Clock3,
  Sun,
  Grid2X2,
  List,
  Command,
  PanelLeftClose,
  X,
  FileText,
  Copy,
  Archive,
  Trash2,
  Download,
  RotateCcw,
  CheckCircle2,
  ShieldCheck,
  ArrowLeft,
  Loader2,
  AlertCircle,
  FileUp,
  MapPin,
  Home,
  Activity,
  HelpCircle,
  BookOpen,
  Sparkles,
  RefreshCw,
} from "lucide-react";
import { api, post, fmtDate, clone, type Project, type Obj } from "./types";
import { guessLevels } from "./floorDetect";
import { levelSummary } from "./floors";
import { Plan } from "./Plan";
import { Workspace } from "./Workspace";
import { ShellV2 } from "./ShellV2";
import { AppVersionPanel } from "./AppVersionPanel";
import { UpdatePanel } from "./UpdatePanel";
import { FeatureAdminCard, FeatureRuntime } from "./featureFlags";
import { ProductLibrary } from "./ProductLibrary";
import "./styles.css";
import { Button, Modal, Badge, Field, STATUS_MATCH } from "./ui";
import { confirmDanger } from "./dangerConfirm";

// 截止按北京时间；旧数据只有日期的按当天 23:59 算。
const isOverdue = (dueAt?: string) => {
  if (!dueAt) return false;
  const local = dueAt.length === 10 ? `${dueAt}T23:59` : dueAt;
  return new Date(`${local}:00+08:00`).getTime() < Date.now();
};

function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/* 2026-10-14（细则 §十.20）：下单是事实，买灯判定是判断，不再用判断挡事实。
   旧版要三连 prompt、且只在「已判买灯」时才出现按钮 ⇒ 入口被自己关死。 */
function App() {
  const [page, setPage] = useState("dashboard"),
    [projects, setProjects] = useState<Project[]>([]),
    [active, setActive] = useState<string | null>(
      new URLSearchParams(location.search).get("project"),
    ),
    [loading, setLoading] = useState(true),
    // 项目列表是否成功读到过：没读到之前不显示「0 个项目」，读失败显示错误和重试。
    [loaded, setLoaded] = useState(false),
    [error, setError] = useState(""),
    [modal, setModal] = useState(""),
    [toast, setToast] = useState(""),
    [query, setQuery] = useState(""),
    [filter, setFilter] = useState("全部项目"),
    [view, setView] = useState("grid"),
    [activity, setActivity] = useState<Obj[]>([]),
    [products, setProducts] = useState<Obj[]>([]),
    [sceneTemplates, setSceneTemplates] = useState<Obj[]>([]),
    [health, setHealth] = useState<Obj>({}),
    [busy, setBusy] = useState(false),
    // 外壳 v2：根入口默认就是 v2；?shell=old 回到旧壳（旧壳里可再切回新版）。
    [shellV2, setShellV2] = useState(() => new URLSearchParams(location.search).get("shell") !== "old"),
    // 有新版可用时记下新的包名：只提示，不自动刷新页面。
    [updateAsset, setUpdateAsset] = useState("");
  const toastTimer = useRef<any>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const notify = useCallback((s: string) => {
    setToast(s);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 4500);
  }, []);
  const refresh = useCallback(async () => {
    try {
      const [p, a, h] = await Promise.all([
        api<Project[]>("/projects"),
        api<Obj[]>("/activity"),
        api("/health"),
      ]);
      setProjects(p);
      setLoaded(true);
      setActivity(a);
      setHealth(h);
      setError("");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    refresh();
    Promise.all([api<Obj[]>("/products"), api<Obj[]>("/scene-templates")])
      .then(([items, templates]) => { setProducts(items); setSceneTemplates(templates); })
      .catch(() => {});
  }, [refresh]);
  // 自动更新：轮询后端托管的前端包，一旦变了（工作台迭代）就自己载入新版本，不用手动刷新。
  const loadedAsset = useRef("");
  useEffect(() => {
    if (!loadedAsset.current) {
      try {
        const path = new URL(import.meta.url).pathname;
        // 仅在构建产物里生效：/dev/ 不比较，避免开发时循环刷新。
        loadedAsset.current = path.includes("/assets/") ? path.split("/").pop() || "" : "";
      } catch {
        loadedAsset.current = "";
      }
    }
    const check = async () => {
      if (!loadedAsset.current) return;
      try {
        const b = await api<Obj>("/build");
        if (b.asset && b.asset !== loadedAsset.current) {
          loadedAsset.current = b.asset;
          // 不自动重载页面：自动跳转会打断正在编辑的设计，也容易被当成「自己又开了一个网页」。
          // 改成右下角常驻提示，由人点一下再载入。
          setUpdateAsset(b.asset);
        }
      } catch {
        /* 服务重启中或不可用，下一轮再试 */
      }
    };
    check();
    const timer = setInterval(check, 8000);
    const onVisible = () => {
      if (!document.hidden) check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [notify]);
  function open(id: string) {
    setActive(id);
    // 旧壳里打开项目时把 shell=old 带上，刷新/返回不会跳回新版壳
    history.replaceState(null, "", `?project=${id}` + (shellV2 ? "" : "&shell=old"));
  }
  function close() {
    setActive(null);
    history.replaceState(null, "", shellV2 ? location.pathname : `${location.pathname}?shell=old`);
    refresh();
  }
  const run = async (fn: () => Promise<any>, message: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      notify(message);
      await refresh();
    } catch (e: any) {
      notify(e.message);
    } finally {
      setBusy(false);
    }
  };
  const mutate = async (p: Project, action: string) => {
    if (action === "delete") {
      const ok = await confirmDanger({
        title: `永久删除「${p.name}」？`,
        detail: "项目附件与历史记录会一并删除，此操作不可撤销。",
        confirmText: "确认删除",
      });
      if (!ok) return;
    }
    run(
      () =>
        action === "delete"
          ? api("/projects/" + p.id, { method: "DELETE" })
          : post(`/projects/${p.id}/${action}`),
      "操作已保存",
    );
  };
  async function importJson(file?: File) {
    if (!file) return;
    try {
      if (file.size > 10 * 1024 * 1024)
        throw new Error("项目 JSON 不能超过 10 MB");
      const p = await post("/projects/import", JSON.parse(await file.text()));
      notify("项目已导入，复核状态已重置");
      open(p.id);
    } catch (e: any) {
      notify(e.message);
    }
  }
  const filtered = projects.filter(
    (p) =>
      (filter === "全部项目"
        ? true
        : (STATUS_MATCH[filter] || [filter]).includes(p.status)) &&
      (!query ||
        `${p.name} ${p.code} ${p.client} ${p.city}`
          .toLowerCase()
          .includes(query.toLowerCase())),
  );
  // Keep demo/closed-region drafts in the full project list for later,
  // individually approved cleanup; they must not flood today's home view.
  const visibleProjects = page === "dashboard"
    ? filtered.filter(p => !p.isDemo && !/^闭合区域\s*\d+$/.test(p.name))
    : filtered;
  const stats = [
    {
      label: "全部项目",
      value: projects.length,
      icon: FolderOpen,
      foot: "每一个空间，都值得好光",
      color: "green",
    },
    {
      label: "设计进行中",
      value: projects.filter((p) => p.status === "设计中").length,
      icon: Layers3,
      foot: "让设计想法逐一落地",
      color: "blue",
    },
    {
      label: "等待人工复核",
      value: projects.filter((p) => ["待复核", "待人工确认"].includes(p.status))
        .length,
      icon: ShieldCheck,
      foot: "细节确认，安心交付",
      color: "amber",
    },
    {
      label: "已确认 / 冻结",
      value: projects.filter((p) => p.status === "已冻结").length,
      icon: CheckCircle2,
      foot: "经过人工复核的设计",
      color: "purple",
    },
  ];
  if (shellV2 && !active) {
    return (
      <>
        <ShellV2
          projects={projects}
          health={health}
          products={products}
          sceneTemplates={sceneTemplates}
          onOpen={open}
          onCreate={() => setModal("create")}
          onNavigate={(p) => {
            setShellV2(false);
            setPage(p);
            // 从 v2 进设置/项目库等旧页时明确进入旧壳，刷新后不会莫名跳回 v2
            history.replaceState(null, "", `${location.pathname}?shell=old`);
          }}
          onOld={() => {
            setShellV2(false);
            setPage("dashboard");
            history.replaceState(null, "", `${location.pathname}?shell=old`);
          }}
          notify={notify}
        />
        {modal === "create" && (
          <CreateProject
            onClose={() => setModal("")}
            onCreated={(p) => {
              setModal("");
              open(p.id);
              notify("项目已创建，开始你的设计");
            }}
            notify={notify}
          />
        )}
        {toast && (
          <div className="toast">
            <CheckCircle2 size={18} />
            {toast}
          </div>
        )}
      </>
    );
  }

  if (active)
    return (
      <>
        <Workspace
          id={active}
          onClose={close}
          notify={notify}
          products={products}
          sceneTemplates={sceneTemplates}
          health={health}
          shellV2={shellV2}
        />
        {toast && (
          <div className="toast">
            <CheckCircle2 size={18} />
            {toast}
          </div>
        )}
        {updateAsset && (
          <div className="update-banner">
            <Sparkles size={18} />
            <span>工作台已更新（新版已就绪，不影响当前编辑）</span>
            <Button variant="primary" onClick={() => location.reload()}>
              载入新版本
            </Button>
          </div>
        )}
      </>
    );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" onClick={() => setPage("dashboard")}>
          <span className="brand-mark">
            <i />
            <b />
          </span>
          <span>
            光律 <small>GUANGLV</small>
            <em>LIGHTING DESIGN STUDIO</em>
          </span>
        </a>
        <div className="workspace-switch">
          <span className="workspace-avatar">光</span>
          <div>
            <b>我的设计工作室</b>
            <small>本地工作空间</small>
          </div>
          <ChevronDown size={15} />
        </div>
        <div className="nav-caption">
          工作空间 <span>WORKSPACE</span>
        </div>
        <nav>
          {[
            { key: "dashboard", label: "工作台", icon: LayoutDashboard },
            { key: "projects", label: "全部项目", icon: FolderOpen },
            { key: "products", label: "灯具与设备库", icon: Lightbulb },
            { key: "templates", label: "场景灵感库", icon: Layers3 },
          ].map((n) => (
            <button
              key={n.key}
              aria-label={n.label}
              className={page === n.key ? "active" : ""}
              onClick={() => {
                setPage(n.key);
                setFilter("全部项目");
              }}
            >
              <n.icon size={19} />
              <span>{n.label}</span>
              {n.key === "projects" && <small>{projects.length}</small>}
            </button>
          ))}
        </nav>
        <div className="nav-divider" />
        <div className="nav-caption">工具与支持</div>
        <nav>
          <button onClick={() => { location.href = "?shell=v2"; }}>
            <Sparkles size={18} />
            <span>新版工作台</span>
            <ArrowUpRight size={14} />
          </button>
          <button onClick={() => setModal("guide")}>
            <BookOpen size={18} />
            <span>使用指南</span>
            <ArrowUpRight size={14} />
          </button>
          <button
            className={page === "settings" ? "active" : ""}
            onClick={() => setPage("settings")}
          >
            <Settings2 size={18} />
            <span>工作台设置</span>
          </button>
        </nav>
        <div className="sidebar-bottom">
          <div className="offline-note">
            <span className="live-dot" />
            本地模式 · 数据由你掌握
            <p>
              项目自动保存于本地数据库
              <br />
              无需云端，也能专注设计。
            </p>
            <div className="local-meter">
              <i />
            </div>
            <small>
              SQLite 持久化存储 <ShieldCheck size={13} />
            </small>
          </div>
          <button className="user-profile" onClick={() => setPage("settings")}>
            <span className="avatar">设</span>
            <span>
              <b>本机工作空间</b>
              <small>单用户 · 无需登录</small>
            </span>
            <Settings2 size={16} />
          </button>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div>
            <PanelLeftClose size={18} />
            <span className="top-separator" />
            工作空间 <ChevronRight size={13} />
            <b>
              {
                {
                  dashboard: "工作台",
                  projects: "全部项目",
                  products: "灯具与设备库",
                  templates: "场景灵感库",
                  settings: "工作台设置",
                }[page]
              }
            </b>
          </div>
          <div>
            <span className="local-status">
              <i /> 本地服务{health.ok ? "已连接" : "连接中"}
            </span>
            <button
              className="icon-btn"
              aria-label="使用帮助"
              onClick={() => setModal("guide")}
            >
              <HelpCircle size={18} />
            </button>
            <span className="avatar small" title="本机单用户工作台">
              本
            </span>
          </div>
        </header>
        <main className="main-content">
          {error ? (
            <div className="error-banner">
              <AlertCircle />
              {error}
              <Button onClick={() => { setLoading(true); refresh(); }}>重试连接</Button>
            </div>
          ) : null}
          {(page === "dashboard" || page === "projects") && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">
                    <Sun size={15} /> 为生活，设计恰到好处的光
                  </div>
                  <h1>
                    {page === "dashboard"
                      ? "每一束光，都有它的位置。"
                      : "让好设计，有序发生。"}
                  </h1>
                  <p>
                    {page === "dashboard"
                      ? "从空间理解到情景交付，让灵感与严谨在这里相遇。"
                      : "管理你的项目、设计版本与交付进度。"}
                  </p>
                </div>
                <Button variant="primary" onClick={() => setModal("create")}>
                  <Plus size={17} />
                  新建项目
                </Button>
              </div>
              {page === "dashboard" && (
                <>
                  <section className="welcome-banner">
                    <div className="banner-copy">
                      <span className="mini-kicker">
                        <i /> YOUR NEXT BRIGHT IDEA
                      </span>
                      <h2>好光，从读懂空间开始。</h2>
                      <p>
                        导入一张户型图，将空间、灯具与生活场景连在一起。
                        <br />
                        在一个工作台里，完成从想法到交付的每一步。
                      </p>
                      <div>
                        <Button onClick={() => setModal("create")}>
                          开启新的设计 <ArrowUpRight size={16} />
                        </Button>
                        <button
                          className="text-link"
                          onClick={() => setModal("guide")}
                        >
                          了解设计流程 <ArrowRight size={14} />
                        </button>
                      </div>
                      <span className="banner-foot">
                        空间识别 <i /> 灯光设计 <i /> 智能情景 <i /> 复核与交付
                      </span>
                    </div>
                    <div className="hero-plan">
                      <div className="plan-decoration ring-one" />
                      <div className="plan-decoration ring-two" />
                      {projects[0] && <Plan design={projects[0].design} mini />}
                      <div className="floating-label">
                        <span className="light-icon">
                          <Lightbulb size={18} />
                        </span>
                        <div>
                          <b>让空间，有光的层次</b>
                          <small>LIGHT SHAPES THE WAY WE LIVE</small>
                        </div>
                        <span className="sparkle">✧</span>
                      </div>
                      <div className="plan-caption">
                        CONCEPT PLAN — 01 <span>示例设计 / DRAFT</span>
                      </div>
                    </div>
                  </section>
                  <div className="stats-grid">
                    {stats.map((s, i) => (
                      <button
                        className="stat-card"
                        key={s.label}
                        onClick={() => {
                          setFilter(
                            ["全部项目", "进行中", "待确认", "已完成"][i],
                          );
                          setPage("projects");
                        }}
                      >
                        <div>
                          <span>{s.label}</span>
                          <span className={"stat-icon " + s.color}>
                            <s.icon size={18} />
                          </span>
                        </div>
                        {loaded ? (
                          <strong>
                            {s.value > 0 ? String(s.value).padStart(2, "0") : "0"}
                            <span>个项目</span>
                          </strong>
                        ) : (
                          <strong className="skeleton-line" aria-hidden="true" />
                        )}
                        <small>
                          {s.foot}
                          <ArrowUpRight size={13} />
                        </small>
                      </button>
                    ))}
                  </div>
                </>
              )}
              <section className="projects-section">
                <div className="section-heading">
                  <h2>
                    {page === "dashboard" ? "最近项目" : "项目总览"}{" "}
                    <span>
                      {loaded
                        ? (page === "dashboard" ? visibleProjects : filtered).length
                        : "…"}
                    </span>
                  </h2>
                  <button
                    className="text-link"
                    onClick={() => importRef.current?.click()}
                  >
                    <Upload size={14} />
                    导入项目
                  </button>
                  <input
                    hidden
                    type="file"
                    accept=".json"
                    ref={importRef}
                    onChange={(e) => {
                      importJson(e.target.files?.[0]);
                      e.target.value = "";
                    }}
                  />
                </div>
                <div className="project-toolbar">
                  <div className="tabs-row">
                    <div className="project-tabs">
                      {["全部项目", "未开始", "进行中", "待确认", "已完成"].map(
                        (s) => (
                          <button
                            className={filter === s ? "active" : ""}
                            key={s}
                            onClick={() => setFilter(s)}
                          >
                            {s}
                          </button>
                        ),
                      )}
                    </div>
                    {/* 归档单独一个虚线入口：与 pill 同排、在组外，不与状态词并排（作者 2026-10-19 拍板 3A） */}
                    <button
                      className={"tab-arch" + (filter === "归档" ? " on" : "")}
                      aria-pressed={filter === "归档"}
                      onClick={() => setFilter("归档")}
                    >
                      归档 {loaded ? projects.filter((p) => p.status === "已归档").length : "…"} ›
                    </button>
                  </div>
                  <div className="filter-tools">
                    <div className="search-field">
                      <Search size={15} />
                      <input
                        placeholder="搜索项目、客户或编号"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                      />
                      {query && (
                        <button
                          onClick={() => setQuery("")}
                          aria-label="清空搜索"
                        >
                          <X size={13} />
                        </button>
                      )}
                    </div>
                    {/* 9 项收成 3 项：三个原状态词一个不删（稿面 1302），已归档也不在这里——它只有上面那一个虚线入口 */}
                    <select
                      aria-label="更多状态筛选"
                      value={["识别中", "已确认", "已导出"].includes(filter) ? filter : ""}
                      onChange={(e) => e.target.value && setFilter(e.target.value)}
                    >
                      <option value="">更多状态 ›</option>
                      <option value="识别中">识别中</option>
                      <option value="已确认">已确认</option>
                      <option value="已导出">已导出</option>
                    </select>
                    <div className="view-switch">
                      <button
                        className={view === "grid" ? "active" : ""}
                        aria-label="卡片视图"
                        onClick={() => setView("grid")}
                      >
                        <Grid2X2 size={16} />
                      </button>
                      <button
                        className={view === "list" ? "active" : ""}
                        aria-label="列表视图"
                        onClick={() => setView("list")}
                      >
                        <List size={17} />
                      </button>
                    </div>
                  </div>
                </div>
                {loading && !loaded ? (
                  <div
                    className={"project-grid skeleton-grid " + (view === "list" ? "list-view" : "")}
                    role="status"
                    aria-busy="true"
                    aria-label="正在读取本地项目"
                  >
                    {[0, 1, 2, 3, 4, 5].map((i) => (
                      <div className="project-card skeleton-card" key={i} aria-hidden="true">
                        <div className="skeleton-block" />
                        <div className="skeleton-line wide" />
                        <div className="skeleton-line" />
                      </div>
                    ))}
                  </div>
                ) : !loaded ? (
                  <div className="empty-state load-failed" role="alert">
                    <AlertCircle size={35} />
                    <h3>项目列表读取失败</h3>
                    <p>{error || "无法连接本地服务"}。项目数据没有丢失，请检查服务后重试。</p>
                    <Button
                      variant="primary"
                      onClick={() => { setLoading(true); refresh(); }}
                    >
                      <RefreshCw size={15} />
                      重试
                    </Button>
                  </div>
                ) : visibleProjects.length ? (
                  <div
                    className={
                      "project-grid " + (view === "list" ? "list-view" : "")
                    }
                  >
                    {visibleProjects.map((p) => (
                      <ProjectCard
                        key={p.id}
                        p={p}
                        onOpen={() => open(p.id)}
                        onAction={(a) => mutate(p, a)}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="empty-state">
                    <FolderOpen size={35} />
                    <h3>这里还没有项目</h3>
                    <p>
                      {query
                        ? "试试其他项目名称或客户关键词。"
                        : "从一张户型图开始你的第一个灯光设计。"}
                    </p>
                  </div>
                )}
              </section>
              {page === "dashboard" && (
                <div className="bottom-grid">
                  <section className="activity-panel">
                    <div className="section-heading">
                      <h2>工作动态</h2>
                      <span className="subtle">最近的设计足迹</span>
                    </div>
                    {activity.slice(0, 4).map((a) => (
                      <button
                        className="activity-row"
                        key={a.id}
                        onClick={() => open(a.project_id)}
                      >
                        <span className="activity-icon">
                          <Clock3 size={16} />
                        </span>
                        <div>
                          <b>{a.action}</b>
                          <small>{a.projectName}</small>
                        </div>
                        <time>{fmtDate(a.at)}</time>
                        <ChevronRight size={14} />
                      </button>
                    ))}
                    {!activity.length && (
                      <p className="subtle">
                        创建项目后，你的操作记录会出现在这里。
                      </p>
                    )}
                  </section>
                  <section className="process-card">
                    <span className="mini-kicker">
                      DESIGNED FOR YOUR WORKFLOW
                    </span>
                    <h3>灵感可以自由，交付必须严谨。</h3>
                    <p>
                      AI 提供初稿，你来把关每个细节。
                      <br />
                      每次修改可追溯，每份交付有依据。
                    </p>
                    <div className="process-steps">
                      <span>
                        <FileUp size={16} />
                        导入
                      </span>
                      <ChevronRight size={12} />
                      <span>
                        <Lightbulb size={16} />
                        设计
                      </span>
                      <ChevronRight size={12} />
                      <span>
                        <ShieldCheck size={16} />
                        复核
                      </span>
                      <ChevronRight size={12} />
                      <span>
                        <Download size={16} />
                        交付
                      </span>
                    </div>
                    <button
                      className="text-link"
                      onClick={() => setModal("guide")}
                    >
                      查看完整工作流程 <ArrowUpRight size={14} />
                    </button>
                  </section>
                </div>
              )}
            </>
          )}
          {page === "products" && (
            <ProductLibrary notify={notify} goProjects={() => setPage("projects")} />
          )}
          {page === "templates" && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">SCENE INSPIRATION</div>
                  <h1>光随生活，情景自如。</h1>
                  <p>
                    四种起点，无限种生活方式。在项目的「智能情景」中应用这些预设。
                  </p>
                </div>
              </div>
              <div className="scene-inspiration">
                {[
                  {
                    n: "日常照明",
                    en: "EVERYDAY LIVING",
                    b: 85,
                    t: 4000,
                    c: "#dfdbd5",
                    desc: "明亮而不打扰，让日常舒展。",
                  },
                  {
                    n: "温馨会客",
                    en: "WARM WELCOME",
                    b: 65,
                    t: 3000,
                    c: "#e5d5b8",
                    desc: "柔和暖光，留给相聚的时刻。",
                  },
                  {
                    n: "观影时光",
                    en: "CINEMA MOMENT",
                    b: 20,
                    t: 2700,
                    c: "#564e44",
                    desc: "调暗空间，让故事成为主角。",
                  },
                  {
                    n: "晚安模式",
                    en: "GOOD NIGHT",
                    b: 8,
                    t: 2700,
                    c: "#3f3628",
                    desc: "一盏低光，陪伴入眠前的安静。",
                  },
                ].map((s) => (
                  <article key={s.n} style={{ background: s.c }}>
                    <span>{s.en}</span>
                    <Sun size={48} strokeWidth={0.8} />
                    <h2>{s.n}</h2>
                    <p>{s.desc}</p>
                    <div>
                      {s.b}% 亮度 <i /> {s.t}K 色温
                    </div>
                    <Button
                      onClick={() => {
                        setPage("projects");
                        notify("打开项目 → 智能情景 → 应用四组预设");
                      }}
                    >
                      在项目中使用 <ArrowUpRight size={14} />
                    </Button>
                  </article>
                ))}
              </div>
            </>
          )}
          {page === "settings" && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">YOUR LOCAL STUDIO</div>
                  <h1>工作台设置</h1>
                  <p>清晰的服务状态，完全本地的数据。</p>
                </div>
              </div>
              <div className="settings-grid">
                <section className="white-panel">
                  <h3>运行环境</h3>
                  {[
                    ["数据库", health.storage || "未连接"],
                    ["服务状态", health.ok ? "运行中" : "未连接"],
                    ["自动保存", "编辑停止后 800 ms 保存"],
                    ["识别 Provider", health.recognitionProvider || "local"],
                    ["图像 Provider", health.imageProvider || "local"],
                  ].map(([k, v]) => (
                    <div className="setting-row" key={k}>
                      <span>{k}</span>
                      <b>{v}</b>
                    </div>
                  ))}
                </section>
                <section className="white-panel">
                  <h3>模型与数据安全</h3>
                  <div className="notice">
                    <ShieldCheck size={18} />
                    本机未保存任何云端密钥；上传的图纸仅作为画布底图，识别结果需人工确认，基础设计不依赖外部服务。
                  </div>
                  <p className="body-copy">
                    导入图片 / PDF 后自动识别空间边界；DXF 只解析基础几何，房间名、面积与语义属性需人工填写与校正。
                    识别结果先以草稿出现，人工确认后才进入设计数据。图像输出为二维灯光示意，不是 AI
                    实景图或照度计算，也不做照度验算。
                  </p>
                  <p className="body-copy">
                    替换模型请在后端 Provider
                    注册适配器并配置环境变量。图纸与设计数据都只存在你自己的机器上。
                  </p>
                  <Button onClick={() => setModal("guide")}>
                    阅读使用指南 <ArrowRight size={15} />
                  </Button>
                </section>
                <section className="white-panel">
                  <h3>版本与更新</h3>
                  <div className="setting-row">
                    <span>当前版本</span>
                    <b>v{health.version || __APP_VERSION__}</b>
                  </div>
                  <AppVersionPanel notify={notify} />
                  <UpdatePanel notify={notify} />
                </section>
                <section className="white-panel">
                  <h3>关于与联系</h3>
                  <p className="body-copy">
                    光律 Guanglv Workbench · MIT 开源。图纸解析、三维渲染与情景规则来自真实照明项目的打磨；数据全部留在你自己的机器上。
                  </p>
                  <div className="contact-cards compact">
                    <a className="contact-card" href="/wechat-support.jpg" target="_blank" rel="noreferrer">
                      <img src="/wechat-support.jpg" alt="技术咨询微信二维码" />
                      <b>技术咨询</b>
                    </a>
                    <a className="contact-card" href="/wechat-business.jpg" target="_blank" rel="noreferrer">
                      <img src="/wechat-business.jpg" alt="商务合作微信二维码" />
                      <b>商务合作</b>
                    </a>
                    <a className="contact-card" href="/wechat-knx.jpg" target="_blank" rel="noreferrer">
                      <img src="/wechat-knx.jpg" alt="KNX培训课程咨询微信二维码" />
                      <b>KNX培训课程咨询</b>
                    </a>
                  </div>
                </section>
                <FeatureAdminCard />
              </div>
            </>
          )}
          <footer className="footer">
            <span>
              光律 <i /> 让每一束光，都有迹可循。
            </span>
            <span>
              本地工作台 · v{health.version || __APP_VERSION__}{" "}
              <span className="live-dot" />
            </span>
          </footer>
        </main>
      </div>
      {modal === "create" && (
        <CreateProject
          onClose={() => setModal("")}
          onCreated={(p) => {
            setModal("");
            open(p.id);
            notify("项目已创建，开始你的设计");
          }}
          notify={notify}
        />
      )}
      {modal === "guide" && (
        <Modal
          title="从空间，到恰好的光"
          subtitle="光律工作台 · 第一版使用指南"
          onClose={() => setModal("")}
        >
          <div className="guide-list">
            {[
              [
                "01",
                "建立项目与导入",
                "新建项目后上传 PNG、JPG、PDF、DXF 或安全 SVG。项目编号只在创建时确认，后续版本保持不变。",
              ],
              [
                "02",
                "校正你的空间",
                "图片、PDF 和 SVG 上传后自动分析真实图像中的空间边界；DXF 自动解析基础几何。空项目直接显示可编辑草稿，已有手工设计不会被覆盖。边界、用途、名称、面积及楼层需人工校正。",
              ],
              [
                "03",
                "布置灯具与情景",
                "每盏灯独立保存产品参数、位置与回路。新增情景，分别控制每盏灯的开关、亮度和色温。灯带每段必须有独立电源与控制关系。",
              ],
              [
                "04",
                "人工复核与交付",
                "需求、布置、灯光、价格、交付分别签名复核。设计变更只让受影响的那几道复核失效，并记录原因。示例项目始终是草稿；正式施工图、电气校核和真实报价不能自动完成。",
              ],
              [
                "05",
                "版本与本地备份",
                "编辑自动保存到 SQLite；历史可恢复为新版本。JSON 可重新导入，ZIP 包含设计与导出资料，但不包含原始附件。完整备份请复制 data 目录。",
              ],
            ].map(([n, t, d]) => (
              <div key={n}>
                <span>{n}</span>
                <section>
                  <h3>{t}</h3>
                  <p>{d}</p>
                </section>
              </div>
            ))}
          </div>
          <div className="guide-contact">
            <h3>需要帮助？</h3>
            <p>用起来有问题，或者要把它接进真实项目，都可以直接找我们。</p>
            <div className="contact-cards">
              <a className="contact-card" href="/wechat-support.jpg" target="_blank" rel="noreferrer">
                <img src="/wechat-support.jpg" alt="技术咨询微信二维码" />
                <b>技术咨询</b>
                <span>出图、三维、情景规则怎么用</span>
              </a>
              <a className="contact-card" href="/wechat-business.jpg" target="_blank" rel="noreferrer">
                <img src="/wechat-business.jpg" alt="商务合作微信二维码" />
                <b>商务合作</b>
                <span>设计、智能、产品与落地交付</span>
              </a>
              <a className="contact-card" href="/wechat-knx.jpg" target="_blank" rel="noreferrer">
                <img src="/wechat-knx.jpg" alt="KNX培训课程咨询微信二维码" />
                <b>KNX培训课程咨询</b>
                <span>KNX 系统课程与项目陪跑</span>
              </a>
            </div>
          </div>
          <div className="modal-foot">
            <Button variant="primary" onClick={() => setModal("")}>
              开始设计 <ArrowRight size={16} />
            </Button>
          </div>
        </Modal>
      )}
      {toast && (
        <div className="toast">
          <CheckCircle2 size={18} />
          {toast}
        </div>
      )}
      {updateAsset && (
        <div className="update-banner">
          <Sparkles size={18} />
          <span>工作台已更新（新版已就绪）</span>
          <Button variant="primary" onClick={() => location.reload()}>
            载入新版本
          </Button>
        </div>
      )}
    </div>
  );
}
function ProjectCard({
  p,
  onOpen,
  onAction,
}: {
  p: Project;
  onOpen: () => void;
  onAction: (a: string) => void;
}) {
  const [menu, setMenu] = useState(false);
  return (
    <article className="project-card">
      <button className="project-preview" onClick={onOpen}>
        <div className="preview-badges">
          <Badge status={p.status} />
          {p.isDemo && <span className="draft-label">示例项目</span>}
        </div>
        <Plan
          design={p.design}
          mini
          background={
            p.design.baseFileId
              ? `/api/projects/${p.id}/files/${p.design.baseFileId}?preview=true`
              : ""
          }
        />
        <div className="preview-bottom">
          <span>
            {p.type} / {levelSummary(p.floors, p.basements)}
          </span>
          <span className="version-chip">
            V{String(p.version).padStart(2, "0")}
          </span>
        </div>
      </button>
      <div className="project-info">
        <div className="project-code">
          {p.code}
          <div className="menu-holder">
            <button
              className="icon-btn"
              aria-label={`${p.name} 更多操作`}
              onClick={() => setMenu(!menu)}
            >
              <MoreHorizontal size={19} />
            </button>
            {menu && (
              <>
                <div className="menu-away" onClick={() => setMenu(false)} />
                <div className="dropdown-menu">
                  {[
                    ["duplicate", "复制项目", Copy],
                    ["versions", "新建版本", Layers3],
                    ...(p.status === "已归档"
                      ? [["unarchive", "取消归档", Archive]]
                      : [["archive", "归档项目", Archive]]),
                    ["delete", "删除项目", Trash2],
                  ].map(([k, t, I]: any) => (
                    <button
                      key={k}
                      className={k === "delete" ? "danger-text" : ""}
                      onClick={() => {
                        setMenu(false);
                        onAction(k);
                      }}
                    >
                      <I size={14} />
                      {t}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
        <button className="project-title" onClick={onOpen}>
          {p.name}
          <ArrowUpRight size={17} />
        </button>
        <div className="project-meta">
          <span>{p.client || "未填写客户"}</span>
          <i />
          <span>{p.city || "未填写城市"}</span>
          <i />
          <span>{p.area} m²</span>
        </div>
        <div className="project-review">
          <span>人工复核</span>
          <div>
            <i
              style={{ width: `${(Object.keys(p.reviews).length / 5) * 100}%` }}
            />
          </div>
          <small>{Object.keys(p.reviews).length}/5</small>
        </div>
        <div className="project-card-foot">
          <span>
            <Clock3 size={12} />
            {fmtDate(p.updatedAt)} 更新
          </span>
          <span className="designer-dot">
            {(p.designer || "设").slice(0, 1)}
          </span>
        </div>
      </div>
    </article>
  );
}
function CreateProject({
  onClose,
  onCreated,
  notify,
}: {
  onClose: () => void;
  onCreated: (p: Project) => void;
  notify: (s: string) => void;
}) {
  // Minimal intake on purpose: only the project name is required. Channel /
  // relationship selection is deliberately not part of project creation.
  const [form, setForm] = useState<Obj>({
      name: "",
      client: "",
      city: "",
      type: "平层",
      area: 120,
      floors: 1,
      basements: 0,
      above: 1,
      smart: "无线",
      relationshipType: "direct_b2c",
      mode: "3D",
      ceiling: 3,
      ceilingNet: 0,
    }),
    [files, setFiles] = useState<File[]>([]),
    [saving, setSaving] = useState(false),
    [error, setError] = useState(""),
    // 3D 项目：创建时就地跑三维建模，进度/成功/失败原因都显示在弹窗里。
    [gen, setGen] = useState<Obj | null>(null);
  const upload = useRef<HTMLInputElement>(null);
  const patch = (k: string, v: any) => setForm({ ...form, [k]: v });
  // 附件文件名常写明了楼层（1F/二层/地下一层）：选好图纸后自动把地上/地下层数带上来。
  useEffect(() => {
    if (!files.length) return;
    const guess = guessLevels(files.map((f) => f.name));
    setForm((v) => ({
      ...v,
      above: Math.max(v.above || 1, guess.above),
      basements: Math.max(v.basements || 0, guess.basements),
      floors:
        Math.max(1, Math.max(v.above || 1, guess.above)) +
        Math.max(v.basements || 0, guess.basements),
    }));
  }, [files]);
  // 3D 项目的建模：后台跑，这里轮询进度（成功/失败原因都带出来）。
  async function runGenerate(pid: string, fileId: string) {
    const fd = new FormData();
    fd.append("file_id", fileId);
    const r = await fetch(`/api/lighting3d/${pid}/generate`, { method: "POST", body: fd });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.detail || d.error || `HTTP ${r.status}`);
    setGen({ state: "running", pct: 0.02, stage: "已提交" });
    for (let i = 0; i < 400; i++) {
      await new Promise((res) => setTimeout(res, 900));
      const j: Obj | null = await api(`/lighting3d/${pid}/job`).catch(() => null);
      if (!j) continue;
      setGen(j);
      if (j.state === "done") return j;
      if (j.state === "error") throw new Error(j.error || "三维模型没生成出来");
    }
    throw new Error("生成超时：请在项目的空间画布中重试");
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      let p = await post("/projects", form);
      if (files.length) {
        const fd = new FormData();
        files.forEach((f) => fd.append("files", f));
        // Import editable draft boundaries where possible; raster inference is
        // never represented as a measured CAD wall or confirmed colour plan.
        fd.append("recognize", "true");
        try {
          p = await api(`/projects/${p.id}/files`, {
            method: "POST",
            body: fd,
          });
        } catch (e: any) {
          notify("项目已创建，但附件上传失败：" + e.message);
        }
      }
      if (form.mode === "3D" && (p.files || []).some(
        (f: Obj) => f.type === "DXF" || /\.dxf$/i.test(String(f.name || "")),
      )) {
        // 3D 项目：接着把上传的 DXF 跑成三维模型，弹窗里显示进度。
        const dxf = (p.files || []).find(
          (f: Obj) =>
            f.type === "DXF" || /\.dxf$/i.test(String(f.name || "")),
        );
        setGen({ state: "error", error: "", project: p });
        if (dxf) {
          try {
            await runGenerate(p.id, dxf.id);
            setGen((g) => ({ ...(g || {}), state: "done", project: p }));
            // 2026-10-12 本地口径：图纸导入跑完三维，就直接进「空间预览」这一步——
            // 在这一步确认各空间对不对，不对就地改名字 / 改边界。
            try {
              sessionStorage.setItem("spacePreview", "1");
            } catch {}
            notify("三维模型已生成：请确认空间（不对可当场改名字 / 改边界）");
            setTimeout(() => onCreated(p), 800);
          } catch (e: any) {
            setGen({ state: "error", error: e.message, project: p });
          }
        }
        setSaving(false);
        return;
      }
      onCreated(p);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal
      title="开启一个新的光空间"
      subtitle="只需填写项目名称即可开始；其余可留空。"
      onClose={() => {
        if (!saving) onClose();
      }}
      wide
    >
      <form onSubmit={submit}>
        <div className="form-section-label">
          01 <span>项目信息</span>
          <small>只需项目名称，其余可留空，创建后随时补充</small>
        </div>
        <div className="form-grid">
          <Field label="项目名称 *">
            <input
              autoFocus
              required
              maxLength={100}
              placeholder="例如：栖岸 · 自然主义私宅"
              value={form.name}
              onChange={(e) => patch("name", e.target.value)}
            />
          </Field>
          <Field label="客户（可选）">
            <input
              maxLength={100}
              placeholder="可留空"
              value={form.client}
              onChange={(e) => patch("client", e.target.value)}
            />
          </Field>
          <Field label="建筑类型">
            <select value={form.type} onChange={(e) => patch("type", e.target.value)}>
              {["平层", "复式", "别墅", "商业空间"].map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </Field>
          <Field label="建筑面积 m²">
            <input
              type="number"
              min={0}
              step="0.1"
              value={form.area}
              onChange={(e) => patch("area", +e.target.value)}
            />
          </Field>
          <Field label="地上层数">
            <input
              type="number"
              min={1}
              max={200}
              value={form.above}
              onChange={(e) =>
                setForm((v) => {
                  const above = Math.max(1, +e.target.value || 1);
                  return { ...v, above, floors: above + (v.basements || 0) };
                })
              }
            />
          </Field>
          <Field label="地下层数">
            <input
              type="number"
              min={0}
              max={9}
              value={form.basements}
              onChange={(e) =>
                setForm((v) => {
                  const basements = Math.max(0, +e.target.value || 0);
                  return { ...v, basements, floors: (v.above || 1) + basements };
                })
              }
            />
            <small>地下室不是负数：最下面的这层记作 B1</small>
          </Field>
          <Field label="是否做智能">
            <select
              value={form.smart || "无线"}
              onChange={(e) => patch("smart", e.target.value)}
            >
              <option value="无线">做智能 · 无线（飞利浦）</option>
              <option value="KNX">做智能 · KNX 总线</option>
              <option value="无">无（不做智能 · 按回路开闭）</option>
            </select>
            <small>
              {form.smart === "无"
                ? "不做智能（按回路开闭）：不建智能设备与情景，灯具按回路开闭；回路编号在「灯具配置」里维护"
                : form.smart === "KNX"
                  ? "KNX 总线：有线总线，逐灯调光调色温"
                  : "无线智能：品牌改用飞利浦（原 JOCO 方案停用）；新的灯具清单到位后逐灯选型"}
            </small>
          </Field>
          <p className="subtle">新建项目默认使用 3D 工作台，保留完整空间、灯具、设备和情景编辑；交付时可一键切换 2D。</p>
          <Field label="原始层高 m">
            <input
              type="number"
              min={0}
              step="0.05"
              placeholder="例如：3.0"
              value={form.ceiling || ""}
              onChange={(e) => patch("ceiling", +e.target.value)}
            />
            <small>结构层高</small>
          </Field>
          <Field label="吊顶后层高 m">
            <input
              type="number"
              min={0}
              step="0.05"
              placeholder="例如：2.7"
              value={form.ceilingNet || ""}
              onChange={(e) => patch("ceilingNet", +e.target.value)}
            />
            <small>净高 —— 决定灯具安装高度与光斑大小（光斑直径 = 2 × 高度 × tan(光束角/2)）</small>
          </Field>
          <Field label="城市（可选）">
            <input
              placeholder="例如：杭州"
              value={form.city}
              onChange={(e) => patch("city", e.target.value)}
            />
          </Field>
        </div>
        <div className="form-section-label">
          02 <span>导入原始图纸</span>
          <small>可选，创建后也可上传</small>
        </div>
        <button
          type="button"
          className="upload-zone"
          onClick={() => upload.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            setFiles([...files, ...Array.from(e.dataTransfer.files)]);
          }}
        >
          <span>
            <FileUp size={24} />
          </span>
          <b>点击选择，或拖拽图纸到这里</b>
          <small>DXF 自动建模；图片/PDF 尝试提取空间草稿，缺少可靠边界时仅供透视参考</small>
        </button>
        <input
          ref={upload}
          type="file"
          hidden
          multiple
          accept=".png,.jpg,.jpeg,.webp,.bmp,.tif,.tiff,.pdf,.dxf,.svg"
          onChange={(e) =>
            setFiles([...files, ...Array.from(e.target.files || [])])
          }
        />
        {files.map((f, i) => (
          <div className="picked-file" key={i}>
            <FileText size={14} />
            {f.name}
            <small>{(f.size / 1024).toFixed(0)} KB</small>
            <button
              type="button"
              className="icon-btn"
              onClick={() => setFiles(files.filter((_, j) => j !== i))}
            >
              <X size={14} />
            </button>
          </div>
        ))}
        {error && <div className="form-error">{error}</div>}
        {gen && (
          <div className={"job-panel " + (gen.state || "")}>
            {gen.state === "done" ? (
              <>
                <div className="job-head ok">
                  <CheckCircle2 size={15} />
                  <b>三维模型已生成</b>
                </div>
                <small>{gen.message}</small>
                {(gen.warn || []).slice(0, 4).map((w2: string, i: number) => (
                  <small key={i}>{w2}</small>
                ))}
                <small>马上打开这个项目…</small>
              </>
            ) : gen.state === "error" ? (
              <>
                <div className="job-head bad">
                  <AlertCircle size={15} />
                  <b>三维模型没生成出来</b>
                </div>
                <small>{gen.error || "没有拿到失败原因"}</small>
                <small>可以先进入项目，在空间画布里换一张 DXF 重试。</small>
              </>
            ) : (
              <>
                <div className="job-head">
                  <b>正在生成三维模型…</b>
                  <span>{Math.round((gen.pct || 0) * 100)}%</span>
                </div>
                <div className="job-prog">
                  <i style={{ width: `${Math.max(4, (gen.pct || 0) * 100)}%` }} />
                </div>
                <small>{gen.stage || "准备解析图纸"} · 整套施工图大约 20 秒</small>
              </>
            )}
          </div>
        )}
        <div className="modal-foot">
          <span className="subtle">
            <ShieldCheck size={14} />
            资料仅保存在你的本地工作空间
          </span>
          {gen ? (
            <Button onClick={() => gen.project && onCreated(gen.project)}>
              进入项目
            </Button>
          ) : (
            <>
              <Button onClick={onClose} disabled={saving}>
                取消
              </Button>
              <Button type="submit" variant="primary" disabled={saving}>
                {saving ? (
                  <Loader2 size={16} className="spin" />
                ) : (
                  <Plus size={16} />
                )}
                {saving ? "正在创建…" : "创建项目"}
              </Button>
            </>
          )}
        </div>
      </form>
    </Modal>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <FeatureRuntime />
    <App />
  </React.StrictMode>,
);

/* 挂载成功：清掉启动兜底标记，别让它把好页面刷掉 */
(window as any).__gvMounted = true;
try {
  sessionStorage.removeItem("gv-guard-reloaded");
} catch {}

/* 工作台更新了自己重载：页面拿不到新 bundle 时不用设计师手动刷（后端 /api/build 就是给这个用的）。
   自测：重建前端后停在旧页面上等一会儿，页面应当自己刷新。 */
(() => {
  let mine = "";
  const check = async () => {
    try {
      const r = await fetch("/api/build", { cache: "no-store" });
      const d = await r.json();
      if (!mine) mine = d.buildId || "";
      else if (d.buildId && d.buildId !== mine) location.reload();
    } catch {
      /* 后端在重启就先不管，下一轮再说 */
    }
  };
  check();
  setInterval(check, 30000);
})();
