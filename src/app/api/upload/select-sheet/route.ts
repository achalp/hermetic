import { NextResponse } from "next/server";
import { apiError } from "@/app/lib/api-error";
import { getExcelBuffer, getStoredExcel } from "@/lib/excel/storage";
import { ingestFile, IngestError } from "@/lib/sources/ingest";

/** Map shared-ingest error codes back onto this route's legacy wire messages. */
function sheetErrorMessage(err: IngestError): string {
  switch (err.code) {
    case "empty_columns":
      return "Selected sheet has no columns";
    case "empty_rows":
      return "Selected sheet has no data rows";
    default:
      // e.g. sheet_not_found — the shared message names the valid sheets.
      return err.message;
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { excel_id, sheet_name } = body;

    if (!excel_id || !sheet_name) {
      return NextResponse.json({ error: "Missing excel_id or sheet_name" }, { status: 400 });
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

    // Sheet extraction is the shared pipeline (lib/sources/ingest); an
    // explicit `sheet` yields the "<file> (<sheet>)" display name this route
    // has always produced.
    let result;
    try {
      result = await ingestFile(
        { buffer, filename: stored.filename, sheet: sheet_name },
        { warmSandbox: true }
      );
    } catch (err) {
      if (err instanceof IngestError) {
        return NextResponse.json({ error: sheetErrorMessage(err) }, { status: 400 });
      }
      throw err;
    }

    if (result.kind !== "dataset") {
      // Unreachable — an explicit sheet never yields the picker.
      return NextResponse.json({ error: "Missing excel_id or sheet_name" }, { status: 400 });
    }

    return NextResponse.json({ csv_id: result.csvId, schema: result.schema });
  } catch (err) {
    return apiError("/api/upload/select-sheet", err, "Sheet selection failed");
  }
}
