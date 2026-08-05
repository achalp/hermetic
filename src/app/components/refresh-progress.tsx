"use client";

/**
 * Refresh progress stepper (extracted from page.tsx, ARCH-5): the three-step
 * status shown while a saved analysis is refreshed against the live source.
 */

const REFRESH_STEPS = [
  { key: "loading", label: "Loaded saved analysis", activeLabel: "Loading saved analysis..." },
  { key: "executing", label: "Ran computations", activeLabel: "Running computations..." },
  { key: "composing", label: "Composed dashboard", activeLabel: "Composing dashboard..." },
] as const;

export function RefreshProgress({
  stage,
}: {
  stage: "loading" | "querying" | "executing" | "composing" | null;
}) {
  const stageIndex =
    stage === "loading"
      ? 0
      : stage === "querying"
        ? 0
        : stage === "executing"
          ? 1
          : stage === "composing"
            ? 2
            : -1;

  return (
    <div className="flex justify-center py-16" role="status" aria-live="polite">
      <div
        className="grid gap-x-8 gap-y-1.5 text-sm"
        style={{ gridTemplateColumns: "repeat(2, auto)" }}
      >
        {REFRESH_STEPS.map((step, i) => {
          const isCompleted = i < stageIndex;
          const isActive = i === stageIndex;

          if (isCompleted) {
            return (
              <div key={step.key} className="flex items-center gap-2 text-t-secondary">
                <svg
                  className="h-4 w-4 text-success-text"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                {step.label}
              </div>
            );
          }

          if (isActive) {
            return (
              <div key={step.key} className="flex items-center gap-2 font-medium text-accent">
                <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                  />
                </svg>
                {step.activeLabel}
              </div>
            );
          }

          return (
            <div key={step.key} className="flex items-center gap-2 text-t-tertiary">
              <span className="inline-block h-4 w-4" />
              {step.label}
            </div>
          );
        })}
      </div>
    </div>
  );
}
