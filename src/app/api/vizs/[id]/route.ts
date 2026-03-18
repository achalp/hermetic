import { NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { loadSavedVisualization, deleteSavedVisualization } from "@/lib/saved/storage";
import type { SavedWorkbook } from "@/lib/saved/storage";
import { parseCSV, toCSVText } from "@/lib/csv/parser";
import { extractSchema } from "@/lib/csv/schema";
import { storeCSV, storeWorkbookManifest } from "@/lib/csv/storage";
import { sanitizeSheetName } from "@/lib/llm/prompts";
import { prepareWarmSandbox } from "@/lib/sandbox";
import type { AdditionalFile } from "@/lib/sandbox";
import { getActiveSandboxRuntime } from "@/lib/runtime-config";
import type { WorkbookManifest, SheetInfo, SheetRelationship } from "@/lib/types";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const viz = await loadSavedVisualization(id);

    // Parse and store the primary CSV in the in-memory store so it's ready for queries.
    const parsed = parseCSV(viz.csvContent);
    const csvId = uuidv4();
    const schema = extractSchema(parsed, csvId, viz.meta.csvFilename);
    const normalizedCsv = toCSVText(parsed);
    await storeCSV(csvId, normalizedCsv, schema);

    // Restore workbook state if this was a multi-sheet viz
    let workbookInfo:
      | { filename: string; sheetInfo: SheetInfo[]; relationships: SheetRelationship[] }
      | undefined;
    if (viz.workbook) {
      workbookInfo = await restoreWorkbook(csvId, normalizedCsv, viz.workbook);
    } else {
      prepareWarmSandbox(csvId, normalizedCsv, getActiveSandboxRuntime());
    }

    return NextResponse.json({
      meta: viz.meta,
      spec: viz.spec,
      artifacts: viz.artifacts,
      csvId,
      schema,
      workbook: workbookInfo,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Not found";
    return NextResponse.json({ error: message }, { status: 404 });
  }
}

/** Restore all workbook sheets into the in-memory store and rebuild the manifest. */
async function restoreWorkbook(
  primaryCsvId: string,
  primaryCsvContent: string,
  wb: SavedWorkbook
): Promise<{ filename: string; sheetInfo: SheetInfo[]; relationships: SheetRelationship[] }> {
  const manifestSheets: WorkbookManifest["sheets"] = [];
  const additionalFiles: AdditionalFile[] = [];
  const enrichedSheetInfo: SheetInfo[] = [];
  let isFirst = true;

  for (const sheet of wb.sheets) {
    const sheetParsed = parseCSV(sheet.csvContent);
    const sheetCsvId = isFirst ? primaryCsvId : uuidv4();
    const displayName = `${wb.filename} (${sheet.name})`;
    const sheetSchema = extractSchema(sheetParsed, sheetCsvId, displayName);
    const sheetCsv = isFirst ? primaryCsvContent : toCSVText(sheetParsed);

    if (!isFirst) {
      await storeCSV(sheetCsvId, sheetCsv, sheetSchema);
      const safeName = sanitizeSheetName(sheet.name);
      additionalFiles.push({ path: `/data/sheets/${safeName}.csv`, content: sheetCsv });
    }

    manifestSheets.push({ name: sheet.name, csvId: sheetCsvId, schema: sheetSchema });

    // Reconstruct sampleRows from parsed CSV data for the workbook preview
    const headers = sheetSchema.columns.map((c) => c.name);
    const sampleRows = sheetParsed.data
      .slice(0, 5)
      .map((row: Record<string, unknown>) => headers.map((h) => String(row[h] ?? "")));
    enrichedSheetInfo.push({
      name: sheet.name,
      rowCount: sheetSchema.row_count,
      columnCount: sheetSchema.columns.length,
      headers,
      sampleRows,
    });

    isFirst = false;
  }

  const manifest: WorkbookManifest = {
    sheets: manifestSheets,
    relationships: wb.relationships,
  };
  storeWorkbookManifest(primaryCsvId, manifest);

  // Warm sandbox with all sheets
  prepareWarmSandbox(
    primaryCsvId,
    primaryCsvContent,
    getActiveSandboxRuntime(),
    null,
    additionalFiles.length > 0 ? additionalFiles : undefined
  );

  return {
    filename: wb.filename,
    sheetInfo: enrichedSheetInfo,
    relationships: wb.relationships,
  };
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await deleteSavedVisualization(id);
    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Delete failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
