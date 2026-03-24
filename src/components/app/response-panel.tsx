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
import type { DrillDownParams, ConversationEntry, SchemaMode } from "@/lib/types";
import type { ModelId, SandboxRuntimeId } from "@/lib/constants";
import type { CachedArtifacts } from "@/lib/pipeline/artifacts-cache";
import { summarizeSpec } from "@/lib/spec-summary";
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
}

export function ResponsePanel({
  csvId,
  warehouseId,
  question,
  questionSeq,
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
}: ResponsePanelProps) {
  const [drillStack, setDrillStack] = useState<DrillLevel[]>([]);
  const currentSpecRef = useRef<Spec | null>(null);
  const currentQuestionRef = useRef<string | null>(question);
  const conversationHistoryRef = useRef<ConversationEntry[]>([]);
  const [previousSpec, setPreviousSpec] = useState<Spec | null>(null);
  const lastSeqRef = useRef(0);
  const dashboardRef = useRef<HTMLDivElement>(null);

  const { spec, isStreaming, error, send, clear } = useUIStream({
    api: "/api/query",
    onComplete: (completedSpec) => {
      currentSpecRef.current = completedSpec;
      setPreviousSpec(null);
      onStreamEnd?.();
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

    // Build updated history before sending (avoid async setState race)
    let historyToSend = conversationHistoryRef.current;
    if (currentSpecRef.current) {
      const summary = summarizeSpec(currentSpecRef.current);
      const newEntry: ConversationEntry = {
        question: currentQuestionRef.current ?? "Analysis",
        specSummary: summary,
      };
      historyToSend = [...historyToSend, newEntry];
      conversationHistoryRef.current = historyToSend;

      // Show previous spec dimmed while streaming
      setPreviousSpec(currentSpecRef.current);
    }

    // Reset drill stack and stale artifacts on follow-up
    setDrillStack([]);
    currentSpecRef.current = null;
    setArtifacts(null);
    setShowArtifacts(false);

    send("", {
      csv_id: csvId,
      warehouse_id: warehouseId ?? undefined,
      question: question,
      conversation_history: historyToSend.length > 0 ? historyToSend : undefined,
      schema_mode: schemaMode,
      code_gen_model: codeGenModel,
      ui_compose_model: uiComposeModel,
      sandbox_runtime: sandboxRuntime,
      purpose,
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

      const drillQuestion = `Drill down into "${params.segment_label}" (${params.filter_column} = ${params.filter_value}): analyze this segment in detail`;
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
    conversationHistoryRef.current = [];
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
      conversationHistoryRef.current = [];
      // Seed artifacts from saved viz (if available)
      setArtifacts(loadedArtifacts ?? null);
      setShowArtifacts(false);
    } else {
      // loadedSpec cleared (e.g., loading a new viz) — clear stale display
      setRestoredSpec(null);
      currentSpecRef.current = null;
    }
  }, [loadedSpec, loadedArtifacts, setArtifacts, setShowArtifacts]);

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

  const activeSpec = spec ?? restoredSpec;

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
      {isStreaming && (
        <PipelineProgress spec={activeSpec} drillStack={drillStack} previousSpec={previousSpec} />
      )}

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

          {/* Save & Export buttons */}
          {activeSpec && !isStreaming && (
            <div className="mt-4 flex items-center gap-2 border-t border-border-default pt-4">
              <ActionButton onClick={handleSave} disabled={saving || !!exporting}>
                {saving ? "Saving..." : "Save"}
              </ActionButton>
              <ActionButton onClick={handleExportPdf} disabled={!!exporting}>
                {exporting === "pdf" ? "Exporting..." : "Export PDF"}
              </ActionButton>
              <ActionButton onClick={handleExportDocx} disabled={!!exporting}>
                {exporting === "docx" ? "Exporting..." : "Export DOCX"}
              </ActionButton>
              <ActionButton onClick={handleExportPptx} disabled={!!exporting}>
                {exporting === "pptx" ? "Exporting..." : "Export PPTX"}
              </ActionButton>
              <ActionButton onClick={handleToggleArtifacts} disabled={artifactsLoading}>
                {artifactsLoading
                  ? "Loading..."
                  : showArtifacts
                    ? "Hide Artifacts"
                    : "View Artifacts"}
              </ActionButton>
              {loadedVizId && onRerun && <ActionButton onClick={onRerun}>Update Data</ActionButton>}
              {saveMessage && (
                <span
                  className={`text-xs ${saveMessage === "Saved!" ? "text-success-text" : "text-error-text"}`}
                >
                  {saveMessage}
                </span>
              )}
              {artifactsError && <span className="text-xs text-error-text">{artifactsError}</span>}
            </div>
          )}
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
      <div className="flex items-center gap-2 text-sm text-accent" role="status" aria-live="polite">
        <SpinnerIcon />
        {message}
      </div>
    );
  }

  const isWarehousePipeline = progress.total === 5;
  const pipelineSteps = isWarehousePipeline ? WAREHOUSE_PIPELINE_STEPS : FILE_PIPELINE_STEPS;
  const stageToStep = isWarehousePipeline ? WAREHOUSE_STAGE_TO_STEP : FILE_STAGE_TO_STEP;
  const currentStep = stageToStep[progress.stage] ?? progress.step;
  const isRetrying = progress.stage === "retrying";

  return (
    <div className="space-y-1.5 text-sm" role="status" aria-live="polite">
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
