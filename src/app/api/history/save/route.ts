import { NextResponse } from "next/server";
import { getStoredCSV, getCSVContent } from "@/lib/csv/storage";
import { getCachedCode } from "@/lib/pipeline/code-cache";
import { getCachedArtifacts } from "@/lib/pipeline/artifacts-cache";
import { saveHistoryEntry } from "@/lib/history/storage";
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

    const cached = getCachedCode(csvId);
    if (!cached) {
      logger.debug("History auto-save skipped: code cache expired", { csvId });
      return NextResponse.json({ skipped: true });
    }

    const artifacts = getCachedArtifacts(csvId);

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
      generatedCode: cached.code,
      schema: stored.schema,
      artifacts: artifacts ?? undefined,
      sourceFile: stored.schema.filename,
      sourceType: sourceType as "upload" | "local" | "warehouse",
      localPath: stored.localPath || stored.localFolderPath,
      warehouseType: stored.schema.warehouse_type,
      csvContent,
      executionMs: artifacts?.execution_ms ?? 0,
    });

    logger.info("History entry saved", { id: meta.id, question: meta.question.slice(0, 50) });
    return NextResponse.json({ meta });
  } catch (err) {
    const message = err instanceof Error ? err.message : "History save failed";
    logger.error("History auto-save error", { error: message });
    // Don't fail the client — auto-save is best-effort
    return NextResponse.json({ skipped: true, error: message });
  }
}
