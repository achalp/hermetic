"use client";

import type { ButtonHTMLAttributes } from "react";

const baseClass =
  "bg-surface-btn px-3 py-1.5 text-xs font-medium text-t-btn hover:bg-surface-btn-hover disabled:opacity-50 transition-colors rounded-badge";

export function ActionButton({
  className,
  style,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={className ? `${baseClass} ${className}` : baseClass}
      style={{
        transitionDuration: "var(--transition-speed)",
        ...style,
      }}
    />
  );
}
