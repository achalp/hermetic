import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The shared multi-entity question module (spec §7) — ONE resolver + ONE
 * context builder used by BOTH pipelines, so ask and investigate cannot drift
 * (author directive: "the two must stay at par").
 *
 * Trust property under test: the request carries ids, never data — every id is
 * re-validated against the server's own manifest store and csv storage.
 */

const storeGet = vi.fn();
vi.mock("@/lib/manifest/store", () => ({
  getManifestStore: () => ({ get: (id: string) => storeGet(id) }),
}));
const getStoredCSV = vi.fn();
vi.mock("@/lib/csv/storage", () => ({
  getStoredCSV: (id: string) => getStoredCSV(id),
}));

const register = vi.fn();
vi.mock("@/lib/sandbox/wasm/range-singleton", () => ({
  getRangeRegistry: () => ({ register }),
}));
const enumerate = vi.fn();
const resolvePlan = vi.fn();
vi.mock("@/lib/sandbox/remote-fetch", () => ({
  enumerateRemoteParquetFiles: (...a: unknown[]) => enumerate(...a),
  resolveRemoteHttpsFetch: (...a: unknown[]) => resolvePlan(...a),
}));

import {
  resolveManifestQuestion,
  buildManifestQuestionContext,
  buildManifestWasmAliases,
  manifestEgressHosts,
  questionBudgetFor,
} from "@/lib/manifest/question-context";

const HOST = "https://acct.blob.core.windows.net";

function seed() {
  const record = {
    manifestId: "m1",
    entities: new Map([
      [
        "housing-gap",
        {
          entity: { name: "housing-gap", url: `${HOST}/data/housing-gap.parquet` },
          status: "ready",
          csvId: "c-gap",
        },
      ],
      [
        "geographies",
        {
          entity: { name: "geographies", url: `${HOST}/data/geographies.parquet` },
          status: "ready",
          csvId: "c-geo",
        },
      ],
    ]),
  };
  storeGet.mockImplementation((id: string) => (id === "m1" ? record : undefined));
  const stored = (name: string, extra: Record<string, unknown> = {}) => ({
    remoteParquetUrl: `${HOST}/data/${name}.parquet`,
    schema: {
      csv_id: `c-${name}`,
      filename: name,
      row_count: 1000,
      columns: [
        {
          name: "geography_id",
          dtype: "string",
          null_count: 0,
          meta: { kind: "categorical" },
          sample_values: ["01001", "01003"],
        },
        {
          name: "year",
          dtype: "number",
          null_count: 0,
          meta: { kind: "number", min: 2010, max: 2024 },
        },
      ],
      sample_rows: [{ geography_id: "01001", year: 2020 }],
    },
    ...extra,
  });
  getStoredCSV.mockImplementation((id: string) =>
    id === "c-gap" ? stored("housing-gap") : id === "c-geo" ? stored("geographies") : undefined
  );
}

const REQ = {
  manifest_id: "m1",
  entities: [
    { name: "housing-gap", csv_id: "c-gap" },
    { name: "geographies", csv_id: "c-geo" },
  ],
};

beforeEach(() => {
  storeGet.mockReset();
  getStoredCSV.mockReset();
  register.mockReset();
  enumerate.mockReset();
  resolvePlan.mockReset();
  let n = 0;
  register.mockImplementation(() => `tok${++n}`);
  resolvePlan.mockImplementation(async (stored: { remoteParquetUrl: string }) => ({
    ok: true,
    url: stored.remoteParquetUrl,
    allowlist: ["acct.blob.core.windows.net"],
  }));
  seed();
});

describe("resolveManifestQuestion — ids re-validated server-side", () => {
  it("resolves a valid request, primary first", () => {
    const r = resolveManifestQuestion(REQ, "c-gap");
    expect(r.entities.map((e) => e.name)).toEqual(["housing-gap", "geographies"]);
    expect(r.entities[0]!.stored.remoteParquetUrl).toContain("housing-gap.parquet");
  });

  it("rejects an unknown manifest / unknown entity", () => {
    expect(() => resolveManifestQuestion({ ...REQ, manifest_id: "nope" }, "c-gap")).toThrow(
      /Unknown manifest/
    );
    expect(() =>
      resolveManifestQuestion(
        { ...REQ, entities: [{ name: "not-real", csv_id: "c-gap" }] },
        "c-gap"
      )
    ).toThrow(/Unknown manifest entity/);
  });

  it("rejects a csvId that is not the server's OWN registration for that entity", () => {
    // A forged or stale id: the client cannot bind entity names to arbitrary
    // sources — only to what the server itself registered.
    expect(() =>
      resolveManifestQuestion(
        { ...REQ, entities: [{ name: "housing-gap", csv_id: "c-geo" }] },
        "c-geo"
      )
    ).toThrow(/out of date/);
  });

  it("rejects when the primary does not match the request's csv_id", () => {
    // The pipeline's plumbing (egress grant, wasm input.csv) hangs off csv_id;
    // a disagreeing primary would ship entity A's context with entity B's data.
    expect(() => resolveManifestQuestion(REQ, "c-geo")).toThrow(/primary entity must match/);
  });

  it("rejects an entity whose stored source has vanished (restart)", () => {
    getStoredCSV.mockReturnValue(undefined);
    expect(() => resolveManifestQuestion(REQ, "c-gap")).toThrow(/no longer loaded/);
  });
});

describe("buildManifestQuestionContext — the prompt section", () => {
  it("docker: per-entity read expressions, schemas in metadata mode", () => {
    const r = resolveManifestQuestion(REQ, "c-gap");
    const ctx = buildManifestQuestionContext(r, { kind: "docker" });
    expect(ctx).toContain(`read_parquet('${HOST}/data/housing-gap.parquet')`);
    expect(ctx).toContain(`read_parquet('${HOST}/data/geographies.parquet')`);
    expect(ctx).toContain("### Entity: housing-gap (1,000 rows)");
    expect(ctx).toContain("geography_id"); // schema lines rendered
    // No delivered-file paths on docker — the code reads the URLs.
    expect(ctx).not.toContain("/data/entities/");
  });

  it("wasm: delivered CSV paths, no URLs — the worker has no network", () => {
    const r = resolveManifestQuestion(REQ, "c-gap");
    const ctx = buildManifestQuestionContext(r, {
      kind: "wasm",
      paths: new Map([
        ["housing-gap", "/data/input.csv"],
        ["geographies", "/data/entities/geographies.csv"],
      ]),
    });
    expect(ctx).toContain('pd.read_csv("/data/input.csv")');
    expect(ctx).toContain('pd.read_csv("/data/entities/geographies.csv")');
    expect(ctx).not.toContain("read_parquet");
    expect(ctx).not.toContain(HOST);
  });

  it("surfaces JOIN hints when entities share key columns", () => {
    const r = resolveManifestQuestion(REQ, "c-gap");
    const ctx = buildManifestQuestionContext(r, { kind: "docker" });
    // Both fixtures carry geography_id with overlapping sample values — the
    // relationship detector should hand the model the join key.
    expect(ctx).toContain("Detected relationships");
    expect(ctx).toContain("geography_id");
  });
});

describe("buildManifestWasmAliases — ranged delivery (D40, P3 items 1+2)", () => {
  it("mints ONE run-scoped token per single-object entity, budgeted from the size hint", async () => {
    // Give housing-gap a bytesHint through the record.
    const rec = storeGet("m1");
    rec.entities.get("housing-gap").entity.bytesHint = 100_000_000;
    const r = resolveManifestQuestion(REQ, "c-gap");
    const built = await buildManifestWasmAliases(r, "run-1");

    expect(built.aliases.map((a) => a.name)).toEqual([
      "housing-gap.parquet",
      "geographies.parquet",
    ]);
    expect(built.aliases[0]!.url).toBe("/api/wasm-range/tok1");
    // Budget: 2× the hint (a question may scan twice), floored at 64MB.
    expect(register.mock.calls[0]![0]).toMatchObject({
      runId: "run-1",
      budgetBytes: 2 * 100_000_000,
    });
    // No hint → the fixed extraction-style ceiling.
    expect(register.mock.calls[1]![0]).toMatchObject({ budgetBytes: 512 * 1024 * 1024 });
    expect(built.readExprs.get("housing-gap")).toBe("read_parquet('housing-gap.parquet')");
  });

  it("a HIVE entity fans out to one token PER FILE — the D20 invariant", async () => {
    const rec = storeGet("m1");
    rec.entities.get("housing-gap").entity.url = `${HOST}/release/theme=gap/*.parquet`;
    getStoredCSV.mockImplementation((id: string) =>
      id === "c-gap"
        ? {
            remoteParquetUrl: `${HOST}/release/theme=gap/*.parquet`,
            isHivePartitioned: true,
            schema: {
              csv_id: "c-gap",
              filename: "housing-gap",
              row_count: 1,
              columns: [],
              sample_rows: [],
            },
          }
        : {
            remoteParquetUrl: `${HOST}/data/geographies.parquet`,
            schema: {
              csv_id: "c-geo",
              filename: "geographies",
              row_count: 1,
              columns: [],
              sample_rows: [],
            },
          }
    );
    enumerate.mockResolvedValue({
      host: "acct.blob.core.windows.net",
      objects: [
        { key: "release/theme=gap/part-0.parquet", size: 10_000_000 },
        { key: "release/theme=gap/part-1.parquet", size: 12_000_000 },
      ],
    });
    const r = resolveManifestQuestion(REQ, "c-gap");
    const built = await buildManifestWasmAliases(r, "run-1");

    // 2 hive files + 1 single object = 3 tokens; hive alias names keep key paths.
    expect(register).toHaveBeenCalledTimes(3);
    expect(built.readExprs.get("housing-gap")).toContain("hive_partitioning=true");
    expect(built.readExprs.get("housing-gap")).toContain("release/theme=gap/part-0.parquet");
    // Prefetch targets carry the LISTING sizes for the hive files.
    expect(built.prefetch.filter((p) => p.url.includes("part-"))).toHaveLength(2);
  });

  it("investigate's budgetMultiplier scales every token", async () => {
    const rec = storeGet("m1");
    rec.entities.get("housing-gap").entity.bytesHint = 100 * 1024 * 1024;
    const r = resolveManifestQuestion(REQ, "c-gap");
    await buildManifestWasmAliases(r, "run-1", { budgetMultiplier: 4 });
    expect(register.mock.calls[0]![0].budgetBytes).toBe(4 * 2 * 100 * 1024 * 1024);
  });

  it("prefetches only where a size is KNOWN — no size, no target", async () => {
    const r = resolveManifestQuestion(REQ, "c-gap"); // no bytesHints seeded
    const built = await buildManifestWasmAliases(r, "run-1");
    expect(built.prefetch).toEqual([]);
  });

  it("fails loudly when an entity has no safe fetch plan", async () => {
    resolvePlan.mockResolvedValue({ ok: false, unsupported: "internal host" });
    const r = resolveManifestQuestion(REQ, "c-gap");
    await expect(buildManifestWasmAliases(r, "run-1")).rejects.toThrow(/internal host/);
  });

  it("questionBudgetFor: 2×hint with a 64MB floor; 512MB without a hint", () => {
    expect(questionBudgetFor(10_000_000)).toBe(64 * 1024 * 1024); // floored
    expect(questionBudgetFor(100_000_000)).toBe(200_000_000);
    expect(questionBudgetFor(undefined)).toBe(512 * 1024 * 1024);
  });
});

describe("wasm-ranged prompt context (D40)", () => {
  it("gives duckdb read exprs and forbids pandas/URLs for these files", () => {
    const r = resolveManifestQuestion(REQ, "c-gap");
    const ctx = buildManifestQuestionContext(r, {
      kind: "wasm-ranged",
      readExprs: new Map([
        ["housing-gap", "read_parquet('housing-gap.parquet')"],
        ["geographies", "read_parquet('geographies.parquet')"],
      ]),
    });
    expect(ctx).toContain("read_parquet('housing-gap.parquet')");
    expect(ctx).toContain("import duckdb");
    expect(ctx).toContain("Do NOT use pd.read_csv");
    expect(ctx).not.toContain(HOST); // the worker never sees an upstream URL
  });
});

describe("manifestEgressHosts — the docker union (revised host policy 2026-08-31)", () => {
  it("unions the hosts of every SELECTED entity, deduped", () => {
    getStoredCSV.mockImplementation((id: string) =>
      id === "c-gap"
        ? {
            remoteParquetUrl: "https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/a.parquet",
            schema: { csv_id: "c-gap", filename: "a", row_count: 1, columns: [], sample_rows: [] },
          }
        : {
            remoteParquetUrl: `${HOST}/data/geographies.parquet`,
            schema: { csv_id: "c-geo", filename: "g", row_count: 1, columns: [], sample_rows: [] },
          }
    );
    const r = resolveManifestQuestion(REQ, "c-gap");
    const hosts = manifestEgressHosts(r);
    expect(hosts).toContain("overturemaps-us-west-2.s3.us-west-2.amazonaws.com");
    expect(hosts).toContain("acct.blob.core.windows.net");
  });

  it("same-host entities produce ONE host, not duplicates", () => {
    const r = resolveManifestQuestion(REQ, "c-gap");
    expect(manifestEgressHosts(r)).toEqual(["acct.blob.core.windows.net"]);
  });

  it("never unions an internal host — the SSRF guard holds per entity", () => {
    getStoredCSV.mockImplementation((id: string) =>
      id === "c-gap"
        ? {
            remoteParquetUrl: "https://169.254.169.254/latest/meta-data.parquet",
            schema: { csv_id: "c-gap", filename: "a", row_count: 1, columns: [], sample_rows: [] },
          }
        : {
            remoteParquetUrl: `${HOST}/data/geographies.parquet`,
            schema: { csv_id: "c-geo", filename: "g", row_count: 1, columns: [], sample_rows: [] },
          }
    );
    const r = resolveManifestQuestion(REQ, "c-gap");
    expect(manifestEgressHosts(r)).toEqual(["acct.blob.core.windows.net"]);
  });
});
