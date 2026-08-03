"use client";

/**
 * Reconnect to a run that survived a client drop — reload / HMR (extracted
 * from page.tsx, exit audit F1). When the page had no source loaded (fresh
 * tab), offer to resume an analysis still executing server-side; resuming
 * restores the source and reattaches ResponsePanel to the live stream (see
 * run-stream-hub / useActiveRuns).
 */
import { useCallback, useState } from "react";
import { useActiveRuns } from "@/hooks/use-active-runs";
import { getSchemaByCsvId, type ActiveRun } from "@/lib/api";
import type { QueryMode } from "@/components/app/query-input";
import type { CSVSchema } from "@/lib/contracts/data-schema";

interface UseReattachArgs {
  enabled: boolean;
  handleUpload: (csvId: string, schema: CSVSchema) => void;
  handleQuery: (question: string, mode: QueryMode) => void;
  handleStreamEnd: () => void;
  currentQuestion: string | null;
  currentMode: QueryMode;
}

export function useReattach({
  enabled,
  handleUpload,
  handleQuery,
  handleStreamEnd,
  currentQuestion,
  currentMode,
}: UseReattachArgs) {
  const [reattachRunId, setReattachRunId] = useState<string | null>(null);
  const activeRuns = useActiveRuns({ enabled });

  const resumeActiveRun = useCallback(
    async (run: ActiveRun) => {
      if (!run.csvId) return;
      const restored = await getSchemaByCsvId(run.csvId);
      if (!restored) {
        activeRuns.dismiss(run.runId); // source expired — nothing to reattach to
        return;
      }
      handleUpload(restored.csv_id, restored.schema); // hasData → true, mounts ResponsePanel
      setReattachRunId(run.runId);
      handleQuery(
        run.question || "Analysis",
        run.route.includes("investigate") ? "investigate" : "ask"
      );
    },
    [handleUpload, handleQuery, activeRuns]
  );

  // Clear the reattach marker whenever a stream ends, so the next follow-up runs
  // through the normal pipeline rather than the attach endpoint.
  const handleStreamEndReattachAware = useCallback(() => {
    handleStreamEnd();
    setReattachRunId(null);
  }, [handleStreamEnd]);

  // A resume that reattached to a run which was already stopped/finished (no live
  // stream, incomplete buffer) would render a blank page. Recover by clearing the
  // reattach marker and re-running the question fresh, so progress + a result show.
  const handleReattachFailed = useCallback(() => {
    setReattachRunId(null);
    if (currentQuestion) handleQuery(currentQuestion, currentMode);
  }, [handleQuery, currentQuestion, currentMode]);

  return {
    reattachRunId,
    activeRuns,
    resumeActiveRun,
    handleStreamEndReattachAware,
    handleReattachFailed,
  };
}
