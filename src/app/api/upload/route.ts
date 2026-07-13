import { NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { apiError } from "@/lib/api-error";
import { parseCSV, toCSVText } from "@/lib/csv/parser";
import { extractSchema } from "@/lib/csv/schema";
import { storeCSV, storeGeoJSON, storeLocalFileRef } from "@/lib/csv/storage";
import { parseExcelMeta, sheetToCSV } from "@/lib/excel/parser";
import { storeExcel } from "@/lib/excel/storage";
import { detectRelationships } from "@/lib/excel/relationships";
import { parseGeoJSON, isGeoJSONObject } from "@/lib/geojson/parser";
import {
  MAX_CSV_SIZE_BYTES,
  MAX_CSV_SIZE_LABEL,
  PARQUET_MATERIALIZE_THRESHOLD,
} from "@/lib/constants";
import { prepareWarmSandbox } from "@/lib/sandbox";
import { getActiveSandboxRuntime } from "@/lib/runtime-config";
import { materializeCsvToParquet } from "@/lib/parquet/materialize";
import { recordRecentSource } from "@/lib/sources/recent-sources";
import { logger } from "@/lib/logger";

/** Cheap row estimate (count newlines, no parse) to choose Parquet vs CSV. */
function countCsvRows(csv: string): number {
  let rows = 0;
  let i = csv.indexOf("\n");
  while (i !== -1) {
    rows++;
    i = csv.indexOf("\n", i + 1);
  }
  return Math.max(0, rows - 1);
}

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

    // Remember the upload — persist its bytes into the managed store so a
    // drag-dropped file re-opens in one click later (see recent-sources.ts).
    const rememberUpload = (rows: number | undefined, bytes: Buffer | string) =>
      recordRecentSource({
        kind: "upload",
        name: file.name,
        subtitle: "Uploaded file",
        rows,
        bytes,
        filename: file.name,
      }).catch(() => {});

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
      prepareWarmSandbox(csvId, csvText, getActiveSandboxRuntime(), text);

      rememberUpload(schema.row_count, text);
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

    // ── CSV path ──────────────────────────────────────────────────
    if (isCSV) {
      const text = await file.text();

      // Large CSV → materialize to Parquet + DuckDB schema (no Node parse) and
      // analyze it via the bind-mounted local-files path, so it scales past the
      // pandas-era cap. Best-effort: any failure falls back to the CSV path.
      const csvId = uuidv4();
      if (
        countCsvRows(text) >= PARQUET_MATERIALIZE_THRESHOLD &&
        getActiveSandboxRuntime() === "docker"
      ) {
        try {
          const { parquetPath, schema } = await materializeCsvToParquet(
            text,
            csvId,
            file.name,
            "docker"
          );
          storeLocalFileRef(csvId, schema, parquetPath, Date.now(), false);
          logger.info("Upload: materialized large CSV to Parquet", {
            csvId,
            rows: schema.row_count,
          });
          rememberUpload(schema.row_count, text);
          return NextResponse.json({ csv_id: csvId, schema });
        } catch (err) {
          logger.warn("Upload: Parquet materialization failed, falling back to CSV", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const parsed = parseCSV(text);
      if (parsed.headers.length === 0) {
        return NextResponse.json({ error: "CSV file has no columns" }, { status: 400 });
      }
      if (parsed.rowCount === 0) {
        return NextResponse.json({ error: "CSV file has no data rows" }, { status: 400 });
      }

      const schema = extractSchema(parsed, csvId, file.name);
      const csvText2 = toCSVText(parsed);
      await storeCSV(csvId, csvText2, schema);
      prepareWarmSandbox(csvId, csvText2, getActiveSandboxRuntime());

      rememberUpload(schema.row_count, text);
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
      prepareWarmSandbox(csvId, csvText3, getActiveSandboxRuntime());

      rememberUpload(schema.row_count, buffer);
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
    return apiError("/api/upload", err, "Upload failed");
  }
}
