/**
 * MCP M1 tests: end-to-end through the SDK's in-memory transport with fully
 * injected fakes (no network, no docker, no LLM), plus the boundary rules
 * that ARE the product: no raw rows in schema responses, read-only SQL
 * enforced before execution, audit line per call with sanitized args.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
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
import { validateSpec } from "@/lib/catalog";
import { setPathRoots } from "@/lib/paths";
import type { WarehouseConnector } from "@/lib/warehouse/connector";

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

function fakeDeps(connector: WarehouseConnector): McpDeps {
  return {
    parseCSV, // real: pure
    extractSchema, // real: pure
    storeCSV: vi.fn(async () => undefined) as unknown as McpDeps["storeCSV"],
    createConnector: vi.fn(() => connector),
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
    ]) as unknown as McpDeps["loadConnections"],
    assertReadOnlySql, // real: the gate under test
    storeWarehouse: vi.fn(),
    getWarehouseState: vi.fn(() => undefined),
    // Minimal orchestration fakes: runPatchStream routes handler writes into
    // the sink; runAskQuery is set per-test.
    runPatchStream: (async (
      _route: string,
      sink: { write: (d: string) => void },
      handler: (stream: unknown) => Promise<void>
    ) => {
      await handler({ push: (line: string) => sink.write(line) });
    }) as unknown as McpDeps["runPatchStream"],
    runAskQuery: vi.fn(async ({ stream }: { stream: unknown }) => {
      const push = (stream as { push: (l: string) => void }).push;
      push('{"op":"add","path":"/root","value":"main"}\n');
      push(
        '{"op":"add","path":"/elements/summary","value":{"type":"Markdown","props":{"content":"Revenue grew 3x."}}}\n'
      );
      push('{"op":"add","path":"/state/__cost","value":{"costUsd":0.12}}\n');
    }) as unknown as McpDeps["runAskQuery"],
    assembleSpecFromPatches,
    persistHistoryEntry: vi.fn(async () => ({
      saved: true as const,
      meta: { id: "hist-123" } as never,
    })) as unknown as McpDeps["persistHistoryEntry"],
    getActiveSandboxRuntime: vi.fn(() => "docker") as unknown as McpDeps["getActiveSandboxRuntime"],
    getCSVContent: vi.fn(async () => CSV_TEXT) as unknown as McpDeps["getCSVContent"],
    executeSandbox: vi.fn(async () => ({
      success: true as const,
      results: { total_revenue: 600 },
      chart_data: { by_month: Array.from({ length: 300 }, (_, i) => ({ i })) },
      images: {},
      execution_ms: 42,
      datasets: { raw: [{ month: "Jan", revenue: 100 }] },
    })) as unknown as McpDeps["executeSandbox"],
    collectGroundedValues, // real: pure
    verifyGrounding, // real: pure — the engine under test
    validateSpec, // real: the enforcing gate under test
    models: { codeGen: "model-a", uiCompose: "model-b" },
  };
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
      "connect_source",
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
    expect(String(result.dashboard_url)).toContain("restore=hist-123");
    expect((result.cost as { costUsd: number }).costUsd).toBe(0.12);
    expect(result.element_count).toBe(1);
  });

  it("surfaces pipeline errors as tool errors (no persist)", async () => {
    const csvPath = join(dir, "rev.csv");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(csvPath, CSV_TEXT);
    const deps = fakeDeps(fakeConnector(""));
    deps.runAskQuery = (async ({ stream }: { stream: unknown }) => {
      (stream as { push: (l: string) => void }).push(
        '{"op":"add","path":"/state/__error","value":"sandbox exploded"}\n'
      );
    }) as unknown as McpDeps["runAskQuery"];
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
    expect(String(payload.error)).toContain("sandbox exploded");
  });

  it("warehouse analyze passes the stored warehouse state and persists under the materialized csvId", async () => {
    const deps = fakeDeps(fakeConnector(""));
    deps.getWarehouseState = vi.fn(() => ({ warehouse: {}, connector: {} }) as never);
    deps.runAskQuery = (async ({
      stream,
      runState,
      warehouseState,
    }: {
      stream: unknown;
      runState: { csvId?: string };
      warehouseState: unknown;
    }) => {
      expect(warehouseState).toBeTruthy();
      runState.csvId = "materialized-42";
      const push = (stream as { push: (l: string) => void }).push;
      push('{"op":"add","path":"/root","value":"main"}\n');
      push('{"op":"add","path":"/elements/a","value":{"type":"Text","props":{"content":"hi"}}}\n');
    }) as unknown as McpDeps["runAskQuery"];
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
    expect((result.chart_data as { by_month: unknown[] }).by_month).toHaveLength(200);
    expect(result.chart_data_truncated_keys).toEqual(["by_month"]);
  });

  it("surfaces sandbox failure kind in the error", async () => {
    const deps = fakeDeps(fakeConnector(""));
    deps.executeSandbox = vi.fn(async () => ({
      success: false as const,
      error: "killed",
      errorKind: "oom" as const,
      execution_ms: 5,
    })) as unknown as McpDeps["executeSandbox"];
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
    expect(String(parseToolJson(result).error)).toContain("rejected by catalog validation");
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
