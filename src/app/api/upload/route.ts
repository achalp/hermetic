import { NextResponse } from "next/server";
import { apiError } from "@/app/lib/api-error";
import { ingestFile, IngestError } from "@/lib/sources/ingest";
import { MAX_CSV_SIZE_BYTES, MAX_CSV_SIZE_LABEL } from "@/lib/constants";

/**
 * Map shared-ingest error codes back onto this route's legacy wire messages
 * — the response shape (and text) predates the shared pipeline and clients
 * key off it.
 */
function uploadErrorMessage(err: IngestError, isExcel: boolean): string {
  switch (err.code) {
    case "empty_columns":
      return isExcel ? "Sheet has no columns" : "CSV file has no columns";
    case "empty_rows":
      return isExcel ? "Sheet has no data rows" : "CSV file has no data rows";
    case "invalid_json":
    case "not_geojson":
      return "JSON file is not valid GeoJSON. Only .csv, .xlsx, and .geojson files are accepted.";
    case "geojson_no_properties":
      return "GeoJSON file has no properties";
    case "no_sheets":
      return "Excel file has no sheets";
    default:
      return err.message;
  }
}

export async function POST(request: Request) {
  try {
    // Reject an oversized upload BEFORE formData() buffers the entire body into
    // memory (App Router route handlers have no default body cap, so a multi-GB
    // POST OOMs the process before the file.size check below runs). Content-
    // Length carries multipart framing, so allow a small margin over the cap.
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_CSV_SIZE_BYTES + 1024 * 1024) {
      return NextResponse.json(
        { error: `File too large. Maximum size is ${MAX_CSV_SIZE_LABEL}.` },
        { status: 413 }
      );
    }
    const formData = await request.formData();
    const file = formData.get("csv") as File | null;

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const name = file.name.toLowerCase();
    const isExcel = name.endsWith(".xlsx");
    const known =
      name.endsWith(".csv") || isExcel || name.endsWith(".geojson") || name.endsWith(".json");

    if (!known) {
      return NextResponse.json(
        { error: "Only .csv, .xlsx, .geojson, and .json files are accepted" },
        { status: 400 }
      );
    }

    if (file.size > MAX_CSV_SIZE_BYTES) {
      return NextResponse.json(
        { error: `File too large. Maximum size is ${MAX_CSV_SIZE_LABEL}.` },
        { status: 400 }
      );
    }

    // FormData handling stays here; everything from extension dispatch to
    // storage — GeoJSON peek, large-CSV Parquet materialization, warm-sandbox
    // prep, Recents recording — is the shared pipeline (lib/sources/ingest).
    const input = isExcel
      ? { buffer: Buffer.from(await file.arrayBuffer()), filename: file.name }
      : { text: await file.text(), filename: file.name };

    let result;
    try {
      result = await ingestFile(input, {
        materializeLargeCsv: true,
        warmSandbox: true,
        recordRecent: true,
        storeExcelForPicker: true,
      });
    } catch (err) {
      if (err instanceof IngestError) {
        return NextResponse.json({ error: uploadErrorMessage(err, isExcel) }, { status: 400 });
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
    return apiError("/api/upload", err, "Upload failed");
  }
}
