import { NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { parseCSV, toCSVText } from "@/lib/csv/parser";
import { extractSchema } from "@/lib/csv/schema";
import { storeCSV, storeGeoJSON } from "@/lib/csv/storage";
import { parseExcelMeta, sheetToCSV } from "@/lib/excel/parser";
import { storeExcel } from "@/lib/excel/storage";
import { detectRelationships } from "@/lib/excel/relationships";
import { parseGeoJSON, isGeoJSONObject } from "@/lib/geojson/parser";
import { MAX_CSV_SIZE_BYTES, MAX_CSV_SIZE_LABEL, DEFAULT_SANDBOX_RUNTIME } from "@/lib/constants";
import { prepareWarmSandbox } from "@/lib/sandbox";

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
    const isGeoJSONExt = name.endsWith(".geojson");
    const isJSON = name.endsWith(".json");

    if (!isCSV && !isExcel && !isGeoJSONExt && !isJSON) {
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

    // ── GeoJSON path ─────────────────────────────────────────────
    // For .json files, peek at the content to check if it's GeoJSON
    let isGeoJSON = isGeoJSONExt;
    let prefetchedText: string | null = null;
    if (isJSON) {
      prefetchedText = await file.text();
      try {
        isGeoJSON = isGeoJSONObject(JSON.parse(prefetchedText));
      } catch {
        isGeoJSON = false;
      }
    }

    if (isGeoJSON) {
      const text = prefetchedText ?? (await file.text());
      const parsed = parseGeoJSON(text);

      if (parsed.headers.length === 0) {
        return NextResponse.json({ error: "GeoJSON file has no properties" }, { status: 400 });
      }

      const csvId = uuidv4();
      const schema = extractSchema(parsed, csvId, file.name);
      schema.has_geojson = true;
      schema.geojson_geometry_type = parsed.geometryType;

      const csvText = toCSVText(parsed);
      await storeCSV(csvId, csvText, schema);
      await storeGeoJSON(csvId, text);
      prepareWarmSandbox(csvId, csvText, DEFAULT_SANDBOX_RUNTIME, text);

      return NextResponse.json({ csv_id: csvId, schema });
    }

    // If it's a .json file that isn't GeoJSON, reject it
    if (isJSON) {
      return NextResponse.json(
        {
          error:
            "JSON file is not valid GeoJSON. Only .csv, .xlsx, and .geojson files are accepted.",
        },
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
      const csvText2 = toCSVText(parsed);
      await storeCSV(csvId, csvText2, schema);
      prepareWarmSandbox(csvId, csvText2, DEFAULT_SANDBOX_RUNTIME);

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
      const csvText3 = toCSVText(parsed);
      await storeCSV(csvId, csvText3, schema);
      prepareWarmSandbox(csvId, csvText3, DEFAULT_SANDBOX_RUNTIME);

      return NextResponse.json({ csv_id: csvId, schema });
    }

    // Multiple sheets: return metadata for sheet picker
    const excelId = uuidv4();
    await storeExcel(excelId, buffer, file.name);

    const relationships = detectRelationships(sheets);

    return NextResponse.json({
      excel_id: excelId,
      sheets,
      filename: file.name,
      relationships,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Upload failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
