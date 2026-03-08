"use client";

import { forwardRef, type HTMLAttributes } from "react";

const baseClass = "theme-card border border-border-default";

export const Card = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, style, ...props }, ref) => (
    <div
      ref={ref}
      {...props}
      className={className ? `${baseClass} ${className}` : baseClass}
      style={{
        background: "var(--bg-panel)",
        padding: "var(--padding-card)",
        borderRadius: "var(--radius-card)",
        boxShadow: "var(--shadow-card)",
        ...style,
      }}
    />
  )
);

Card.displayName = "Card";
