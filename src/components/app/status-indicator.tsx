"use client";

import type { PipelineStage } from "@/lib/types";

interface StatusIndicatorProps {
  stage: PipelineStage | null;
}

const STAGE_LABELS: Record<PipelineStage, string> = {
  generating_code: "Generating analysis code...",
  reviewing_code: "Reviewing code for safety...",
  revising_code: "Revising code after review...",
  executing: "Running analysis in sandbox...",
  retrying: "Retrying with corrected code...",
  composing_ui: "Composing visualization...",
  done: "Complete",
  error: "Error occurred",
};

const STAGE_ORDER: PipelineStage[] = ["generating_code", "executing", "composing_ui", "done"];

// The review/revise + retry/error sub-phases aren't their own dot in the coarse
// stepper — collapse each onto the step it belongs to so exactly one dot lights
// (review/revise happen around code generation; retry/error during execution).
function stepFor(stage: PipelineStage): PipelineStage {
  if (stage === "reviewing_code" || stage === "revising_code") return "generating_code";
  if (stage === "retrying" || stage === "error") return "executing";
  return stage;
}

export function StatusIndicator({ stage }: StatusIndicatorProps) {
  if (!stage) return null;
  const activeStep = stepFor(stage);

  return (
    <div
      className="theme-card flex items-center gap-4 border border-border-default bg-surface-1 px-4 py-3"
      style={{
        borderRadius: "var(--radius-card)",
        boxShadow: "var(--shadow-card)",
      }}
    >
      {STAGE_ORDER.map((s) => {
        const isCurrent = s === activeStep;
        const isPast = STAGE_ORDER.indexOf(s) < STAGE_ORDER.indexOf(activeStep);

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
