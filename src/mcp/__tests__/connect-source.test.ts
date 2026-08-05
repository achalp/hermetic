/**
 * connect_source through the SDK's in-memory transport with injected fakes —
 * a fresh suite for the Phase-2 unification: the path branch now runs the
 * SHARED ingestion pipeline (lib/sources/ingest.ts) with MCP opting into
 * warm-sandbox prep, Recents, and large-CSV materialization; the
 * connection_id branch runs the SHARED cached introspection
 * (lib/warehouse/introspect.ts) and returns inferred relationships.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../server";
import type { McpDeps } from "../deps";
import { clearSources } from "../sources";
import type { AuditEntry } from "../audit";
import { makeIngest, type IngestDeps } from "@/lib/sources/ingest";
import { introspectWithCache } from "@/lib/warehouse/introspect";
import { parseCSV, toCSVText } from "@/lib/csv/parser";
import { extractSchema } from "@/lib/csv/schema";
import { storeLocalFileRef, storeGeoJSON } from "@/lib/csv/storage";
import { getFileInfo } from "@/lib/local-files/browser";
import { parseExcelMeta, sheetToCSV } from "@/lib/excel/parser";
import { parseGeoJSON, isGeoJSONObject } from "@/lib/geojson/parser";
import { setPathRoots } from "@/lib/paths";
import type { WarehouseConnector } from "@/lib/warehouse/connector";
import type { CSVSchema } from "@/lib/contracts/data-schema";

const CSV_TEXT = "month,revenue\nJan,100\nFeb,200\nMar,300\n";

/** Two joinable tables so inferRelationships has something real to find. */
function fakeConnector(): WarehouseConnector {
  return {
    testConnection: vi.fn(async () => undefined),
    listTables: vi.fn(async () => [
      { schema: "public", name: "orders", row_count_estimate: 10, column_count: 3 },
      { schema: "public", name: "customers", row_count_estimate: 5, column_count: 2 },
    ]),
    introspectAllTables: vi.fn(async () => [
      {
        schema: "public",
        name: "orders",
        row_count_estimate: 10,
        columns: [
          { name: "id", type: "bigint" },
          { name: "customer_id", type: "bigint" },
          { name: "amount", type: "numeric" },
        ],
      },
      {
        schema: "public",
        name: "customers",
        row_count_estimate: 5,
        columns: [
          { name: "id", type: "bigint" },
          { name: "name", type: "text" },
        ],
      },
    ]),
    executeSQL: vi.fn(async () => "x\n1\n"),
    close: vi.fn(async () => undefined),
  } as unknown as WarehouseConnector;
}

interface Spies {
  storeCSV: ReturnType<typeof vi.fn>;
  storeLocalFileRef: ReturnType<typeof vi.fn>;
  prepareWarmSandbox: ReturnType<typeof vi.fn>;
  recordRecentSource: ReturnType<typeof vi.fn>;
  materializeCsvToParquet: ReturnType<typeof vi.fn>;
}

/**
 * The deps connect_source / get_schema / list_sources touch. The injected
 * `ingestFile` is the REAL shared pipeline over these fakes — proving the
 * tool passes its policy flags (warm, recents, materialize) through it.
 */
function fakeDeps(connector: WarehouseConnector): { deps: McpDeps; spies: Spies } {
  const spies: Spies = {
    storeCSV: vi.fn(async () => undefined),
    storeLocalFileRef: vi.fn(storeLocalFileRef),
    prepareWarmSandbox: vi.fn(),
    recordRecentSource: vi.fn(async () => undefined),
    materializeCsvToParquet: vi.fn(async () => {
      throw new Error("not materializable in tests");
    }),
  };
  const ingestDeps = {
    parseCSV,
    toCSVText,
    extractSchema,
    storeCSV: spies.storeCSV,
    storeGeoJSON,
    storeLocalFileRef: spies.storeLocalFileRef,
    parseExcelMeta,
    sheetToCSV,
    parseGeoJSON,
    isGeoJSONObject,
    extractParquetSchema: vi.fn(async (_p: string, csvId: string, filename: string) =>
      extractSchema(parseCSV(CSV_TEXT), csvId, filename)
    ),
    getFileInfo,
    getActiveSandboxRuntime: vi.fn(() => "docker"),
    materializeCsvToParquet: spies.materializeCsvToParquet,
    prepareWarmSandbox: spies.prepareWarmSandbox,
    recordRecentSource: spies.recordRecentSource,
  } as unknown as IngestDeps;

  const deps = {
    loadConnections: vi.fn(async () => [
      {
        id: "conn-1",
        label: "PostgreSQL: prod",
        config: {
          type: "postgresql",
          host: "h",
          port: 5432,
          database: "d",
          user: "u",
          password: "p",
        },
        createdAt: "2026-01-01T00:00:00Z",
      },
    ]),
    createConnector: vi.fn(() => connector),
    storeWarehouse: vi.fn(),
    ingestFile: makeIngest(ingestDeps),
    introspectWithCache, // real: the cache + inference engine under test
  } as unknown as McpDeps;
  return { deps, spies };
}

async function connectedClient(deps: McpDeps, audit: AuditEntry[]) {
  const server = buildMcpServer(deps, (e) => audit.push(e));
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function parseToolJson(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  return JSON.parse(content[0].text);
}

let dir: string;
let audit: AuditEntry[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-connect-test-"));
  setPathRoots({ dataRoot: dir, scratchRoot: join(dir, "scratch"), userRoot: join(dir, "user") });
  clearSources();
  audit = [];
});
afterEach(() => {
  setPathRoots({});
  rmSync(dir, { recursive: true, force: true });
});

describe("connect_source(path) — shared ingestion pipeline", () => {
  it("orders.csv: schema without raw rows, warm sandbox prepped, recent recorded", async () => {
    const csvPath = join(dir, "orders.csv");
    writeFileSync(csvPath, CSV_TEXT);
    const { deps, spies } = fakeDeps(fakeConnector());
    const client = await connectedClient(deps, audit);

    const connected = parseToolJson(
      await client.callTool({ name: "connect_source", arguments: { path: csvPath } })
    );
    expect(connected.source_id).toBeTruthy();
    expect(connected.kind).toBe("csv");
    expect((connected.schema as Record<string, unknown>).row_count).toBe(3);
    // THE boundary invariant: row-linked samples never appear anywhere.
    expect(JSON.stringify(connected)).not.toContain("sample_rows");

    // MCP now opts into the web routes' conveniences.
    expect(spies.prepareWarmSandbox).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("month,revenue"),
      "docker",
      undefined
    );
    expect(spies.recordRecentSource).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "local-file", path: csvPath, rows: 3 })
    );

    const got = parseToolJson(
      await client.callTool({ name: "get_schema", arguments: { source_id: connected.source_id } })
    );
    expect((got.schema as Record<string, unknown>).row_count).toBe(3);
  });

  it("multi-sheet excel returns the sheet list, then connects the chosen sheet", async () => {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    const s1 = wb.addWorksheet("Revenue");
    s1.addRow(["month", "revenue"]);
    s1.addRow(["Jan", 100]);
    const s2 = wb.addWorksheet("Costs");
    s2.addRow(["month", "cost"]);
    s2.addRow(["Jan", 40]);
    const xlsxPath = join(dir, "book.xlsx");
    await wb.xlsx.writeFile(xlsxPath);

    const { deps } = fakeDeps(fakeConnector());
    const client = await connectedClient(deps, audit);

    const listing = parseToolJson(
      await client.callTool({ name: "connect_source", arguments: { path: xlsxPath } })
    );
    expect(listing.needs_sheet).toBe(true);
    expect((listing.sheets as Array<{ name: string }>).map((sh) => sh.name)).toEqual([
      "Revenue",
      "Costs",
    ]);
    expect(String(listing.hint)).toContain("sheet");

    const connected = parseToolJson(
      await client.callTool({
        name: "connect_source",
        arguments: { path: xlsxPath, sheet: "Costs" },
      })
    );
    expect(connected.source_id).toBeTruthy();
    const schema = connected.schema as { filename: string; row_count: number };
    expect(schema.filename).toContain("Costs");
    expect(schema.row_count).toBe(1);
  });

  it("ingest rejections surface as invalid_input with the actionable message", async () => {
    const csvPath = join(dir, "empty.csv");
    writeFileSync(csvPath, "a,b\n");
    const { deps } = fakeDeps(fakeConnector());
    const client = await connectedClient(deps, audit);
    const res = await client.callTool({
      name: "connect_source",
      arguments: { path: csvPath },
    });
    expect((res as { isError?: boolean }).isError).toBe(true);
    const payload = parseToolJson(res);
    expect(payload.code).toBe("invalid_input");
    expect(String(payload.error)).toContain("no data rows");
  });

  it("a large CSV materializes to a bind-mounted (local-parquet) source", async () => {
    const bigCsv = "n\n" + "1\n".repeat(100_000);
    const csvPath = join(dir, "big.csv");
    writeFileSync(csvPath, bigCsv);
    const { deps, spies } = fakeDeps(fakeConnector());
    const schema = extractSchema(parseCSV("n\n1\n"), "x", "big.csv") as CSVSchema;
    spies.materializeCsvToParquet.mockImplementation(async (_t: string, csvId: string) => ({
      parquetPath: join(dir, "big.parquet"),
      schema: { ...schema, csv_id: csvId },
    }));
    const client = await connectedClient(deps, audit);

    const connected = parseToolJson(
      await client.callTool({ name: "connect_source", arguments: { path: csvPath } })
    );
    expect(spies.materializeCsvToParquet).toHaveBeenCalledTimes(1);
    // Materialized = bind-mounted ref, so the source advertises analyze, not
    // run_analysis.
    expect(connected.source_type).toBe("local-parquet");
    expect(spies.storeLocalFileRef).toHaveBeenCalled();
    expect(spies.storeCSV).not.toHaveBeenCalled();
  });
});

describe("connect_source(connection_id) — shared cached introspection", () => {
  it("returns inferred relationships and hits the schema cache on reconnect", async () => {
    const connector = fakeConnector();
    const { deps } = fakeDeps(connector);
    const client = await connectedClient(deps, audit);

    const first = parseToolJson(
      await client.callTool({ name: "connect_source", arguments: { connection_id: "conn-1" } })
    );
    expect(first.kind).toBe("warehouse");
    expect(first.table_count).toBe(2);
    expect(first.relationships).toEqual([
      {
        table: "orders",
        column: "customer_id",
        references_table: "customers",
        references_column: "id",
      },
    ]);
    // Never credentials on the wire.
    const text = JSON.stringify(first);
    expect(text).not.toContain("password");
    expect(text).not.toContain('"p"');

    const second = parseToolJson(
      await client.callTool({ name: "connect_source", arguments: { connection_id: "conn-1" } })
    );
    // The expensive introspection ran ONCE — the second connect was served by
    // the fingerprint-validated schema cache, relationships intact.
    expect(connector.introspectAllTables).toHaveBeenCalledTimes(1);
    expect(second.relationships).toEqual(first.relationships);
    expect(deps.storeWarehouse).toHaveBeenCalledTimes(2);
  });

  it("falls back to raw introspection when the introspect dep is absent", async () => {
    const connector = fakeConnector();
    const { deps } = fakeDeps(connector);
    (deps as { introspectWithCache?: unknown }).introspectWithCache = undefined;
    const client = await connectedClient(deps, audit);

    const connected = parseToolJson(
      await client.callTool({ name: "connect_source", arguments: { connection_id: "conn-1" } })
    );
    expect(connected.kind).toBe("warehouse");
    expect(connected.table_count).toBe(2);
    // Raw introspection: no inference ran, so no relationships field.
    expect(connected.relationships).toBeUndefined();
  });
});
