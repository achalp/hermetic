"use client";

import {
  useUIStream,
  Renderer,
  StateProvider,
  ActionProvider,
  VisibilityProvider,
} from "@json-render/react";
import type { Spec } from "@json-render/react";
import { registry, drillDownCallbackRef } from "@/components/registry";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DrillDownParams, ConversationEntry, SchemaMode } from "@/lib/types";
import type { ModelId, SandboxRuntimeId } from "@/lib/constants";
import type { CachedArtifacts } from "@/lib/pipeline/artifacts-cache";
import { summarizeSpec } from "@/lib/spec-summary";
import {
  downloadDashboardAsPdf,
  downloadDashboardAsDocx,
  downloadDashboardAsPptx,
} from "@/lib/export-utils";
import { ArtifactsViewer } from "@/components/app/artifacts-viewer";

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
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [exporting, setExporting] = useState<"pdf" | "docx" | "pptx" | null>(null);
  const [showArtifacts, setShowArtifacts] = useState(false);
  const [artifacts, setArtifacts] = useState<CachedArtifacts | null>(null);
  const [artifactsLoading, setArtifactsLoading] = useState(false);
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

  const handleSave = useCallback(async () => {
    if (!csvId || !currentSpecRef.current) return;
    setSaving(true);
    setSaveMessage(null);
    try {
      const res = await fetch("/api/vizs/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          csvId,
          spec: currentSpecRef.current,
          question: currentQuestionRef.current ?? "Analysis",
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        setSaveMessage(data.error ?? "Save failed");
      } else {
        setSaveMessage("Saved!");
        onSaved?.();
        setTimeout(() => setSaveMessage(null), 2000);
      }
    } catch {
      setSaveMessage("Save failed");
    } finally {
      setSaving(false);
    }
  }, [csvId, onSaved]);

  const handleExportPdf = useCallback(async () => {
    if (!dashboardRef.current) return;
    setExporting("pdf");
    try {
      await downloadDashboardAsPdf(dashboardRef.current, currentQuestionRef.current ?? "dashboard");
    } catch (e) {
      console.error("PDF export failed:", e);
    } finally {
      setExporting(null);
    }
  }, []);

  const handleExportDocx = useCallback(async () => {
    if (!dashboardRef.current) return;
    setExporting("docx");
    try {
      await downloadDashboardAsDocx(
        dashboardRef.current,
        currentQuestionRef.current ?? "dashboard"
      );
    } catch (e) {
      console.error("DOCX export failed:", e);
    } finally {
      setExporting(null);
    }
  }, []);

  const handleExportPptx = useCallback(async () => {
    if (!dashboardRef.current) return;
    setExporting("pptx");
    try {
      await downloadDashboardAsPptx(
        dashboardRef.current,
        currentQuestionRef.current ?? "dashboard"
      );
    } catch (e) {
      console.error("PPTX export failed:", e);
    } finally {
      setExporting(null);
    }
  }, []);

  const handleClear = useCallback(() => {
    clear();
    setDrillStack([]);
    currentSpecRef.current = null;
    setPreviousSpec(null);
    conversationHistoryRef.current = [];
  }, [clear]);

  const [artifactsError, setArtifactsError] = useState<string | null>(null);

  const handleToggleArtifacts = useCallback(async () => {
    if (showArtifacts) {
      setShowArtifacts(false);
      return;
    }
    if (!csvId) return;
    if (artifacts) {
      setShowArtifacts(true);
      return;
    }
    setArtifactsLoading(true);
    setArtifactsError(null);
    try {
      const res = await fetch(`/api/artifacts/${csvId}`);
      if (res.ok) {
        const data = await res.json();
        setArtifacts(data);
        setShowArtifacts(true);
      } else {
        setArtifactsError("Artifacts expired. Re-run the query or save the visualization first.");
        setTimeout(() => setArtifactsError(null), 4000);
      }
    } catch {
      setArtifactsError("Failed to load artifacts.");
      setTimeout(() => setArtifactsError(null), 4000);
    } finally {
      setArtifactsLoading(false);
    }
  }, [showArtifacts, csvId, artifacts]);

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

  const actionBtnClass =
    "bg-surface-btn px-3 py-1.5 text-xs font-medium text-t-btn hover:bg-surface-btn-hover disabled:opacity-50 transition-colors";

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
                    <Renderer spec={level.spec} registry={registry} />
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
        <div
          ref={dashboardRef}
          className="theme-card border border-border-default"
          style={{
            background: "var(--bg-panel)",
            padding: "var(--padding-card)",
            borderRadius: "var(--radius-card)",
            boxShadow: "var(--shadow-card)",
          }}
        >
          <StateProvider initialState={activeSpec.state ?? {}}>
            <ActionProvider>
              <VisibilityProvider>
                <Renderer spec={activeSpec} registry={registry} loading={isStreaming} />
              </VisibilityProvider>
            </ActionProvider>
          </StateProvider>

          {/* Save & Export buttons */}
          {activeSpec && !isStreaming && (
            <div className="mt-4 flex items-center gap-2 border-t border-border-default pt-4">
              <button
                onClick={handleSave}
                disabled={saving || !!exporting}
                className={actionBtnClass}
                style={{
                  borderRadius: "var(--radius-badge)",
                  transitionDuration: "var(--transition-speed)",
                }}
              >
                {saving ? "Saving..." : "Save"}
              </button>
              <button
                onClick={handleExportPdf}
                disabled={!!exporting}
                className={actionBtnClass}
                style={{
                  borderRadius: "var(--radius-badge)",
                  transitionDuration: "var(--transition-speed)",
                }}
              >
                {exporting === "pdf" ? "Exporting..." : "Export PDF"}
              </button>
              <button
                onClick={handleExportDocx}
                disabled={!!exporting}
                className={actionBtnClass}
                style={{
                  borderRadius: "var(--radius-badge)",
                  transitionDuration: "var(--transition-speed)",
                }}
              >
                {exporting === "docx" ? "Exporting..." : "Export DOCX"}
              </button>
              <button
                onClick={handleExportPptx}
                disabled={!!exporting}
                className={actionBtnClass}
                style={{
                  borderRadius: "var(--radius-badge)",
                  transitionDuration: "var(--transition-speed)",
                }}
              >
                {exporting === "pptx" ? "Exporting..." : "Export PPTX"}
              </button>
              <button
                onClick={handleToggleArtifacts}
                disabled={artifactsLoading}
                className={actionBtnClass}
                style={{
                  borderRadius: "var(--radius-badge)",
                  transitionDuration: "var(--transition-speed)",
                }}
              >
                {artifactsLoading
                  ? "Loading..."
                  : showArtifacts
                    ? "Hide Artifacts"
                    : "View Artifacts"}
              </button>
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
        </div>
      )}

      {/* Artifacts viewer */}
      {showArtifacts && artifacts && <ArtifactsViewer artifacts={artifacts} />}

      {/* Previous spec shown dimmed below the new dashboard during follow-ups */}
      {previousSpec && isStreaming && (
        <div
          className="theme-card border border-border-default opacity-40"
          style={{
            background: "var(--bg-panel)",
            padding: "var(--padding-card)",
            borderRadius: "var(--radius-card)",
            boxShadow: "var(--shadow-card)",
          }}
        >
          <StateProvider initialState={previousSpec.state ?? {}}>
            <ActionProvider>
              <VisibilityProvider>
                <Renderer spec={previousSpec} registry={registry} />
              </VisibilityProvider>
            </ActionProvider>
          </StateProvider>
        </div>
      )}
    </div>
  );
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "\u2026" : s;
}
