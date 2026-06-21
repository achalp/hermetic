import { NextResponse } from "next/server";
import { getStoredCSV, getCSVContent } from "@/lib/csv/storage";
import { getCachedCode } from "@/lib/pipeline/code-cache";
import { getCachedArtifacts } from "@/lib/pipeline/artifacts-cache";
import { getConversationTurns } from "@/lib/pipeline/conversation-cache";
import { saveHistoryEntry } from "@/lib/history/storage";
import { summarizeSpec } from "@/lib/spec-summary";
import type { Spec } from "@json-render/react";
import { logger } from "@/lib/logger";

export async function POST(request: Request) {
  try {
    const { csvId, spec, question } = await request.json();

    if (!csvId || !spec || !question) {
      return NextResponse.json(
        { error: "csvId, spec, and question are required" },
        { status: 400 }
      );
    }

    // Look up cached data (best-effort — may have expired)
    const stored = getStoredCSV(csvId);
    if (!stored) {
      logger.debug("History auto-save skipped: CSV expired", { csvId });
      return NextResponse.json({ skipped: true });
    }

    const artifacts = getCachedArtifacts(csvId);
    // Single-shot Ask caches its one Python script in the code cache. An
    // Investigate doesn't — its per-step code lives in the trail — but the
    // investigate route mirrors the last successful step's code onto the cached
    // artifacts. Fall back to that so investigations aren't silently dropped
    // from history (the data check above is the only real "can't save" gate).
    const generatedCode = getCachedCode(csvId)?.code ?? artifacts?.code ?? "";

    // Determine source type
    const isLocal = !!(stored.localPath || stored.localFolderPath);
    const isWarehouse = stored.schema.source_type === "warehouse";
    const sourceType = isLocal ? "local" : isWarehouse ? "warehouse" : "upload";

    // Only fetch CSV content for uploaded files
    let csvContent: string | undefined;
    if (sourceType === "upload") {
      csvContent = (await getCSVContent(csvId)) ?? undefined;
    }

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
    });

    // Update the latest conversation turn's specSummary now that the spec is available.
    // The turn was appended during execution with an empty specSummary because
    // the spec hadn't been streamed yet.
    const turns = getConversationTurns(csvId);
    if (turns.length > 0) {
      const lastTurn = turns[turns.length - 1];
      if (!lastTurn.specSummary && spec) {
        lastTurn.specSummary = summarizeSpec(spec as unknown as Spec);
      }
    }

    logger.info("History entry saved", { id: meta.id, question: meta.question.slice(0, 50) });
    return NextResponse.json({ meta });
  } catch (err) {
    const message = err instanceof Error ? err.message : "History save failed";
    logger.error("History auto-save error", { error: message });
    // Don't fail the client — auto-save is best-effort
    return NextResponse.json({ skipped: true, error: message });
  }
}
