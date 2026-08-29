"use client";

import type { Spec } from "@/lib/contracts/spec";
import { readStreamState, type PlanStep } from "@/lib/contracts/stream-state";
import { ProgressCard, type ProgressStep } from "@/app/components/progress-card";
import { GroundingAdvisories, hasGroundingAdvisories } from "@/app/components/findings-tab";
import type { DrillLevel } from "@/app/components/spec-insights";

/**
 * Live progress + trust-signal UI for the Ask and Investigate streams
 * (extracted from response-panel.tsx — modularization M5-5f; the panel
 * declared these four components inline, pinning presentational code to the
 * transport god-file).
 */

const FILE_PIPELINE_STEPS = [
  { stage: "analyzing", label: "Analyzed your data", activeLabel: "Analyzing your data..." },
  { stage: "computing", label: "Ran computations", activeLabel: "Running computations..." },
  { stage: "composing", label: "Composed dashboard", activeLabel: "Composing dashboard..." },
] as const;

const WAREHOUSE_PIPELINE_STEPS = [
  { stage: "generating_sql", label: "Generated SQL query", activeLabel: "Generating SQL query..." },
  { stage: "querying_warehouse", label: "Queried warehouse", activeLabel: "Querying warehouse..." },
  { stage: "analyzing", label: "Analyzed results", activeLabel: "Analyzing results..." },
  { stage: "computing", label: "Ran computations", activeLabel: "Running computations..." },
  { stage: "composing", label: "Composed dashboard", activeLabel: "Composing dashboard..." },
] as const;

// Map stage names to step numbers per pipeline type
const FILE_STAGE_TO_STEP: Record<string, number> = {
  analyzing: 1,
  computing: 2,
  retrying: 2,
  composing: 3,
};

const WAREHOUSE_STAGE_TO_STEP: Record<string, number> = {
  generating_sql: 1,
  querying_warehouse: 2,
  analyzing: 3,
  computing: 4,
  retrying: 4,
  composing: 5,
};

const RETRYING_LABEL = "Fixing and retrying...";

export function PipelineProgress({
  spec,
  drillStack,
  previousSpec,
}: {
  spec: Spec | null;
  drillStack: DrillLevel[];
  previousSpec: Spec | null;
}) {
  const progress = readStreamState(spec).__progress;

  // If dashboard content is already building, hide the stepper
  if (spec?.root) return null;

  // Fall back to generic messages when no progress data (drill-down, restored spec, etc.)
  if (!progress) {
    const message =
      drillStack.length > 0
        ? "Drilling down..."
        : previousSpec
          ? "Updating dashboard..."
          : "Building visualization...";
    return (
      <div
        className="flex flex-col items-center justify-center gap-3 py-20"
        role="status"
        aria-live="polite"
      >
        <div className="flex gap-1.5">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="inline-block h-2 w-2 rounded-full bg-accent"
              data-motion="essential"
              style={{
                animation: "pulse 1.2s ease-in-out infinite",
                animationDelay: `${i * 0.2}s`,
              }}
            />
          ))}
        </div>
        <span className="text-sm text-t-secondary">{message}</span>
      </div>
    );
  }

  const isWarehousePipeline = progress.total === 5;
  const pipelineSteps = isWarehousePipeline ? WAREHOUSE_PIPELINE_STEPS : FILE_PIPELINE_STEPS;
  const stageToStep = isWarehousePipeline ? WAREHOUSE_STAGE_TO_STEP : FILE_STAGE_TO_STEP;
  const currentStep =
    (progress.stage ? stageToStep[progress.stage] : undefined) ?? progress.step ?? 1;
  const isRetrying = progress.stage === "retrying";
  const retryStep = isWarehousePipeline ? 4 : 2;

  const steps: ProgressStep[] = pipelineSteps.map((step, i) => {
    const stepNum = i + 1;
    const status: ProgressStep["status"] =
      stepNum < currentStep ? "done" : stepNum > currentStep ? "upcoming" : "active";
    const label =
      status === "active"
        ? isRetrying && stepNum === retryStep
          ? RETRYING_LABEL
          : step.activeLabel
        : step.label;
    return { label, status };
  });

  return (
    <div className="flex justify-center py-16">
      <ProgressCard steps={steps} state={readStreamState(spec)} />
    </div>
  );
}

/**
 * Live progress UI for an Investigate stream. Reads two pieces of state
 * the server emits as patches:
 *
 *   /state/__plan       — { approach, steps[] } once planning is done
 *   /state/__progress   — { stage, step, total } each phase transition
 *
 * Status per step is updated in-place by /api/query/investigate as it
 * fires sub_started / sub_finished / sub_failed events.
 */
export function InvestigateProgress({ spec }: { spec: Spec | null }) {
  const state = readStreamState(spec);
  const plan = state.__plan;
  const progress = state.__progress;
  const errorMsg = state.__error;

  // Once the dashboard root has started rendering, hide this UI — the
  // composed content takes over.
  if (spec?.root) return null;

  const stage = progress?.stage ?? "planning";
  const stageLabel =
    stage === "generating_sql"
      ? "Writing warehouse SQL..."
      : stage === "querying_warehouse"
        ? "Querying the warehouse..."
        : stage === "planning"
          ? "Planning the investigation..."
          : stage === "investigating"
            ? "Running sub-questions..."
            : stage === "composing"
              ? "Composing the unified dashboard..."
              : "Working...";

  const steps: ProgressStep[] = [{ label: stageLabel, status: "active" }];

  return (
    <div className="flex justify-center py-16">
      <ProgressCard steps={steps} state={state}>
        {plan?.approach && (
          <p className="mt-3 text-sm leading-relaxed text-t-secondary">{plan.approach}</p>
        )}

        {plan?.steps && plan.steps.length > 0 && (
          <ol className="mt-3 flex flex-col gap-2 text-sm">
            {plan.steps.map((step) => (
              <li
                key={step.index}
                className="flex items-start gap-2.5 border border-border-default px-3 py-2"
                style={{
                  borderRadius: "var(--radius-card)",
                  background:
                    step.status === "running" ? "var(--color-accent-subtle)" : "transparent",
                }}
              >
                <span className="mt-0.5 shrink-0">
                  <StepIcon status={step.status} />
                </span>
                <div className="flex-1">
                  <div
                    className={
                      step.status === "failed"
                        ? "text-error-text"
                        : step.status === "done"
                          ? "text-t-secondary"
                          : "text-t-primary"
                    }
                  >
                    <span className="font-medium">Step {step.index + 1}.</span> {step.question}
                  </div>
                  {step.rationale && (
                    <div className="mt-0.5 text-xs text-t-tertiary">{step.rationale}</div>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}

        {errorMsg && (
          <div
            className="mt-3 border border-error-border bg-error-bg p-3 text-sm text-error-text"
            style={{ borderRadius: "var(--radius-card)" }}
          >
            {errorMsg}
          </div>
        )}
      </ProgressCard>
    </div>
  );
}

/**
 * Surfaces the two Investigate trust signals the server emits as state:
 *   /state/__dataQuality — degraded / failed / dropped sub-questions
 *   /state/__grounding    — figures in the narrative that trace to no result
 *
 * Both render as compact banners above the composed dashboard. The full,
 * re-runnable detail lives in the artifacts panel's Trail tab.
 */
export function InvestigationCaveats({ spec }: { spec: Spec | null }) {
  const state = readStreamState(spec);
  const dq = state.__dataQuality;
  const g = state.__grounding;

  const hasDq =
    !!dq && (dq.degraded?.length ?? 0) + (dq.failed?.length ?? 0) + (dq.removed?.length ?? 0) > 0;
  const hasUngrounded = !!g && g.ok === false && (g.ungrounded?.length ?? 0) > 0;
  // Findings-era advisory fields (declared-findings spec §3.4/§3.5) — a
  // report can carry them even when every figure traced (ok === true), so
  // they gate independently of hasUngrounded.
  const hasAdvisories = !!g && hasGroundingAdvisories(g);
  if (!hasDq && !hasUngrounded && !hasAdvisories) return null;

  return (
    <div className="mb-3 flex flex-col gap-2">
      {hasUngrounded && (
        <div
          className="border px-3 py-2 text-sm"
          style={{
            borderRadius: "var(--radius-card)",
            borderColor: "var(--color-warning-border)",
            background: "var(--color-warning-bg)",
            color: "var(--color-warning-text)",
          }}
        >
          <span className="font-medium">▲ Verify these figures.</span> {g!.ungrounded!.length}{" "}
          number{g!.ungrounded!.length === 1 ? "" : "s"} in the narrative could not be traced to a
          computed result: {g!.ungrounded!.join(", ")}. See the artifacts Trail for each step&apos;s
          code.
        </div>
      )}
      {/* Self-contained, plain-language "A few notes on this summary" block with a
          technical-details reveal (redesign) — no external warn box / header. */}
      {hasAdvisories && <GroundingAdvisories grounding={g!} />}
      {hasDq && (
        <div
          className="border border-border-default px-3 py-2 text-sm"
          style={{ borderRadius: "var(--radius-card)" }}
        >
          <span className="font-medium text-t-primary">Data-quality notes:</span>
          <ul className="mt-1 flex flex-col gap-0.5 text-xs text-t-secondary">
            {dq!.failed?.map((s) => (
              <li key={`f${s.stepNo}`}>
                <span style={{ color: "var(--color-error-text)" }}>Step {s.stepNo} failed</span> —{" "}
                {s.question}
              </li>
            ))}
            {dq!.degraded?.map((s) => (
              <li key={`d${s.stepNo}`}>
                <span style={{ color: "var(--color-warning-text)" }}>Step {s.stepNo} degraded</span>{" "}
                — {s.question}
                {s.reason ? ` (${s.reason})` : ""}
              </li>
            ))}
            {dq!.removed?.map((s) => (
              <li key={`r${s.stepNo}`}>
                <span className="text-t-tertiary">Step {s.stepNo} dropped by re-planner</span> —{" "}
                {s.question}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function StepIcon({ status }: { status: PlanStep["status"] }) {
  if (status === "running") return <SpinnerIcon />;
  if (status === "done") {
    return (
      <svg
        className="h-4 w-4 text-success-text"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <polyline points="20 6 9 17 4 12" />
      </svg>
    );
  }
  if (status === "failed") {
    return (
      <svg
        className="h-4 w-4 text-error-text"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    );
  }
  // pending
  return (
    <span
      className="inline-block h-4 w-4 rounded-full border border-border-default"
      aria-hidden="true"
    />
  );
}

export function SpinnerIcon() {
  return (
    <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}
