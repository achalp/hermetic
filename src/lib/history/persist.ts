/**
 * Persist a completed analysis to history from a spec + csvId + question. All the
 * other inputs (schema, artifacts, generated code, source CSV) are looked up
 * server-side by csvId, so this is the ONLY thing a caller must supply.
 *
 * Shared by the client-triggered /api/history/save route AND the query pipeline,
 * which calls it itself at the concluding stage so a run survives a client that
 * disconnected mid-analysis.
 */
import { getStoredCSV, getCSVContent } from "@/lib/csv/storage";
import { getCachedCode } from "@/lib/pipeline/code-cache";
import { getCachedArtifacts } from "@/lib/pipeline/artifacts-cache";
import { getConversationTurns } from "@/lib/pipeline/conversation-cache";
import { saveHistoryEntry } from "@/lib/history/storage";
import { summarizeSpec } from "@/lib/spec-summary";
import type { HistoryMeta } from "@/lib/contracts/storage-types";
import { logger } from "@/lib/logger";

export type PersistResult = { saved: true; meta: HistoryMeta } | { saved: false; reason: string };

export async function persistHistoryEntry(
  csvId: string,
  spec: Record<string, unknown>,
  question: string,
  opts: {
    /**
     * Skip the cached code/artifacts lookup. The cache is keyed by csvId, so
     * for a spec this process did NOT compose (an MCP host authoring its own
     * dashboard) the cache holds some OTHER run's Python and results —
     * pairing them would make "Edit & rerun" execute code that never produced
     * the visible dashboard.
     */
    withoutCachedRun?: boolean;
  } = {}
): Promise<PersistResult> {
  if (!csvId || !spec || !question) return { saved: false, reason: "missing csvId/spec/question" };

  // Best-effort: cached source data may have expired.
  const stored = getStoredCSV(csvId);
  if (!stored) {
    logger.debug("History save skipped: CSV expired", { csvId });
    return { saved: false, reason: "csv expired" };
  }

  const artifacts = opts.withoutCachedRun ? undefined : getCachedArtifacts(csvId);
  // Single-shot Ask caches its Python in the code cache; Investigate mirrors its
  // last successful step's code onto the artifacts. Fall back so nothing drops.
  const generatedCode = opts.withoutCachedRun
    ? ""
    : (getCachedCode(csvId)?.code ?? artifacts?.code ?? "");

  const isLocal = !!(stored.localPath || stored.localFolderPath);
  const isWarehouse = stored.schema.source_type === "warehouse";
  const sourceType = isLocal ? "local" : isWarehouse ? "warehouse" : "upload";

  let csvContent: string | undefined;
  if (sourceType === "upload") csvContent = (await getCSVContent(csvId)) ?? undefined;

  const meta = await saveHistoryEntry({
    question,
    spec,
    generatedCode,
    schema: stored.schema,
    artifacts: artifacts ?? undefined,
    sourceFile: stored.schema.filename,
    sourceType: sourceType as "upload" | "local" | "warehouse",
    localPath: stored.localPath || stored.localFolderPath,
    warehouseType: stored.schema.warehouse_type,
    csvContent,
    executionMs: artifacts?.execution_ms ?? 0,
    csvId,
  });

  // Backfill the latest conversation turn's specSummary (appended during
  // execution with an empty summary because the spec wasn't ready yet).
  const turns = getConversationTurns(csvId);
  const lastTurn = turns[turns.length - 1];
  if (lastTurn && !lastTurn.specSummary) {
    lastTurn.specSummary = summarizeSpec(spec);
  }

  logger.info("History entry saved", { id: meta.id, question: meta.question.slice(0, 50) });
  return { saved: true, meta };
}
