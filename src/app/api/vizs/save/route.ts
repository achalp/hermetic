import { NextResponse } from "next/server";
import { apiError } from "@/app/lib/api-error";
import { getCachedCode } from "@/lib/pipeline/code-cache";
import { getCachedArtifacts } from "@/lib/pipeline/artifacts-cache";
import { getStoredCSV, getCSVContent, getWorkbookManifest } from "@/lib/csv/storage";
import { saveVisualization, saveNewVersion } from "@/lib/saved/storage";
import type { SavedWorkbook } from "@/lib/saved/storage";
import { schemaFingerprint } from "@/lib/saved/schema-compat";
import { readJsonBody, parseBody, VizSaveSchema } from "@/lib/api-schemas";

export async function POST(request: Request) {
  try {
    const read = await readJsonBody(request);
    if (!read.ok) return read.response;
    const parsed = parseBody(VizSaveSchema, read.body);
    if (!parsed.ok) return parsed.response;
    const { csvId, spec, question, parentVizId, historyId } = parsed.data;

    // Look up CSV
    const stored = getStoredCSV(csvId);
    if (!stored) {
      return NextResponse.json(
        { error: "CSV not found or expired. Please re-upload." },
        { status: 404 }
      );
    }

    const csvContent = await getCSVContent(csvId);
    if (!csvContent) {
      return NextResponse.json({ error: "CSV content not found" }, { status: 404 });
    }

    // Grab artifacts from in-memory cache (best-effort — may have expired)
    const artifacts = getCachedArtifacts(csvId);

    // generatedCode: single-shot Ask caches its one script; an Investigate
    // mirrors its last successful step's code onto the cached artifacts. Without
    // the artifacts fallback, saving an investigation 404'd ("code not found").
    const generatedCode = getCachedCode(csvId)?.code ?? artifacts?.code;
    if (!generatedCode) {
      return NextResponse.json(
        {
          error:
            "Generated code not found in cache. It may have expired — please re-run the query.",
        },
        { status: 404 }
      );
    }

    const fingerprint = schemaFingerprint(stored.schema);

    // Determine source type for refresh support
    const isLocal = !!(stored.localPath || stored.localFolderPath);
    const isWarehouse = stored.schema.source_type === "warehouse";
    const sourceType: "upload" | "local" | "warehouse" = isLocal
      ? "local"
      : isWarehouse
        ? "warehouse"
        : "upload";
    const localPath = stored.localPath || stored.localFolderPath;
    const sql = artifacts?.sql;

    // Check for workbook manifest — if present, persist all sheets
    const workbook = await buildSavedWorkbook(csvId);

    // If parentVizId is set, save as a new version of that viz
    if (parentVizId) {
      const meta = await saveNewVersion(parentVizId, {
        csvFilename: stored.schema.filename,
        csvContent,
        generatedCode,
        spec,
        artifacts: artifacts ?? undefined,
        schemaFingerprint: fingerprint,
        sourceType,
        localPath,
        sql,
        historyId: typeof historyId === "string" ? historyId : undefined,
      });
      return NextResponse.json({ meta });
    }

    const meta = await saveVisualization({
      question,
      csvFilename: stored.schema.filename,
      csvContent,
      generatedCode,
      spec,
      artifacts: artifacts ?? undefined,
      schemaFingerprint: fingerprint,
      workbook,
      sourceType,
      localPath,
      sql,
      historyId: typeof historyId === "string" ? historyId : undefined,
    });

    return NextResponse.json({ meta });
  } catch (err) {
    return apiError("/api/vizs/save", err, "Save failed");
  }
}

/** If csvId has a workbook manifest, gather all sheet CSVs for persistence. */
async function buildSavedWorkbook(csvId: string): Promise<SavedWorkbook | undefined> {
  const manifest = getWorkbookManifest(csvId);
  if (!manifest) return undefined;

  const sheets: SavedWorkbook["sheets"] = [];
  for (const sheet of manifest.sheets) {
    const content = await getCSVContent(sheet.csvId);
    if (content) {
      sheets.push({ name: sheet.name, csvContent: content });
    }
  }

  if (sheets.length === 0) return undefined;

  // Build SheetInfo from manifest schemas for the UI preview
  const sheetInfo = manifest.sheets.map((s) => {
    const headers = s.schema.columns.map((c) => c.name);
    return {
      name: s.name,
      rowCount: s.schema.row_count,
      columnCount: s.schema.columns.length,
      headers,
      sampleRows: s.schema.sample_rows
        ? s.schema.sample_rows
            .slice(0, 5)
            .map((row: Record<string, unknown>) => headers.map((h) => String(row[h] ?? "")))
        : undefined,
    };
  });

  return {
    filename: manifest.sheets[0]?.schema.filename.replace(/ \(.*\)$/, "") ?? "workbook.xlsx",
    sheets,
    sheetInfo,
    relationships: manifest.relationships,
  };
}
