"use client";

import { forwardRef, type HTMLAttributes } from "react";

const baseClass = "theme-card border border-border-default rounded-card shadow-card p-card";

export const Card = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, style, ...props }, ref) => (
    <div
      ref={ref}
      {...props}
      className={className ? `${baseClass} ${className}` : baseClass}
      style={{
        background: "var(--bg-panel)",
        ...style,
      }}
    />
  )
);

Card.displayName = "Card";
