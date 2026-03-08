"use client";

import { forwardRef, type HTMLAttributes } from "react";

const baseClass =
  "theme-card border border-border-default rounded-card shadow-card p-card bg-panel";

export const Card = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, style, ...props }, ref) => (
    <div
      ref={ref}
      {...props}
      className={className ? `${baseClass} ${className}` : baseClass}
      style={style}
    />
  )
);

Card.displayName = "Card";
