import { useEffect } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { AlertCircle, Trash2 } from "lucide-react";

/** C8：危险操作统一确认弹窗（与 Workspace.tsx 内同一套 .confirm-modal DOM / 样式）。
 *  用法：if (!(await confirmDanger({ title: "删除该设备？", detail: "..." }))) return;
 *  说明：弹出层挂到 document.body，Promise<boolean> 返回「确认 / 取消」，避免各处再写 window.confirm。 */
export type DangerConfirmOptions = {
  title: string;
  detail?: string;
  confirmText?: string;
  cancelText?: string;
};

function DangerConfirmDialog({
  title,
  detail,
  confirmText = "确认执行",
  cancelText = "取消",
  onResolve,
}: DangerConfirmOptions & { onResolve: (ok: boolean) => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onResolve(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onResolve]);
  return createPortal(
    <div
      className="confirm-modal-mask"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-modal-title"
      onClick={() => onResolve(false)}
    >
      <div
        className="confirm-modal"
        role="document"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="confirm-modal-head">
          <span className="confirm-modal-icon"><AlertCircle size={18} /></span>
          <h3 id="confirm-modal-title">{title}</h3>
        </div>
        {detail && <p className="confirm-modal-detail">{detail}</p>}
        <div className="confirm-modal-actions">
          <button className="btn" onClick={() => onResolve(false)}>{cancelText}</button>
          <button className="btn danger" onClick={() => onResolve(true)}>
            <Trash2 size={14} />
            {confirmText}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function confirmDanger(opts: DangerConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    host.className = "confirm-modal-host";
    document.body.appendChild(host);
    const root = createRoot(host);
    let settled = false;
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      try {
        root.unmount();
      } catch {
        /* 卸载竞态忽略 */
      }
      host.remove();
      resolve(ok);
    };
    root.render(<DangerConfirmDialog {...opts} onResolve={settle} />);
  });
}
