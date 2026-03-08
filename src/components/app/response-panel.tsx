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
}

export function ResponsePanel({
  csvId,
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
}: ResponsePanelProps) {
  const [drillStack, setDrillStack] = useState<DrillLevel[]>([]);
  const currentSpecRef = useRef<Spec | null>(null);
  const currentQuestionRef = useRef<string | null>(question);
  const conversationHistoryRef = useRef<ConversationEntry[]>([]);
  const [previousSpec, setPreviousSpec] = useState<Spec | null>(null);
  const lastSeqRef = useRef(0);
  const dashboardRef = useRef<HTMLDivElement>(null);

  const {
    saving,
    saveMessage,
    exporting,
    handleSave,
    handleExportPdf,
    handleExportDocx,
    handleExportPptx,
  } = useSaveExport({ csvId, currentSpecRef, currentQuestionRef, dashboardRef, onSaved });

  const {
    showArtifacts,
    setShowArtifacts,
    artifacts,
    setArtifacts,
    artifactsLoading,
    artifactsError,
    handleToggleArtifacts,
  } = useArtifacts({ csvId });

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

  // Keep current question in sync
  useEffect(() => {
    currentQuestionRef.current = question;
  }, [question]);

  // Watch questionSeq changes to trigger initial queries and follow-ups
  useEffect(() => {
    if (questionSeq === 0 || questionSeq === lastSeqRef.current) return;
    lastSeqRef.current = questionSeq;

    if (!csvId || !question) return;

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
      question: question,
      conversation_history: historyToSend.length > 0 ? historyToSend : undefined,
      schema_mode: schemaMode,
      code_gen_model: codeGenModel,
      ui_compose_model: uiComposeModel,
      sandbox_runtime: sandboxRuntime,
    });

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questionSeq]);

  // Set up drill-down callback ref
  useEffect(() => {
    drillDownCallbackRef.current = (params: DrillDownParams) => {
      if (!currentSpecRef.current || !csvId) return;

      const currentQuestion = currentQuestionRef.current ?? "Analysis";
      setDrillStack((prev) => [
        ...prev,
        {
          question: currentQuestion,
          segmentLabel: params.segment_label,
          spec: currentSpecRef.current!,
        },
      ]);

      const drillQuestion = `Drill down into "${params.segment_label}" (${params.filter_column} = ${params.filter_value}): analyze this segment in detail`;
      currentQuestionRef.current = drillQuestion;
      currentSpecRef.current = null;

      send("", {
        csv_id: csvId,
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
    }
  }, [loadedSpec, loadedArtifacts]);

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
              <StateProvider initialState={level.spec.state ?? {}}>
                <ActionProvider>
                  <VisibilityProvider>
                    <RendererErrorBoundary>
                      <Renderer spec={level.spec} registry={registry} />
                    </RendererErrorBoundary>
                  </VisibilityProvider>
                </ActionProvider>
              </StateProvider>
            </div>
          ))}
        </div>
      )}

      {/* Streaming indicator */}
      {isStreaming && (
        <div className="flex items-center gap-2 text-sm text-accent">
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
          {drillStack.length > 0
            ? "Drilling down..."
            : previousSpec
              ? "Updating dashboard..."
              : "Building visualization..."}
        </div>
      )}

      {/* Active level */}
      {activeSpec && (
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
      {previousSpec && isStreaming && (
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

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "\u2026" : s;
}
