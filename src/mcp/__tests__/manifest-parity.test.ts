/**
 * MCP manifest parity (spec §6): a dataset manifest attaches through
 * connect_source, describes itself through get_schema, and analyze runs the
 * selection pre-step + on-demand materialization server-side — the pipeline
 * receives the SAME context.manifest shape the web client builds, so the
 * multi-entity mechanics (D40 ranged reads, egress union) need no MCP fork.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { connectSource, looksLikeManifestUrl } from "@/mcp/tools/connect-source";
import { getSchema } from "@/mcp/tools/get-schema";
import { analyze, type AnalyzeDeps } from "@/mcp/tools/analyze";
import { clearSources, capabilitiesOf, registerSource } from "@/mcp/sources";
import { McpToolError } from "@/mcp/errors";
import type { McpDeps } from "@/mcp/deps";
import type { ManifestRecord, EntityState } from "@/lib/manifest/store";
import type { ManifestEntity } from "@/lib/contracts/dataset-manifest";

const M_URL = "https://data.example.org/hub/manifest.json";

const entity = (name: string): ManifestEntity => ({
  name,
  url: `https://data.example.org/hub/${name}.parquet`,
  description: `${name} data`,
});

function record(states: [string, EntityState][]): ManifestRecord {
  return {
    manifestId: "11111111-1111-4111-8111-111111111111",
    manifest: {
      manifestUrl: M_URL,
      format: "files-array",
      title: "Housing hub",
      entities: states.map(([, s]) => s.entity),
    } as never,
    excluded: [],
    entities: new Map(states),
    manifestHash: "f".repeat(64),
    connectedAt: 1_000,
  };
}

const pendingRecord = () =>
  record([
    ["housing", { entity: entity("housing"), status: "pending" }],
    ["population", { entity: entity("population"), status: "pending" }],
    ["parks", { entity: entity("parks"), status: "pending" }],
  ]);

beforeEach(() => clearSources());

describe("looksLikeManifestUrl", () => {
  it("routes .json to the manifest door, everything else to parquet", () => {
    expect(looksLikeManifestUrl(M_URL)).toBe(true);
    expect(looksLikeManifestUrl("https://x.org/catalog.JSON")).toBe(true);
    expect(looksLikeManifestUrl("https://x.org/data.parquet")).toBe(false);
    expect(looksLikeManifestUrl("s3://bucket/prefix/*.parquet")).toBe(false);
    expect(looksLikeManifestUrl("not a url")).toBe(false);
    // The query string must not fool the extension check.
    expect(looksLikeManifestUrl("https://x.org/data.parquet?fmt=json")).toBe(false);
  });
});

describe("connect_source with a manifest url", () => {
  it("registers a manifest source and returns the entity index", async () => {
    const rec = pendingRecord();
    const deps = {
      connectManifest: vi.fn(async () => rec),
      getManifestRecord: vi.fn(() => rec),
    } as unknown as McpDeps;

    const out = await connectSource(deps, { url: M_URL });
    expect(deps.connectManifest).toHaveBeenCalledWith({ url: M_URL });
    expect(out.kind).toBe("manifest");
    expect(out.source_type).toBe("manifest");
    expect(out.label).toBe("Housing hub");
    expect(out.entity_count).toBe(3);
    expect((out.entities as { name: string }[]).map((e) => e.name)).toEqual([
      "housing",
      "population",
      "parks",
    ]);
    expect(typeof out.source_id).toBe("string");
    // Boundary: no urls-with-credentials, no raw rows — just the index.
    expect(JSON.stringify(out)).not.toContain("sample_rows");
  });

  it("get_schema returns the live record's entity states; a lost record is source_expired", async () => {
    const rec = pendingRecord();
    rec.entities.set("housing", {
      entity: entity("housing"),
      status: "ready",
      csvId: "c-1",
      rowCount: 42,
      columnCount: 3,
    });
    let live: ManifestRecord | undefined = rec;
    const deps = {
      connectManifest: vi.fn(async () => rec),
      getManifestRecord: vi.fn(() => live),
    } as unknown as McpDeps;
    const connected = await connectSource(deps, { url: M_URL });

    const out = await getSchema(deps, { source_id: connected.source_id as string });
    const housing = (out.entities as Record<string, unknown>[]).find((e) => e.name === "housing")!;
    expect(housing.status).toBe("ready");
    expect(housing.row_count).toBe(42);
    expect(housing.row_count_is_exact).toBe(true);

    live = undefined; // server restarted; registry entry outlived the store
    await expect(getSchema(deps, { source_id: connected.source_id as string })).rejects.toThrow(
      /no longer in hermetic's store/
    );
  });
});

describe("analyze on a manifest source", () => {
  function analyzeDeps(rec: ManifestRecord | undefined) {
    const runAskQuery = vi.fn<(a: Record<string, unknown>) => Promise<undefined>>(
      async () => undefined
    );
    const deps = {
      runPatchStream: vi.fn(
        async (_label: string, _sink: unknown, fn: (s: never) => Promise<void>) => {
          await fn({} as never);
          return "run-1";
        }
      ),
      stopRun: vi.fn(async () => undefined),
      runAskQuery,
      getWarehouseState: () => undefined,
      getStoredCSV: () => undefined,
      getActiveSandboxRuntime: () => "docker" as const,
      assembleSpecFromPatches: () => ({ elements: {} }) as never,
      persistHistoryEntry: vi.fn(async () => ({ saved: false as const, reason: "test" })),
      getCachedArtifacts: () => undefined,
      getManifestRecord: () => rec,
      selectManifestEntities: vi.fn(async () => ({
        entities: ["housing", "population"],
        usedFallback: false,
      })),
      ensureManifestEntitiesReady: vi.fn(async () => ({
        ready: [
          { name: "housing", csvId: "c-1" },
          { name: "population", csvId: "c-2" },
        ],
        unavailable: [],
      })),
      models: { codeGen: "m", uiCompose: "m" },
    };
    return { deps: deps as unknown as AnalyzeDeps, runAskQuery, raw: deps };
  }

  it("selects, ensures, and passes context.manifest with the primary as the source", async () => {
    const rec = pendingRecord();
    const source = registerSource({
      kind: "manifest",
      label: "Housing hub",
      manifestId: rec.manifestId,
      origin: { via: "url", url: M_URL },
    });
    const { deps, runAskQuery, raw } = analyzeDeps(rec);

    const out = await analyze(deps, { source_id: source.id, question: "how many homes?" });

    expect(raw.selectManifestEntities).toHaveBeenCalledWith(rec, "how many homes?");
    expect(raw.ensureManifestEntitiesReady).toHaveBeenCalledWith(rec, ["housing", "population"]);
    const call = runAskQuery.mock.calls[0]![0];
    expect(call.context).toMatchObject({
      manifest: {
        manifest_id: rec.manifestId,
        entities: [
          { name: "housing", csv_id: "c-1" },
          { name: "population", csv_id: "c-2" },
        ],
      },
    });
    // Primary alignment: the pipeline's csvId IS the first ready entity —
    // resolveManifestQuestion rejects anything else server-side.
    expect(call.source).toEqual({ kind: "csv", csvId: "c-1" });
    expect(out.source_id).toBe(source.id);
  });

  it("fails actionably when nothing could be prepared, naming each reason", async () => {
    const rec = pendingRecord();
    const source = registerSource({
      kind: "manifest",
      label: "Housing hub",
      manifestId: rec.manifestId,
      origin: { via: "url", url: M_URL },
    });
    const { deps, raw } = analyzeDeps(rec);
    (raw.ensureManifestEntitiesReady as ReturnType<typeof vi.fn>).mockResolvedValue({
      ready: [],
      unavailable: [{ name: "housing", reason: "introspection budget exhausted — retry" }],
    });

    await expect(
      analyze(deps, { source_id: source.id, question: "how many homes?" })
    ).rejects.toThrow(/housing: introspection budget exhausted/);
  });

  it("a lost record is source_expired with the reattach hint", async () => {
    const source = registerSource({
      kind: "manifest",
      label: "Housing hub",
      manifestId: "22222222-2222-4222-8222-222222222222",
      origin: { via: "url", url: M_URL },
    });
    const { deps } = analyzeDeps(undefined);
    const err = await analyze(deps, { source_id: source.id, question: "q" }).catch((e) => e);
    expect(err).toBeInstanceOf(McpToolError);
    expect(String(err.message)).toContain(`connect_source({ url: "${M_URL}" })`);
  });
});

describe("capabilitiesOf(manifest)", () => {
  it("advertises exactly what the tools actually accept", () => {
    const caps = capabilitiesOf({
      id: "x",
      kind: "manifest",
      label: "m",
      manifestId: "m-1",
    });
    expect(caps.source_type).toBe("manifest");
    expect(caps.supported_tools).toEqual(["get_schema", "analyze"]);
    // Every refusing tool is listed WITH its reason — the host never probes.
    expect(Object.keys(caps.unsupported_tools).sort()).toEqual([
      "persist_dashboard",
      "run_analysis",
      "run_sql",
      "verify_narrative",
    ]);
  });
});
