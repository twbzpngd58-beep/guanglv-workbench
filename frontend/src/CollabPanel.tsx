/** 协同与冲突：§10.1–10.4 阶段 4／5 的录入与回填联动（闸门可见可操作）。
 *  三块共用后端已有的口：/api/supplierpack、/api/conflict、/api/projects/{pid}/missing-items。
 *  文案里保留「需核验／未核」等口径：界面不许把没核过的东西说成核过。 */
import { useCallback, useEffect, useState } from "react";
import { api } from "./types";

type Obj = Record<string, any>;

const VENDOR_KINDS = ["定制", "智能"];
const STATUS_LABEL: Obj = {
  dispatched: "已派出", returned: "已回传", merged: "已合图",
  rejected: "已打回", timeout: "已超时", "": "—",
};
const REJECT_MUST: Obj = {
  开孔: ["plate_id", "ours_uv", "theirs_uv", "hole_mm", "ours_version", "theirs_version"],
  空间: ["ours", "theirs", "timestamp", "baseline_version"],
  回路: ["circuit_no", "channel_a", "channel_b"],
  通道: ["gateway_no", "model", "limit", "used"],
  参数: ["param", "requirement"],
};

export default function CollabPanel({ id, notify, locked }:
  { id: string; notify: (t: string, k?: "ok" | "error") => void; locked?: boolean }) {
  const [tab, setTab] = useState<"包" | "冲突" | "缺件">("包");
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
      // 后端 422 正文就是闸门原文，原样显示，不换成「操作失败」
      setErr(String(e?.message || "操作失败"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="studio-content">
      <div className="page-heading">
        <div className="eyebrow">COLLABORATION &amp; CONFLICT LEDGER</div>
        <div className="heading-line">
          <h2>协同与冲突</h2>
          <div className="wsv2-itabs">
            {(["包", "冲突", "缺件"] as const).map((t) => (
              <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t}</button>
            ))}
          </div>
        </div>
        <p className="heading-note">
          发包走文件不走登录；冲突只标记不自动修，接受／打回／挂起由人逐条签；
          缺件的值只从回填口这一个口写进来。
        </p>
      </div>
      {err && <div className="collab-err" role="alert">{err}</div>}
      {tab === "包" && <PackTab id={id} run={run} busy={busy} notify={notify} locked={locked} />}
      {tab === "冲突" && <ConflictTab id={id} run={run} busy={busy} notify={notify} />}
      {tab === "缺件" && <MissingTab id={id} run={run} busy={busy} notify={notify} locked={locked} />}
    </main>
  );
}

/** 发包 → 下载 → 收回报 → 合图／打回，加验收①的四数计数。 */
function PackTab({ id, run, busy, notify, locked }: any) {
  const [kind, setKind] = useState("定制");
  const [vendor, setVendor] = useState("");
  const [days, setDays] = useState(7);
  const [packs, setPacks] = useState<Obj[]>([]);
  const [stats, setStats] = useState<Obj>({});
  const [lastReturn, setLastReturn] = useState<Obj | null>(null);

  const reload = useCallback(async () => {
    const [p, s] = await Promise.all([
      api(`/supplierpack/${id}/packs`), api(`/supplierpack/${id}/stats`)]);
    setPacks(p.packs || []);
    setStats(s);
  }, [id]);
  useEffect(() => { reload().catch((e) => notify(e.message, "error")); }, [reload, notify]);

  const c = stats.counts || {};
  const chip = (k: string, label: string) => (
    <div className={"collab-chip" + (Number(c[k]) > 0 ? " hot" : "")}>
      <span>{label}</span><b>{Number(c[k] || 0)}</b>
    </div>
  );

  return (
    <section className="collab-sec">
      <div className="collab-chips">
        {chip("dispatched", "派出")}
        {chip("returned", "回传")}
        {chip("merged", "合图")}
        {chip("rejected", "退回")}
        {chip("timeout", "超时")}
      </div>
      {Object.keys(stats["退回原因计数"] || {}).length > 0 && (
        <div className="collab-reasons">
          <b>退回原因（按 §10.2 规则号分桶）</b>
          {Object.entries(stats["退回原因计数"]).map(([k, v]: any) => (
            <span key={k}>{k} × {v}</span>
          ))}
        </div>
      )}

      <div className="collab-form">
        <label>供应商类型
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            {VENDOR_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </label>
        <label>指名单（柜格上登记的供应商名，留空＝发全部）
          <input value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="如：柜厂甲" />
        </label>
        <label>回传期限（天）
          <input type="number" min={1} value={days} onChange={(e) => setDays(Number(e.target.value) || 7)} />
        </label>
        <button className="wsv2-btn gold" disabled={busy || locked}
          onClick={() => run(async () => {
            await api(`/supplierpack/${id}/dispatch`, {
              method: "POST",
              body: JSON.stringify({ vendor_kind: kind, vendor_name: vendor, deadline_days: days }),
            });
            await reload();
          }, "协同包已派出：下载后发给供应商")}>
          发包
        </button>
      </div>

      <table className="collab-table">
        <thead><tr><th>包号</th><th>供应商</th><th>状态</th><th>必挂对象</th>
          <th>期限</th><th>回传校验</th><th>操作</th></tr></thead>
        <tbody>
          {packs.map((p) => {
            const ret = (p.returns || [])[(p.returns || []).length - 1] || null;
            const overdue = p.status === "dispatched" && String(p.deadline_at || "") <= new Date().toISOString();
            return (
              <tr key={p.pack_id}>
                <td><b>{p.pack_id}</b>{p.parent_pack_id && <small> 打回自 {p.parent_pack_id}</small>}</td>
                <td>{p.vendor_name || "未指名"}<small>（{p.vendor_kind}）</small></td>
                <td>{STATUS_LABEL[p.status] || p.status}{overdue && <em className="collab-bad"> 已过期限</em>}</td>
                <td>{(p.slots || []).length}</td>
                <td>{String(p.deadline_at || "").slice(0, 10)}</td>
                <td>{ret ? (ret.verdict === "accepted" ? "校验通过" : "硬拒进退回箱") : "未回传"}</td>
                <td className="collab-ops">
                  <a href={`/api/supplierpack/${id}/pack/${p.pack_id}/download`} download>下载包</a>
                  <label className="collab-upload">
                    回报 CSV
                    <input type="file" accept=".csv,text/csv" hidden disabled={locked}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        e.target.value = "";
                        if (!f) return;
                        const fd = new FormData();
                        fd.append("file", f);
                        run(async () => {
                          const r = await api(`/supplierpack/${id}/pack/${p.pack_id}/return`,
                            { method: "POST", body: fd });
                          setLastReturn({ pack_id: p.pack_id, ...r });
                          await reload();
                        }, "回传已校验");
                      }} />
                  </label>
                  <button disabled={busy || locked || ret?.verdict !== "accepted"}
                    title={ret?.verdict === "accepted" ? "把已校验的值落回对象" : "只有校验通过的包能合图"}
                    onClick={() => run(async () => {
                      const r: any = await api(`/supplierpack/${id}/pack/${p.pack_id}/merge`, { method: "POST" });
                      await reload();
                      notify(`合图完成：落位 ${(r.applied || []).length} 条、跳过 ${(r.skipped || []).length} 条、`
                        + `冲突 ${(r.conflict_ids || []).length} 条；布置闸门已按改动顶回，发下一包前要重签`);
                    })}>合图</button>
                </td>
              </tr>
            );
          })}
          {!packs.length && <tr><td colSpan={7}>还没有派出记录：发包前先确认布置闸门已签、柜体供应商已登记。</td></tr>}
        </tbody>
      </table>

      {lastReturn && <ReturnReport data={lastReturn} />}
    </section>
  );
}

/** 一次回传的校验结论：六条硬拒＋C1–C6 诚实三态。 */
function ReturnReport({ data }: { data: Obj }) {
  const checks = data.checks || {};
  return (
    <div className="collab-report">
      <h3>最近一次回传：{data.pack_id} · {data.verdict === "accepted" ? "校验通过" : "整包退回"}</h3>
      {(data.hard_rejects || []).length > 0 && (
        <ul className="collab-hard">
          {data.hard_rejects.map((x: Obj, i: number) => (
            <li key={i}>规则 {x.rule}：{x.why}{x.security ? "（客户数据外发即一次泄露）" : ""}</li>
          ))}
        </ul>
      )}
      <div className="collab-cs">
        {["C1", "C2", "C3", "C4", "C5", "C6"].map((k) => {
          const v = checks[k] || {};
          return (
            <span key={k} className={"collab-c " + (v.state || "unknown")}>
              <b>{k}</b> {v.state === "pass" ? "过" : v.state === "fail" ? "不过" : "未核"}
              <em>{v.why || ""}</em>
            </span>
          );
        })}
      </div>
      {(data.conflicts || []).length > 0 && (
        <p className="collab-note">冲突 {data.conflicts.length} 条已进冲突表（校验这一刻就挂账，不合图也留痕）。</p>
      )}
    </div>
  );
}

/** 冲突表：扫描 → 挂账 → 逐条 接受／打回／挂起。只标记不自动修。 */
function ConflictTab({ id, run, busy, notify }: any) {
  const [rows, setRows] = useState<Obj[]>([]);
  const [counts, setCounts] = useState<Obj>({});
  const [report, setReport] = useState<Obj | null>(null);
  const [open, setOpen] = useState<string>("");
  const [reject, setReject] = useState<Obj>({});

  const reload = useCallback(async () => {
    const l = await api(`/conflict/${id}/list`);
    setRows(l.rows || []);
    setCounts(l.counts || {});
  }, [id]);
  useEffect(() => { reload().catch((e) => notify(e.message, "error")); }, [reload, notify]);

  // 打回单必带项（§10.3）：按类型给空表，缺项由后端 422 点名，不在前端猜
  const startReject = (row: Obj) => {
    const fields = REJECT_MUST[row.type] || [];
    const seed: Obj = { type: row.type, object_ids: row.object_ids || [],
                        slot_id: (row.object_ids || []).find((x: string) => /^m\d/.test(x)) || "" };
    fields.forEach((f: string) => {
      seed[f] = f === "ours" ? String(row.ours || "") : f === "theirs" ? String(row.theirs || "")
        : f === "timestamp" ? new Date().toISOString() : "";
    });
    setOpen(row.conflict_id);
    setReject(seed);
  };

  return (
    <section className="collab-sec">
      <div className="collab-chips">
        <div className={"collab-chip" + (counts["阻断"] ? " hot" : "")}><span>阻断</span><b>{counts["阻断"] || 0}</b></div>
        <div className="collab-chip"><span>提示</span><b>{rows.filter((r) => r.severity === "提示").length}</b></div>
        <div className={"collab-chip" + (counts["未处理"] ? " hot" : "")}><span>未处理</span><b>{counts["未处理"] || 0}</b></div>
        <div className="collab-chip"><span>总</span><b>{counts["总"] || 0}</b></div>
      </div>
      <div className="collab-form">
        <button className="wsv2-btn" disabled={busy}
          onClick={() => run(async () => { setReport(await api(`/conflict/${id}/scan`)); }, "扫描完成（未挂账）")}>
          扫一遍
        </button>
        <button className="wsv2-btn gold" disabled={busy}
          title="开孔①②③／回路①③／空间①＝阻断；提示级不进 1.0 拦截"
          onClick={() => run(async () => {
            const r: any = await api(`/conflict/${id}/scan`, { method: "POST" });
            setReport(r);
            await reload();
          }, "冲突已挂账到冲突表（只标记，不自动改图）")}>
          扫描并挂账
        </button>
      </div>

      {report && (
        <div className="collab-report">
          <h3>扫描读数 · 尺度状态：{report.scale?.label || "未核"}</h3>
          {report.scale?.notice && <p className="collab-warn">{report.scale.notice}</p>}
          <p className="collab-note">{report.rule}</p>
          {(report.unknown || []).length > 0 && (
            <details className="collab-unknown" open>
              <summary>判不了 {report.unknown.length} 项（未核＝没查过，不等于没冲突）</summary>
              <ul>{report.unknown.map((u: string, i: number) => <li key={i}>{u}</li>)}</ul>
            </details>
          )}
        </div>
      )}

      <table className="collab-table">
        <thead><tr><th>类型／规则</th><th>严重度</th><th>涉及对象</th><th>原始值</th>
          <th>对方值／建议值</th><th>状态</th><th>处置</th></tr></thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.conflict_id}>
              <td><b>{row.type}</b> {row.rule_id}<small>{row.why}</small></td>
              <td><span className={"collab-sev " + (row.severity === "阻断" ? "bad" : "warn")}>{row.severity}</span></td>
              <td><code>{(row.object_ids || []).join(" / ")}</code>
                <small>{row.from_pack ? `来自 ${row.pack_id}` : "扫描级（自己的图）"}</small></td>
              <td>{row.ours}</td>
              <td>{row.theirs}<br /><em>建议：{row.suggestion || "—"}</em></td>
              <td>{row.state}{row.decision_note && <small>（{row.decision_note}）</small>}</td>
              <td className="collab-ops">
                <button disabled={busy} onClick={() => run(async () => {
                  await api(`/supplierpack/${id}/conflicts/${row.conflict_id}`, {
                    method: "POST",
                    body: JSON.stringify({ decision: "接受", note: "人工确认接受，图上按现值继续" }),
                  });
                  await reload();
                }, "已接受（留人留痕）")}>接受</button>
                <button disabled={busy || !row.from_pack}
                  title={row.from_pack ? "按 §10.3 五类必带项生成打回单与派生包" :
                    "扫描级冲突不挂派生包：要改的是自己的图，回图纸页改完重扫"}
                  onClick={() => startReject(row)}>打回</button>
                <button disabled={busy} onClick={() => run(async () => {
                  await api(`/supplierpack/${id}/conflicts/${row.conflict_id}`, {
                    method: "POST", body: JSON.stringify({ decision: "挂起", note: "等对方补资料" }),
                  });
                  await reload();
                }, "已挂起")}>挂起</button>
              </td>
            </tr>
          ))}
          {!rows.length && <tr><td colSpan={7}>冲突表是空的：点「扫一遍」看看是真没冲突，还是材料不足判不了。</td></tr>}
        </tbody>
      </table>

      {open && (
        <div className="collab-reject">
          <h3>打回单（{reject.type}）· §10.3 五类各有必带项，只写「冲突」二字会被直接退回</h3>
          <div className="collab-fields">
            {Object.keys(reject).filter((k) => !["type", "object_ids", "slot_id"].includes(k)).map((f) => (
              <label key={f}>{f}
                <input value={String(reject[f] || "")}
                  onChange={(e) => setReject({ ...reject, [f]: e.target.value })} />
              </label>
            ))}
          </div>
          <div className="collab-form">
            <button className="wsv2-btn gold" disabled={busy}
              onClick={() => run(async () => {
                const row = rows.find((r) => r.conflict_id === open);
                if (!row?.from_pack) throw new Error("这条冲突不是回传包带来的，没有可打回的包");
                await api(`/supplierpack/${id}/pack/${row.pack_id}/reject`, {
                  method: "POST", body: JSON.stringify({ items: [reject] }),
                });
                await reload();
                setOpen("");
              }, "打回单已生成派生包 v2（只带被点名的槽位）")}>提交打回单</button>
            <button className="wsv2-btn" disabled={busy} onClick={() => setOpen("")}>取消</button>
          </div>
        </div>
      )}
    </section>
  );
}

/** 缺件单与回填口：值只从 field_path 一个口写进来，回填留人留时间。 */
function MissingTab({ id, run, busy, notify, locked }: any) {
  const [items, setItems] = useState<Obj[]>([]);
  const [meta, setMeta] = useState<Obj>({});
  const [by, setBy] = useState("胡工");
  const [draft, setDraft] = useState<Obj>({});

  const reload = useCallback(async () => {
    const r = await api(`/projects/${id}/missing-items`);
    setItems(r.items || []);
    setMeta({ bySeverity: r.bySeverity, naming: r.naming, version: r.version, count: r.count });
  }, [id]);
  useEffect(() => { reload().catch((e) => notify(e.message, "error")); }, [reload, notify]);

  const v = meta.version || {};
  return (
    <section className="collab-sec">
      <div className="collab-chips">
        <div className={"collab-chip" + (meta.bySeverity?.["阻断"] ? " hot" : "")}><span>阻断级缺件</span><b>{meta.bySeverity?.["阻断"] || 0}</b></div>
        <div className="collab-chip"><span>提示级缺件</span><b>{meta.bySeverity?.["提示"] || 0}</b></div>
        <div className="collab-chip"><span>封板后阻断</span><b>{meta.bySeverity?.["封板后"] || 0}</b></div>
        <div className="collab-chip"><span>版本级别</span><b>{v.level || "—"}</b></div>
      </div>
      {v.blocking > 0 && (
        <p className="collab-warn">
          当前版本级别：{v.level}（阻断级未回填 {v.blocking} 条／封板后 {v.postSealBlocking} 条）。
          原因：{(v.reasons || []).join("；") || "—"}
        </p>
      )}
      <div className="collab-form">
        <label>回填人（必填，机器不能替人说）
          <input value={by} onChange={(e) => setBy(e.target.value)} />
        </label>
      </div>
      <table className="collab-table">
        <thead><tr><th>要什么</th><th>对象</th><th>严重度</th><th>问谁／在哪问</th>
          <th>回填值</th><th>操作</th></tr></thead>
        <tbody>
          {items.slice(0, 200).map((it) => (
            <tr key={it.field_path}>
              <td><b>{it.what}</b><small>{it.accident}</small></td>
              <td><code>{it.field_path}</code><small>{it.code}</small></td>
              <td><span className={"collab-sev " + (it.severity === "阻断" ? "bad" : "warn")}>{it.severity}</span></td>
              <td>{it.ask_whom}<small>{it.ask_where}</small></td>
              <td><input value={String(draft[it.field_path] ?? "")}
                placeholder={it.status === "已豁免" ? `已豁免：${it.reason}` : "填一个值"}
                onChange={(e) => setDraft({ ...draft, [it.field_path]: e.target.value })} /></td>
              <td className="collab-ops">
                <button disabled={busy || locked || !String(draft[it.field_path] ?? "").trim()}
                  onClick={() => run(async () => {
                    await api(`/projects/${id}/backfill`, {
                      method: "POST",
                      body: JSON.stringify({ fieldPath: it.field_path, value: draft[it.field_path], by }),
                    });
                    setDraft({ ...draft, [it.field_path]: "" });
                    await reload();
                  }, `${it.what} 已回填（留人与时间）`)}>回填</button>
                <button disabled={busy || locked || !String(draft[it.field_path + ":waive"] ?? "").trim()}
                  title="豁免必须写理由，且这行仍在表内"
                  onClick={() => run(async () => {
                    await api(`/projects/${id}/waive-missing`, {
                      method: "POST",
                      body: JSON.stringify({ fieldPath: it.field_path,
                        reason: draft[it.field_path + ":waive"], by }),
                    });
                    await reload();
                  }, "已豁免（理由与人名留在表内）")}>豁免</button>
                <input className="collab-reason" placeholder="豁免理由"
                  value={String(draft[it.field_path + ":waive"] ?? "")}
                  onChange={(e) => setDraft({ ...draft, [it.field_path + ":waive"]: e.target.value })} />
              </td>
            </tr>
          ))}
          {!items.length && <tr><td colSpan={6}>缺件单是空的：字典里适用的字段都回填了。</td></tr>}
        </tbody>
      </table>
      <p className="collab-note">
        指名率：{meta.naming?.named ?? "—"}/{meta.naming?.denominator ?? "—"}
        （自动编号覆盖 {meta.naming?.autoNumberCoverage ?? 0}％，未指名 {(meta.naming?.uncovered || []).length} 个）。
        回填＝关闭；豁免＝理由＋人名留下但行还在表里；值只从这一口写进来，别处写同名字段就是一值两份。
      </p>
    </section>
  );
}
