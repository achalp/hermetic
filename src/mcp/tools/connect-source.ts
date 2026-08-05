/**
 * connect_source — attach a data source and return a source_id + schema
 * summary (mcp-server spec §3, pillar: boundary).
 *
 * One of:
 *   path          — local CSV, Excel (.xlsx), GeoJSON (.geojson/.json),
 *                   Parquet file, or Parquet folder (Hive partitioning
 *                   auto-detected). Excel with multiple sheets returns the
 *                   sheet list; re-call with `sheet` to pick one.
 *   url           — cloud Parquet (s3://, https://, gs://): file, folder, or
 *                   Hive-partitioned prefix, read over the network by DuckDB.
 *   connection_id — saved warehouse connection (created in the hermetic app).
 *
 * The response never carries credentials, raw rows, or file contents — only
 * the id, label, and the same schema summary get_schema returns.
 *
 * Credentials are NEVER tool arguments (a secret passed as an arg transits
 * the host model's context): cloud buckets authenticate via the MCP server's
 * own environment (AWS_REGION / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY /
 * AWS_ENDPOINT_URL in the host's mcpServers env block); warehouses via
 * connections saved once in the web app. That policy is also why there is no
 * "new warehouse connection" input here.
 */
import { readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { McpDeps } from "../deps";
import { registerSource, type McpSource } from "../sources";
import { summarizeSource } from "./get-schema";
import type { RemoteCreds } from "@/lib/contracts/storage-types";
import type { CSVSchema } from "@/lib/contracts/data-schema";

export const connectSourceInput = {
  path: z
    .string()
    .optional()
    .describe(
      "Path to a local data file or Parquet folder: .csv, .xlsx, .geojson/.json (GeoJSON), " +
        ".parquet, or a directory of Parquet files (Hive partitioning auto-detected)."
    ),
  url: z
    .string()
    .optional()
    .describe(
      "Cloud Parquet URL (s3://, https://, gs://): a file, folder, or Hive-partitioned " +
        "prefix. Read over the network — nothing is downloaded. Private buckets use the " +
        "server's AWS_* environment, never tool arguments."
    ),
  connection_id: z
    .string()
    .optional()
    .describe("Id of a saved warehouse connection (created in the hermetic app)."),
  sheet: z
    .string()
    .optional()
    .describe("For multi-sheet Excel files: the sheet to load. Omit to get the sheet list back."),
  label: z.string().optional().describe("Optional display label for the source."),
};

/** Refuse to slurp arbitrarily large text files into memory. */
const MAX_TEXT_BYTES = 200 * 1024 * 1024;

/** Private-bucket auth from the SERVER environment (never tool args). */
export function envRemoteCreds(env: NodeJS.ProcessEnv = process.env): RemoteCreds | undefined {
  const creds: RemoteCreds = {};
  if (env.AWS_REGION) creds.s3Region = env.AWS_REGION;
  if (env.AWS_ACCESS_KEY_ID) creds.s3AccessKeyId = env.AWS_ACCESS_KEY_ID;
  if (env.AWS_SECRET_ACCESS_KEY) creds.s3SecretAccessKey = env.AWS_SECRET_ACCESS_KEY;
  if (env.AWS_ENDPOINT_URL) creds.s3Endpoint = env.AWS_ENDPOINT_URL;
  return Object.keys(creds).length > 0 ? creds : undefined;
}

/** A human filename from a Parquet URL: the last path segment, or the host. */
function filenameFromUrl(url: string): string {
  try {
    const u = new URL(url.replace(/^s3:\/\//i, "https://").replace(/^gs:\/\//i, "https://"));
    return u.pathname.split("/").filter(Boolean).pop() || u.hostname;
  } catch {
    return url.split("/").filter(Boolean).pop() || url;
  }
}

function guardSize(abs: string): void {
  const size = statSync(abs).size;
  if (size > MAX_TEXT_BYTES) {
    throw new Error(
      `File is ${Math.round(size / (1024 * 1024))}MB — over the ${MAX_TEXT_BYTES / (1024 * 1024)}MB limit for ` +
        "in-memory formats. Convert to Parquet or use a warehouse connection."
    );
  }
}

async function connectUrl(deps: McpDeps, url: string, label?: string): Promise<McpSource> {
  if (!deps.isSafeParquetUrl(url)) {
    throw new Error(
      "Not a valid cloud Parquet URL — expected s3://, https://, or gs:// with no quotes " +
        "or shell characters."
    );
  }
  const { readUrl, isHivePartitioned } = deps.normalizeRemoteParquetUrl(url);
  const csvId = randomUUID();
  const filename = filenameFromUrl(url);
  const creds = envRemoteCreds();
  const schema = await deps.extractRemoteParquetSchema(
    readUrl,
    csvId,
    filename,
    deps.getActiveSandboxRuntime(),
    isHivePartitioned,
    creds
  );
  deps.storeRemoteParquetRef(csvId, schema, readUrl, creds, isHivePartitioned);
  return registerSource({
    kind: "csv",
    label: label ?? filename,
    csvId,
    schema,
    remote: true,
  });
}

async function connectCsvText(
  deps: McpDeps,
  csvText: string,
  filename: string,
  label: string | undefined,
  geojsonText?: string
): Promise<McpSource> {
  const parsed = deps.parseCSV(csvText);
  if (parsed.headers.length === 0) throw new Error(`${filename}: no columns found.`);
  if (parsed.rowCount === 0) throw new Error(`${filename}: no data rows.`);
  const csvId = randomUUID();
  const schema = deps.extractSchema(parsed, csvId, filename);
  if (geojsonText) {
    schema.has_geojson = true;
    schema.geojson_geometry_type = deps.parseGeoJSON(geojsonText).geometryType;
  }
  const normalized = deps.toCSVText(parsed);
  await deps.storeCSV(csvId, normalized, schema);
  if (geojsonText) await deps.storeGeoJSON(csvId, geojsonText);
  return registerSource({ kind: "csv", label: label ?? filename, csvId, schema });
}

async function connectParquetPath(
  deps: McpDeps,
  abs: string,
  isFolder: boolean,
  label?: string
): Promise<McpSource> {
  const info = await deps.getFileInfo(abs);
  const isHive = isFolder ? (info.isHivePartitioned ?? false) : undefined;
  const csvId = randomUUID();
  const schema = await deps.extractParquetSchema(
    abs,
    csvId,
    basename(abs),
    isFolder,
    deps.getActiveSandboxRuntime(),
    isHive
  );
  deps.storeLocalFileRef(csvId, schema, abs, info.mtime, isFolder, isHive);
  return registerSource({
    kind: "csv",
    label: label ?? basename(abs),
    csvId,
    schema,
    pathBased: true,
  });
}

interface ExcelSheetListing {
  needs_sheet: true;
  path: string;
  sheets: Array<{ name: string; row_count: number; column_count: number }>;
  hint: string;
}

async function connectExcel(
  deps: McpDeps,
  abs: string,
  sheet: string | undefined,
  label?: string
): Promise<McpSource | ExcelSheetListing> {
  guardSize(abs);
  const buffer = await readFile(abs);
  const { sheets, workbook } = await deps.parseExcelMeta(buffer);
  if (sheets.length === 0) throw new Error("Excel file has no sheets.");

  const pick = sheet ?? (sheets.length === 1 ? sheets[0].name : undefined);
  if (!pick) {
    return {
      needs_sheet: true,
      path: abs,
      sheets: sheets.map((sh) => ({
        name: sh.name,
        row_count: sh.rowCount,
        column_count: sh.columnCount,
      })),
      hint: "Multiple sheets — call connect_source again with the same path and a `sheet`.",
    };
  }
  if (!sheets.some((sh) => sh.name === pick)) {
    throw new Error(`No sheet named '${pick}'. Sheets: ${sheets.map((sh) => sh.name).join(", ")}`);
  }
  const csvText = deps.sheetToCSV(workbook, pick);
  const filename = `${basename(abs)} (${pick})`;
  return connectCsvText(deps, csvText, filename, label);
}

async function connectGeoJson(deps: McpDeps, abs: string, label?: string): Promise<McpSource> {
  guardSize(abs);
  const text = readFileSync(abs, "utf-8");
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch {
    throw new Error(`${basename(abs)}: not valid JSON.`);
  }
  if (!deps.isGeoJSONObject(parsedJson)) {
    throw new Error(`${basename(abs)}: JSON but not GeoJSON — only GeoJSON .json is supported.`);
  }
  const geo = deps.parseGeoJSON(text);
  if (geo.headers.length === 0) throw new Error(`${basename(abs)}: GeoJSON has no properties.`);
  const csvText = deps.toCSVText(geo);
  return connectCsvText(deps, csvText, basename(abs), label, text);
}

export async function connectSource(
  deps: McpDeps,
  args: { path?: string; url?: string; connection_id?: string; sheet?: string; label?: string }
): Promise<Record<string, unknown>> {
  const given = [args.path, args.url, args.connection_id].filter(Boolean).length;
  if (given !== 1) {
    throw new Error("Provide exactly one of `path`, `url`, or `connection_id`.");
  }

  if (args.sheet && !(args.path ?? "").toLowerCase().endsWith(".xlsx")) {
    throw new Error(
      "`sheet` applies only to .xlsx paths — remove it or point `path` at a workbook."
    );
  }

  let source: McpSource;
  if (args.url) {
    source = await connectUrl(deps, args.url.trim(), args.label);
  } else if (args.path) {
    const abs = resolve(args.path);
    const st = statSync(abs);
    if (st.isDirectory()) {
      source = await connectParquetPath(deps, abs, true, args.label);
    } else {
      const ext = extname(abs).toLowerCase();
      if (ext === ".parquet") {
        source = await connectParquetPath(deps, abs, false, args.label);
      } else if (ext === ".xlsx") {
        const result = await connectExcel(deps, abs, args.sheet, args.label);
        if ("needs_sheet" in result) return result as unknown as Record<string, unknown>;
        source = result;
      } else if (ext === ".geojson" || ext === ".json") {
        source = await connectGeoJson(deps, abs, args.label);
      } else if (ext === ".csv") {
        guardSize(abs);
        source = await connectCsvText(deps, readFileSync(abs, "utf-8"), basename(abs), args.label);
      } else {
        throw new Error(
          `Unsupported file type '${ext}'. Supported: .csv, .xlsx, .geojson/.json (GeoJSON), ` +
            ".parquet, or a Parquet folder."
        );
      }
    }
  } else {
    const connections = await deps.loadConnections();
    const saved = connections.find((c) => c.id === args.connection_id);
    if (!saved) {
      const known = connections.map((c) => c.id).join(", ") || "(none)";
      throw new Error(`No saved connection '${args.connection_id}'. Known ids: ${known}`);
    }
    const connector = deps.createConnector(saved.config);
    await connector.testConnection();
    const tables = await connector.introspectAllTables();
    const tableInfos = await connector.listTables();
    source = registerSource({
      kind: "warehouse",
      label: args.label ?? saved.name ?? saved.label,
      connectionId: saved.id,
      warehouseType: saved.config.type,
      connector,
      tables,
    });
    // Also register in the shared warehouse store under the source id, so
    // analyze() can hand runAskQuery the same {warehouse, connector} state
    // the web harness assembles (validate-request.ts).
    deps.storeWarehouse(
      {
        warehouseId: source.id,
        config: saved.config,
        tables: tableInfos,
        tableSchemas: tables,
        createdAt: Date.now(),
      },
      connector
    );
  }

  return { source_id: source.id, ...summarizeSource(source) };
}

export type { CSVSchema };
