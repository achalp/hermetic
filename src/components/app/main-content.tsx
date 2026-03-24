"use client";

import type { ReactNode } from "react";

interface MainContentProps {
  blurred?: boolean;
  railVisible?: boolean;
  children: ReactNode;
}

export function MainContent({ blurred, railVisible, children }: MainContentProps) {
  return (
    <div
      className="min-h-screen"
      style={{
        paddingTop: 56,
        marginRight: railVisible ? 48 : undefined,
        filter: blurred ? "blur(6px)" : undefined,
        opacity: blurred ? 0.6 : undefined,
        pointerEvents: blurred ? "none" : undefined,
        transition: "filter 0.3s ease, opacity 0.3s ease, margin-right 0.3s ease",
      }}
    >
      <div style={{ maxWidth: 1000, margin: "0 auto", padding: "0 40px" }}>{children}</div>
    </div>
  );
}
