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
}: {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: string;
  className?: string;
  disabled?: boolean;
  type?: "button" | "submit";
  title?: string;
}) {
  return (
    <button
      type={type}
      className={`btn ${variant} ${className}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
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
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
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
      {status}
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
