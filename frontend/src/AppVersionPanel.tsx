import { useEffect, useState } from "react";
import { AlertCircle, Loader2, RotateCcw } from "lucide-react";
import { api, type Obj } from "./types";
import { Button } from "./ui";
import { confirmDanger } from "./dangerConfirm";

type VersionRow = {
  id: string;
  createdAt: string;
  version: string;
  buildId: string;
  asset: string;
  tag: string;
  note: string;
  sizeBytes?: number;
  current?: boolean;
};

function stamp(s: string) {
  return (s || "").replace("T", " ").slice(0, 16);
}

/**
 * 设置 → 版本与更新 里的本机版本区。
 * - 上半：当前版本的更新内容（来自后端 RELEASE_NOTES）
 * - 下半：本机版本库快照列表 + 回退（后端异步调 version_rollback.sh，页面轮询 health 后自动重载）
 */
export function AppVersionPanel({ notify }: { notify: (s: string) => void }) {
  const [notes, setNotes] = useState<Obj | null>(null);
  const [data, setData] = useState<Obj | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState("");
  const [rolling, setRolling] = useState(false);
  const [rollbackError, setRollbackError] = useState("");

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const [n, v] = await Promise.all([
        api<Obj>("/app/release-notes"),
        api<Obj>("/app/versions"),
      ]);
      setNotes(n);
      setData(v);
      const rows: VersionRow[] = v?.versions || [];
      const cur = rows.find((x) => x.current) || rows[0];
      setSelected(cur?.id || "");
    } catch (e: any) {
      setError(e?.message || "读取本机版本信息失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const versions: VersionRow[] = data?.versions || [];
  const currentId = versions.find((x) => x.current)?.id || "";
  const selectedRow = versions.find((x) => x.id === selected);
  const currentRow = versions.find((x) => x.current);

  async function rollback() {
    if (!selectedRow || rolling || selected === currentId) return;
    const ok = await confirmDanger({
      title: `回退到「${selectedRow.tag || selectedRow.id}」？`,
      detail:
        "会停止服务、恢复这个版本的程序与前端，然后重启；项目数据 data/ 不受影响。" +
        "回退前会自动保存当前状态，回退期间页面会短暂断开并自动重连。",
      confirmText: "确认回退",
    });
    if (!ok) return;
    setRollbackError("");
    setRolling(true);
    const started = Date.now();
    let requestSent = false;
    try {
      const r = await fetch(`/api/app/versions/${encodeURIComponent(selectedRow.id)}/rollback`, {
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
        setRollbackError(detail || `回退请求失败（${r.status}）`);
        return;
      }
      requestSent = true;
      notify("已发起回退，服务重启中…");
    } catch (e: any) {
      // 服务可能恰好在这时被停掉；请求可能已经送达 helper，继续轮询比直接报错稳。
      const msg = String(e?.message || e || "");
      if (/failed to fetch|network|fetch/i.test(msg)) {
        requestSent = true;
        notify("回退请求已发出，等待服务重启…");
      } else {
        setRolling(false);
        setRollbackError(msg || "回退请求失败");
        return;
      }
    }

    if (!requestSent) {
      setRolling(false);
      return;
    }

    // 必须等「先掉线、再回来」才重载：POST 返回后 helper 还有 3 秒才停服务，
    // 如果一看到 health 200 就 reload，会抢在回退前刷新，页面停在旧状态。
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
        setRollbackError(
          "回退后服务 90 秒内没有回来。请查看版本库 ui-rollback.log，或双击桌面「光律-回退版本.command」。",
        );
      }
    }, 1000);
  }

  return (
    <div className="appver" data-fid="K-07">
      {loading && (
        <div className="appver-loading">
          <Loader2 className="spin" size={15} /> 正在读取本机版本…
        </div>
      )}
      {!!error && (
        <div className="appver-error">
          {error}
          <button type="button" onClick={() => void load()} data-fid="K-12">重试</button>
        </div>
      )}
      {!loading && !error && (
        <>
          <div className="appver-head" data-fid="K-08">
            <b>本版更新</b>
            <span>
              v{notes?.version || data?.current?.version || ""}
              {notes?.releasedAt ? ` · ${notes.releasedAt}` : ""}
            </span>
          </div>
          {notes?.items?.length ? (
            <ul className="appver-notes">
              {notes.items.map((it: Obj, i: number) => (
                <li key={i}>
                  <b>{it.title}</b>
                  <span>{it.detail}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="appver-hint">这个版本没有登记更新说明。</p>
          )}

          <div className="appver-head appver-history-head" data-fid="K-09">
            <b>本机版本历史</b>
            <span>共 {versions.length} 个</span>
          </div>
          <p className="appver-hint">
            回退只恢复程序与前端，不动 <code>data/</code>；服务会重启约 3–10 秒。
            旧于本功能的版本回退后，设置页可能没有本入口，可用桌面「光律-回退版本.command」。
          </p>
          {versions.length ? (
            <>
              <div className="appver-row">
                <select
                  value={selected}
                  onChange={(e) => setSelected(e.target.value)}
                  disabled={rolling}
                  aria-label="选择要回退的本机版本" data-fid="K-10"
                >
                  {versions.map((v) => (
                    <option key={v.id} value={v.id}>
                      {stamp(v.createdAt)} · {v.tag || v.id}
                      {v.current ? "（当前）" : ""}
                    </option>
                  ))}
                </select>
                <Button
                  disabled={rolling || !selectedRow || selected === currentId}
                  onClick={() => void rollback()}
                  title={selected === currentId ? "当前已经在用这个版本" : "回退到选中的本机快照"} fid="K-11"
                >
                  <RotateCcw size={14} /> {selected === currentId ? "当前版本" : "回退到此版本"}
                </Button>
              </div>
              {selectedRow ? <p className="appver-note">{selectedRow.note || "（无备注）"}</p> : null}
              <p className="appver-hint">
                当前线上：{data?.current?.version || ""} · {currentRow?.tag || "尚未快照"}
              </p>
            </>
          ) : (
            <p className="appver-hint">
              还没有本机版本快照。可双击项目目录里的「光律-保存版本.command」先存一个。
            </p>
          )}
          {!!rollbackError && (
            <p className="appver-error">
              <AlertCircle size={14} /> {rollbackError}
            </p>
          )}
        </>
      )}
      {rolling && (
        <div className="appver-overlay" role="status" aria-live="polite">
          <div>
            <Loader2 className="spin" size={26} />
            <b>正在回退版本…</b>
            <p>服务会短暂重启，页面会自动重连。</p>
          </div>
        </div>
      )}
    </div>
  );
}
