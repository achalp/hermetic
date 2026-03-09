import { NextResponse } from "next/server";
import { getCachedCode } from "@/lib/pipeline/code-cache";
import { getCachedArtifacts } from "@/lib/pipeline/artifacts-cache";
import { getStoredCSV, getCSVContent, getWorkbookManifest } from "@/lib/csv/storage";
import { saveVisualization, saveNewVersion } from "@/lib/saved/storage";
import type { SavedWorkbook } from "@/lib/saved/storage";
import { schemaFingerprint } from "@/lib/saved/schema-compat";

export async function POST(request: Request) {
  try {
    const { csvId, spec, question, parentVizId } = await request.json();

    if (!csvId || !spec || !question) {
      return NextResponse.json(
        { error: "csvId, spec, and question are required" },
        { status: 400 }
      );
    }

    // Look up cached code
    const cached = getCachedCode(csvId);
    if (!cached) {
      return NextResponse.json(
        {
          error:
            "Generated code not found in cache. It may have expired — please re-run the query.",
        },
        { status: 404 }
      );
    }

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
    const fingerprint = schemaFingerprint(stored.schema);

    // Check for workbook manifest — if present, persist all sheets
    const workbook = await buildSavedWorkbook(csvId);

    // If parentVizId is set, save as a new version of that viz
    if (parentVizId) {
      const meta = await saveNewVersion(parentVizId, {
        csvFilename: stored.schema.filename,
        csvContent,
        generatedCode: cached.code,
        spec,
        artifacts: artifacts ?? undefined,
        schemaFingerprint: fingerprint,
      });
      return NextResponse.json({ meta });
    }

    const meta = await saveVisualization({
      question,
      csvFilename: stored.schema.filename,
      csvContent,
      generatedCode: cached.code,
      spec,
      artifacts: artifacts ?? undefined,
      schemaFingerprint: fingerprint,
      workbook,
    });

    return NextResponse.json({ meta });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Save failed";
    return NextResponse.json({ error: message }, { status: 500 });
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
