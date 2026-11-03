/** 闸门录入：§8.3 电工交底 12 条＋逐项签字（A11）、§14 尺度标定（D02）、§5.2 品牌墙。
 *  三块的口径和协同面板一样：后端判据原文照搬，界面不替人说「已过」。 */
import { useCallback, useEffect, useState } from "react";
import { api } from "./types";

type Obj = Record<string, any>;

export default function GatePanel({ id, notify, locked }:
  { id: string; notify: (t: string, k?: "ok" | "error") => void; locked?: boolean }) {
  const [tab, setTab] = useState<"交底" | "尺度" | "品牌墙">("交底");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const run = async (work: () => Promise<unknown>, okText?: string) => {
    if (busy) return;
    setBusy(true);
    setErr("");
    try {
      await work();
      if (okText) notify(okText);
    } catch (e: any) {
      setErr(String(e?.message || "操作失败"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="studio-content">
      <div className="page-heading">
        <div className="eyebrow">HANDOVER · SCALE · BRAND WALL</div>
        <div className="heading-line">
          <h2>闸门录入</h2>
          <div className="wsv2-itabs">
            {(["交底", "尺度", "品牌墙"] as const).map((t) => (
              <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t}</button>
            ))}
          </div>
        </div>
        <p className="heading-note">
          交底 12 条要逐条签字才算施工可交接（A11）；尺度要两处独立校准一致才升「已核」（§14 红线）；
          品牌墙只存终端零售价，授权没登记就按「无授权」处理。
        </p>
      </div>
      {err && <div className="collab-err" role="alert">{err}</div>}
      {tab === "交底" && <HandoverTab id={id} run={run} busy={busy} notify={notify} locked={locked} />}
      {tab === "尺度" && <ScaleTab id={id} run={run} busy={busy} notify={notify} locked={locked} />}
      {tab === "品牌墙" && <WallTab id={id} notify={notify} />}
    </main>
  );
}

/** 交底 12 条：判据原文＋为何为否＋签字位；出图登记（Q17 三字段）在同一条链上。 */
function HandoverTab({ id, run, busy, notify, locked }: any) {
  const [h, setH] = useState<Obj | null>(null);
  const [by, setBy] = useState("胡工");

  const reload = useCallback(async () => setH(await api(`/projects/${id}/handover`)), [id]);
  useEffect(() => { reload().catch((e) => notify(e.message, "error")); }, [reload, notify]);

  if (!h) return <section className="collab-sec"><p className="collab-note">交底页加载中…</p></section>;
  const items: Obj[] = h.items || [];
  return (
    <section className="collab-sec">
      <div className="collab-chips">
        <div className={"collab-chip" + (!h.allYes ? " hot" : "")}><span>判为「是」</span><b>{h.yesCount}/{items.length}</b></div>
        <div className="collab-chip"><span>为否的条</span><b>{(h.noItems || []).join("、") || "—"}</b></div>
        <div className={"collab-chip" + (!h.signsComplete ? " hot" : "")}><span>已签字</span><b>{h.signsDone}/{h.signsRequired}</b></div>
        <div className="collab-chip"><span>出图登记</span><b>{h.registry?.registered ?? 0}</b></div>
      </div>
      <div className={"collab-warn"}>
        判定线：{h.line} —— {h.lineWhy}
      </div>

      <table className="collab-table">
        <thead><tr><th>#</th><th>现场要问的问题</th><th>判据</th><th>为否的原因</th>
          <th>会出的事故</th><th>签字</th><th>操作</th></tr></thead>
        <tbody>
          {items.map((it) => (
            <tr key={it.no}>
              <td><b>{it.no}</b></td>
              <td>{it.question}</td>
              <td><span className={"collab-sev " + (it.verdict === "是" ? "" : it.na ? "" : "bad")}>
                {it.verdict}{it.na ? "（不适用）" : ""}</span>
                <small>{(it.basis || []).join("；") || "无缺件挡路"}</small></td>
              <td>{(it.why_no || []).length ? (
                <ul className="collab-hard">{it.why_no.map((w: string, i: number) => <li key={i}>{w}</li>)}</ul>
              ) : "—"}</td>
              <td>{it.if_no}<small>返工 Top10：{(it.top10 || []).join("、") || "—"}</small></td>
              <td>{it.sign?.signed ? (it.sign.valid ? `已签 ${it.sign.by}` : `已签但失效：${it.sign.why}`)
                : `未签（${it.sign?.why || "—"}）`}</td>
              <td className="collab-ops">
                <label>签字人<input className="collab-reason" value={by}
                  onChange={(e) => setBy(e.target.value)} /></label>
                <button disabled={busy || locked || !by.trim()}
                  title="签字记下当时的 revision：设计一改，旧签字即失效（不静默算已签）"
                  onClick={() => run(async () => {
                    await api(`/projects/${id}/handover-sign`, {
                      method: "POST",
                      body: JSON.stringify({ key: it.sign_key, by, note: `第 ${it.no} 条：${it.verdict}` }),
                    });
                    await reload();
                  }, `第 ${it.no} 条已签字（${it.verdict}）`)}>签字</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="collab-note">{h.rule}</p>

      <div className="collab-form">
        <button className="wsv2-btn gold" disabled={busy || locked || !by.trim()}
          title="把这一批图号/版本/日期记成「已发出」：之后再改设计，第 12 条会报旧版未回收"
          onClick={() => run(async () => {
            const r: any = await api(`/projects/${id}/issue-frames`, {
              method: "POST", body: JSON.stringify({ by }),
            });
            setH(r.handover);
            notify(`出图登记完成：${r.registry.length} 个图号按发出态记账，旧版未回收 ${(r.state?.outdatedIssues || []).length} 条`);
          })}>登记本轮出图（Q17 三字段）</button>
      </div>
      {(h.registry?.problems || []).length > 0 && (
        <div className="collab-report">
          <h3>图号登记问题</h3>
          <ul className="collab-hard">{h.registry.problems.map((x: string, i: number) => <li key={i}>{x}</li>)}</ul>
        </div>
      )}
    </section>
  );
}

/** 尺度标定：两处独立校准一致才 verified；未核时界面不许出现「尺寸已核实」。 */
function ScaleTab({ id, run, busy, notify, locked }: any) {
  const [q, setQ] = useState<Obj | null>(null);
  const [files, setFiles] = useState<Obj[]>([]);
  const [form, setForm] = useState<Obj>({ fileId: "", knownM: "", drawingValue: "", note: "", by: "胡工" });

  const reload = useCallback(async () => {
    const [report, p] = await Promise.all([api(`/projects/${id}/quality`), api(`/projects/${id}`)]);
    setQ(report);
    setFiles(p.files || []);
    setForm((f: Obj) => ({ ...f, fileId: f.fileId || (p.files?.[0]?.id || "") }));
  }, [id]);
  useEffect(() => { reload().catch((e) => notify(e.message, "error")); }, [reload, notify]);

  if (!q) return <section className="collab-sec"><p className="collab-note">尺度状态加载中…</p></section>;
  const sc = q.scale || {};
  const set = (k: string) => (e: any) => setForm({ ...form, [k]: e.target.value });
  return (
    <section className="collab-sec">
      <div className="collab-chips">
        <div className={"collab-chip" + (sc.status !== "verified" ? " hot" : "")}><span>尺度状态</span><b>{sc.label}</b></div>
        <div className="collab-chip"><span>比例系数</span><b>{sc.factor}</b></div>
        <div className="collab-chip"><span>独立校准</span><b>{(sc.calibrations || []).length}</b></div>
        <div className="collab-chip"><span>能称「尺寸已核实」</span><b>{sc.canClaimVerifiedDimensions ? "能" : "不能"}</b></div>
      </div>
      <div className={sc.status === "verified" ? "collab-note" : "collab-warn"}>
        {sc.notice || sc.basis}
      </div>
      {(sc.conflicts || []).length > 0 && (
        <div className="collab-report">
          <h3>校准读数打架（不一致就不升「已核」）</h3>
          <ul className="collab-hard">{sc.conflicts.map((c: any, i: number) => (
            <li key={i}>{typeof c === "string" ? c : JSON.stringify(c)}</li>))}</ul>
        </div>
      )}

      <div className="collab-form">
        <label>图纸文件
          <select value={form.fileId} onChange={set("fileId")}>
            {files.length ? files.map((f) => (
              <option key={f.id} value={f.id}>{f.name}</option>
            )) : <option value="">（本项目还没有图纸文件）</option>}
          </select>
        </label>
        <label>现场已知尺寸（米）
          <input type="number" step="0.01" value={form.knownM} onChange={set("knownM")} placeholder="如 1.2" />
        </label>
        <label>图上同一处的读数（按图单位）
          <input type="number" step="1" value={form.drawingValue} onChange={set("drawingValue")} placeholder="如 1200" />
        </label>
        <label>量的是哪一处（备注）
          <input value={form.note} onChange={set("note")} placeholder="如：样板墙净长" />
        </label>
        <label>标定人
          <input value={form.by} onChange={set("by")} />
        </label>
        <button className="wsv2-btn gold" disabled={busy || locked || !form.fileId || !form.by.trim()}
          onClick={() => run(async () => {
            const r: any = await api(`/projects/${id}/scale-calibration`, {
              method: "POST",
              body: JSON.stringify({ fileId: form.fileId, knownM: Number(form.knownM),
                                     drawingValue: Number(form.drawingValue), note: form.note, by: form.by }),
            });
            setQ({ ...q, scale: r.scale });
            notify(`尺度标定已登记：${r.scale.label}（${r.scale.basis}）`);
          }, "标定已留人留读数")}>提交这一处校准</button>
      </div>
      <table className="collab-table">
        <thead><tr><th>图纸</th><th>已知尺寸(m)</th><th>图上读数</th><th>系数</th><th>量的是什么</th><th>人</th><th>时间</th></tr></thead>
        <tbody>
          {(sc.calibrations || []).map((c: Obj, i: number) => (
            <tr key={i}>
              <td>{(files.find((f) => f.id === c.fileId) || {}).name || c.fileId}</td>
              <td>{c.knownM}</td><td>{c.drawingValue}</td><td><code>{c.factor}</code></td>
              <td>{c.note}<small>单位按 {c.unit} 记</small></td><td>{c.by}</td><td>{c.at}</td>
            </tr>
          ))}
          {!(sc.calibrations || []).length && (
            <tr><td colSpan={7}>还没有一处校准：图上坐标就只是「图上的数」，不能说定位尺寸已核。</td></tr>)}
        </tbody>
      </table>
      <p className="collab-note">
        四态检查：过 {q.fourState?.pass ?? 0}／不过 {q.fourState?.fail ?? 0}／
        未核 {q.fourState?.unknown ?? 0}／不适用 {q.fourState?.na ?? 0}（分母 {q.fourState?.denominator ?? 0}）。
        两处独立校准一致才升「已核」；不一致就停在「未核」并列出打架的读数。
      </p>
    </section>
  );
}

/** 品牌墙：只读展示（录入在产品库）；授权未登记＝按无授权处理，界面无条件如实标。 */
function WallTab({ id, notify }: any) {
  const [bw, setBw] = useState<Obj | null>(null);
  useEffect(() => {
    api(`/projects/${id}/brand-wall`).then(setBw).catch((e) => notify(e.message, "error"));
  }, [id, notify]);
  if (!bw) return <section className="collab-sec"><p className="collab-note">品牌墙加载中…</p></section>;
  const wall = bw.wall || {};
  return (
    <section className="collab-sec">
      <div className="collab-chips">
        <div className="collab-chip"><span>版本</span><b>{bw.edition}</b></div>
        <div className="collab-chip"><span>品牌数</span><b>{wall.brandCount}</b></div>
        <div className="collab-chip"><span>有零售价</span><b>{bw.pricedCount}/{bw.productCount}</b></div>
        <div className={"collab-chip" + (wall.authCovered ? "" : " hot")}>
          <span>授权已登记</span><b>{wall.authCovered}/{wall.brandCount}</b></div>
        <div className="collab-chip"><span>logo 可加载</span><b>{wall.logoLoadable}</b></div>
      </div>
      <div className="collab-form">
        <div className="collab-note">
          零售价区间：{(bw.priceRange || []).length ? `${bw.priceRange[0]} — ${bw.priceRange[1]} 元` : "还没有一条零售价"}
          ｜口径：{bw.priceScope}（{bw.gates?.schema}）
        </div>
      </div>
      <table className="collab-table">
        <thead><tr><th>品牌</th><th>状态</th><th>授权档位</th><th>有效期</th>
          <th>在库款数</th><th>有价款数</th><th>logo</th></tr></thead>
        <tbody>
          {(wall.rows || []).map((r: Obj) => (
            <tr key={r.brand_id}>
              <td><b>{r.name}</b><small>{r.brand_id}</small></td>
              <td>{r.status}</td>
              <td><span className={"collab-sev " + (r.auth_recorded ? "" : "bad")}>
                {r.tier_label || "未登记（按无授权处理）"}</span></td>
              <td>{r.valid_to || "—"}</td>
              <td>{r.product_count}</td>
              <td>{r.priced_count}<small>覆盖率 {r.product_count ? Math.round(100 * r.priced_count / r.product_count) : 0}%</small></td>
              <td>{r.logo_ok ? "可加载" : "加载不到"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {(wall.dataQualityWarnings || []).length > 0 && (
        <div className="collab-report">
          <h3>数据质量提示（不是建议，是「现在不能说」的那部分）</h3>
          <ul className="collab-hard">{wall.dataQualityWarnings.map((w: string, i: number) => <li key={i}>{w}</li>)}</ul>
        </div>
      )}
      <p className="collab-note">
        品牌与款式的录入口在「产品库」（零售价／授权随产品资料进来）；这一页只把墙上的现状读出来，
        个人版不显示授权明细。
      </p>
    </section>
  );
}
