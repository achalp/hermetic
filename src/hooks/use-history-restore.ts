"use client";

/**
 * URL-driven history entry points, extracted from page.tsx (ARCH-5):
 *   ?restore=<id>        — load a persisted history entry read-only
 *   ?rerun_history=<id>  — refresh it against the live source (falls back to
 *                          a plain restore for a warehouse entry when no
 *                          connection is active)
 * Both run ONCE on mount (the URL param only exists on the navigation that
 * set it; the param is stripped immediately) and deliberately capture the
 * mount-time warehouse/runtime values — hence the empty dep lists.
 */
import { useEffect } from "react";
import type { Spec } from "@/spec/react";
import type { CSVSchema } from "@/lib/contracts/data-schema";
import type { CachedArtifacts } from "@/lib/contracts/investigation";
import type { SandboxRuntimeId } from "@/lib/constants";
import type { PageDispatch } from "@/hooks/use-page-state";
import { loadHistoryEntry, refreshHistoryEntry } from "@/app/lib/api";

export function useHistoryRestore(args: {
  dispatch: PageDispatch;
  handleUpload: (csvId: string, schema: CSVSchema) => void;
  warehouseId: string | null;
  sandboxRuntime: SandboxRuntimeId;
}): void {
  const { dispatch, handleUpload, warehouseId, sandboxRuntime } = args;

  // ── Restore from history (?restore=id) ────────────────────
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const restoreId = params.get("restore");
    if (!restoreId) return;

    // Clean up URL
    window.history.replaceState({}, "", "/");

    // Load the history entry (same pattern as handleLoadViz)
    dispatch({ type: "LOAD_VIZ_START" });
    loadHistoryEntry(restoreId)
      .then((data) => {
        if (data.csvId) {
          handleUpload(data.csvId, data.schema);
        }
        dispatch({
          type: "LOAD_VIZ_SUCCESS",
          question: data.meta.question,
          spec: data.spec,
          artifacts: (data.artifacts as unknown as CachedArtifacts) ?? null,
        });
      })
      .catch((err) => {
        console.error("Failed to restore history entry:", err);
        dispatch({ type: "LOAD_VIZ_ERROR" });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Re-run from history (?rerun_history=id) ────────────────
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const rerunId = params.get("rerun_history");
    if (!rerunId) return;

    window.history.replaceState({}, "", "/");

    // First load the entry to check source type before attempting refresh
    loadHistoryEntry(rerunId)
      .then(async (data) => {
        const isWarehouse = data.meta.sourceType === "warehouse";
        const canRefresh = !isWarehouse || !!warehouseId;

        if (canRefresh) {
          dispatch({ type: "RERUN_START" });
          dispatch({ type: "REFRESH_STAGE", stage: "loading" });
          await new Promise((r) => setTimeout(r, 100));
          dispatch({ type: "REFRESH_STAGE", stage: "executing" });
          const result = await refreshHistoryEntry(rerunId, warehouseId, sandboxRuntime);
          dispatch({ type: "REFRESH_STAGE", stage: "composing" });
          handleUpload(result.csvId, result.schema);
          // RERUN_FAST_SUCCESS clears refreshStage in the reducer.
          dispatch({
            type: "RERUN_FAST_SUCCESS",
            spec: result.spec,
            artifacts: (result.artifacts as unknown as CachedArtifacts) ?? null,
          });
        } else {
          // Warehouse without active connection — just restore
          if (data.csvId) {
            handleUpload(data.csvId, data.schema);
          }
          dispatch({
            type: "LOAD_VIZ_SUCCESS",
            question: data.meta.question,
            spec: data.spec,
            artifacts: (data.artifacts as unknown as CachedArtifacts) ?? null,
          });
        }
      })
      .catch(() => {
        // RERUN_ERROR clears refreshStage in the reducer.
        dispatch({ type: "RERUN_ERROR" });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
