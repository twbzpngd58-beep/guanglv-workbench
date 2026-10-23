import React, { useEffect, useMemo, useState } from "react";
import {
  LayoutDashboard, FolderOpen, Lightbulb, Layers3, Settings2, Plus,
  Search, ArrowRight, ShieldCheck, Clock3, Activity, Sparkles,
  ChevronRight, X, Check, Boxes, PanelLeft, HardDrive, Wifi, Sun,
  Grid2X2, Command,
} from "lucide-react";
import type { Obj, Project } from "./types";
import { getCapabilities } from "./capabilities";
import "./shellV2.css";

type Props = {
  projects: Project[];
  health: Obj;
  products: Obj[];
  sceneTemplates: Obj[];
  onOpen: (id: string) => void;
  onCreate: () => void;
  onNavigate: (page: string) => void;
  onOld: () => void;
  notify: (s: string) => void;
};

type Edition = "personal" | "knx" | "enterprise";

const ED: Record<Edition, { label: string; short: string; note: string }> = {
  personal: { label: "个人版", short: "FREE", note: "全量制图 · 合作品牌产品/零售价 · 合作品牌 IES 只读" },
  knx: { label: "KNX 工程师版", short: "PRO", note: "KNX 工程包 · 刻字 / 调试 / 映射 · 自有 IES" },
  enterprise: { label: "企业定制版", short: "OEM", note: "默认含 KNX · 客户/渠道/价格/团队/白标 · IES 接口" },
};

function statusTag(s: string) {
  if (["待复核", "待人工确认"].includes(s)) return <span className="sv2-tag warn">{s}</span>;
  if (["已冻结", "已交付"].includes(s)) return <span className="sv2-tag ok">{s}</span>;
  if (["设计中", "草稿"].includes(s)) return <span className="sv2-tag blue">{s}</span>;
  return <span className="sv2-tag">{s}</span>;
}

const fmt = (s?: string) => (s ? s.replace("T", " ").slice(0, 16) : "—");

function LicenseIssue({ caps, onClose, onDone, notify }: {
  caps: Obj | null;
  onClose: () => void;
  onDone: () => void;
  notify: (s: string) => void;
}) {
  const [secret, setSecret] = useState("");
  const [edition, setEdition] = useState("enterprise");
  const [licensee, setLicensee] = useState("");
  const [expires, setExpires] = useState("");
  const [mods, setMods] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const moduleRows = ((caps?.modules || []) as Obj[]).filter((m: Obj) => m.pack !== "kernel");
  async function submit() {
    if (!secret.trim() || !licensee.trim()) { notify("请填写签名密钥和授权方"); return; }
    setBusy(true);
    try {
      const r = await fetch("/api/license/sign", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret, edition, licensee, expires, modules: mods }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.detail || "签发失败");
      notify("许可已签发并安装：" + licensee);
      onDone();
      onClose();
    } catch (e: any) {
      notify("签发失败：" + e.message);
    } finally { setBusy(false); }
  }
  return (
    <div className="sv2-mask sv2-licmask" onClick={onClose}>
      <div className="sv2-licmodal" onClick={(e) => e.stopPropagation()} data-fid="K-16">
        <div className="sv2-dh"><b>签发许可</b><span className="sv2-sp" /><button onClick={onClose}><X size={16} /></button></div>
        <div className="sv2-licbody">
          <p className="sv2-hint">本机签发工具：输入发行方密钥，签发后直接安装。正式发行应在离线签发机执行。</p>
          <label>签名密钥<input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="GUANGLV_LICENSE_SECRET" /></label>
          <div className="sv2-licrow">
            <label>版本<select value={edition} onChange={(e) => setEdition(e.target.value)}>
              <option value="personal">个人版</option><option value="knx">KNX 工程师版</option><option value="enterprise">企业定制版</option>
            </select></label>
            <label>到期日<input value={expires} onChange={(e) => setExpires(e.target.value)} placeholder="2027-12-31（留空=长期）" /></label>
          </div>
          <label>授权方<input value={licensee} onChange={(e) => setLicensee(e.target.value)} placeholder="公司 / 个人名称" /></label>
          <div className="sv2-limods">
            <b>模块白名单（留空 = 该版本全部）</b>
            <div>
              {moduleRows.map((m: Obj) => (
                <label key={m.id}><input type="checkbox" checked={mods.includes(m.id)} onChange={(e) => setMods(v => e.target.checked ? [...v, m.id] : v.filter(x => x !== m.id))} />{m.id}<small>{String(m.pack).replace("pack.", "")}</small></label>
              ))}
            </div>
          </div>
          <div className="sv2-dh" style={{ height: "auto", border: 0, padding: 0, justifyContent: "flex-end" }}>
            <button className="sv2-btn" onClick={onClose}>取消</button>
            <button className="sv2-btn gold" disabled={busy} onClick={submit} data-fid="K-17">{busy ? "签发中…" : "签发并安装"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ShellV2(p: Props) {
  const [edition, setEdition] = useState<Edition>("personal");
  const [drawer, setDrawer] = useState(false);
  const [caps, setCaps] = useState<Obj | null>(null);
  const [install, setInstall] = useState<Obj | null>(null);
  const [licOpen, setLicOpen] = useState(false);
  useEffect(() => {
    try { localStorage.setItem("gv.demo.edition", edition); } catch {}
    getCapabilities(edition).then(setCaps).catch(() => setCaps(null));
    fetch("/api/install/status").then(r => r.ok ? r.json() : null).then(setInstall).catch(() => setInstall(null));
  }, [edition]);
  const sorted = useMemo(
    () => [...p.projects].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))),
    [p.projects],
  );
  const last = sorted[0];
  const needReview = p.projects.filter((x) => ["待复核", "待人工确认"].includes(x.status)).length;
  const inDesign = p.projects.filter((x) => ["设计中", "草稿"].includes(x.status)).length;
  const frozen = p.projects.filter((x) => ["已冻结", "已交付"].includes(x.status)).length;
  const isKnx = edition === "knx" || edition === "enterprise";
  const isEnt = edition === "enterprise";
  // C2：零数据不再显示 "00"；空库首屏只保留一个主 CTA（见下方 isEmpty 分支）。
  const isEmpty = !p.projects.length;
  const pad2 = (n: number) => (n > 0 ? String(n).padStart(2, "0") : "0");

  async function refreshInstall() {
    const [c, st] = await Promise.all([
      getCapabilities(),
      fetch("/api/install/status").then(r => r.ok ? r.json() : null).catch(() => null),
    ]);
    setCaps(c);
    setInstall(st);
    if (c?.edition) setEdition(c.edition as Edition);
  }
  async function installLicense(file?: File) {
    if (!file) return;
    const fd = new FormData();
    fd.append("file", file);
    try {
      const r = await fetch("/api/install/license", { method: "POST", body: fd });
      const data = await r.json();
      if (!r.ok) throw new Error(data.detail || "安装失败");
      await refreshInstall();
      p.notify("许可已安装：" + (data.license?.licensee || data.license?.edition || ""));
    } catch (e: any) {
      p.notify("许可安装失败：" + e.message);
    }
  }
  async function removeLicense() {
    try {
      const r = await fetch("/api/install/license", { method: "DELETE" });
      if (!r.ok) throw new Error("移除失败");
      await refreshInstall();
      p.notify("许可已移除，回到个人版");
    } catch (e: any) {
      p.notify(e.message);
    }
  }
  const rail = [
    { icon: LayoutDashboard, label: "工作台", short: "工作台", active: true, act: () => {}, fid: "S-51" },
    { icon: FolderOpen, label: "全部项目", short: "全部项目", act: () => p.onNavigate("projects"), fid: "S-52" },
    { icon: Lightbulb, label: "灯具与设备库", short: "灯具库", act: () => p.onNavigate("products"), fid: "S-53" },
    { icon: Layers3, label: "场景灵感库", short: "场景库", act: () => p.onNavigate("templates"), fid: "S-54" },
    ...(isKnx ? [{ icon: Boxes, label: "KNX 工程", short: "KNX", act: () => p.notify("KNX 工程：下一批接入项目壳"), fid: "S-65" }] : []),
    ...(isEnt ? [
      { icon: Grid2X2, label: "品牌与报价", short: "品牌报价", act: () => p.notify("品牌与报价：企业包 UI 下一批接入"), fid: "S-66" },
      { icon: ShieldCheck, label: "团队与权限", short: "团队", act: () => p.notify("团队与权限：企业包 UI 下一批接入"), fid: "S-67" },
    ] : []),
  ];

  return (
    <div className="sv2">
      <header className="sv2-top">
        <div className="sv2-brand">
          <span className="sv2-mark" />
          <span><b>光律</b><small>GUANGLV STUDIO</small></span>
        </div>
        <div className="sv2-crumb">工作空间 <ChevronRight size={12} /> <b>工作台</b></div>
        <div className="sv2-search">
          <Search size={13} />
          <input placeholder="搜索项目、客户或编号" data-fid="S-49" />
          <span className="sv2-kbd"><Command size={10} /> K</span>
        </div>
        <span className="sv2-sp" />
        <span className="sv2-health"><i /> 本地服务 {p.health.ok ? "已连接" : "连接中"}</span>
        {caps?.demoEditionsAllowed !== false && <div className="sv2-ed">
          {(Object.keys(ED) as Edition[]).map((k) => (
            <button key={k} className={edition === k ? "on" : ""} onClick={() => setEdition(k)} data-fid={k === "personal" ? "A-08" : k === "knx" ? "A-09" : "A-10"}>
              {ED[k].label}<small>{ED[k].short}</small>
            </button>
          ))}
        </div>}
        <button className="sv2-btn ghost" onClick={p.onOld} data-fid="S-01">旧版工作台</button>
        <span className="sv2-avatar">光</span>
      </header>

      <div className="sv2-body">
        <nav className="sv2-rail">
          {rail.map((it, i) => (
            <button key={i} className={"sv2-item" + (it.active ? " on" : "")} title={it.label} onClick={it.act} data-fid={it.fid}>
              <it.icon size={17} /><span>{(it as any).short || it.label}</span>
            </button>
          ))}
          <span className="sv2-sp" />
          <button className="sv2-item" title="能力与插件" onClick={() => setDrawer(true)} data-fid="S-55">
            <PanelLeft size={17} /><span>能力</span>
          </button>
          <button className="sv2-item" title="工作台设置" onClick={() => p.onNavigate("settings")} data-fid="S-56">
            <Settings2 size={17} /><span>设置</span>
          </button>
        </nav>

        <main className="sv2-main">
          <div className="sv2-hero">
            <div>
              <div className="sv2-eyebrow">YOUR NEXT BRIGHT IDEA · {ED[edition].label}</div>
              <h1>{isEmpty ? "从第一张图纸开始。" : "继续上次的光。"}</h1>
              <p>{isEmpty ? "导入一张户型图，或新建空白项目，从第一个空间开始。" : ED[edition].note}</p>
            </div>
            <div className="sv2-actions">
              {isEmpty ? (
                <button className="sv2-btn gold" onClick={p.onCreate} data-fid="S-04"><Plus size={14} /> 新建第一个项目</button>
              ) : (
                <>
                  <button className="sv2-btn ghost" onClick={() => p.onNavigate("projects")} data-fid="S-05">全部项目</button>
                  <button className="sv2-btn gold" onClick={p.onCreate} data-fid="S-04"><Plus size={14} /> 新建项目</button>
                </>
              )}
            </div>
          </div>

          {isEmpty ? (
            <div className="sv2-emptyhome">
              <span className="sv2-eh-icon"><HardDrive size={22} /></span>
              <b>还没有项目</b>
              <p>新建一个项目开始布灯与情景设计；旧版工作台的历史图纸可在「旧版工作台」里导入。所有文件只保存在本机。</p>
            </div>
          ) : (
          <>
          <div className="sv2-grid">
            <section className="sv2-continue">
              <div className="sv2-thumb"><PlanThumb /></div>
              <div className="sv2-cinfo">
                <div className="sv2-ck">CONTINUE · {last?.code || "暂无项目"}</div>
                <div className="sv2-ct">{last?.name || "从一张图纸开始"}</div>
                <div className="sv2-cm">
                  {last ? `V${String(last.version).padStart(2, "0")} · ${last.status} · ${last.area} ㎡ · ${last.updatedAt?.slice(0, 10) || ""}` : "新建项目后，这里会显示最近一次设计"}
                </div>
                <button className="sv2-next" onClick={() => (last ? p.onOpen(last.id) : p.onCreate())} data-fid="S-06">
                  {last ? "继续布灯" : "新建第一个项目"} <ArrowRight size={13} />
                </button>
              </div>
            </section>
            <div className="sv2-quick">
              <button className="sv2-q" onClick={p.onCreate} data-fid="S-07"><Plus size={17} /><b>新建项目</b><small>DXF / 图片 / 空白</small></button>
              <button className="sv2-q" onClick={() => p.onNavigate("products")} data-fid="S-08"><Lightbulb size={17} /><b>灯具与设备库</b><small>{p.products.length || 230} 款 · 合作品牌含零售价</small></button>
              <button className="sv2-q" onClick={() => p.onNavigate("templates")} data-fid="S-09"><Layers3 size={17} /><b>场景灵感库</b><small>{p.sceneTemplates.length || 50} 个情景</small></button>
              <button className="sv2-q" onClick={() => setDrawer(true)} data-fid="S-10"><Sparkles size={17} /><b>能力与插件</b><small>{isEnt ? "KNX + 企业包" : isKnx ? "KNX 工程包" : "个人版 · 全量制图"}</small></button>
            </div>
          </div>

          <div className="sv2-stats">
            <div className="sv2-stat"><span>进行中</span><b>{pad2(inDesign)}</b><small>个设计</small></div>
            <div className="sv2-stat"><span>待复核</span><b>{pad2(needReview)}</b><small>个人工确认</small></div>
            <div className="sv2-stat"><span>已冻结</span><b>{pad2(frozen)}</b><small>个交付</small></div>
            <div className="sv2-stat"><span>全部项目</span><b>{pad2(p.projects.length)}</b><small>本地 SQLite</small></div>
          </div>

          <div className="sv2-listhead">
            <h2>最近项目</h2><span>按最近编辑</span><span className="sv2-sp" />
            <button className="sv2-link" onClick={() => p.onNavigate("projects")} data-fid="S-11">查看全部 <ArrowRight size={12} /></button>
          </div>
          <div className="sv2-table" data-fid="S-12">
            <div className="sv2-tr head"><span>项目</span><span>状态</span><span>版本</span><span>面积</span><span>方案</span><span>更新</span></div>
            {sorted.slice(0, 6).map((x) => (
              <button className="sv2-tr" key={x.id} onClick={() => p.onOpen(x.id)}>
                <span className="sv2-proj"><i /><span><b>{x.name}</b><small>{x.code} · {x.client || "未填客户"} · {x.city || "城市未填"}</small></span></span>
                <span>{statusTag(x.status)}</span>
                <span className="sv2-mono">V{String(x.version).padStart(2, "0")}</span>
                <span className="sv2-mono">{x.area} ㎡</span>
                <span className="sv2-mono">{x.smart || "无"}</span>
                <span className="sv2-mono">{fmt(x.updatedAt)}</span>
              </button>
            ))}
          </div>
          </>
          )}

          <div className="sv2-ability" onClick={() => setDrawer(true)} data-fid="A-03">
            <span className="sv2-aic"><Sparkles size={16} /></span>
            <div><b>{isEnt ? "企业包已启用：客户、渠道、品牌、团队、IES 接口。" : isKnx ? "KNX 工程包已启用：刻字 / 调试 / 映射。" : "个人版：全量制图 + 合作品牌产品 / 零售价 / IES 只读。"}</b>
              <p>插件化沉到皮下；左侧图标、右栏页签、导出卡按能力出现。点此查看能力与插件。</p></div>
            <span className="sv2-sp" /><button className="sv2-btn ghost">查看能力 <ArrowRight size={12} /></button>
          </div>

          <div className="sv2-foot">
            <span>本地工作台 · v{p.health.version || "1.3.2"}</span>
            <span>{caps ? `能力接口已连接 · ${caps.label} · ${(caps.modules || []).filter((m: Obj) => m.enabled).length} 模块` : "能力接口连接中"}</span>
            {caps && <span>{caps.license?.valid ? `许可：${caps.license.licensee || caps.license.profile}${caps.license.expiresAt ? " · " + caps.license.expiresAt : ""}` : "许可：未安装 · 个人版"}</span>}
            <span className="sv2-sp" />
            <span><Wifi size={11} /> 本机 · SQLite</span>
            <span>合作品牌产品与零售价三版全有</span>
          </div>
        </main>
      </div>

      {drawer && (
        <div className="sv2-mask" onClick={() => setDrawer(false)}>
          <aside className="sv2-drawer" onClick={(e) => e.stopPropagation()} data-fid="A-01">
            <div className="sv2-dh"><b>能力与插件</b><span className="sv2-sp" /><button onClick={() => setDrawer(false)} data-fid="A-07"><X size={16} /></button></div>
            <div className="sv2-db">
              <div className="sv2-license">
                <b>许可</b>
                <span>{caps?.license?.valid ? `${caps.label} · ${caps.license.licensee || caps.license.profile}` : "未安装 · 个人版"}</span>
                <small>{caps?.license?.valid ? (caps.license.expiresAt ? `到期 ${caps.license.expiresAt}` : "长期有效") : (caps?.license?.reason || "把 license.json 放到 data/，并在 .env 配 GUANGLV_LICENSE_SECRET")}</small>
              </div>
              <div className="sv2-install" data-fid="A-05">
                <b>安装检查</b>
                {[
                  ["许可文件", install ? (install.licenseFileExists ? "已找到" : "未安装") : "检查中", !!install?.licenseFileExists],
                  ["签名密钥", install ? (install.secretConfigured ? "已配置" : "未配置") : "检查中", !!install?.secretConfigured],
                  ["许可状态", install?.license?.valid ? `${install.license.edition} · 有效` : "未安装 · 个人版", !!install?.license?.valid],
                  ["演示版本口", install ? (install.demoEditionsAllowed ? "开" : "关") : "检查中", install ? !install.demoEditionsAllowed : false],
                ].map(([k, v, ok]: any) => (
                  <div className="sv2-icheck" key={k}><i className={ok ? "ok" : ""} />{k}<span>{v}</span></div>
                ))}
                {install && <small className="sv2-ipath">{install.licenseFile}</small>}
                <div className="sv2-iact">
                  <label className="sv2-iupload" data-fid="K-13">安装 license.json
                    <input type="file" accept=".json,application/json" hidden onChange={(e) => { installLicense(e.target.files?.[0]); e.target.value = ""; }} />
                  </label>
                  {install?.license?.valid && <button className="sv2-iremove" onClick={removeLicense} data-fid="K-14">移除许可</button>}
                  <button className="sv2-iremove" onClick={() => setLicOpen(true)} data-fid="K-15">签发许可</button>
                </div>
              </div>
              <p className="sv2-dlead">购买/授权只感知包；日常感知入口。base 是内核，不叫包。{caps ? ` 服务端能力：${caps.label} · ${(caps.modules || []).filter((m: Obj) => m.enabled).length} 个已启用模块。` : ""}</p>
              <Pack name="内核能力（base）" id="kernel 2.0.0 · 不叫包" on icon={Boxes}
                desc="图纸解析、布灯、情景、三维、基础导出、合作品牌墙、合作品牌 IES 只读。"
                mods={["图纸解析", "布灯", "情景", "三维", "导出", "品牌墙", "品牌 IES"]} />
              <Pack name="KNX 工程包" id="pack.knx · 1.0.0" on={isKnx} icon={Boxes}
                desc="品牌库、映射与拓扑、组地址与对账、刻字、调试、竣工；1 个签名包。"
                mods={["品牌库", "映射", "组地址", "刻字", "调试", "竣工"]} lock={!isKnx ? "KNX 工程师版" : undefined} />
              <Pack name="企业定制包" id="pack.enterprise · 1.0.0" on={isEnt} icon={ShieldCheck}
                desc="客户/渠道/价格规则、授权层级、团队权限、审计、供应商协同、模板与白标、IES 接口。"
                mods={["报价", "客户", "渠道", "价格规则", "授权", "团队", "审计", "协同", "模板", "白标", "IES"]} lock={!isEnt ? "企业定制版" : undefined} />
              <div className="sv2-hint">个人版：1 张 KNX 虚线卡，首页零付费噪音。KNX/企业：按合同/许可出现。暂不定价。</div>
            </div>
          </aside>
        </div>
      )}
      {licOpen && <LicenseIssue caps={caps} onClose={() => setLicOpen(false)} onDone={refreshInstall} notify={p.notify} />}
    </div>
  );
}

function Pack(p: { name: string; id: string; on: boolean; icon: any; desc: string; mods: string[]; lock?: string; }) {
  const Icon = p.icon;
  return (
    <div className={"sv2-pack" + (p.on ? " on" : "") + (p.lock ? " locked" : "")} data-fid="A-06">
      <div className="sv2-pt"><span className="sv2-pi"><Icon size={14} /></span><span><b>{p.name}</b><small>{p.id}</small></span></div>
      <p>{p.desc}</p>
      <div className="sv2-pm">{p.mods.map((m) => <span key={m}>{m}</span>)}</div>
      <div className="sv2-pf"><span className={"sv2-tag " + (p.on ? "ok" : "warn")}>{p.lock ? "需要 " + p.lock : "已启用"}</span><span className="sv2-sp" /><span className="sv2-tag">{p.lock ? "可见不可用" : "随版本"}</span></div>
    </div>
  );
}

function PlanThumb() {
  return (
    <svg viewBox="0 0 240 160" aria-hidden>
      <rect width="240" height="160" fill="#171614" />
      <g stroke="#4a4236" strokeWidth="2" fill="none">
        <rect x="26" y="20" width="92" height="58" /><rect x="126" y="20" width="88" height="58" />
        <rect x="26" y="86" width="92" height="54" /><rect x="126" y="86" width="88" height="54" />
        <path d="M118 20v120M26 78h188" />
      </g>
      <g fill="#d9a75f">
        <circle cx="48" cy="42" r="3.5" /><circle cx="78" cy="42" r="3.5" /><circle cx="150" cy="42" r="3.5" /><circle cx="190" cy="42" r="3.5" />
        <circle cx="52" cy="108" r="3.5" /><circle cx="170" cy="110" r="3.5" />
      </g>
      <g fill="#7d7465" fontSize="8" fontFamily="monospace"><text x="30" y="148">1F · 客 / 主 / 餐 / 次</text></g>
      <g fill="#d9a75f" opacity=".18"><circle cx="48" cy="42" r="22" /><circle cx="150" cy="42" r="22" /></g>
    </svg>
  );
}
