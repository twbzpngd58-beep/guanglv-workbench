import React, { useEffect } from "react";
import { X } from "lucide-react";
import type { Obj } from "./types";

export function Button({
  children,
  onClick,
  variant = "",
  className = "",
  disabled = false,
  type = "button",
  title,
  fid,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: string;
  className?: string;
  disabled?: boolean;
  type?: "button" | "submit";
  title?: string;
  /** 功能编号（见 features.ts）：会渲染成 data-fid，供编号徽标与隐藏使用。 */
  fid?: string;
}) {
  return (
    <button
      type={type}
      className={`btn ${variant} ${className}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
      data-fid={fid}
    >
      {children}
    </button>
  );
}
export function Modal({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
  fid,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
  /** 功能编号（见 features.ts）：会渲染成 data-fid。 */
  fid?: string;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [onClose]);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={"modal " + (wide ? "wide" : "")}
        data-fid={fid}
      >
        <div className="modal-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            <X size={20} />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}
/* 状态词（作者 2026-10-19 拍板）：库里存的值一个字不动，只改界面上给人看的字。
   草稿/识别中→未开始；设计中→进行中；待复核/待人工确认→待确认；已确认/已冻结/已导出→已完成；已归档→归档。 */
export const STATUS_WORDS: Record<string, string> = {
  草稿: "未开始",
  识别中: "未开始",
  设计中: "进行中",
  待复核: "待确认",
  待人工确认: "待确认",
  已确认: "已完成",
  已冻结: "已完成",
  已导出: "已完成",
  已归档: "归档",
};
/** 界面状态词 → 库里的原值集合（筛选谓词按这个匹配，不碰数据）。 */
export const STATUS_MATCH: Record<string, string[]> = {
  未开始: ["草稿", "识别中"],
  进行中: ["设计中"],
  待确认: ["待复核", "待人工确认"],
  已完成: ["已确认", "已冻结", "已导出"],
  归档: ["已归档"],
};
export function statusWord(status: string) {
  return STATUS_WORDS[status] || status;
}
export function Badge({ status }: { status: string }) {
  return (
    <span
      className={
        "badge " +
        (["设计中", "已确认", "已冻结"].includes(status)
          ? "green"
          : status === "待复核" || status === "待人工确认"
            ? "amber"
            : "gray")
      }
    >
      <i />
      {statusWord(status)}
    </span>
  );
}
export function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {React.Children.map(children, (child) =>
        React.isValidElement<Obj>(child) &&
        typeof child.type === "string" &&
        ["input", "select", "textarea"].includes(child.type)
          ? React.cloneElement(child, { "aria-label": label })
          : child,
      )}
    </label>
  );
}
