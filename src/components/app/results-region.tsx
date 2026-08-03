"use client";

/**
 * The results region (extracted from page.tsx, exit audit F1): analysis
 * history, the follow-up question input, the (lazily loaded) ResponsePanel,
 * and follow-up suggestion pills. Always mounted once data exists, hidden in
 * States 1–2 — unmounting would abort in-flight streams.
 */
import dynamic from "next/dynamic";
import type { RefObject } from "react";
import { AnalysisHistory, type HistoryEntry } from "@/components/app/analysis-history";
import { QueryInput, type QueryMode } from "@/components/app/query-input";
import { SuggestionPills } from "@/components/app/suggestion-pills";
import type { usePageState } from "@/hooks/use-page-state";
import type { useArtifacts } from "@/hooks/use-artifacts";
import type { NotebookExportApi } from "@/components/app/notebook-view";
import type { CostInfo } from "@/components/app/cost-footer";
import type { SchemaMode } from "@/lib/contracts/data-schema";
import type { useModelSettings } from "@/hooks/use-model-settings";
import type { useReattach } from "@/hooks/use-reattach";

// Lazy-load ResponsePanel — it pulls in plotly.js, globe.gl, maplibre-gl, three.js etc.
const ResponsePanel = dynamic(
  () => import("@/components/app/response-panel").then((m) => m.ResponsePanel),
  { ssr: false }
);

export interface ResultsRegionProps {
  hasData: boolean;
  isState3: boolean;
  isState4: boolean;
  queryMode: QueryMode;
  setQueryMode: (m: QueryMode) => void;
  analysisHistory: HistoryEntry[];
  onRemoveHistoryEntry: (ts: number) => void;
  onGuardedQuery: (question: string, mode?: QueryMode) => Promise<void>;
  /** The page reducer's full state + dispatch — this region renders it. */
  pageState: ReturnType<typeof usePageState>["state"];
  dispatch: ReturnType<typeof usePageState>["dispatch"];
  dashboardRef: RefObject<HTMLDivElement | null>;
  csvId: string | null;
  warehouseId: string | null;
  reattach: ReturnType<typeof useReattach>;
  schemaMode: SchemaMode;
  models: ReturnType<typeof useModelSettings>;
  purpose: string;
  onRerun: () => void;
  onEffectiveCsvIdChange: (id: string | null) => void;
  onNotebookExportApiChange: (api: NotebookExportApi | null) => void;
  pageArtifacts: ReturnType<typeof useArtifacts>;
  onAnalysisComplete: (entry: { spec: HistoryEntry["spec"]; question: string }) => void;
  onCost: (cost: CostInfo) => void;
  followUpSuggestions: string[];
}

export function ResultsRegion(props: ResultsRegionProps) {
  const {
    hasData,
    isState3,
    isState4,
    queryMode,
    setQueryMode,
    analysisHistory,
    onRemoveHistoryEntry,
    onGuardedQuery,
    pageState,
    dispatch,
    dashboardRef,
    pageArtifacts,
    followUpSuggestions,
  } = props;
  const { isAnalyzing } = pageState;

  if (!hasData) return null;
  return (
    <div className={isState3 || isState4 ? "py-8" : "hidden"}>
      {/* Analysis history — shows previous question/result pairs */}
      {isState4 && analysisHistory.length > 1 && (
        <AnalysisHistory
          entries={analysisHistory.slice(0, -1)}
          onReplay={onGuardedQuery}
          onRestore={(entry) => {
            // Spread to create a new reference so the useEffect in
            // ResponsePanel fires even if restoring the same entry twice.
            dispatch({
              type: "LOAD_VIZ_SUCCESS",
              question: entry.question,
              spec: { ...entry.spec },
              artifacts: null,
            });
          }}
          onRemove={onRemoveHistoryEntry}
        />
      )}
      {/* Follow-up question input — ABOVE results for quick access */}
      {isState4 && !isAnalyzing && (
        <div className="mb-6 w-full max-w-[700px] mx-auto">
          <QueryInput
            onSubmit={onGuardedQuery}
            disabled={!hasData}
            isLoading={isAnalyzing}
            mode={queryMode}
            onModeChange={setQueryMode}
          />
        </div>
      )}
      <div ref={dashboardRef}>
        <ResponsePanel
          csvId={props.csvId}
          warehouseId={props.warehouseId}
          question={pageState.currentQuestion}
          questionSeq={pageState.questionSeq}
          mode={pageState.currentMode}
          reattachRunId={props.reattach.reattachRunId}
          onStreamEnd={props.reattach.handleStreamEndReattachAware}
          onReattachFailed={props.reattach.handleReattachFailed}
          loadedSpec={pageState.loadedSpec}
          loadedArtifacts={pageState.loadedArtifacts}
          schemaMode={props.schemaMode}
          codeGenModel={props.models.codeGenModel}
          uiComposeModel={props.models.uiComposeModel}
          sandboxRuntime={props.models.sandboxRuntime}
          purpose={props.purpose}
          onRerun={props.onRerun}
          loadedVizId={pageState.loadedVizId}
          onEffectiveCsvIdChange={props.onEffectiveCsvIdChange}
          onNotebookExportApiChange={props.onNotebookExportApiChange}
          rerunCode={pageState.rerunCode}
          rerunSql={pageState.rerunSql}
          artifacts={pageArtifacts.artifacts}
          setArtifacts={pageArtifacts.setArtifacts}
          onAnalysisComplete={props.onAnalysisComplete}
          onCost={props.onCost}
        />
      </div>
      {/* Follow-up suggestions — surfaces after each successful analysis */}
      {isState4 && !isAnalyzing && followUpSuggestions.length > 0 && (
        <div className="mt-6 w-full max-w-[700px] mx-auto">
          <SuggestionPills
            suggestions={followUpSuggestions}
            onSelect={onGuardedQuery}
            title="Try next"
          />
        </div>
      )}
    </div>
  );
}
