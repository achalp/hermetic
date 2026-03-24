"use client";

import type { ReactNode } from "react";

interface TopBarProps {
  center?: ReactNode;
  right?: ReactNode;
  onLogoClick?: () => void;
}

export function TopBar({ center, right, onLogoClick }: TopBarProps) {
  return (
    <header
      className="fixed top-0 w-full h-14 bg-surface-1 border-b border-border-default flex items-center justify-between px-6"
      style={{ zIndex: "var(--z-topbar)" } as React.CSSProperties}
    >
      {/* Left: logo */}
      <span
        className="text-accent text-[16px] font-bold lowercase cursor-pointer select-none"
        onClick={onLogoClick}
      >
        hermetic
      </span>

      {/* Center: absolutely positioned for true centering */}
      {center && (
        <div
          className="absolute pointer-events-auto"
          style={{ left: "50%", transform: "translateX(-50%)" }}
        >
          {center}
        </div>
      )}

      {/* Right */}
      {right && <div className="flex items-center gap-3">{right}</div>}
    </header>
  );
}
