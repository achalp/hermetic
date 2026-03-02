"use client";

import type { PipelineStage } from "@/lib/types";

interface StatusIndicatorProps {
  stage: PipelineStage | null;
}

const STAGE_LABELS: Record<PipelineStage, string> = {
  generating_code: "Generating analysis code...",
  executing: "Running analysis in sandbox...",
  retrying: "Retrying with corrected code...",
  composing_ui: "Composing visualization...",
  done: "Complete",
  error: "Error occurred",
};

const STAGE_ORDER: PipelineStage[] = ["generating_code", "executing", "composing_ui", "done"];

export function StatusIndicator({ stage }: StatusIndicatorProps) {
  if (!stage) return null;

  return (
    <div
      className="theme-card flex items-center gap-4 border border-border-default bg-surface-1 px-4 py-3"
      style={{
        borderRadius: "var(--radius-card)",
        boxShadow: "var(--shadow-card)",
      }}
    >
      {STAGE_ORDER.map((s) => {
        const isCurrent = stage === s || (stage === "retrying" && s === "executing");
        const isPast =
          STAGE_ORDER.indexOf(s) <
          STAGE_ORDER.indexOf(
            stage === "retrying" ? "executing" : stage === "error" ? "executing" : stage
          );

        return (
          <div key={s} className="flex items-center gap-2">
            <div
              className={`h-2.5 w-2.5 rounded-full transition-colors ${
                isCurrent ? "animate-pulse bg-accent" : isPast ? "bg-success-text" : "bg-surface-2"
              }`}
              style={{ transitionDuration: "var(--transition-speed)" }}
            />
            <span
              className={`text-xs ${
                isCurrent
                  ? "font-medium text-accent"
                  : isPast
                    ? "text-success-text"
                    : "text-t-tertiary"
              }`}
            >
              {STAGE_LABELS[s]}
            </span>
          </div>
        );
      })}
    </div>
  );
}
