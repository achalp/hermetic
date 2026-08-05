/**
 * Tests for the shared file-ingestion pipeline (lib/sources/ingest.ts) —
 * the ONE implementation behind the upload route, the local-files schema
 * route, and MCP connect_source. Pure parsing/schema deps are real; stores
 * and side-effect capabilities (warm sandbox, recents, materialization) are
 * spies, so the policy gating is what's under test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeIngest, IngestError, type IngestDeps } from "../ingest";
import { parseCSV, toCSVText } from "@/lib/csv/parser";
import { extractSchema } from "@/lib/csv/schema";
import { parseExcelMeta, sheetToCSV } from "@/lib/excel/parser";
import { parseGeoJSON, isGeoJSONObject } from "@/lib/geojson/parser";
import type { CSVSchema } from "@/lib/contracts/data-schema";

const CSV_TEXT = "month,revenue\nJan,100\nFeb,200\nMar,300\n";

const GEOJSON_TEXT = JSON.stringify({
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [0, 0] },
      properties: { name: "Origin", population: 5 },
    },
  ],
});

function fakeDeps(overrides: Partial<IngestDeps> = {}): IngestDeps {
  return {
    parseCSV, // real: pure
    toCSVText, // real: pure
    extractSchema, // real: pure
    storeCSV: vi.fn(async () => undefined) as unknown as IngestDeps["storeCSV"],
    storeGeoJSON: vi.fn(async () => undefined) as unknown as IngestDeps["storeGeoJSON"],
    storeLocalFileRef: vi.fn() as unknown as IngestDeps["storeLocalFileRef"],
    parseExcelMeta, // real: pure over a buffer
    sheetToCSV, // real: pure
    parseGeoJSON, // real: pure
    isGeoJSONObject, // real: pure
    extractParquetSchema: vi.fn(async (_p: string, csvId: string, filename: string) =>
      extractSchema(parseCSV(CSV_TEXT), csvId, filename)
    ) as unknown as IngestDeps["extractParquetSchema"],
    getFileInfo: vi.fn(async (p: string) => ({
      path: p,
      name: "x",
      size: 1,
      mtime: 42,
      extension: "",
      isDirectory: false,
      isParquetFolder: false,
    })) as unknown as IngestDeps["getFileInfo"],
    getActiveSandboxRuntime: vi.fn(
      () => "docker"
    ) as unknown as IngestDeps["getActiveSandboxRuntime"],
    materializeCsvToParquet: vi.fn() as unknown as IngestDeps["materializeCsvToParquet"],
    prepareWarmSandbox: vi.fn() as unknown as IngestDeps["prepareWarmSandbox"],
    recordRecentSource: vi.fn(async () => undefined) as unknown as IngestDeps["recordRecentSource"],
    storeExcel: vi.fn(async () => undefined) as unknown as IngestDeps["storeExcel"],
    detectRelationships: vi.fn(() => []) as unknown as IngestDeps["detectRelationships"],
    ...overrides,
  };
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "(no error)";
  } catch (err) {
    if (err instanceof IngestError) return err.code;
    throw err;
  }
}

async function workbookBuffer(sheets: Array<[string, string[][]]>): Promise<Buffer> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  for (const [name, rows] of sheets) {
    const ws = wb.addWorksheet(name);
    for (const row of rows) ws.addRow(row);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ingest-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("csv", () => {
  it("parses, stores the NORMALIZED text, and returns the schema", async () => {
    const deps = fakeDeps();
    const result = await makeIngest(deps)({ text: CSV_TEXT, filename: "orders.csv" });
    expect(result.kind).toBe("dataset");
    if (result.kind !== "dataset") return;
    expect(result.format).toBe("csv");
    expect(result.schema.row_count).toBe(3);
    expect(result.schema.filename).toBe("orders.csv");
    const call = vi.mocked(deps.storeCSV).mock.calls[0];
    expect(call[0]).toBe(result.csvId);
    expect(call[1]).toBe(toCSVText(parseCSV(CSV_TEXT)));
    // In-memory input: no bind-mount ref.
    expect(call[3]).toBeUndefined();
    // Policy flags off: no warm sandbox, no recents.
    expect(deps.prepareWarmSandbox).not.toHaveBeenCalled();
    expect(deps.recordRecentSource).not.toHaveBeenCalled();
  });

  it("rejects empty headers and empty rows with stable codes", async () => {
    const ingest = makeIngest(fakeDeps());
    expect(await code(ingest({ text: "", filename: "empty.csv" }))).toBe("empty_columns");
    expect(await code(ingest({ text: "a,b\n", filename: "headers-only.csv" }))).toBe("empty_rows");
  });

  it("warms the sandbox and records an upload recent when the policy asks", async () => {
    const deps = fakeDeps();
    const result = await makeIngest(deps)(
      { text: CSV_TEXT, filename: "orders.csv" },
      { warmSandbox: true, recordRecent: true }
    );
    if (result.kind !== "dataset") throw new Error("expected dataset");
    expect(deps.prepareWarmSandbox).toHaveBeenCalledWith(
      result.csvId,
      expect.stringContaining("month,revenue"),
      "docker",
      undefined
    );
    expect(deps.recordRecentSource).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "upload",
        name: "orders.csv",
        subtitle: "Uploaded file",
        rows: 3,
        bytes: CSV_TEXT,
        filename: "orders.csv",
      })
    );
  });

  it("path input: attachLocalRef binds the mount ref AT store time and records a local-file recent", async () => {
    const csvPath = join(dir, "rev.csv");
    writeFileSync(csvPath, CSV_TEXT);
    const deps = fakeDeps();
    await makeIngest(deps)({ path: csvPath }, { recordRecent: true, attachLocalRef: true });
    const call = vi.mocked(deps.storeCSV).mock.calls[0];
    // The fix for the old post-hoc `stored.localPath = ...` mutation.
    expect(call[3]).toEqual({ path: csvPath, mtime: expect.any(Number) });
    expect(deps.recordRecentSource).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "local-file", path: csvPath, subtitle: csvPath })
    );
  });

  it("path input WITHOUT attachLocalRef stores plain in-memory CSV (mount mode changes the code-gen prompt, so it is caller policy)", async () => {
    const csvPath = join(dir, "rev.csv");
    writeFileSync(csvPath, CSV_TEXT);
    const deps = fakeDeps();
    await makeIngest(deps)({ path: csvPath }, {});
    expect(vi.mocked(deps.storeCSV).mock.calls[0][3]).toBeUndefined();
  });
});

describe("large-CSV materialization (policy-gated)", () => {
  const bigSchema = { row_count: 3, filename: "big.csv", columns: [] } as unknown as CSVSchema;

  it("materializes past the threshold on docker and stores a local ref instead of CSV text", async () => {
    const deps = fakeDeps({
      materializeCsvToParquet: vi.fn(async () => ({
        parquetPath: "/parquet/big.parquet",
        schema: bigSchema,
      })) as unknown as IngestDeps["materializeCsvToParquet"],
    });
    const result = await makeIngest(deps)(
      { text: CSV_TEXT, filename: "big.csv" },
      { materializeLargeCsv: true, materializeRowThreshold: 1, recordRecent: true }
    );
    if (result.kind !== "dataset") throw new Error("expected dataset");
    expect(result.materialized).toBe(true);
    expect(result.pathBased).toBe(true);
    expect(deps.storeLocalFileRef).toHaveBeenCalledWith(
      result.csvId,
      bigSchema,
      "/parquet/big.parquet",
      expect.any(Number),
      false
    );
    expect(deps.storeCSV).not.toHaveBeenCalled();
    // Recents still recorded for the materialized upload.
    expect(deps.recordRecentSource).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "upload", name: "big.csv" })
    );
  });

  it("skips materialization off-policy, under threshold, or off docker", async () => {
    // Off policy.
    let deps = fakeDeps();
    await makeIngest(deps)({ text: CSV_TEXT, filename: "a.csv" }, { materializeRowThreshold: 1 });
    expect(deps.materializeCsvToParquet).not.toHaveBeenCalled();

    // Under threshold (the real 100k default).
    deps = fakeDeps();
    await makeIngest(deps)({ text: CSV_TEXT, filename: "a.csv" }, { materializeLargeCsv: true });
    expect(deps.materializeCsvToParquet).not.toHaveBeenCalled();

    // Non-docker runtime.
    deps = fakeDeps({
      getActiveSandboxRuntime: vi.fn(
        () => "microsandbox"
      ) as unknown as IngestDeps["getActiveSandboxRuntime"],
    });
    await makeIngest(deps)(
      { text: CSV_TEXT, filename: "a.csv" },
      { materializeLargeCsv: true, materializeRowThreshold: 1 }
    );
    expect(deps.materializeCsvToParquet).not.toHaveBeenCalled();
    expect(deps.storeCSV).toHaveBeenCalled();
  });

  it("falls back to the plain CSV path when materialization fails", async () => {
    const deps = fakeDeps({
      materializeCsvToParquet: vi.fn(async () => {
        throw new Error("docker exploded");
      }) as unknown as IngestDeps["materializeCsvToParquet"],
    });
    const result = await makeIngest(deps)(
      { text: CSV_TEXT, filename: "big.csv" },
      { materializeLargeCsv: true, materializeRowThreshold: 1 }
    );
    if (result.kind !== "dataset") throw new Error("expected dataset");
    expect(result.materialized).toBeUndefined();
    expect(deps.storeCSV).toHaveBeenCalledTimes(1);
  });
});

describe("excel", () => {
  it("multi-sheet: returns the picker; stores the workbook only under storeExcelForPicker", async () => {
    const buffer = await workbookBuffer([
      [
        "Revenue",
        [
          ["month", "revenue"],
          ["Jan", "100"],
        ],
      ],
      [
        "Costs",
        [
          ["month", "cost"],
          ["Jan", "40"],
        ],
      ],
    ]);
    const deps = fakeDeps();
    const ingest = makeIngest(deps);

    const listing = await ingest({ buffer, filename: "book.xlsx" });
    expect(listing.kind).toBe("sheet_picker");
    if (listing.kind !== "sheet_picker") return;
    expect(listing.sheets.map((sh) => sh.name)).toEqual(["Revenue", "Costs"]);
    expect(listing.excelId).toBeUndefined();
    expect(deps.storeExcel).not.toHaveBeenCalled();

    const stored = await ingest({ buffer, filename: "book.xlsx" }, { storeExcelForPicker: true });
    if (stored.kind !== "sheet_picker") throw new Error("expected picker");
    expect(stored.excelId).toBeTruthy();
    expect(deps.storeExcel).toHaveBeenCalledWith(stored.excelId, buffer, "book.xlsx");
    expect(stored.relationships).toEqual([]);
  });

  it("an explicit sheet loads it with the '(sheet)' display name; unknown sheets are named", async () => {
    const buffer = await workbookBuffer([
      [
        "Revenue",
        [
          ["month", "revenue"],
          ["Jan", "100"],
        ],
      ],
      [
        "Costs",
        [
          ["month", "cost"],
          ["Jan", "40"],
        ],
      ],
    ]);
    const ingest = makeIngest(fakeDeps());
    const result = await ingest({ buffer, filename: "book.xlsx", sheet: "Costs" });
    if (result.kind !== "dataset") throw new Error("expected dataset");
    expect(result.format).toBe("excel-sheet");
    expect(result.sheet).toBe("Costs");
    expect(result.schema.filename).toBe("book.xlsx (Costs)");
    expect(result.schema.row_count).toBe(1);

    const bad = ingest({ buffer, filename: "book.xlsx", sheet: "Q9" });
    expect(await code(bad)).toBe("sheet_not_found");
    await expect(ingest({ buffer, filename: "book.xlsx", sheet: "Q9" })).rejects.toThrow(
      /Revenue, Costs/
    );
  });

  it("a single sheet auto-loads under the plain filename", async () => {
    const buffer = await workbookBuffer([
      [
        "Only",
        [
          ["a", "b"],
          ["1", "2"],
        ],
      ],
    ]);
    const result = await makeIngest(fakeDeps())({ buffer, filename: "one.xlsx" });
    if (result.kind !== "dataset") throw new Error("expected dataset");
    expect(result.schema.filename).toBe("one.xlsx");
    expect(result.sheet).toBe("Only");
  });
});

describe("geojson", () => {
  it("stamps the schema, stores the sidecar, and warms with the raw text", async () => {
    const deps = fakeDeps();
    const result = await makeIngest(deps)(
      { text: GEOJSON_TEXT, filename: "places.json" },
      { warmSandbox: true }
    );
    if (result.kind !== "dataset") throw new Error("expected dataset");
    expect(result.format).toBe("geojson");
    expect(result.schema.has_geojson).toBe(true);
    expect(result.schema.geojson_geometry_type).toBe("Point");
    expect(deps.storeGeoJSON).toHaveBeenCalledWith(result.csvId, GEOJSON_TEXT);
    expect(deps.prepareWarmSandbox).toHaveBeenCalledWith(
      result.csvId,
      expect.any(String),
      "docker",
      GEOJSON_TEXT
    );
  });

  it("rejects invalid JSON, non-GeoJSON JSON, and feature-less GeoJSON", async () => {
    const ingest = makeIngest(fakeDeps());
    expect(await code(ingest({ text: "{nope", filename: "x.json" }))).toBe("invalid_json");
    expect(await code(ingest({ text: '{"hello":1}', filename: "x.json" }))).toBe("not_geojson");
    // With zero features the parser's own guard fires first (raw Error, not
    // an IngestError) — same as all three pre-unification implementations;
    // the synthetic _geometry_type header makes the no-properties code
    // unreachable for any non-empty collection.
    const empty = JSON.stringify({ type: "FeatureCollection", features: [] });
    await expect(ingest({ text: empty, filename: "x.geojson" })).rejects.toThrow(
      /GeoJSON has no features/
    );
  });
});

describe("path guards and parquet", () => {
  it("refuses oversized in-memory formats read from disk", async () => {
    const csvPath = join(dir, "big.csv");
    writeFileSync(csvPath, CSV_TEXT);
    const oversize = makeIngest(fakeDeps())({ path: csvPath }, { maxTextBytes: 4 });
    expect(await code(oversize)).toBe("too_large");
    await expect(makeIngest(fakeDeps())({ path: csvPath }, { maxTextBytes: 4 })).rejects.toThrow(
      /Convert to Parquet or use a warehouse connection/
    );
  });

  it("rejects unknown extensions", async () => {
    const exePath = join(dir, "tool.exe");
    writeFileSync(exePath, "MZ");
    expect(await code(makeIngest(fakeDeps())({ path: exePath }))).toBe("unsupported_type");
  });

  it("a directory ingests as a Parquet folder ref with Hive detection", async () => {
    const folder = join(dir, "events");
    mkdirSync(folder);
    const deps = fakeDeps({
      getFileInfo: vi.fn(async () => ({
        path: folder,
        name: "events",
        size: 0,
        mtime: 42,
        extension: "",
        isDirectory: true,
        isParquetFolder: true,
        isHivePartitioned: true,
      })) as unknown as IngestDeps["getFileInfo"],
    });
    const result = await makeIngest(deps)({ path: folder }, { recordRecent: true });
    if (result.kind !== "dataset") throw new Error("expected dataset");
    expect(result.format).toBe("parquet");
    expect(result.pathBased).toBe(true);
    expect(result.isHivePartitioned).toBe(true);
    expect(deps.extractParquetSchema).toHaveBeenCalledWith(
      folder,
      result.csvId,
      "events",
      true,
      "docker",
      true
    );
    expect(deps.storeLocalFileRef).toHaveBeenCalledWith(
      result.csvId,
      result.schema,
      folder,
      42,
      true,
      true
    );
    expect(deps.recordRecentSource).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "local-folder", isHivePartitioned: true })
    );
  });

  it("a .parquet file ingests as a file ref (isHive stays undefined)", async () => {
    const pq = join(dir, "events.parquet");
    writeFileSync(pq, "PAR1fake");
    const deps = fakeDeps();
    const result = await makeIngest(deps)({ path: pq });
    if (result.kind !== "dataset") throw new Error("expected dataset");
    expect(deps.extractParquetSchema).toHaveBeenCalledWith(
      pq,
      result.csvId,
      "events.parquet",
      false,
      "docker",
      undefined
    );
    expect(deps.storeLocalFileRef).toHaveBeenCalledWith(
      result.csvId,
      result.schema,
      pq,
      42,
      false,
      undefined
    );
  });
});
