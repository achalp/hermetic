import { NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { stat, readFile } from "node:fs/promises";
import { resolve, basename, extname } from "node:path";
import { validateLocalOrigin, isAllowedExtension } from "@/lib/local-files/security";
import { parseBody, LocalFileSelectSchema } from "@/lib/api-schemas";
import { getFileInfo } from "@/lib/local-files/browser";
import { extractParquetSchema } from "@/lib/parquet/schema-extractor";
import { parseCSV, toCSVText } from "@/lib/csv/parser";
import { extractSchema } from "@/lib/csv/schema";
import { storeCSV, storeLocalFileRef } from "@/lib/csv/storage";
import { parseExcelMeta, sheetToCSV } from "@/lib/excel/parser";
import { storeExcel } from "@/lib/excel/storage";
import { detectRelationships } from "@/lib/excel/relationships";
import { parseGeoJSON, isGeoJSONObject } from "@/lib/geojson/parser";
import { getActiveSandboxRuntime } from "@/lib/runtime-config";
import { prepareWarmSandbox } from "@/lib/sandbox";

export async function POST(request: Request) {
  if (!validateLocalOrigin(request)) {
    return NextResponse.json({ error: "Local access only" }, { status: 403 });
  }

  try {
    const parsed = parseBody(LocalFileSelectSchema, await request.json());
    if (!parsed.ok) return parsed.response;
    const { path: rawPath, type } = parsed.data;

    const filePath = resolve(rawPath);
    const fileInfo = await stat(filePath);
    const filename = basename(filePath);
    const ext = extname(filePath).toLowerCase();
    const runtime = getActiveSandboxRuntime();
    const csvId = uuidv4();

    // ── Parquet folder ─────────────────────────────────────────
    if (type === "folder") {
      if (!fileInfo.isDirectory()) {
        return NextResponse.json({ error: "Expected a directory" }, { status: 400 });
      }

      // Detect Hive partitioning (subdirs like year=2024/month=1/)
      const folderInfo = await getFileInfo(filePath);
      const isHive = folderInfo.isHivePartitioned ?? false;

      const schema = await extractParquetSchema(filePath, csvId, filename, true, runtime, isHive);

      storeLocalFileRef(csvId, schema, filePath, fileInfo.mtimeMs, true, isHive);

      return NextResponse.json({ csv_id: csvId, schema });
    }

    // ── Single file ────────────────────────────────────────────
    if (!fileInfo.isFile()) {
      return NextResponse.json({ error: "Expected a file" }, { status: 400 });
    }

    if (!isAllowedExtension(filename)) {
      return NextResponse.json({ error: `File type not supported: ${ext}` }, { status: 400 });
    }

    // ── Parquet file ─────────────────────────────────────────
    if (ext === ".parquet") {
      const schema = await extractParquetSchema(filePath, csvId, filename, false, runtime);

      storeLocalFileRef(csvId, schema, filePath, fileInfo.mtimeMs, false);

      return NextResponse.json({ csv_id: csvId, schema });
    }

    // ── CSV file ─────────────────────────────────────────────
    if (ext === ".csv") {
      const text = await readFile(filePath, "utf-8");
      const parsed = parseCSV(text);

      if (parsed.headers.length === 0) {
        return NextResponse.json({ error: "CSV file has no columns" }, { status: 400 });
      }
      if (parsed.rowCount === 0) {
        return NextResponse.json({ error: "CSV file has no data rows" }, { status: 400 });
      }

      const schema = extractSchema(parsed, csvId, filename);
      const csvText = toCSVText(parsed);
      await storeCSV(csvId, csvText, schema);

      // Also store local path for bind-mount execution
      const stored = (await import("@/lib/csv/storage")).getStoredCSV(csvId);
      if (stored) {
        stored.localPath = filePath;
        stored.localMtime = fileInfo.mtimeMs;
      }

      prepareWarmSandbox(csvId, csvText, runtime);
      return NextResponse.json({ csv_id: csvId, schema });
    }

    // ── GeoJSON / JSON file ──────────────────────────────────
    if (ext === ".geojson" || ext === ".json") {
      const text = await readFile(filePath, "utf-8");

      let isGeoJSON = ext === ".geojson";
      if (ext === ".json") {
        try {
          isGeoJSON = isGeoJSONObject(JSON.parse(text));
        } catch {
          isGeoJSON = false;
        }
      }

      if (!isGeoJSON) {
        return NextResponse.json({ error: "JSON file is not valid GeoJSON" }, { status: 400 });
      }

      const parsed = parseGeoJSON(text);
      if (parsed.headers.length === 0) {
        return NextResponse.json({ error: "GeoJSON file has no properties" }, { status: 400 });
      }

      const schema = extractSchema(parsed, csvId, filename);
      schema.has_geojson = true;
      schema.geojson_geometry_type = parsed.geometryType;

      const csvText = toCSVText(parsed);
      await storeCSV(csvId, csvText, schema);
      const { storeGeoJSON } = await import("@/lib/csv/storage");
      await storeGeoJSON(csvId, text);

      prepareWarmSandbox(csvId, csvText, runtime, text);
      return NextResponse.json({ csv_id: csvId, schema });
    }

    // ── Excel file ───────────────────────────────────────────
    if (ext === ".xlsx") {
      const buffer = await readFile(filePath);
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

        const schema = extractSchema(parsed, csvId, filename);
        const csvText2 = toCSVText(parsed);
        await storeCSV(csvId, csvText2, schema);
        prepareWarmSandbox(csvId, csvText2, runtime);
        return NextResponse.json({ csv_id: csvId, schema });
      }

      // Multiple sheets: return metadata for sheet picker
      const excelId = uuidv4();
      await storeExcel(excelId, buffer, filename);
      const relationships = detectRelationships(sheets);

      return NextResponse.json({
        excel_id: excelId,
        sheets,
        filename,
        relationships,
      });
    }

    return NextResponse.json({ error: `Unsupported file type: ${ext}` }, { status: 400 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to extract schema";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
