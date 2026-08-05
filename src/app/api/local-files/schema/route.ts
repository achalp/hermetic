import { NextResponse } from "next/server";
import { apiError } from "@/app/lib/api-error";
import { stat } from "node:fs/promises";
import { resolve, basename, extname } from "node:path";
import {
  validateLocalOrigin,
  isAllowedExtension,
  isPathAllowed,
  PATH_NOT_ALLOWED_ERROR,
} from "@/lib/local-files/security";
import { parseBody, LocalFileSelectSchema } from "@/lib/api-schemas";
import { ingestFile, IngestError } from "@/lib/sources/ingest";

/** Map shared-ingest error codes back onto this route's legacy wire messages. */
function localErrorMessage(err: IngestError, ext: string): string {
  switch (err.code) {
    case "empty_columns":
      return ext === ".xlsx" ? "Sheet has no columns" : "CSV file has no columns";
    case "empty_rows":
      return ext === ".xlsx" ? "Sheet has no data rows" : "CSV file has no data rows";
    case "invalid_json":
    case "not_geojson":
      return "JSON file is not valid GeoJSON";
    case "geojson_no_properties":
      return "GeoJSON file has no properties";
    case "no_sheets":
      return "Excel file has no sheets";
    case "unsupported_type":
      return `Unsupported file type: ${ext}`;
    default:
      // e.g. too_large — the shared message is already actionable.
      return err.message;
  }
}

export async function POST(request: Request) {
  if (!validateLocalOrigin(request)) {
    return NextResponse.json({ error: "Local access only" }, { status: 403 });
  }

  try {
    const parsed = parseBody(LocalFileSelectSchema, await request.json());
    if (!parsed.ok) return parsed.response;
    const { path: rawPath, type } = parsed.data;

    const filePath = resolve(rawPath);

    // Root-jail — see lib/local-files/security.ts isPathAllowed.
    if (!isPathAllowed(filePath)) {
      return NextResponse.json({ error: PATH_NOT_ALLOWED_ERROR }, { status: 403 });
    }
    const fileInfo = await stat(filePath);
    const filename = basename(filePath);
    const ext = extname(filePath).toLowerCase();

    if (type === "folder") {
      if (!fileInfo.isDirectory()) {
        return NextResponse.json({ error: "Expected a directory" }, { status: 400 });
      }
    } else {
      if (!fileInfo.isFile()) {
        return NextResponse.json({ error: "Expected a file" }, { status: 400 });
      }
      if (!isAllowedExtension(filename)) {
        return NextResponse.json({ error: `File type not supported: ${ext}` }, { status: 400 });
      }
    }

    // Past the security checks, everything is the shared pipeline
    // (lib/sources/ingest): Parquet file/folder refs (Hive auto-detected),
    // CSV with its bind-mount ref attached at store time (previously patched
    // onto the stored entry post-hoc), GeoJSON stamping, and the Excel
    // single-sheet/picker split — plus warm-sandbox prep and Recents.
    let result;
    try {
      result = await ingestFile(
        { path: filePath },
        { warmSandbox: true, recordRecent: true, storeExcelForPicker: true, attachLocalRef: true }
      );
    } catch (err) {
      if (err instanceof IngestError) {
        return NextResponse.json({ error: localErrorMessage(err, ext) }, { status: 400 });
      }
      throw err;
    }

    // Multiple sheets: return metadata for the sheet picker.
    if (result.kind === "sheet_picker") {
      return NextResponse.json({
        excel_id: result.excelId,
        sheets: result.sheets,
        filename: result.filename,
        relationships: result.relationships,
      });
    }

    return NextResponse.json({ csv_id: result.csvId, schema: result.schema });
  } catch (err) {
    return apiError("/api/local-files/schema", err, "Failed to extract schema");
  }
}
