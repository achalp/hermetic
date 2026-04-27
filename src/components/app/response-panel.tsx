"use client";

import {
  useUIStream,
  Renderer,
  StateProvider,
  ActionProvider,
  VisibilityProvider,
} from "@json-render/react";
import type { Spec } from "@json-render/react";
import { registry } from "@/components/registry";
import { drillDownCallbackRef } from "@/lib/drill-down-context";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DrillDownParams, SchemaMode } from "@/lib/types";
import type { ModelId, SandboxRuntimeId } from "@/lib/constants";
import type { CachedArtifacts } from "@/lib/pipeline/artifacts-cache";
import { useSaveExport } from "@/hooks/use-save-export";
import { useArtifacts } from "@/hooks/use-artifacts";
import { ArtifactsViewer } from "@/components/app/artifacts-viewer";
import { RendererErrorBoundary } from "@/components/app/renderer-error-boundary";
import { ActionButton } from "@/components/ui/action-button";
import { Card } from "@/components/ui/card";

interface DrillLevel {
  question: string;
  segmentLabel: string;
  spec: Spec;
}

interface ResponsePanelProps {
  csvId: string | null;
  warehouseId?: string | null;
  question: string | null;
  questionSeq: number;
  /**
   * Which pipeline to use for the next stream:
   * - "ask" (default) → /api/query, single-shot
   * - "investigate" → /api/query/investigate, multi-step plan + execute + compose
   * The mode is captured at the moment the stream begins; switching after
   * the question is in flight has no effect until the next questionSeq tick.
   */
  mode?: "ask" | "investigate";
  onStreamEnd?: () => void;
  loadedSpec?: Spec | null;
  loadedArtifacts?: CachedArtifacts | null;
  onSaved?: () => void;
  schemaMode?: SchemaMode;
  codeGenModel?: ModelId;
  uiComposeModel?: ModelId;
  sandboxRuntime?: SandboxRuntimeId;
  purpose?: string;
  onRerun?: () => void;
  loadedVizId?: string | null;
  onArtifactsChange?: (artifacts: CachedArtifacts | null) => void;
  onEffectiveCsvIdChange?: (csvId: string | null) => void;
  onAnalysisComplete?: (entry: { question: string; spec: Spec }) => void;
  /**
   * When set alongside a fresh `questionSeq`, ResponsePanel calls /api/query
   * with this code in `context.code`. The server skips code-gen and runs the
   * sandbox-execute → UI-compose path, producing a fresh dashboard from the
   * edited code. Used by the Edit-and-Rerun feature.
   */
  rerunCode?: string | null;
  /**
   * When set, ResponsePanel sends `context.sql` so the server skips NL-to-SQL
   * generation (warehouse sources only). Used by SQL Edit-and-Rerun.
   */
  rerunSql?: string | null;
}

export function ResponsePanel({
  csvId,
  warehouseId,
  question,
  questionSeq,
  mode = "ask",
  onStreamEnd,
  loadedSpec,
  loadedArtifacts,
  onSaved,
  schemaMode = "metadata",
  codeGenModel,
  uiComposeModel,
  sandboxRuntime,
  purpose = "infographic",
  onRerun,
  loadedVizId,
  onArtifactsChange,
  onEffectiveCsvIdChange,
  onAnalysisComplete,
  rerunCode,
  rerunSql,
}: ResponsePanelProps) {
  const [drillStack, setDrillStack] = useState<DrillLevel[]>([]);
  const currentSpecRef = useRef<Spec | null>(null);
  const currentQuestionRef = useRef<string | null>(question);
  // Conversation history is now managed server-side via the conversation cache.
  const [previousSpec, setPreviousSpec] = useState<Spec | null>(null);
  const lastSeqRef = useRef(0);
  const dashboardRef = useRef<HTMLDivElement>(null);

  // Route the next stream to the right pipeline. The hook reads `api` per
  // call inside its useCallback, so toggling here before a new questionSeq
  // is enough — no remount required.
  const apiUrl = mode === "investigate" ? "/api/query/investigate" : "/api/query";

  const { spec, isStreaming, error, send, clear } = useUIStream({
    api: apiUrl,
    onComplete: (completedSpec) => {
      currentSpecRef.current = completedSpec;
      setPreviousSpec(null);
      onStreamEnd?.();
      if (completedSpec?.root && currentQuestionRef.current) {
        onAnalysisComplete?.({
          question: currentQuestionRef.current,
          spec: JSON.parse(JSON.stringify(completedSpec)),
        });
      }
    },
    onError: () => {
      setPreviousSpec(null);
      onStreamEnd?.();
    },
  });

  // For warehouse queries, the csvId is generated server-side and emitted in the stream
  const warehouseCsvId = (spec?.state as Record<string, unknown> | undefined)
    ?.__warehouse_csv_id as string | undefined;
  const effectiveCsvId = csvId ?? warehouseCsvId ?? null;

  const {
    showArtifacts,
    setShowArtifacts,
    artifacts,
    setArtifacts,
    artifactsLoading,
    artifactsError,
    handleToggleArtifacts,
  } = useArtifacts({ csvId: effectiveCsvId });

  const {
    saving,
    saveMessage,
    exporting,
    handleSave,
    handleExportPdf,
    handleExportDocx,
    handleExportPptx,
  } = useSaveExport({
    csvId: effectiveCsvId,
    currentSpecRef,
    currentQuestionRef,
    dashboardRef,
    onSaved,
  });

  // Keep current question in sync
  useEffect(() => {
    currentQuestionRef.current = question;
  }, [question]);

  // Watch questionSeq changes to trigger initial queries and follow-ups
  useEffect(() => {
    if (questionSeq === 0 || questionSeq === lastSeqRef.current) return;
    lastSeqRef.current = questionSeq;

    if ((!csvId && !warehouseId) || !question) return;

    // Show previous spec dimmed while streaming
    if (currentSpecRef.current) {
      setPreviousSpec(currentSpecRef.current);
    }

    // Reset drill stack and stale artifacts on follow-up
    setDrillStack([]);
    currentSpecRef.current = null;
    setArtifacts(null);
    setShowArtifacts(false);

    // Conversation history is managed server-side (keyed by csvId)
    send("", {
      csv_id: csvId,
      warehouse_id: warehouseId ?? undefined,
      question: question,
      schema_mode: schemaMode,
      code_gen_model: codeGenModel,
      ui_compose_model: uiComposeModel,
      sandbox_runtime: sandboxRuntime,
      purpose,
      // When set, the server uses these instead of generating fresh code/SQL.
      // Used for Edit-and-Rerun: rebuild dashboard from edited Python and/or SQL.
      code: rerunCode ?? undefined,
      sql: rerunSql ?? undefined,
    });

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questionSeq]);

  // Set up drill-down callback ref
  useEffect(() => {
    drillDownCallbackRef.current = (params: DrillDownParams) => {
      if (!currentSpecRef.current || !csvId) return;

      const currentQuestion = currentQuestionRef.current ?? "Analysis";
      // Deep-clone the spec so later stream mutations don't corrupt the snapshot
      const snapshotSpec = JSON.parse(JSON.stringify(currentSpecRef.current!));
      setDrillStack((prev) => [
        ...prev,
        {
          question: currentQuestion,
          segmentLabel: params.segment_label,
          spec: snapshotSpec,
        },
      ]);

      const additionalFilters = params.additional_filters ?? [];
      const filterDesc = [
        `${params.filter_column} = ${params.filter_value}`,
        ...additionalFilters.map((f) => `${f.column} = ${f.value}`),
      ].join(", ");
      const drillQuestion = `Drill down into "${params.segment_label}" (${filterDesc}): analyze this segment in detail`;
      currentQuestionRef.current = drillQuestion;
      currentSpecRef.current = null;

      send("", {
        csv_id: csvId,
        warehouse_id: warehouseId ?? undefined,
        question: drillQuestion,
        drill_down_context: {
          parent_question: currentQuestion,
          filter_column: params.filter_column,
          filter_value: params.filter_value,
          segment_label: params.segment_label,
          chart_title: params.chart_title,
          additional_filters: additionalFilters.length > 0 ? additionalFilters : undefined,
        },
        schema_mode: schemaMode,
        code_gen_model: codeGenModel,
        ui_compose_model: uiComposeModel,
        sandbox_runtime: sandboxRuntime,
        purpose,
      });
    };

    return () => {
      drillDownCallbackRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [csvId, send]);

  const handleClear = useCallback(() => {
    clear();
    setDrillStack([]);
    currentSpecRef.current = null;
    setPreviousSpec(null);
  }, [clear]);

  // Restored spec for drill-back or loaded viz
  const [restoredSpec, setRestoredSpec] = useState<Spec | null>(null);

  // When loadedSpec changes, treat it as a restored spec
  useEffect(() => {
    if (loadedSpec) {
      currentSpecRef.current = loadedSpec;
      setRestoredSpec(loadedSpec);
      setDrillStack([]);
      setPreviousSpec(null);
      // Seed artifacts from saved viz (if available)
      setArtifacts(loadedArtifacts ?? null);
      setShowArtifacts(false);
    } else {
      // loadedSpec cleared (e.g., loading a new viz) — clear stale display
      setRestoredSpec(null);
      currentSpecRef.current = null;
    }
  }, [loadedSpec, loadedArtifacts, setArtifacts, setShowArtifacts]);

  // Notify parent when artifacts change
  useEffect(() => {
    onArtifactsChange?.(artifacts);
  }, [artifacts, onArtifactsChange]);

  // Report effectiveCsvId to parent (needed for page-level artifacts panel)
  useEffect(() => {
    onEffectiveCsvIdChange?.(effectiveCsvId);
  }, [effectiveCsvId, onEffectiveCsvIdChange]);

  const handleBackWithRestore = useCallback(
    (toIndex: number) => {
      const targetLevel = drillStack[toIndex];
      const newStack = drillStack.slice(0, toIndex);
      setDrillStack(newStack);
      currentSpecRef.current = targetLevel.spec;
      currentQuestionRef.current = targetLevel.question;
      clear();
      setRestoredSpec(targetLevel.spec);
    },
    [drillStack, clear]
  );

  // When a new stream starts, clear restored spec
  useEffect(() => {
    if (isStreaming) {
      setRestoredSpec(null);
    }
  }, [isStreaming]);

  // restoredSpec takes priority when set (user clicked Restore or loaded a viz).
  // spec from useUIStream only takes over during/after a new stream.
  const activeSpec = restoredSpec ?? spec;

  if (error) {
    return (
      <div
        className="border border-error-border bg-error-bg p-6"
        style={{ borderRadius: "var(--radius-card)" }}
      >
        <p className="font-medium text-error-text">Analysis Error</p>
        <p className="mt-1 text-sm text-error-text opacity-85">{error.message}</p>
        <button
          onClick={handleClear}
          className="mt-3 text-sm font-medium text-error-text underline hover:no-underline"
        >
          Try again
        </button>
      </div>
    );
  }

  if (!activeSpec && !isStreaming && !previousSpec) {
    // During the brief gap between mount and first stream chunk, show a loading state
    // instead of returning null (which causes a blank screen flash)
    if (questionSeq > 0) {
      return (
        <div
          className="flex items-center gap-2 text-sm text-accent"
          role="status"
          aria-live="polite"
        >
          <SpinnerIcon />
          Starting analysis...
        </div>
      );
    }
    return null;
  }

  return (
    <div className="space-y-4">
      {/* Breadcrumb navigation */}
      {drillStack.length > 0 && (
        <nav className="flex items-center gap-1 text-sm">
          <button
            onClick={() => handleBackWithRestore(0)}
            className="text-accent hover:text-accent-hover transition-colors"
            style={{ transitionDuration: "var(--transition-speed)" }}
          >
            {truncate(drillStack[0].question, 40)}
          </button>
          {drillStack.slice(1).map((level, i) => (
            <span key={i} className="flex items-center gap-1">
              <span className="text-t-tertiary">/</span>
              <button
                onClick={() => handleBackWithRestore(i + 1)}
                className="text-accent hover:text-accent-hover transition-colors"
                style={{ transitionDuration: "var(--transition-speed)" }}
              >
                {level.segmentLabel}
              </button>
            </span>
          ))}
          <span className="text-t-tertiary">/</span>
          <span className="font-medium text-t-secondary">
            {drillStack[drillStack.length - 1].segmentLabel}
          </span>
        </nav>
      )}

      {/* Collapsed previous levels (drill-down) */}
      {drillStack.length > 0 && (
        <div className="space-y-2">
          {drillStack.map((level, i) => (
            <div
              key={i}
              className="theme-card max-h-24 overflow-hidden border border-border-default opacity-50"
              style={{
                background: "var(--bg-panel)",
                borderRadius: "var(--radius-card)",
                padding: "var(--padding-card)",
              }}
            >
              <p className="mb-2 text-xs font-medium text-t-secondary">{level.question}</p>
              {level.spec?.root && level.spec?.elements && (
                <StateProvider initialState={level.spec.state ?? {}}>
                  <ActionProvider>
                    <VisibilityProvider>
                      <RendererErrorBoundary>
                        <Renderer spec={level.spec} registry={registry} />
                      </RendererErrorBoundary>
                    </VisibilityProvider>
                  </ActionProvider>
                </StateProvider>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Streaming indicator */}
      {isStreaming && mode === "investigate" ? (
        <InvestigateProgress spec={activeSpec} />
      ) : isStreaming ? (
        <PipelineProgress spec={activeSpec} drillStack={drillStack} previousSpec={previousSpec} />
      ) : null}

      {/* Active level */}
      {activeSpec?.root && activeSpec?.elements && (
        <Card ref={dashboardRef}>
          <StateProvider initialState={activeSpec.state ?? {}}>
            <ActionProvider>
              <VisibilityProvider>
                <RendererErrorBoundary>
                  <Renderer spec={activeSpec} registry={registry} loading={isStreaming} />
                </RendererErrorBoundary>
              </VisibilityProvider>
            </ActionProvider>
          </StateProvider>

          {/* Save/Export/Artifacts actions moved to top bar — see page.tsx */}
        </Card>
      )}

      {/* Artifacts viewer */}
      {showArtifacts && artifacts && <ArtifactsViewer artifacts={artifacts} />}

      {/* Previous spec shown dimmed below the new dashboard during follow-ups */}
      {previousSpec?.root && previousSpec?.elements && isStreaming && (
        <Card className="opacity-40">
          <StateProvider initialState={previousSpec.state ?? {}}>
            <ActionProvider>
              <VisibilityProvider>
                <RendererErrorBoundary>
                  <Renderer spec={previousSpec} registry={registry} />
                </RendererErrorBoundary>
              </VisibilityProvider>
            </ActionProvider>
          </StateProvider>
        </Card>
      )}
    </div>
  );
}

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

function PipelineProgress({
  spec,
  drillStack,
  previousSpec,
}: {
  spec: Spec | null;
  drillStack: DrillLevel[];
  previousSpec: Spec | null;
}) {
  const progress = (spec?.state as Record<string, unknown> | undefined)?.__progress as
    | { stage: string; step: number; total: number }
    | undefined;

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
  const currentStep = stageToStep[progress.stage] ?? progress.step;
  const isRetrying = progress.stage === "retrying";

  return (
    <div className="flex justify-center py-16" role="status" aria-live="polite">
      <div
        className="grid gap-x-8 gap-y-1.5 text-sm"
        style={{ gridTemplateColumns: "repeat(2, auto)" }}
      >
        {pipelineSteps.map((step, i) => {
          const stepNum = i + 1;
          const isCompleted = stepNum < currentStep;
          const isUpcoming = stepNum > currentStep;

          if (isUpcoming) {
            return (
              <div key={step.stage} className="flex items-center gap-2 text-t-tertiary">
                <span className="inline-block h-4 w-4" />
                {step.label}
              </div>
            );
          }

          if (isCompleted) {
            return (
              <div key={step.stage} className="flex items-center gap-2 text-t-secondary">
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
                {step.label}
              </div>
            );
          }

          // Active
          const retryStep = isWarehousePipeline ? 4 : 2;
          const label = isRetrying && stepNum === retryStep ? RETRYING_LABEL : step.activeLabel;
          return (
            <div key={step.stage} className="flex items-center gap-2 text-accent font-medium">
              <SpinnerIcon />
              {label}
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface PlanStep {
  index: number;
  question: string;
  rationale: string;
  status: "pending" | "running" | "done" | "failed";
}

interface PlanState {
  approach?: string;
  steps?: PlanStep[];
}

interface ProgressMeta {
  stage?: string;
  step?: number;
  total?: number;
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
function InvestigateProgress({ spec }: { spec: Spec | null }) {
  const state = (spec?.state as Record<string, unknown> | undefined) ?? {};
  const plan = state.__plan as PlanState | undefined;
  const progress = state.__progress as ProgressMeta | undefined;
  const errorMsg = state.__error as string | undefined;

  // Once the dashboard root has started rendering, hide this UI — the
  // composed content takes over.
  if (spec?.root) return null;

  const stage = progress?.stage ?? "planning";
  const stageLabel =
    stage === "planning"
      ? "Planning the investigation..."
      : stage === "investigating"
        ? "Running sub-questions..."
        : stage === "composing"
          ? "Composing the unified dashboard..."
          : "Working...";

  return (
    <div className="flex flex-col gap-4 py-10" role="status" aria-live="polite">
      <div className="flex items-center justify-center gap-3">
        <SpinnerIcon />
        <span className="text-sm font-medium text-accent">{stageLabel}</span>
      </div>

      {plan?.approach && (
        <div className="mx-auto max-w-[700px] text-center text-sm text-t-secondary">
          {plan.approach}
        </div>
      )}

      {plan?.steps && plan.steps.length > 0 && (
        <ol className="mx-auto flex w-full max-w-[700px] flex-col gap-2 text-sm">
          {plan.steps.map((step) => (
            <li
              key={step.index}
              className="flex items-start gap-3 border border-border-default px-3 py-2"
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
          className="mx-auto max-w-[700px] border border-error-border bg-error-bg p-3 text-sm text-error-text"
          style={{ borderRadius: "var(--radius-card)" }}
        >
          {errorMsg}
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

function SpinnerIcon() {
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

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "\u2026" : s;
}
