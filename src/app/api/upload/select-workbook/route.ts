import { NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { parseCSV, toCSVText } from "@/lib/csv/parser";
import { extractSchema } from "@/lib/csv/schema";
import { storeCSV, storeWorkbookManifest } from "@/lib/csv/storage";
import { parseExcelMeta, sheetToCSV } from "@/lib/excel/parser";
import { getExcelBuffer, getStoredExcel } from "@/lib/excel/storage";
import { detectRelationships } from "@/lib/excel/relationships";
import { sanitizeSheetName } from "@/lib/llm/prompts";
import { DEFAULT_SANDBOX_RUNTIME } from "@/lib/constants";
import { prepareWarmSandbox } from "@/lib/sandbox";
import type { AdditionalFile } from "@/lib/sandbox";
import type { WorkbookManifest } from "@/lib/types";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { excel_id } = body;

    if (!excel_id) {
      return NextResponse.json({ error: "Missing excel_id" }, { status: 400 });
    }

    const stored = getStoredExcel(excel_id);
    if (!stored) {
      return NextResponse.json(
        { error: "Excel file not found or expired. Please re-upload." },
        { status: 404 }
      );
    }

    const buffer = await getExcelBuffer(excel_id);
    if (!buffer) {
      return NextResponse.json(
        { error: "Excel file not found or expired. Please re-upload." },
        { status: 404 }
      );
    }

    const { sheets, workbook } = await parseExcelMeta(buffer);
    const relationships = detectRelationships(sheets);

    // Convert each sheet to CSV, parse, and store
    const manifestSheets: WorkbookManifest["sheets"] = [];
    let primaryCsvId: string | null = null;
    let primaryCsvContent: string | null = null;
    const additionalFiles: AdditionalFile[] = [];

    for (const sheet of sheets) {
      let csvText: string;
      try {
        csvText = sheetToCSV(workbook, sheet.name);
      } catch {
        continue; // skip empty sheets
      }

      const parsed = parseCSV(csvText);
      if (parsed.headers.length === 0 || parsed.rowCount === 0) continue;

      const csvId = uuidv4();
      const displayName = `${stored.filename} (${sheet.name})`;
      const schema = extractSchema(parsed, csvId, displayName);
      const csvContent = toCSVText(parsed);
      await storeCSV(csvId, csvContent, schema);

      manifestSheets.push({ name: sheet.name, csvId, schema });

      if (!primaryCsvId) {
        primaryCsvId = csvId;
        primaryCsvContent = csvContent;
      } else {
        // Non-primary sheets become additional files
        const safeName = sanitizeSheetName(sheet.name);
        additionalFiles.push({ path: `/data/sheets/${safeName}.csv`, content: csvContent });
      }
    }

    if (!primaryCsvId || !primaryCsvContent || manifestSheets.length === 0) {
      return NextResponse.json({ error: "No valid sheets found in workbook" }, { status: 400 });
    }

    // Store workbook manifest keyed by primary csvId
    const manifest: WorkbookManifest = {
      sheets: manifestSheets,
      relationships,
    };
    storeWorkbookManifest(primaryCsvId, manifest);

    // Pre-load all sheets into warm sandbox
    prepareWarmSandbox(
      primaryCsvId,
      primaryCsvContent,
      DEFAULT_SANDBOX_RUNTIME,
      null,
      additionalFiles.length > 0 ? additionalFiles : undefined
    );

    // Return the primary sheet's csvId and schema
    const primarySheet = manifestSheets[0];
    return NextResponse.json({
      csv_id: primaryCsvId,
      schema: primarySheet.schema,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Workbook selection failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
