import { NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { parseCSV, toCSVText } from "@/lib/csv/parser";
import { extractSchema } from "@/lib/csv/schema";
import { storeCSV } from "@/lib/csv/storage";
import { parseExcelMeta, sheetToCSV } from "@/lib/excel/parser";
import { getExcelBuffer, getStoredExcel } from "@/lib/excel/storage";

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

    const { workbook } = await parseExcelMeta(buffer);
    const csvText = sheetToCSV(workbook, sheet_name);
    const parsed = parseCSV(csvText);

    if (parsed.headers.length === 0) {
      return NextResponse.json({ error: "Selected sheet has no columns" }, { status: 400 });
    }

    if (parsed.rowCount === 0) {
      return NextResponse.json({ error: "Selected sheet has no data rows" }, { status: 400 });
    }

    const csvId = uuidv4();
    const displayName = `${stored.filename} (${sheet_name})`;
    const schema = extractSchema(parsed, csvId, displayName);
    await storeCSV(csvId, toCSVText(parsed), schema);

    return NextResponse.json({ csv_id: csvId, schema });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Sheet selection failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
