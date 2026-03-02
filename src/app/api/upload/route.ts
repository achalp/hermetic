import { NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { parseCSV, toCSVText } from "@/lib/csv/parser";
import { extractSchema } from "@/lib/csv/schema";
import { storeCSV } from "@/lib/csv/storage";
import { parseExcelMeta, sheetToCSV } from "@/lib/excel/parser";
import { storeExcel } from "@/lib/excel/storage";
import { MAX_CSV_SIZE_BYTES, MAX_CSV_SIZE_LABEL } from "@/lib/constants";

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("csv") as File | null;

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const name = file.name.toLowerCase();
    const isCSV = name.endsWith(".csv");
    const isExcel = name.endsWith(".xlsx");

    if (!isCSV && !isExcel) {
      return NextResponse.json(
        { error: "Only .csv and .xlsx files are accepted" },
        { status: 400 }
      );
    }

    if (file.size > MAX_CSV_SIZE_BYTES) {
      return NextResponse.json(
        { error: `File too large. Maximum size is ${MAX_CSV_SIZE_LABEL}.` },
        { status: 400 }
      );
    }

    // ── CSV path (unchanged) ──────────────────────────────────────
    if (isCSV) {
      const text = await file.text();
      const parsed = parseCSV(text);

      if (parsed.headers.length === 0) {
        return NextResponse.json({ error: "CSV file has no columns" }, { status: 400 });
      }

      if (parsed.rowCount === 0) {
        return NextResponse.json({ error: "CSV file has no data rows" }, { status: 400 });
      }

      const csvId = uuidv4();
      const schema = extractSchema(parsed, csvId, file.name);
      await storeCSV(csvId, toCSVText(parsed), schema);

      return NextResponse.json({ csv_id: csvId, schema });
    }

    // ── Excel path ────────────────────────────────────────────────
    const buffer = Buffer.from(await file.arrayBuffer());
    const { sheets, workbook } = await parseExcelMeta(buffer);

    if (sheets.length === 0) {
      return NextResponse.json({ error: "Excel file has no sheets" }, { status: 400 });
    }

    // Single sheet: auto-convert to CSV
    if (sheets.length === 1) {
      const csvText = sheetToCSV(workbook, sheets[0].name);
      const parsed = parseCSV(csvText);

      if (parsed.headers.length === 0) {
        return NextResponse.json({ error: "Sheet has no columns" }, { status: 400 });
      }

      if (parsed.rowCount === 0) {
        return NextResponse.json({ error: "Sheet has no data rows" }, { status: 400 });
      }

      const csvId = uuidv4();
      const schema = extractSchema(parsed, csvId, file.name);
      await storeCSV(csvId, toCSVText(parsed), schema);

      return NextResponse.json({ csv_id: csvId, schema });
    }

    // Multiple sheets: return metadata for sheet picker
    const excelId = uuidv4();
    await storeExcel(excelId, buffer, file.name);

    return NextResponse.json({
      excel_id: excelId,
      sheets,
      filename: file.name,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Upload failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
