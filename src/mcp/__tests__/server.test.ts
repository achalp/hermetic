/**
 * MCP M1 tests: end-to-end through the SDK's in-memory transport with fully
 * injected fakes (no network, no docker, no LLM), plus the boundary rules
 * that ARE the product: no raw rows in schema responses, read-only SQL
 * enforced before execution, audit line per call with sanitized args.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../server";
import type { McpDeps } from "../deps";
import { clearSources } from "../sources";
import type { AuditEntry } from "../audit";
import { sanitizeArgs } from "../audit";
import { parseCSV } from "@/lib/csv/parser";
import { extractSchema } from "@/lib/csv/schema";
import { assertReadOnlySql } from "@/lib/warehouse/sql-guard";
import { assembleSpecFromPatches } from "@/lib/pipeline/assemble-spec";
import { collectGroundedValues, verifyGrounding } from "@/lib/pipeline/grounding";
import { validateSpec, catalogComponents } from "@/lib/catalog";
import { isSafeParquetUrl } from "@/lib/parquet/duckdb-source";
import { normalizeRemoteParquetUrl } from "@/lib/parquet/partition";
import { storeRemoteParquetRef, storeLocalFileRef, storeGeoJSON } from "@/lib/csv/storage";
import { getFileInfo } from "@/lib/local-files/browser";
import { parseExcelMeta, sheetToCSV } from "@/lib/excel/parser";
import { parseGeoJSON, isGeoJSONObject } from "@/lib/geojson/parser";
import { toCSVText } from "@/lib/csv/parser";
import { setPathRoots } from "@/lib/paths";
import {
  exportDashboardHtml,
  exportAppTemplateHtml,
  type ExportInput,
} from "@/lib/export/html-export";
import type { WarehouseConnector } from "@/lib/warehouse/connector";
import type { WarehouseState } from "@/lib/pipeline/validate-request";
import type { HistoryMeta } from "@/lib/contracts/storage-types";
import type { CSVSchema } from "@/lib/contracts/data-schema";

const CSV_TEXT = "month,revenue\nJan,100\nFeb,200\nMar,300\n";

function fakeConnector(resultCsv: string): WarehouseConnector {
  return {
    testConnection: vi.fn(async () => undefined),
    listTables: vi.fn(async () => []),
    introspectAllTables: vi.fn(async () => [
      {
        schema: "public",
        name: "orders",
        row_count_estimate: 2_500_000_000,
        columns: [
          { name: "id", type: "bigint" },
          { name: "amount", type: "numeric" },
        ],
      },
    ]),
    executeSQL: vi.fn(async () => resultCsv),
    close: vi.fn(async () => undefined),
  } as unknown as WarehouseConnector;
}

/**
 * A stream-shaped fake for the runAskQuery seam: tests push NDJSON lines the
 * way the real pipeline emits them. Structurally narrower than PatchStream,
 * so the runPatchStream fake below carries the one genuine cast.
 */
type FakeStream = { push: (line: string) => void };
const pushOf = (stream: unknown) => (stream as FakeStream).push;

function fakeDeps(connector: WarehouseConnector): McpDeps {
  // The artifacts cache records the question it was computed for; the fake
  // mirrors that so the S8 mismatch guard is exercised honestly.
  const lastRun = { question: "" };
  return {
    parseCSV, // real: pure
    extractSchema, // real: pure
    storeCSV: vi.fn(async () => undefined),
    createConnector: vi.fn(() => connector),
    loadConnections: vi.fn(async () => [
      {
        id: "conn-1",
        label: "PostgreSQL: prod",
        config: {
          type: "postgresql" as const,
          host: "h",
          port: 5432,
          database: "d",
          user: "u",
          password: "p",
        },
        createdAt: "2026-01-01T00:00:00Z",
      },
    ]),
    assertReadOnlySql, // real: the gate under test
    storeWarehouse: vi.fn(),
    // connect_source registers the warehouse in the shared store, so the
    // default fake reports it live; expiry tests flip this to undefined.
    // Cast: partial WarehouseState — the tools only check truthiness for
    // liveness / thread it opaquely into runAskQuery (itself a fake here).
    getWarehouseState: vi.fn(() => ({ warehouse: {}, connector: {} }) as unknown as WarehouseState),
    // Minimal orchestration fakes: runPatchStream routes handler writes into
    // the sink; runAskQuery is set per-test. Cast: the fake hands handlers a
    // FakeStream, not a real PatchStream (no emitProgress/setMeta/isClosed).
    runPatchStream: (async (
      _route: string,
      sink: { write: (d: string) => void },
      handler: (stream: unknown) => Promise<void>
    ) => {
      await handler({ push: (line: string) => sink.write(line) } satisfies FakeStream);
      // The real runPatchStream returns the run's correlation id.
      return "run-test-1";
    }) as unknown as McpDeps["runPatchStream"],
    stopRun: vi.fn(async () => true),
    runAskQuery: vi.fn(async ({ stream, question }: { stream: unknown; question: string }) => {
      lastRun.question = question;
      const push = pushOf(stream);
      push('{"op":"add","path":"/root","value":"main"}\n');
      push(
        '{"op":"add","path":"/elements/summary","value":{"type":"TextBlock","props":{"content":"Revenue grew 3x."}}}\n'
      );
      // A chart TITLE must not pollute the summary; a StatCard must surface
      // as a headline stat, not as prose.
      push(
        '{"op":"add","path":"/elements/chart","value":{"type":"BarChart","props":{"title":"Revenue by Month"}}}\n'
      );
      push(
        '{"op":"add","path":"/elements/kpi","value":{"type":"StatCard","props":{"label":"Total","value":600}}}\n'
      );
      push('{"op":"add","path":"/state/__cost","value":{"costUsd":0.12}}\n');
    }),
    assembleSpecFromPatches,
    getCachedArtifacts: vi.fn(() => ({
      code: "c",
      question: lastRun.question,
      results: { total_revenue: 600, growth_pct: 12.5 },
      chart_data: { by_month: Array.from({ length: 250 }, (_, i) => ({ m: i, v: i * 2 })) },
      datasets: { raw: [{ secret_row: "should-never-appear" }] },
      execution_ms: 10,
    })),
    persistHistoryEntry: vi.fn(async () => ({
      saved: true as const,
      // Cast: partial HistoryMeta — the tools read only .id.
      meta: { id: "hist-123" } as HistoryMeta,
    })),
    // Default: no persisted entries — the export_dashboard suite overrides
    // with a real-shaped entry (and a miniature dist for the real assembler).
    loadHistoryEntry: vi.fn(async (id: string) => {
      throw new Error(`no entry ${id}`);
    }),
    exportDashboardHtml, // real: pure over the distDir the caller supplies
    exportAppTemplateHtml, // real: pure over the distDir the caller supplies
    getActiveSandboxRuntime: vi.fn(() => "docker" as const),
    getCSVContent: vi.fn(async () => CSV_TEXT),
    // Live by default; individual tests flip it to exercise expiry.
    // Cast: partial StoredCSV — liveness only checks truthiness.
    getStoredCSV: vi.fn(
      () =>
        ({
          schema: {},
          filePath: "",
          createdAt: Date.now(),
        }) as unknown as NonNullable<ReturnType<McpDeps["getStoredCSV"]>>
    ),
    restoreStoredCSV: vi.fn(),
    getGeoJSONContent: vi.fn(async () => null),
    executeSandbox: vi.fn(async () => ({
      success: true as const,
      results: { total_revenue: 600 },
      chart_data: { by_month: Array.from({ length: 300 }, (_, i) => ({ i })) },
      images: {},
      execution_ms: 42,
      datasets: { raw: [{ month: "Jan", revenue: 100 }] },
    })),
    collectGroundedValues, // real: pure
    verifyGrounding, // real: pure — the engine under test
    validateSpec, // real: the enforcing gate under test
    catalogComponentNames: () => Object.keys(catalogComponents),
    // Remote/local parquet: validation+normalization real (pure); the
    // extractors are faked (they run docker); the ref stores are real
    // (in-memory maps under the test path roots).
    isSafeParquetUrl,
    normalizeRemoteParquetUrl,
    extractRemoteParquetSchema: vi.fn(async (_url: string, csvId: string, filename: string) =>
      extractSchema(parseCSV(CSV_TEXT), csvId, filename)
    ),
    storeRemoteParquetRef: vi.fn(storeRemoteParquetRef),
    extractParquetSchema: vi.fn(async (_p: string, csvId: string, filename: string) =>
      extractSchema(parseCSV(CSV_TEXT), csvId, filename)
    ),
    storeLocalFileRef: vi.fn(storeLocalFileRef),
    getFileInfo, // real: fs
    parseExcelMeta, // real: pure over a buffer
    sheetToCSV, // real: pure
    parseGeoJSON, // real: pure
    isGeoJSONObject, // real: pure
    storeGeoJSON, // real: writes under test scratch root
    toCSVText, // real: pure
    models: { codeGen: "model-a", uiCompose: "model-b" },
  };
}

/**
 * Test factory (review FIX 3): a complete McpDeps from the defaults above
 * with typed overrides — Partial<McpDeps> gives per-test fakes contextual
 * typing against the REAL member types, which is what removed the
 * `as unknown as McpDeps[...]` double-casts this file carried.
 */
function makeTestDeps(
  overrides: Partial<McpDeps> = {},
  connector: WarehouseConnector = fakeConnector("")
): McpDeps {
  return { ...fakeDeps(connector), ...overrides };
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
  dir = mkdtempSync(join(tmpdir(), "mcp-test-"));
  setPathRoots({ dataRoot: dir, scratchRoot: join(dir, "scratch"), userRoot: join(dir, "user") });
  clearSources();
  audit = [];
});
afterEach(() => {
  setPathRoots({});
  rmSync(dir, { recursive: true, force: true });
});

describe("mcp server (in-memory transport, fake deps)", () => {
  it("lists the v1 tool surface", async () => {
    const client = await connectedClient(fakeDeps(fakeConnector("")), audit);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "analyze",
      "analyze_cancel",
      "analyze_result",
      "analyze_start",
      "analyze_status",
      "audit_analysis",
      "connect_source",
      "dashboard_data",
      "edit_dashboard",
      "export_dashboard",
      "get_dashboard_plan",
      "get_schema",
      "list_sources",
      "persist_dashboard",
      "run_analysis",
      "run_sql",
      "verify_narrative",
    ]);
  });

  it("connect_source(csv) returns schema WITHOUT raw rows; get_schema matches", async () => {
    const csvPath = join(dir, "rev.csv");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(csvPath, CSV_TEXT);

    const client = await connectedClient(fakeDeps(fakeConnector("")), audit);
    const connected = parseToolJson(
      await client.callTool({ name: "connect_source", arguments: { path: csvPath } })
    );

    expect(connected.source_id).toBeTruthy();
    expect(connected.kind).toBe("csv");
    const schema = connected.schema as Record<string, unknown>;
    expect(schema.row_count).toBe(3);
    // THE boundary invariant: row-linked samples never appear anywhere.
    expect(JSON.stringify(connected)).not.toContain("sample_rows");

    const got = parseToolJson(
      await client.callTool({ name: "get_schema", arguments: { source_id: connected.source_id } })
    );
    expect((got.schema as Record<string, unknown>).row_count).toBe(3);
  });

  it("connect_source(connection) returns table summaries, never credentials", async () => {
    const client = await connectedClient(fakeDeps(fakeConnector("")), audit);
    const connected = parseToolJson(
      await client.callTool({ name: "connect_source", arguments: { connection_id: "conn-1" } })
    );
    expect(connected.kind).toBe("warehouse");
    expect(connected.table_count).toBe(1);
    const text = JSON.stringify(connected);
    expect(text).not.toContain("password");
    expect(text).not.toContain('"p"');
  });

  it("run_sql executes read-only SELECT with a row cap", async () => {
    const bigCsv = "n\n" + Array.from({ length: 500 }, (_, i) => i).join("\n") + "\n";
    const connector = fakeConnector(bigCsv);
    const client = await connectedClient(fakeDeps(connector), audit);
    const { source_id } = parseToolJson(
      await client.callTool({ name: "connect_source", arguments: { connection_id: "conn-1" } })
    ) as { source_id: string };

    const result = parseToolJson(
      await client.callTool({
        name: "run_sql",
        arguments: { source_id, sql: "SELECT n FROM t", max_rows: 10 },
      })
    );
    expect(result.row_count_returned).toBe(10);
    expect(result.truncated).toBe(true);
    expect(connector.executeSQL).toHaveBeenCalledWith("SELECT n FROM t");
  });

  it("run_sql rejects non-SELECT BEFORE the connector is touched", async () => {
    const connector = fakeConnector("x\n1\n");
    const client = await connectedClient(fakeDeps(connector), audit);
    const { source_id } = parseToolJson(
      await client.callTool({ name: "connect_source", arguments: { connection_id: "conn-1" } })
    ) as { source_id: string };

    const result = await client.callTool({
      name: "run_sql",
      arguments: { source_id, sql: "DROP TABLE orders" },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(connector.executeSQL).not.toHaveBeenCalled();
  });

  it("run_sql refuses csv sources with a redirect message", async () => {
    const csvPath = join(dir, "rev.csv");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(csvPath, CSV_TEXT);
    const client = await connectedClient(fakeDeps(fakeConnector("")), audit);
    const { source_id } = parseToolJson(
      await client.callTool({ name: "connect_source", arguments: { path: csvPath } })
    ) as { source_id: string };

    const result = parseToolJson(
      await client.callTool({ name: "run_sql", arguments: { source_id, sql: "SELECT 1" } })
    );
    expect(String(result.error)).toContain("run_analysis");
  });

  it("audits every call with outcome and duration; errors audited too", async () => {
    const client = await connectedClient(fakeDeps(fakeConnector("")), audit);
    await client.callTool({ name: "list_sources", arguments: {} });
    await client.callTool({ name: "get_schema", arguments: { source_id: "nope" } });

    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({ tool: "list_sources", outcome: "ok" });
    expect(audit[1]).toMatchObject({ tool: "get_schema", outcome: "error" });
    expect(audit[1].error).toContain("Unknown source_id");
    for (const e of audit) expect(e.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("analyze (fake pipeline)", () => {
  it("returns summary, cost, and the dashboard link from the persisted id", async () => {
    const csvPath = join(dir, "rev.csv");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(csvPath, CSV_TEXT);
    const deps = fakeDeps(fakeConnector(""));
    const client = await connectedClient(deps, audit);
    const { source_id } = parseToolJson(
      await client.callTool({ name: "connect_source", arguments: { path: csvPath } })
    ) as { source_id: string };

    const result = parseToolJson(
      await client.callTool({
        name: "analyze",
        arguments: { source_id, question: "How is revenue trending?" },
      })
    );
    expect(result.summary).toContain("Revenue grew 3x.");
    expect(result.history_id).toBe("hist-123");
    // The run's correlation id joins the response to logs/diagnostics/cost
    // rows, and withAudit stamps it into the audit line.
    expect(result.run_id).toBe("run-test-1");
    expect(audit.find((e) => e.tool === "analyze")?.runId).toBe("run-test-1");
    expect(String(result.dashboard_url)).toContain("restore=hist-123");
    // The single-file download link rides beside dashboard_url (0.4.0) so a
    // host can offer "share this" without a second tool call.
    expect(String(result.export_url)).toContain("/api/export/hist-123");
    expect((result.cost as { costUsd: number }).costUsd).toBe(0.12);
    expect(result.element_count).toBe(3);
    // Chart titles are labels, not findings — they must not appear as prose.
    expect(result.summary).not.toContain("Revenue by Month");
    expect(result.headline_stats).toEqual([{ label: "Total", value: 600 }]);
    // The computed values come back — no recomputation needed for a
    // follow-up number, and verify_narrative has something to check.
    expect((result.results as Record<string, number>).total_revenue).toBe(600);
    expect((result.chart_data as { by_month: unknown[] }).by_month).toHaveLength(100);
    expect(result.chart_data_truncated_keys).toEqual(["by_month"]);
    // Row-level datasets still never cross the boundary.
    expect(JSON.stringify(result)).not.toContain("should-never-appear");
  });

  it("does NOT return artifacts computed for a DIFFERENT question (concurrency guard)", async () => {
    const csvPath = join(dir, "rev.csv");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(csvPath, CSV_TEXT);
    // Simulate another run having overwritten the csvId-keyed cache.
    const deps = makeTestDeps({
      getCachedArtifacts: vi.fn(() => ({
        code: "c",
        question: "a completely different question",
        results: { someone_elses: 999 },
        chart_data: {},
        datasets: {},
        execution_ms: 1,
      })),
    });
    const client = await connectedClient(deps, audit);
    const { source_id } = parseToolJson(
      await client.callTool({ name: "connect_source", arguments: { path: csvPath } })
    ) as { source_id: string };

    const result = parseToolJson(
      await client.callTool({ name: "analyze", arguments: { source_id, question: "my question" } })
    );
    // The narrative is this run's; the other run's numbers must NOT ride along.
    expect(result.summary).toContain("Revenue grew 3x.");
    expect(JSON.stringify(result)).not.toContain("someone_elses");
  });

  it("surfaces pipeline errors as tool errors (no persist)", async () => {
    const csvPath = join(dir, "rev.csv");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(csvPath, CSV_TEXT);
    // What a failing Ask run actually emits since the error-channel unify:
    // the typed `/state/__error` message PLUS the UI error spec.
    const deps = makeTestDeps({
      runAskQuery: async ({ stream }: { stream: unknown }) => {
        const push = pushOf(stream);
        push('{"op":"add","path":"/state/__error","value":"sandbox exploded"}\n');
        push('{"op":"add","path":"/root","value":"error"}\n');
      },
    });
    const client = await connectedClient(deps, audit);
    const { source_id } = parseToolJson(
      await client.callTool({ name: "connect_source", arguments: { path: csvPath } })
    ) as { source_id: string };

    const result = await client.callTool({
      name: "analyze",
      arguments: { source_id, question: "?" },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(deps.persistHistoryEntry).not.toHaveBeenCalled();
    const payload = parseToolJson(result);
    // The REAL message, not the old literal "pipeline error" fallback.
    expect(String(payload.error)).toContain("sandbox exploded");
    expect(String(payload.error)).not.toContain("pipeline error");
  });

  it("warehouse analyze passes the discriminated warehouse source and persists under the materialized csvId", async () => {
    const deps = makeTestDeps({
      runAskQuery: async ({
        stream,
        runState,
        source,
      }: {
        stream: unknown;
        runState: { csvId?: string };
        source: { kind: string; warehouseState?: unknown };
      }) => {
        // The union discriminates: a warehouse run arrives as kind
        // "warehouse" with the live state attached, no null field to probe.
        expect(source.kind).toBe("warehouse");
        expect(source.warehouseState).toBeTruthy();
        runState.csvId = "materialized-42";
        const push = pushOf(stream);
        push('{"op":"add","path":"/root","value":"main"}\n');
        push(
          '{"op":"add","path":"/elements/a","value":{"type":"TextBlock","props":{"content":"hi"}}}\n'
        );
      },
    });
    const client = await connectedClient(deps, audit);
    const { source_id } = parseToolJson(
      await client.callTool({ name: "connect_source", arguments: { connection_id: "conn-1" } })
    ) as { source_id: string };

    const result = parseToolJson(
      await client.callTool({ name: "analyze", arguments: { source_id, question: "q" } })
    );
    expect(deps.persistHistoryEntry).toHaveBeenCalledWith(
      "materialized-42",
      expect.anything(),
      "q"
    );
    expect(deps.storeWarehouse).toHaveBeenCalled();
    expect(result.history_id).toBe("hist-123");
  });
});

describe("run_analysis (fake sandbox)", () => {
  async function csvSource(deps: McpDeps) {
    const csvPath = join(dir, "rev.csv");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(csvPath, CSV_TEXT);
    const client = await connectedClient(deps, audit);
    const { source_id } = parseToolJson(
      await client.callTool({ name: "connect_source", arguments: { path: csvPath } })
    ) as { source_id: string };
    return { client, source_id };
  }

  it("forces network-deny docker execution and withholds datasets", async () => {
    const deps = fakeDeps(fakeConnector(""));
    const { client, source_id } = await csvSource(deps);
    const result = parseToolJson(
      await client.callTool({
        name: "run_analysis",
        arguments: { source_id, python: "results['x']=1" },
      })
    );
    expect(deps.executeSandbox).toHaveBeenCalledWith(
      CSV_TEXT,
      "results['x']=1",
      expect.objectContaining({ runtime: "docker", network: "deny" })
    );
    expect((result.results as Record<string, unknown>).total_revenue).toBe(600);
    // Row-level datasets never cross the boundary: no datasets key, and the
    // row values themselves are absent from the payload.
    expect(result.datasets).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('"month":"Jan"');
    // chart_data capped at 200 rows with the truncated key reported.
    expect((result.chart_data as { by_month: unknown[] }).by_month).toHaveLength(100);
    expect(result.chart_data_truncated_keys).toEqual(["by_month"]);
  });

  it("surfaces sandbox failure kind in the error", async () => {
    const deps = makeTestDeps({
      executeSandbox: vi.fn(async () => ({
        success: false as const,
        error: "killed",
        errorKind: "oom" as const,
        execution_ms: 5,
      })),
    });
    const { client, source_id } = await csvSource(deps);
    const result = await client.callTool({
      name: "run_analysis",
      arguments: { source_id, python: "x" },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(String(parseToolJson(result).error)).toContain("(oom)");
  });
});

describe("verify_narrative (real grounding engine)", () => {
  it("passes grounded prose and flags fabricated figures", async () => {
    const deps = fakeDeps(fakeConnector(""));
    const client = await connectedClient(deps, audit);

    const good = parseToolJson(
      await client.callTool({
        name: "verify_narrative",
        arguments: {
          prose: "Total revenue reached 600 this quarter.",
          results: { total_revenue: 600 },
        },
      })
    );
    expect(good.ok).toBe(true);

    const bad = parseToolJson(
      await client.callTool({
        name: "verify_narrative",
        arguments: {
          prose: "Revenue hit $4.7M, up 312.5% year over year.",
          results: { total_revenue: 600 },
        },
      })
    );
    expect(bad.ok).toBe(false);
    expect((bad.ungrounded as string[]).length).toBeGreaterThan(0);
  });

  it("requires computed outputs", async () => {
    const deps = fakeDeps(fakeConnector(""));
    const client = await connectedClient(deps, audit);
    const result = await client.callTool({
      name: "verify_narrative",
      arguments: { prose: "Revenue is 5." },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
  });
});

describe("connect_source: cloud URLs, parquet paths, excel, geojson", () => {
  it("connects a cloud parquet URL; env creds resolved server-side, never in the response", async () => {
    const deps = fakeDeps(fakeConnector(""));
    const client = await connectedClient(deps, audit);
    const prevEnv = { ...process.env };
    process.env.AWS_ACCESS_KEY_ID = "AKIA_TEST";
    process.env.AWS_SECRET_ACCESS_KEY = "supersecret";
    try {
      const result = parseToolJson(
        await client.callTool({
          name: "connect_source",
          arguments: { url: "s3://bucket/data/trips.parquet" },
        })
      );
      expect(result.source_id).toBeTruthy();
      expect(JSON.stringify(result)).not.toContain("supersecret");
      expect(JSON.stringify(result)).not.toContain("AKIA_TEST");
      const call = vi.mocked(deps.storeRemoteParquetRef).mock.calls[0];
      expect((call[3] as { s3SecretAccessKey?: string })?.s3SecretAccessKey).toBe("supersecret");
    } finally {
      process.env = prevEnv;
    }
  });

  it("rejects unsafe URLs before any extraction", async () => {
    const deps = fakeDeps(fakeConnector(""));
    const client = await connectedClient(deps, audit);
    const result = await client.callTool({
      name: "connect_source",
      arguments: { url: "s3://bucket/x'; DROP--" },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(deps.extractRemoteParquetSchema).not.toHaveBeenCalled();
  });

  it("run_analysis refuses remote and path-based sources (network/mount policy)", async () => {
    const deps = fakeDeps(fakeConnector(""));
    const client = await connectedClient(deps, audit);
    const { source_id } = parseToolJson(
      await client.callTool({
        name: "connect_source",
        arguments: { url: "https://example.com/data.parquet" },
      })
    ) as { source_id: string };
    const result = await client.callTool({
      name: "run_analysis",
      arguments: { source_id, python: "x" },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(String(parseToolJson(result).error)).toContain("analyze");
  });

  it("connects a local parquet file as a path-based source", async () => {
    const deps = fakeDeps(fakeConnector(""));
    const client = await connectedClient(deps, audit);
    const pq = join(dir, "events.parquet");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(pq, "PAR1fake");
    const result = parseToolJson(
      await client.callTool({ name: "connect_source", arguments: { path: pq } })
    );
    expect(result.source_id).toBeTruthy();
    expect(deps.extractParquetSchema).toHaveBeenCalledWith(
      pq,
      expect.any(String),
      "events.parquet",
      false,
      "docker",
      undefined
    );
    expect(deps.storeLocalFileRef).toHaveBeenCalled();
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

    const deps = fakeDeps(fakeConnector(""));
    const client = await connectedClient(deps, audit);

    const listing = parseToolJson(
      await client.callTool({ name: "connect_source", arguments: { path: xlsxPath } })
    );
    expect(listing.needs_sheet).toBe(true);
    expect((listing.sheets as Array<{ name: string }>).map((sh) => sh.name)).toEqual([
      "Revenue",
      "Costs",
    ]);

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

  it("connects GeoJSON and rejects non-GeoJSON .json", async () => {
    const { writeFileSync } = await import("node:fs");
    const geoPath = join(dir, "places.geojson");
    writeFileSync(
      geoPath,
      JSON.stringify({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [0, 0] },
            properties: { name: "Origin", population: 5 },
          },
        ],
      })
    );
    const deps = fakeDeps(fakeConnector(""));
    const client = await connectedClient(deps, audit);
    const ok = parseToolJson(
      await client.callTool({ name: "connect_source", arguments: { path: geoPath } })
    );
    expect((ok.schema as { has_geojson: boolean }).has_geojson).toBe(true);

    const plainPath = join(dir, "config.json");
    writeFileSync(plainPath, JSON.stringify({ hello: "world" }));
    const bad = await client.callTool({
      name: "connect_source",
      arguments: { path: plainPath },
    });
    expect((bad as { isError?: boolean }).isError).toBe(true);
  });
});

describe("expired sources fail with an actionable message (reliability #1)", () => {
  async function expiredCsvClient() {
    const csvPath = join(dir, "rev.csv");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(csvPath, CSV_TEXT);
    const deps = fakeDeps(fakeConnector(""));
    const client = await connectedClient(deps, audit);
    const { source_id } = parseToolJson(
      await client.callTool({ name: "connect_source", arguments: { path: csvPath } })
    ) as { source_id: string };
    // The underlying store entry idles out while the registry still holds it.
    deps.getStoredCSV = vi.fn(() => undefined);
    return { client, source_id, csvPath, deps };
  }

  it("analyze names the source, the cause, and the exact re-attach call", async () => {
    const { client, source_id, csvPath } = await expiredCsvClient();
    const res = await client.callTool({
      name: "analyze",
      arguments: { source_id, question: "q" },
    });
    expect((res as { isError?: boolean }).isError).toBe(true);
    const msg = String(parseToolJson(res).error);
    expect(msg).toContain("rev.csv");
    expect(msg).toContain("no longer in hermetic's store");
    expect(msg).toContain("connect_source");
    expect(msg).toContain(csvPath); // the exact path to replay
    expect(msg).toContain("NEW source_id");
  });

  it("run_analysis and persist_dashboard fail the same way, not with raw errors", async () => {
    const { client, source_id } = await expiredCsvClient();
    for (const call of [
      { name: "run_analysis", arguments: { source_id, python: "x" } },
      {
        name: "persist_dashboard",
        arguments: { source_id, title: "t", spec: { root: "r", elements: {} } },
      },
    ]) {
      const res = await client.callTool(call);
      expect((res as { isError?: boolean }).isError).toBe(true);
      expect(String(parseToolJson(res).error)).toContain("connect_source");
    }
  });

  it("a dead warehouse connection says how to reconnect instead of leaking a driver error", async () => {
    const deps = fakeDeps(fakeConnector(""));
    const client = await connectedClient(deps, audit);
    const { source_id } = parseToolJson(
      await client.callTool({ name: "connect_source", arguments: { connection_id: "conn-1" } })
    ) as { source_id: string };
    // Sweeper closed the connector and dropped the store entry.
    deps.getWarehouseState = vi.fn(() => undefined);

    const res = await client.callTool({
      name: "run_sql",
      arguments: { source_id, sql: "SELECT 1" },
    });
    expect((res as { isError?: boolean }).isError).toBe(true);
    const msg = String(parseToolJson(res).error);
    expect(msg).toContain("closed");
    expect(msg).toContain('connection_id: "conn-1"');
    // The connector must never have been touched.
    expect(vi.mocked(deps.createConnector).mock.results[0].value.executeSQL).not.toHaveBeenCalled();
  });
});

describe("progress reporting for long runs", () => {
  it("maps pipeline patches to host-facing progress updates", async () => {
    const { progressFromPatch } = await import("../tools/analyze");
    expect(
      progressFromPatch({
        path: "/state/__progress",
        value: { stage: "code_gen", step: 1, total: 3 },
      })
    ).toEqual({
      stage: "code_gen",
      step: 1,
      total: 3,
    });
    // Sandbox execution reports a fraction — surfaced as percent complete.
    expect(
      progressFromPatch({
        path: "/state/__exec",
        value: { phase: "scanning", detail: "12M rows", fraction: 0.5 },
      })
    ).toEqual({ stage: "executing: scanning", detail: "12M rows", step: 50, total: 100 });
    // Non-progress patches are ignored.
    expect(progressFromPatch({ path: "/root", value: "main" })).toBeNull();
    expect(progressFromPatch({ path: "/state/__cost", value: {} })).toBeNull();
  });

  it("sends nothing when the host did not request progress", async () => {
    const { progressReporterFor } = await import("../server");
    expect(progressReporterFor(undefined)).toBeUndefined();
    expect(progressReporterFor({ sendNotification: async () => {} })).toBeUndefined();
    expect(progressReporterFor({ _meta: { progressToken: "t" } })).toBeUndefined();
  });

  it("advances monotonically when the pipeline reports no step/total", async () => {
    const { progressReporterFor } = await import("../server");
    const sent: Array<{ progress: number; message?: string }> = [];
    const report = progressReporterFor({
      _meta: { progressToken: "tok" },
      sendNotification: async (n) => void sent.push(n.params),
    })!;
    report({ stage: "starting" });
    report({ stage: "code_gen" });
    report({ stage: "executing", detail: "scanning" });
    expect(sent.map((x) => x.progress)).toEqual([1, 2, 3]);
    expect(sent[2].message).toBe("executing — scanning");
  });

  it("delivers progress notifications to a real client during analyze", async () => {
    const csvPath = join(dir, "rev.csv");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(csvPath, CSV_TEXT);
    // A pipeline that reports two stages before finishing.
    const deps = makeTestDeps({
      runAskQuery: async ({ stream, question }: { stream: unknown; question: string }) => {
        const push = pushOf(stream);
        push(
          '{"op":"add","path":"/state/__progress","value":{"stage":"code_gen","step":1,"total":3}}\n'
        );
        push('{"op":"add","path":"/state/__exec","value":{"phase":"executing","fraction":0.5}}\n');
        push('{"op":"add","path":"/root","value":"main"}\n');
        push(
          '{"op":"add","path":"/elements/s","value":{"type":"TextBlock","props":{"content":"Done. ' +
            question +
            '"}}}\n'
        );
      },
    });

    const server = buildMcpServer(deps, (e) => audit.push(e));
    const client = new Client({ name: "progress-test", version: "0.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);

    const seen: string[] = [];
    const { source_id } = parseToolJson(
      await client.callTool({ name: "connect_source", arguments: { path: csvPath } })
    ) as { source_id: string };

    await client.callTool({ name: "analyze", arguments: { source_id, question: "q" } }, undefined, {
      onprogress: (p: { message?: string }) => void seen.push(p.message ?? ""),
    });

    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.join(" | ")).toContain("code_gen");
    expect(seen.join(" | ")).toContain("executing");
  });
});

describe("host-facing coherence (review fixes)", () => {
  it("advertises per-source capabilities so the host never has to probe", async () => {
    const deps = fakeDeps(fakeConnector(""));
    const client = await connectedClient(deps, audit);
    const wh = parseToolJson(
      await client.callTool({ name: "connect_source", arguments: { connection_id: "conn-1" } })
    );
    expect(wh.source_type).toBe("warehouse");
    expect(wh.supported_tools).toContain("run_sql");
    expect(Object.keys(wh.unsupported_tools as object)).toContain("run_analysis");

    const url = parseToolJson(
      await client.callTool({
        name: "connect_source",
        arguments: { url: "s3://b/x.parquet" },
      })
    );
    // A cloud source reports kind "csv" for storage reasons — the capability
    // block is what tells the host it is NOT run_analysis-able.
    expect(url.kind).toBe("csv");
    expect(url.source_type).toBe("cloud-parquet");
    expect(Object.keys(url.unsupported_tools as object)).toContain("run_analysis");

    const listed = parseToolJson(await client.callTool({ name: "list_sources", arguments: {} }));
    expect((listed.sources as Array<{ source_type: string }>).map((x) => x.source_type)).toEqual([
      "warehouse",
      "cloud-parquet",
    ]);
  });

  it("rewrites web-app error phrasing into MCP affordances", async () => {
    const { mcpifyError } = await import("../tools/analyze");
    expect(mcpifyError("CSV not found or expired. Please re-upload.")).toContain("connect_source");
    // The exact prose run-ask-query emits — the earlier regex left
    // " your data." dangling after the substitution.
    expect(mcpifyError("CSV content not found. Please re-upload your data.")).toBe(
      "CSV content not found. Call connect_source again to re-attach the source."
    );
    expect(mcpifyError("Source file has been modified. Please re-select the file.")).toContain(
      "connect_source"
    );
    expect(mcpifyError("some other failure")).toBe("some other failure");
  });

  it("rotates mcp-audit.jsonl past the size cap (single .1 generation)", async () => {
    const { fileAuditSink, AUDIT_ROTATE_BYTES } = await import("../audit");
    const { hermeticPaths } = await import("@/lib/paths");
    const { writeFileSync, statSync, readFileSync, mkdirSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    const file = hermeticPaths.mcpAuditFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "x".repeat(AUDIT_ROTATE_BYTES + 1));
    const sink = fileAuditSink();
    sink({ ts: "t", tool: "analyze", args: {}, outcome: "ok", durationMs: 1 });
    // Old contents moved aside, fresh file holds only the new entry.
    expect(statSync(`${file}.1`).size).toBeGreaterThan(AUDIT_ROTATE_BYTES);
    expect(readFileSync(file, "utf-8")).toContain('"tool":"analyze"');
    expect(statSync(file).size).toBeLessThan(1000);
  });

  it("audit redacts presigned-URL query strings", async () => {
    const { redactUrl } = await import("../audit");
    expect(redactUrl("https://b.s3.amazonaws.com/x.parquet?X-Amz-Signature=deadbeef")).toBe(
      "https://b.s3.amazonaws.com/x.parquet?<query-redacted>"
    );
    const deps = fakeDeps(fakeConnector(""));
    const client = await connectedClient(deps, audit);
    await client.callTool({
      name: "connect_source",
      arguments: { url: "s3://b/x.parquet?X-Amz-Credential=SECRETKEY" },
    });
    expect(JSON.stringify(audit)).not.toContain("SECRETKEY");
  });

  it("rejects `sheet` on a non-xlsx path instead of ignoring it", async () => {
    const csvPath = join(dir, "rev.csv");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(csvPath, CSV_TEXT);
    const client = await connectedClient(fakeDeps(fakeConnector("")), audit);
    const res = await client.callTool({
      name: "connect_source",
      arguments: { path: csvPath, sheet: "Q3" },
    });
    expect((res as { isError?: boolean }).isError).toBe(true);
  });
});

describe("persist_dashboard (real catalog validation — ENFORCING)", () => {
  async function csvClient(deps: McpDeps) {
    const csvPath = join(dir, "rev.csv");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(csvPath, CSV_TEXT);
    const client = await connectedClient(deps, audit);
    const { source_id } = parseToolJson(
      await client.callTool({ name: "connect_source", arguments: { path: csvPath } })
    ) as { source_id: string };
    return { client, source_id };
  }

  it("rejects an invalid spec with the validation reason; persists nothing", async () => {
    const deps = fakeDeps(fakeConnector(""));
    const { client, source_id } = await csvClient(deps);
    const result = await client.callTool({
      name: "persist_dashboard",
      arguments: {
        source_id,
        title: "bad",
        spec: { root: "x", elements: { x: { type: "NoSuchComponent", props: {} } } },
      },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    const msg = String(parseToolJson(result).error);
    expect(msg).toContain("rejected by catalog validation");
    // The host must not have to guess component names (review S4).
    expect(msg).toContain("Valid component types:");
    expect(msg).toContain("StatCard");
    expect(deps.persistHistoryEntry).not.toHaveBeenCalled();
  });

  it("persists a valid spec and returns the viewer link", async () => {
    const deps = fakeDeps(fakeConnector(""));
    const { client, source_id } = await csvClient(deps);
    const result = parseToolJson(
      await client.callTool({
        name: "persist_dashboard",
        arguments: {
          source_id,
          title: "Revenue overview",
          // A REAL catalog component with its canonical sample props — the
          // enforcing validator accepts only genuine catalog specs.
          spec: {
            root: "root",
            elements: {
              root: {
                type: "TextBlock",
                props: (await import("@/lib/__tests__/fixtures/catalog-samples"))
                  .ALL_CATALOG_SAMPLES.TextBlock,
                children: [],
              },
            },
          },
        },
      })
    );
    expect(result.history_id).toBe("hist-123");
    expect(String(result.dashboard_url)).toContain("restore=hist-123");
  });
});

describe("export_dashboard (real assembler over a miniature dist)", () => {
  const ENTRY_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

  /** The html-export test fixture pattern: a dist the test controls fully. */
  async function makeMiniDist(): Promise<string> {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const dist = join(dir, "mini-dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(
      join(dist, "export-manifest.json"),
      JSON.stringify({
        fullOnlyTypes: ["Globe3D"],
        profiles: {
          standard: { js: "export-standard.js", css: "export-standard.css", bytes: 10 },
          full: { js: "export-full.js", css: "export-full.css", bytes: 20 },
        },
      })
    );
    writeFileSync(join(dist, "export-app.css"), ":root{--x:1}");
    writeFileSync(join(dist, "export-standard.js"), "/*standard*/");
    writeFileSync(join(dist, "export-standard.css"), ".std{}");
    writeFileSync(join(dist, "export-full.js"), "/*full*/");
    writeFileSync(join(dist, "export-full.css"), ".full{}");
    return dist;
  }

  function exportDeps(miniDist: string) {
    return makeTestDeps({
      loadHistoryEntry: vi.fn(async (id: string) => ({
        // Cast: partial HistoryMeta — the tool reads question + timestamp.
        meta: {
          id,
          question: "Revenue by region?",
          timestamp: Date.parse("2026-08-05T00:00:00Z"),
        } as HistoryMeta,
        spec: {
          root: "r",
          elements: {
            r: { type: "LayoutColumn", props: {}, children: ["c"] },
            c: { type: "BarChart", props: { title: "T" }, children: [] },
          },
          state: { datasets: { main: [{ a: 1 }] }, __cost: { usd: 1 } },
        },
        generatedCode: "",
        schema: {} as CSVSchema,
      })),
      // The REAL assembler, pointed at the miniature dist instead of the
      // repo's viewer build.
      exportDashboardHtml: vi.fn((input: ExportInput) =>
        exportDashboardHtml({ ...input, distDir: miniDist })
      ),
    });
  }

  it("writes the self-contained file and reports both handles + size honesty", async () => {
    const { existsSync, readFileSync } = await import("node:fs");
    const deps = exportDeps(await makeMiniDist());
    const client = await connectedClient(deps, audit);

    const result = parseToolJson(
      await client.callTool({ name: "export_dashboard", arguments: { history_id: ENTRY_ID } })
    );

    // Default path: data/exports/<id>.html under the (test) data root.
    expect(result.file_path).toBe(join(dir, "exports", `${ENTRY_ID}.html`));
    expect(isAbsolute(result.file_path as string)).toBe(true);
    const html = readFileSync(result.file_path as string, "utf-8");
    expect(html).toContain("/*standard*/");
    expect(html).toContain('id="hermetic-spec"');
    expect(html).toContain("Revenue by region?");
    // Internal state stripped on the way out (governance floor).
    expect(html).not.toContain("__cost");
    expect(existsSync(result.file_path as string)).toBe(true);

    expect(String(result.export_url)).toContain(`/api/export/${ENTRY_ID}`);
    expect(result.bundle).toBe("standard");
    expect(result.size_bytes).toBeGreaterThan(0);
    expect(result.element_count).toBe(2);
    expect(result.full_only_types_used).toEqual([]);

    expect(audit.find((e) => e.tool === "export_dashboard")).toMatchObject({ outcome: "ok" });
  });

  it("honors an absolute out_path and rejects a relative one", async () => {
    const deps = exportDeps(await makeMiniDist());
    const client = await connectedClient(deps, audit);
    const outPath = join(dir, "custom", "report.html");

    const ok = parseToolJson(
      await client.callTool({
        name: "export_dashboard",
        arguments: { history_id: ENTRY_ID, out_path: outPath },
      })
    );
    expect(ok.file_path).toBe(outPath);
    const { existsSync } = await import("node:fs");
    expect(existsSync(outPath)).toBe(true);

    const bad = await client.callTool({
      name: "export_dashboard",
      arguments: { history_id: ENTRY_ID, out_path: "relative/report.html" },
    });
    expect((bad as { isError?: boolean }).isError).toBe(true);
    expect(parseToolJson(bad).code).toBe("invalid_input");
  });

  it("rejects malformed and unknown ids as invalid_input", async () => {
    const deps = exportDeps(await makeMiniDist());
    const client = await connectedClient(deps, audit);

    const malformed = await client.callTool({
      name: "export_dashboard",
      arguments: { history_id: "not-a-uuid" },
    });
    expect((malformed as { isError?: boolean }).isError).toBe(true);
    expect(parseToolJson(malformed).code).toBe("invalid_input");
    // Malformed ids never reach the store.
    expect(deps.loadHistoryEntry).not.toHaveBeenCalled();

    // Valid UUID, no such entry (the DEFAULT loadHistoryEntry fake throws).
    const bareClient = await connectedClient(makeTestDeps({}), audit);
    const unknown = await bareClient.callTool({
      name: "export_dashboard",
      arguments: { history_id: "aaaaaaaa-bbbb-4ccc-8ddd-000000000000" },
    });
    expect((unknown as { isError?: boolean }).isError).toBe(true);
    expect(parseToolJson(unknown).code).toBe("invalid_input");
  });

  it("names the build step when the export bundles are missing", async () => {
    // A distDir with no export-manifest.json — the assembler's ENOENT.
    const deps = makeTestDeps({
      loadHistoryEntry: exportDeps(await makeMiniDist()).loadHistoryEntry,
      exportDashboardHtml: vi.fn((input: ExportInput) =>
        exportDashboardHtml({ ...input, distDir: join(dir, "no-such-dist") })
      ),
    });
    const client = await connectedClient(deps, audit);
    const res = await client.callTool({
      name: "export_dashboard",
      arguments: { history_id: ENTRY_ID },
    });
    expect((res as { isError?: boolean }).isError).toBe(true);
    const payload = parseToolJson(res);
    expect(payload.code).toBe("execution_failed");
    expect(String(payload.error)).toContain("pnpm mcp:build-viewer");
  });
});

describe("sanitizeArgs", () => {
  it("truncates code/sql previews and replaces objects", () => {
    const out = sanitizeArgs({
      sql: "SELECT " + "x".repeat(300),
      source_id: "abc",
      spec: { root: "r", elements: {} },
      max_rows: 5,
    });
    expect((out.sql as string).length).toBeLessThanOrEqual(201);
    expect(out.spec).toBe("<object>");
    expect(out.max_rows).toBe(5);
    expect(out.source_id).toBe("abc");
  });
});

describe("RPC hygiene (spec §8): error codes, truncation flags, contract version", () => {
  it("errors carry a taxonomy code on the wire and in the audit line", async () => {
    const connector = fakeConnector("x\n1\n");
    const client = await connectedClient(fakeDeps(connector), audit);

    const unknown = parseToolJson(
      await client.callTool({ name: "get_schema", arguments: { source_id: "nope" } })
    );
    expect(unknown.code).toBe("unknown_source");

    const { source_id } = parseToolJson(
      await client.callTool({ name: "connect_source", arguments: { connection_id: "conn-1" } })
    ) as { source_id: string };
    const rejected = parseToolJson(
      await client.callTool({ name: "run_sql", arguments: { source_id, sql: "DROP TABLE t" } })
    );
    expect(rejected.code).toBe("sql_rejected");

    const errorEntries = audit.filter((e) => e.outcome === "error");
    expect(errorEntries.map((e) => e.code)).toEqual(["unknown_source", "sql_rejected"]);
  });

  it("uncoded failures fall back to code 'internal'", async () => {
    const connector = fakeConnector("");
    (connector.executeSQL as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("driver exploded")
    );
    const client = await connectedClient(fakeDeps(connector), audit);
    const { source_id } = parseToolJson(
      await client.callTool({ name: "connect_source", arguments: { connection_id: "conn-1" } })
    ) as { source_id: string };
    const res = parseToolJson(
      await client.callTool({ name: "run_sql", arguments: { source_id, sql: "SELECT 1" } })
    );
    expect(res.code).toBe("internal");
  });

  it("get_schema flags column truncation instead of silently capping", async () => {
    const wide =
      Array.from({ length: 90 }, (_, i) => `c${i}`).join(",") +
      "\n" +
      Array.from({ length: 90 }, (_, i) => String(i)).join(",") +
      "\n";
    const csvPath = join(dir, "wide.csv");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(csvPath, wide);
    const client = await connectedClient(fakeDeps(fakeConnector("")), audit);
    const res = parseToolJson(
      await client.callTool({ name: "connect_source", arguments: { path: csvPath } })
    );
    const schema = res.schema as {
      columns: unknown[];
      column_count: number;
      truncated_columns: number;
    };
    expect(schema.columns).toHaveLength(80);
    expect(schema.column_count).toBe(90);
    expect(schema.truncated_columns).toBe(10);
  });

  it("list_sources reports the contract version", async () => {
    const client = await connectedClient(fakeDeps(fakeConnector("")), audit);
    const res = parseToolJson(await client.callTool({ name: "list_sources", arguments: {} }));
    expect(res.contract_version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("MCP Apps (SEP-1865): template resource, tool linkage, gated structuredContent", () => {
  const UI_URI = "ui://hermetic/dashboard";
  const UI_MIME = "text/html;profile=mcp-app";
  const UI_CAPS = {
    extensions: { "io.modelcontextprotocol/ui": { mimeTypes: [UI_MIME] } },
  };

  /** A client that negotiated the ui extension (Claude Desktop's shape). */
  async function uiClient(deps: McpDeps) {
    const server = buildMcpServer(deps, (e) => audit.push(e));
    const client = new Client({ name: "ui-client", version: "0.0.0" }, { capabilities: UI_CAPS });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return client;
  }

  const VALID_SPEC = async () => ({
    root: "root",
    elements: {
      root: {
        type: "TextBlock",
        props: (await import("@/lib/__tests__/fixtures/catalog-samples")).ALL_CATALOG_SAMPLES
          .TextBlock,
        children: [],
      },
    },
  });

  async function csvSource(client: Client) {
    const csvPath = join(dir, "apps.csv");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(csvPath, CSV_TEXT);
    const { source_id } = parseToolJson(
      await client.callTool({ name: "connect_source", arguments: { path: csvPath } })
    ) as { source_id: string };
    return source_id;
  }

  it("dashboard-producing tools declare the template in _meta.ui; others don't", async () => {
    const client = await connectedClient(makeTestDeps(), audit);
    const { tools } = await client.listTools();
    for (const name of ["analyze", "persist_dashboard"]) {
      const meta = tools.find((t) => t.name === name)?._meta as
        | { ui?: { resourceUri?: string }; "ui/resourceUri"?: string }
        | undefined;
      expect(meta?.ui?.resourceUri).toBe(UI_URI);
      // The deprecated flat key rides along for pre-final hosts.
      expect(meta?.["ui/resourceUri"]).toBe(UI_URI);
    }
    const schemaMeta = tools.find((t) => t.name === "get_schema")?._meta as
      | { ui?: unknown }
      | undefined;
    expect(schemaMeta?.ui).toBeUndefined();
  });

  it("serves the data-less template at ui://hermetic/dashboard with the app mimeType", async () => {
    // The same miniature dist trick as export_dashboard: the REAL assembler
    // over a dist the test owns.
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const miniDist = join(dir, "app-dist");
    mkdirSync(miniDist, { recursive: true });
    writeFileSync(
      join(miniDist, "export-manifest.json"),
      JSON.stringify({
        fullOnlyTypes: [],
        profiles: {
          standard: { js: "export-standard.js", css: "export-standard.css", bytes: 10 },
          full: { js: "export-full.js", css: "export-full.css", bytes: 20 },
        },
      })
    );
    writeFileSync(join(miniDist, "export-app.css"), ":root{--x:1}");
    writeFileSync(join(miniDist, "export-standard.js"), "/*standard*/");
    writeFileSync(join(miniDist, "export-standard.css"), ".std{}");
    const deps = makeTestDeps({
      exportAppTemplateHtml: vi.fn(() => exportAppTemplateHtml({ distDir: miniDist })),
    });
    const client = await uiClient(deps);

    const { resources } = await client.listResources();
    const listed = resources.find((r) => r.uri === UI_URI);
    expect(listed?.mimeType).toBe(UI_MIME);

    const read = await client.readResource({ uri: UI_URI });
    const item = read.contents[0] as { mimeType?: string; text?: string };
    expect(item.mimeType).toBe(UI_MIME);
    expect(item.text).toContain("/*standard*/");
    expect(item.text).toContain('"mode":"mcp-app"');
    expect(item.text).not.toContain('id="hermetic-spec"');
  });

  it("persist_dashboard returns the spec as structuredContent to a ui-capable client", async () => {
    const deps = makeTestDeps();
    const client = await uiClient(deps);
    const source_id = await csvSource(client);
    const result = await client.callTool({
      name: "persist_dashboard",
      arguments: { source_id, title: "Revenue overview", spec: await VALID_SPEC() },
    });

    const sc = (result as { structuredContent?: Record<string, unknown> }).structuredContent;
    expect(sc).toBeTruthy();
    expect(sc?.question).toBe("Revenue overview");
    expect((sc?.spec as { root?: string })?.root).toBe("root");
    // Model-visible text: pre-0.5.0 contract exactly — no payload key.
    const text = parseToolJson(result);
    expect(text.__ui).toBeUndefined();
    expect(text.history_id).toBeTruthy();
  });

  it("withholds structuredContent from a client that never negotiated the extension", async () => {
    const deps = makeTestDeps();
    const client = await connectedClient(deps, audit);
    const source_id = await csvSource(client);
    const result = await client.callTool({
      name: "persist_dashboard",
      arguments: { source_id, title: "Revenue overview", spec: await VALID_SPEC() },
    });

    expect((result as { structuredContent?: unknown }).structuredContent).toBeUndefined();
    expect(parseToolJson(result).__ui).toBeUndefined();
  });
});

describe("analyze cancellation (notifications/cancelled → stopRun)", () => {
  it("stops the live run when the host cancels mid-pipeline", async () => {
    // A runAskQuery fake that reports its runId (first /state add, as the
    // real runPatchStream does), then stalls long enough to be cancelled.
    const deps = makeTestDeps({
      runAskQuery: vi.fn(async ({ stream }: { stream: unknown }) => {
        const push = pushOf(stream);
        push(
          '{"op":"add","path":"/state","value":{"__progress":{"stage":"generating","step":1,"total":5},"__runId":"run-live-9"}}\n'
        );
        await new Promise((r) => setTimeout(r, 120));
        // Past the cancellation: the closed stream must swallow, not crash.
        push('{"op":"add","path":"/root","value":"main"}\n');
      }) as unknown as McpDeps["runAskQuery"],
    });
    const csvPath = join(dir, "cancel.csv");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(csvPath, CSV_TEXT);
    const client = await connectedClient(deps, audit);
    const { source_id } = parseToolJson(
      await client.callTool({ name: "connect_source", arguments: { path: csvPath } })
    ) as { source_id: string };

    const controller = new AbortController();
    const pending = client
      .callTool({ name: "analyze", arguments: { source_id, question: "q" } }, undefined, {
        signal: controller.signal,
      })
      .then(
        () => "resolved",
        () => "rejected"
      );
    // Let the run start and report its runId, then cancel like Desktop does.
    await new Promise((r) => setTimeout(r, 40));
    controller.abort();

    expect(await pending).toBe("rejected");
    // The cancellation must reach the run controller — that is what unwinds
    // LLM streams, kills sandbox containers, and frees the per-source lock.
    await vi.waitFor(() => expect(deps.stopRun).toHaveBeenCalledWith("run-live-9"));
  });
});

describe("background analysis jobs (analyze_start / status / result / cancel)", () => {
  async function uiCapableClient(deps: McpDeps) {
    const server = buildMcpServer(deps, (e) => audit.push(e));
    const client = new Client(
      { name: "ui-client", version: "0.0.0" },
      {
        capabilities: {
          extensions: {
            "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
          },
        },
      }
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return client;
  }

  async function startedJob(deps: McpDeps, client: Client) {
    const csvPath = join(dir, "jobs.csv");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(csvPath, CSV_TEXT);
    const { source_id } = parseToolJson(
      await client.callTool({ name: "connect_source", arguments: { path: csvPath } })
    ) as { source_id: string };
    const start = parseToolJson(
      await client.callTool({
        name: "analyze_start",
        arguments: { source_id, question: "Revenue trend?" },
      })
    );
    return { source_id, job_id: start.job_id as string, start };
  }

  it("start returns immediately; status long-polls to done; result is the analyze payload", async () => {
    const { _resetAnalysisJobs } = await import("../tools/analyze-async");
    _resetAnalysisJobs();
    // A pipeline slow enough that analyze_start must NOT wait for it.
    const deps = makeTestDeps({
      runAskQuery: vi.fn(async ({ stream, question }: { stream: unknown; question: string }) => {
        void question;
        const push = pushOf(stream);
        push(
          '{"op":"add","path":"/state","value":{"__progress":{"stage":"generating","step":1,"total":5},"__runId":"run-job-1"}}\n'
        );
        await new Promise((r) => setTimeout(r, 150));
        push('{"op":"add","path":"/root","value":"main"}\n');
        push(
          '{"op":"add","path":"/elements/summary","value":{"type":"TextBlock","props":{"content":"Revenue grew 3x."}}}\n'
        );
      }) as unknown as McpDeps["runAskQuery"],
    });
    const client = await uiCapableClient(deps);

    const t0 = Date.now();
    const { job_id, start } = await startedJob(deps, client);
    expect(Date.now() - t0).toBeLessThan(1000); // never blocks on the pipeline
    expect(start.status).toBe("running");

    // Long-poll until done — bounded, no fixed sleeps.
    let status: Record<string, unknown> = {};
    for (let i = 0; i < 20; i++) {
      status = parseToolJson(
        await client.callTool({
          name: "analyze_status",
          arguments: { job_id, wait_seconds: 1 },
        })
      );
      if (status.status === "done") break;
    }
    expect(status.status).toBe("done");

    const result = await client.callTool({
      name: "analyze_result",
      arguments: { job_id },
    });
    const body = parseToolJson(result);
    expect(body.job_id).toBe(job_id);
    expect(body.summary).toContain("Revenue grew 3x.");
    expect(body.history_id).toBeTruthy();
    // The MCP-Apps channel rides the result call for ui-capable hosts.
    const sc = (result as { structuredContent?: Record<string, unknown> }).structuredContent;
    expect((sc?.spec as { root?: string })?.root).toBe("main");
    expect(body.__ui).toBeUndefined();
  });

  it("cancel stops the live run and result reports the cancellation", async () => {
    const { _resetAnalysisJobs } = await import("../tools/analyze-async");
    _resetAnalysisJobs();
    const deps = makeTestDeps({
      runAskQuery: vi.fn(async ({ stream }: { stream: unknown }) => {
        const push = pushOf(stream);
        // Real stream protocol: wholesale /state add (carries __runId), then
        // /state/__progress replaces — only the replaces map to stages.
        push(
          '{"op":"add","path":"/state","value":{"__progress":{"stage":"starting","step":0,"total":5},"__runId":"run-job-2"}}\n'
        );
        push(
          '{"op":"replace","path":"/state/__progress","value":{"stage":"generating","step":1,"total":5}}\n'
        );
        await new Promise((r) => setTimeout(r, 60_000)); // never finishes on its own
      }) as unknown as McpDeps["runAskQuery"],
    });
    const client = await connectedClient(deps, audit);
    const { job_id } = await startedJob(deps, client);

    // Let the runId patch arrive before cancelling.
    await vi.waitFor(async () => {
      const s = parseToolJson(
        await client.callTool({
          name: "analyze_status",
          arguments: { job_id, wait_seconds: 0 },
        })
      );
      expect((s.stage as { stage?: string })?.stage).toBe("generating");
    });

    const cancelled = parseToolJson(
      await client.callTool({ name: "analyze_cancel", arguments: { job_id } })
    );
    expect(cancelled.status).toBe("cancelled");
    expect(deps.stopRun).toHaveBeenCalledWith("run-job-2");

    const result = await client.callTool({ name: "analyze_result", arguments: { job_id } });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(String(parseToolJson(result).error)).toContain("cancelled");
  });

  it("analyze_start rejects an unknown source instead of burying it in a job", async () => {
    const deps = makeTestDeps();
    const client = await connectedClient(deps, audit);
    const res = await client.callTool({
      name: "analyze_start",
      arguments: { source_id: "nope", question: "q" },
    });
    expect((res as { isError?: boolean }).isError).toBe(true);
  });
});

describe("dashboard_data (the iframe's pull channel)", () => {
  const ENTRY = {
    meta: {
      id: "e2f1a6c0-0000-4000-8000-000000000001",
      question: "Revenue by region?",
      timestamp: Date.parse("2026-08-06T00:00:00Z"),
    } as HistoryMeta,
    spec: {
      root: "r",
      elements: { r: { type: "BarChart", props: { title: "T" }, children: [] } },
      state: { datasets: { main: [{ a: 1 }] }, __cost: { usd: 1 } },
    },
    generatedCode: "",
    schema: {} as CSVSchema,
  };

  async function uiClient(deps: McpDeps) {
    const server = buildMcpServer(deps, (e) => audit.push(e));
    const client = new Client(
      { name: "ui-client", version: "0.0.0" },
      {
        capabilities: {
          extensions: {
            "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
          },
        },
      }
    );
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);
    return client;
  }

  it("returns the payload on BOTH channels, app-only visibility, internals stripped", async () => {
    const deps = makeTestDeps({ loadHistoryEntry: vi.fn(async () => ENTRY) });
    const client = await uiClient(deps);

    const { tools } = await client.listTools();
    const meta = tools.find((t) => t.name === "dashboard_data")?._meta as
      | { ui?: { visibility?: string[] } }
      | undefined;
    expect(meta?.ui?.visibility).toEqual(["app"]);

    const result = await client.callTool({
      name: "dashboard_data",
      arguments: { history_id: ENTRY.meta.id },
    });
    // Channel 1: structuredContent (when the host preserves it).
    const sc = (result as { structuredContent?: Record<string, unknown> }).structuredContent;
    expect((sc?.spec as { root?: string })?.root).toBe("r");
    // Channel 2: the JSON text block (survives structuredContent stripping).
    const text = parseToolJson(result);
    expect((text.spec as { root?: string })?.root).toBe("r");
    expect(text.question).toBe("Revenue by region?");
    // Publish floor: __-prefixed pipeline state never leaves the server.
    expect(JSON.stringify(text.spec)).not.toContain("__cost");
  });

  it("rejects an unknown history_id with an actionable error", async () => {
    const deps = makeTestDeps();
    const client = await uiClient(deps);
    const res = await client.callTool({
      name: "dashboard_data",
      arguments: { history_id: "nope" },
    });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(String(parseToolJson(res).error)).toContain("No history entry");
  });
});

describe("truncateAtBoundary (deep-dive summary cap, run-4 fix)", () => {
  it("never cuts mid-word: prefers sentence ends, falls back to word ends", async () => {
    const { truncateAtBoundary } = await import("../tools/analyze");
    const text =
      "August marks the single largest deterioration. The step change dwarfs every other month. " +
      "Self-Serve drives most of it.";
    const bySentence = truncateAtBoundary(text, 100);
    expect(bySentence.endsWith(".")).toBe(true);
    expect(text.startsWith(bySentence)).toBe(true);

    const byWord = truncateAtBoundary("August marks the single largest deterioration", 25);
    expect(byWord).toBe("August marks the single…");

    expect(truncateAtBoundary("short", 100)).toBe("short");
  });
});
