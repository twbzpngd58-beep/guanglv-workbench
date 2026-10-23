import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Download,
  ExternalLink,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { api, type Obj } from "./types";
import { Button } from "./ui";
import { confirmDanger } from "./dangerConfirm";

/** 设置 → 版本与更新 里的「检查更新 / 立即更新」区。
 *
 *  - 检查：后端去 GitHub 问最新发行版，顺带带回收安装包 + SHA256；
 *  - 立即更新：POST /api/update/apply 起 helper（下载→校验→快照→停服→覆盖→重启），
 *    这里每秒轮询 /api/update/status 显示阶段；服务重启期间读不到是正常现象；
 *  - 更新完成后自动刷新页面，拿到新前端。
 *  旧版本（1.3.1）没有这段逻辑，它们的按钮只会打开下载页 —— 所以 Release 里另外放了一份
 *  「光律-更新.command」，双击就能跑同一个 helper。
 */

type Asset = { name: string; url: string; size: number; sha256: string };

type CheckInfo = {
  current: string;
  latest: string;
  hasUpdate: boolean;
  url: string;
  notes?: string;
  publishedAt?: string;
  source?: string;
  error?: string;
  asset?: Asset | null;
  canAutoUpdate?: boolean;
  autoUpdateReason?: string;
  repo?: string;
};

type Status = {
  current: string;
  phase: string;
  message: string;
  ok: boolean | null;
  from?: string;
  to?: string;
  percent?: number | null;
  backup?: string;
  hint?: string;
  running?: boolean;
};

const PHASE: Record<string, string> = {
  idle: "尚未检查",
  start: "准备更新",
  check: "检查新版本",
  download: "下载发行包",
  verify: "校验安装包",
  snapshot: "备份当前版本",
  stage: "解包",
  stop: "停止服务",
  replace: "写入新版本",
  deps: "检查依赖",
  restart: "重启服务",
  health: "等待服务自检",
  done: "更新完成",
  failed: "更新失败",
  uptodate: "已是最新版本",
};

function sizeText(n?: number) {
  if (!n) return "";
  const mb = n / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

export function UpdatePanel({ notify }: { notify: (s: string) => void }) {
  const [info, setInfo] = useState<CheckInfo | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState("");
  const timer = useRef<number | null>(null);

  const stopPolling = () => {
    if (timer.current) {
      window.clearInterval(timer.current);
      timer.current = null;
    }
  };

  const pollOnce = async (): Promise<Status | null> => {
    try {
      const s = await api<Status>("/update/status");
      setStatus(s);
      if (s.phase === "done" && s.ok) {
        stopPolling();
        setApplying(false);
        notify(`已更新到 v${s.to || s.current}，页面即将刷新`);
        window.setTimeout(() => location.reload(), 1500);
      } else if (s.phase === "failed") {
        stopPolling();
        setApplying(false);
        setError([s.message, s.hint].filter(Boolean).join("；"));
      }
      return s;
    } catch {
      // 停服 / 重启期间接口必然读不到，这不是错误。
      return null;
    }
  };

  const startPolling = () => {
    stopPolling();
    timer.current = window.setInterval(() => void pollOnce(), 1000);
  };

  useEffect(() => {
    void (async () => {
      const s = await pollOnce();
      if (s?.running) {
        setApplying(true);
        startPolling();
      }
    })();
    return stopPolling;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const check = async () => {
    setChecking(true);
    setError("");
    try {
      const r = await api<CheckInfo>("/update/check");
      setInfo(r);
      if (r.error) setError(r.error);
      else if (r.hasUpdate) notify(`发现新版本 v${r.latest}，点「立即更新」直接升级`);
      else notify(`已是最新版本 v${r.current}`);
    } catch (e: any) {
      setError(e?.message || "检查更新失败");
    } finally {
      setChecking(false);
    }
  };

  const apply = async () => {
    if (!info?.hasUpdate) return;
    const ok = await confirmDanger({
      title: `立即更新到 v${info.latest}？`,
      detail:
        `会下载 ${info.asset?.name || "发行包"}` +
        `${info.asset?.size ? `（${sizeText(info.asset.size)}）` : ""}，先做 SHA256 校验；` +
        "更新前自动备份当前版本，然后停服务、覆盖程序与前端、重启自检，约 20–90 秒。" +
        "项目数据 data/ 与 .env 不会被改动；万一新版有问题，可以双击桌面「光律-回退版本.command」退回。",
      confirmText: "确认更新",
    });
    if (!ok) return;
    setError("");
    setApplying(true);
    try {
      const r = await api<Obj>("/update/apply", {
        method: "POST",
        body: JSON.stringify({ confirm: true }),
      });
      if (!r?.ok) throw new Error(r?.message || "更新没有开始");
      notify(`正在更新到 v${r.latest}…`);
      startPolling();
    } catch (e: any) {
      setApplying(false);
      setError(e?.message || "更新没有开始");
    }
  };

  const phase = status?.phase || "idle";
  const busy = applying || !!status?.running;
  const pct = typeof status?.percent === "number" ? status.percent : null;
  const barPct =
    pct ??
    (phase === "replace" || phase === "restart" || phase === "health"
      ? 92
      : phase === "snapshot" || phase === "stage" || phase === "stop"
        ? 70
        : 15);

  return (
    <>
      <div className="setting-row">
        <span>更新状态</span>
        <b>
          {busy
            ? PHASE[phase] || "更新中"
            : !info
              ? status?.phase === "done" && status?.ok
                ? "上次更新成功"
                : "尚未检查"
              : info.error
                ? "检查失败"
                : info.hasUpdate
                  ? `有新版本 v${info.latest}`
                  : "已是最新"}
        </b>
      </div>
      <p className="body-copy">
        检查 GitHub 上有没有比这版更新的发行版。源码部署的机器可以直接「立即更新」：自动下载发行包、
        校验 SHA256、备份当前版本、覆盖程序与前端并重启，项目数据在 data/ 不会被改动。
      </p>
      <div className="update-actions">
        <Button disabled={checking || busy} onClick={() => void check()}>
          {checking ? "正在检查…" : "检查更新"} <RefreshCw size={15} />
        </Button>
        {info?.hasUpdate && info.canAutoUpdate && !busy && (
          <Button variant="primary" onClick={() => void apply()}>
            <Download size={15} /> 立即更新到 v{info.latest}
          </Button>
        )}
        {info?.hasUpdate && (
          <a href={String(info.url || "")} target="_blank" rel="noreferrer">
            打开下载页 <ExternalLink size={14} />
          </a>
        )}
      </div>

      {info?.hasUpdate && info.canAutoUpdate && info.asset && (
        <small className="update-note">
          安装包 {info.asset.name}
          {info.asset.size ? ` · ${sizeText(info.asset.size)}` : ""} · 校验通过后才写入
        </small>
      )}
      {info?.hasUpdate && !info.canAutoUpdate && info.autoUpdateReason && (
        <small className="update-note">
          这台机器不能一键更新（{info.autoUpdateReason}），请用「打开下载页」手动覆盖。
        </small>
      )}

      {busy && (
        <div className="update-progress" role="status" aria-live="polite">
          <div className="update-progress-head">
            <Loader2 className="spin" size={15} />
            <b>{PHASE[phase] || "更新中"}</b>
            <span>{barPct}%</span>
          </div>
          <div className="update-bar">
            <i style={{ width: `${barPct}%` }} />
          </div>
          <p>{status?.message || "正在准备…"}</p>
          <small>服务重启时页面会短暂断开，属于正常现象，做完会自动刷新。</small>
        </div>
      )}

      {!!error && (
        <p className="appver-error">
          <AlertCircle size={14} /> {error}
        </p>
      )}

      {!busy && status?.phase === "done" && status.ok && (
        <small className="update-note">
          <CheckCircle2 size={13} /> 上次更新成功：v{status.from} → v{status.to}
          {status.backup ? `；备份：${status.backup}` : ""}
        </small>
      )}
    </>
  );
}
