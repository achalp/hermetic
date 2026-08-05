/**
 * Shared file-ingestion pipeline.
 *
 * Extension dispatch → parse → validate → extract schema → store used to
 * exist three times (upload route, local-files schema route, MCP
 * connect_source) and had drifted: only the upload route materialized large
 * CSVs to Parquet, only the web routes warmed sandboxes and recorded recent
 * sources, and the local-files route attached the bind-mount path by
 * mutating the stored entry after the fact. This module is the ONE
 * implementation; consumers differ only by the plain inputs they pass and
 * the policy flags they opt into.
 *
 * Framework-free by design (no Next imports): web routes keep their
 * FormData/response handling and hand plain text/buffer/path inputs here.
 * `makeIngest(deps)` preserves the MCP harness's injection seam (mcp/deps.ts
 * consumes lib functions only through `McpDeps`); the web routes use
 * `ingestFile`, the same factory bound to the real lib functions.
 *
 * Errors are plain `IngestError`s with a stable `code` and an actionable
 * message: the MCP boundary wraps them into its taxonomy
 * (McpToolError("invalid_input", …)), the web routes map codes back onto
 * their legacy wire messages — so both wire shapes stay exactly as they were.
 */
import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { randomUUID } from "node:crypto";
import type { CSVSchema, SheetInfo, SheetRelationship } from "@/lib/contracts/data-schema";
import { parseCSV, toCSVText } from "@/lib/csv/parser";
import { extractSchema } from "@/lib/csv/schema";
import { storeCSV, storeGeoJSON, storeLocalFileRef } from "@/lib/csv/storage";
import { parseExcelMeta, sheetToCSV } from "@/lib/excel/parser";
import { storeExcel } from "@/lib/excel/storage";
import { detectRelationships } from "@/lib/excel/relationships";
import { parseGeoJSON, isGeoJSONObject } from "@/lib/geojson/parser";
import { extractParquetSchema } from "@/lib/parquet/schema-extractor";
import { materializeCsvToParquet } from "@/lib/parquet/materialize";
import { getFileInfo } from "@/lib/local-files/browser";
import { getActiveSandboxRuntime } from "@/lib/runtime-config";
import { prepareWarmSandbox } from "@/lib/sandbox";
import { recordRecentSource } from "./recent-sources";
import { PARQUET_MATERIALIZE_THRESHOLD } from "@/lib/constants";
import { logger } from "@/lib/logger";

/** Refuse to slurp arbitrarily large text files into memory (path reads). */
export const MAX_INGEST_TEXT_BYTES = 200 * 1024 * 1024;

export type IngestErrorCode =
  | "too_large"
  | "unsupported_type"
  | "empty_columns"
  | "empty_rows"
  | "invalid_json"
  | "not_geojson"
  | "geojson_no_properties"
  | "no_sheets"
  | "sheet_not_found";

/**
 * A rejected input (as opposed to an infrastructure failure, which is thrown
 * raw). `code` is the contract consumers map on; `message` is actionable
 * prose in the MCP style, usable as-is at that boundary.
 */
export class IngestError extends Error {
  constructor(
    public readonly code: IngestErrorCode,
    message: string
  ) {
    super(message);
    this.name = "IngestError";
  }
}

/**
 * The narrow lib surface ingestion consumes. Required deps are the pipeline
 * itself; the optional block is CAPABILITIES — when a dep is absent, the
 * matching policy flag is a silent no-op (the MCP fallback seam assembles
 * this from `McpDeps`, which does not carry them).
 */
export interface IngestDeps {
  parseCSV: typeof parseCSV;
  toCSVText: typeof toCSVText;
  extractSchema: typeof extractSchema;
  storeCSV: typeof storeCSV;
  storeGeoJSON: typeof storeGeoJSON;
  storeLocalFileRef: typeof storeLocalFileRef;
  parseExcelMeta: typeof parseExcelMeta;
  sheetToCSV: typeof sheetToCSV;
  parseGeoJSON: typeof parseGeoJSON;
  isGeoJSONObject: typeof isGeoJSONObject;
  extractParquetSchema: typeof extractParquetSchema;
  getFileInfo: typeof getFileInfo;
  getActiveSandboxRuntime: typeof getActiveSandboxRuntime;
  // ── Capability deps (policy-gated, optional) ─────────────────────
  materializeCsvToParquet?: typeof materializeCsvToParquet;
  prepareWarmSandbox?: typeof prepareWarmSandbox;
  recordRecentSource?: typeof recordRecentSource;
  storeExcel?: typeof storeExcel;
  detectRelationships?: typeof detectRelationships;
}

export interface IngestInput {
  /** Absolute path to a local data file or Parquet folder (read server-side). */
  path?: string;
  /** In-memory text content (.csv / .geojson / .json uploads). */
  text?: string;
  /** In-memory workbook bytes (.xlsx uploads). */
  buffer?: Buffer;
  /** Original filename — required for in-memory inputs; defaults to basename(path). */
  filename?: string;
  /** Explicit Excel sheet to load. Omit on a multi-sheet workbook to get the picker back. */
  sheet?: string;
}

export interface IngestPolicy {
  /**
   * Large CSVs → Parquet + DuckDB schema (no Node parse), analyzed via the
   * bind-mounted local-files path so they scale past the pandas-era cap.
   * Docker-only (the materializer runs an ephemeral DuckDB container);
   * best-effort — any failure falls back to the plain CSV path.
   */
  materializeLargeCsv?: boolean;
  /** Row-count gate for materialization (tests shrink it). */
  materializeRowThreshold?: number;
  /** Fire-and-forget pre-load of the data into a warm sandbox. */
  warmSandbox?: boolean;
  /** Record (or bump) the source in the persisted Recents list. */
  recordRecent?: boolean;
  /**
   * Multi-sheet picker: persist the workbook and return an `excelId` so the
   * select-sheet/select-workbook routes can finish the job (web flow). MCP
   * skips this — its picker replays the original path with a `sheet` arg.
   */
  storeExcelForPicker?: boolean;
  /**
   * Attach path-read CSVs as bind-mount refs (localPath/localMtime on the
   * stored entry) so execution reads the file in place and the entry never
   * idles out. Caller policy, NOT a path-branch default: it flips the
   * pipeline into mount mode with a different code-gen "Data Location"
   * preamble, so turning it on for a consumer invalidates that consumer's
   * committed replay fixtures (this is how the MCP proof caught it).
   * The local-files route has always attached; upload and MCP never did.
   */
  attachLocalRef?: boolean;
  /** Size cap for path reads of in-memory formats. */
  maxTextBytes?: number;
}

export interface IngestDataset {
  kind: "dataset";
  csvId: string;
  schema: CSVSchema;
  format: "csv" | "excel-sheet" | "geojson" | "parquet";
  /** True when a large CSV was materialized to Parquet (no CSV text stored). */
  materialized?: boolean;
  /** True when the data is a bind-mounted file ref, not stored CSV text. */
  pathBased?: boolean;
  isFolder?: boolean;
  isHivePartitioned?: boolean;
  /** The sheet actually loaded (xlsx only). */
  sheet?: string;
}

export interface IngestSheetPicker {
  kind: "sheet_picker";
  /** Present only under `storeExcelForPicker`. */
  excelId?: string;
  filename: string;
  sheets: SheetInfo[];
  /** Present when the deps carry `detectRelationships`. */
  relationships?: SheetRelationship[];
}

export type IngestResult = IngestDataset | IngestSheetPicker;

export type IngestFn = (input: IngestInput, policy?: IngestPolicy) => Promise<IngestResult>;

/** Where the recents entry should point back to (per input origin). */
type RecentSeed =
  | { kind: "upload"; bytes: Buffer | string }
  | { kind: "local-file" | "local-folder"; path: string };

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

export function makeIngest(deps: IngestDeps): IngestFn {
  const warm = (policy: IngestPolicy, csvId: string, csvText: string, geojsonText?: string) => {
    if (!policy.warmSandbox || !deps.prepareWarmSandbox) return;
    deps.prepareWarmSandbox(csvId, csvText, deps.getActiveSandboxRuntime(), geojsonText);
  };

  // Best-effort by contract (recordRecentSource never throws into a connect).
  const record = (
    policy: IngestPolicy,
    seed: RecentSeed,
    filename: string,
    rows: number | undefined,
    isHivePartitioned?: boolean
  ) => {
    if (!policy.recordRecent || !deps.recordRecentSource) return;
    if (seed.kind === "upload") {
      // Persist the bytes into the managed store so a drag-dropped file
      // re-opens in one click later (see recent-sources.ts).
      void deps
        .recordRecentSource({
          kind: "upload",
          name: filename,
          subtitle: "Uploaded file",
          rows,
          bytes: seed.bytes,
          filename,
        })
        .catch(() => {});
    } else {
      void deps
        .recordRecentSource({
          kind: seed.kind,
          name: filename,
          subtitle: seed.path,
          path: seed.path,
          rows,
          isHivePartitioned,
        })
        .catch(() => {});
    }
  };

  async function ingestCsv(
    text: string,
    filename: string,
    policy: IngestPolicy,
    seed: RecentSeed,
    local?: { path: string; mtime: number }
  ): Promise<IngestDataset> {
    const csvId = randomUUID();

    const threshold = policy.materializeRowThreshold ?? PARQUET_MATERIALIZE_THRESHOLD;
    const runtime = deps.getActiveSandboxRuntime();
    if (
      policy.materializeLargeCsv &&
      deps.materializeCsvToParquet &&
      countCsvRows(text) >= threshold &&
      runtime === "docker"
    ) {
      try {
        const { parquetPath, schema } = await deps.materializeCsvToParquet(
          text,
          csvId,
          filename,
          runtime
        );
        deps.storeLocalFileRef(csvId, schema, parquetPath, Date.now(), false);
        logger.info("Ingest: materialized large CSV to Parquet", {
          csvId,
          rows: schema.row_count,
        });
        record(policy, seed, filename, schema.row_count);
        return {
          kind: "dataset",
          csvId,
          schema,
          format: "csv",
          materialized: true,
          pathBased: true,
        };
      } catch (err) {
        logger.warn("Ingest: Parquet materialization failed, falling back to CSV", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const parsed = deps.parseCSV(text);
    if (parsed.headers.length === 0)
      throw new IngestError("empty_columns", `${filename}: no columns found.`);
    if (parsed.rowCount === 0) throw new IngestError("empty_rows", `${filename}: no data rows.`);

    const schema = deps.extractSchema(parsed, csvId, filename);
    const csvText = deps.toCSVText(parsed);
    // `local` attaches the bind-mount ref AT store time (localPath/localMtime
    // on the entry) — replacing the local-files route's old post-hoc mutation
    // of the stored object.
    await deps.storeCSV(csvId, csvText, schema, local);
    warm(policy, csvId, csvText);
    record(policy, seed, filename, schema.row_count);
    return { kind: "dataset", csvId, schema, format: "csv" };
  }

  async function ingestGeoJson(
    text: string,
    filename: string,
    policy: IngestPolicy,
    seed: RecentSeed
  ): Promise<IngestDataset> {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(text);
    } catch {
      throw new IngestError("invalid_json", `${filename}: not valid JSON.`);
    }
    if (!deps.isGeoJSONObject(parsedJson)) {
      throw new IngestError(
        "not_geojson",
        `${filename}: JSON but not GeoJSON — only GeoJSON .json is supported.`
      );
    }
    const geo = deps.parseGeoJSON(text);
    if (geo.headers.length === 0)
      throw new IngestError("geojson_no_properties", `${filename}: GeoJSON has no properties.`);

    const csvId = randomUUID();
    const schema = deps.extractSchema(geo, csvId, filename);
    schema.has_geojson = true;
    schema.geojson_geometry_type = geo.geometryType;

    const csvText = deps.toCSVText(geo);
    await deps.storeCSV(csvId, csvText, schema);
    await deps.storeGeoJSON(csvId, text);
    warm(policy, csvId, csvText, text);
    record(policy, seed, filename, schema.row_count);
    return { kind: "dataset", csvId, schema, format: "geojson" };
  }

  async function ingestExcel(
    buffer: Buffer,
    filename: string,
    sheet: string | undefined,
    policy: IngestPolicy,
    seed: RecentSeed
  ): Promise<IngestResult> {
    const { sheets, workbook } = await deps.parseExcelMeta(buffer);
    if (sheets.length === 0) throw new IngestError("no_sheets", "Excel file has no sheets.");

    const pick = sheet ?? (sheets.length === 1 ? sheets[0].name : undefined);
    if (!pick) {
      // Multiple sheets and no choice made: hand back the picker.
      const relationships = deps.detectRelationships?.(sheets);
      let excelId: string | undefined;
      if (policy.storeExcelForPicker && deps.storeExcel) {
        excelId = randomUUID();
        await deps.storeExcel(excelId, buffer, filename);
      }
      return { kind: "sheet_picker", excelId, filename, sheets, relationships };
    }
    if (!sheets.some((sh) => sh.name === pick)) {
      throw new IngestError(
        "sheet_not_found",
        `No sheet named '${pick}'. Sheets: ${sheets.map((sh) => sh.name).join(", ")}`
      );
    }

    // An EXPLICIT sheet choice is reflected in the display name ("book.xlsx
    // (Costs)"); a single-sheet auto-pick keeps the plain filename.
    const displayName = sheet ? `${filename} (${pick})` : filename;
    const csvText = deps.sheetToCSV(workbook, pick);
    const parsed = deps.parseCSV(csvText);
    if (parsed.headers.length === 0)
      throw new IngestError("empty_columns", `${displayName}: no columns found.`);
    if (parsed.rowCount === 0) throw new IngestError("empty_rows", `${displayName}: no data rows.`);

    const csvId = randomUUID();
    const schema = deps.extractSchema(parsed, csvId, displayName);
    const normalized = deps.toCSVText(parsed);
    await deps.storeCSV(csvId, normalized, schema);
    warm(policy, csvId, normalized);
    record(policy, seed, filename, schema.row_count);
    return { kind: "dataset", csvId, schema, format: "excel-sheet", sheet: pick };
  }

  async function ingestParquetPath(
    abs: string,
    isFolder: boolean,
    policy: IngestPolicy
  ): Promise<IngestDataset> {
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
    record(
      policy,
      { kind: isFolder ? "local-folder" : "local-file", path: abs },
      basename(abs),
      schema.row_count,
      isHive
    );
    return {
      kind: "dataset",
      csvId,
      schema,
      format: "parquet",
      pathBased: true,
      isFolder,
      isHivePartitioned: isHive,
    };
  }

  /** Path reads only: in-memory callers (uploads) enforce their own cap. */
  function guardSize(abs: string, size: number, policy: IngestPolicy): void {
    const max = policy.maxTextBytes ?? MAX_INGEST_TEXT_BYTES;
    if (size > max) {
      throw new IngestError(
        "too_large",
        `File is ${Math.round(size / (1024 * 1024))}MB — over the ${Math.round(max / (1024 * 1024))}MB limit for ` +
          "in-memory formats. Convert to Parquet or use a warehouse connection."
      );
    }
  }

  return async function ingest(input: IngestInput, policy: IngestPolicy = {}) {
    // ── Path input: stat, guard, read ────────────────────────────
    if (input.path) {
      const abs = input.path;
      const st = statSync(abs);
      if (st.isDirectory()) return ingestParquetPath(abs, true, policy);

      const filename = input.filename ?? basename(abs);
      const ext = extname(abs).toLowerCase();
      const seed: RecentSeed = { kind: "local-file", path: abs };

      if (ext === ".parquet") return ingestParquetPath(abs, false, policy);
      if (ext === ".xlsx") {
        guardSize(abs, st.size, policy);
        return ingestExcel(await readFile(abs), filename, input.sheet, policy, seed);
      }
      if (ext === ".csv") {
        guardSize(abs, st.size, policy);
        const text = await readFile(abs, "utf-8");
        return ingestCsv(
          text,
          filename,
          policy,
          seed,
          policy.attachLocalRef ? { path: abs, mtime: st.mtimeMs } : undefined
        );
      }
      if (ext === ".geojson" || ext === ".json") {
        guardSize(abs, st.size, policy);
        return ingestGeoJson(await readFile(abs, "utf-8"), filename, policy, seed);
      }
      throw new IngestError(
        "unsupported_type",
        `Unsupported file type '${ext}'. Supported: .csv, .xlsx, .geojson/.json (GeoJSON), ` +
          ".parquet, or a Parquet folder."
      );
    }

    // ── In-memory input: dispatch on the filename ────────────────
    if (!input.filename)
      throw new IngestError("unsupported_type", "In-memory input needs a filename.");
    const filename = input.filename;
    const ext = extname(filename).toLowerCase();
    if (input.buffer && ext === ".xlsx") {
      return ingestExcel(input.buffer, filename, input.sheet, policy, {
        kind: "upload",
        bytes: input.buffer,
      });
    }
    if (typeof input.text === "string") {
      const seed: RecentSeed = { kind: "upload", bytes: input.text };
      if (ext === ".csv") return ingestCsv(input.text, filename, policy, seed);
      if (ext === ".geojson" || ext === ".json")
        return ingestGeoJson(input.text, filename, policy, seed);
    }
    throw new IngestError(
      "unsupported_type",
      `Unsupported file type '${ext}'. Supported: .csv, .xlsx, .geojson/.json (GeoJSON), ` +
        ".parquet, or a Parquet folder."
    );
  };
}

/** The real-lib binding (web routes). MCP binds through mcp/deps.ts instead. */
export function realIngestDeps(): IngestDeps {
  return {
    parseCSV,
    toCSVText,
    extractSchema,
    storeCSV,
    storeGeoJSON,
    storeLocalFileRef,
    parseExcelMeta,
    sheetToCSV,
    parseGeoJSON,
    isGeoJSONObject,
    extractParquetSchema,
    getFileInfo,
    getActiveSandboxRuntime,
    materializeCsvToParquet,
    prepareWarmSandbox,
    recordRecentSource,
    storeExcel,
    detectRelationships,
  };
}

export const ingestFile: IngestFn = makeIngest(realIngestDeps());
