import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parseWasmSchemaEnvelope,
  singleObjectAlias,
  CONNECT_LEASE_MS,
} from "@/lib/parquet/wasm-schema-job";
import { createWasmSchemaLeaseStore } from "@/lib/parquet/wasm-schema-lease-store";

/**
 * Connect-time schema extraction in the worker (build log D27). The envelope
 * crosses a CLIENT, so shape validation is not defensive politeness — an
 * unvalidated payload becomes a stored schema and then prompt context.
 */

describe("parseWasmSchemaEnvelope", () => {
  const good = {
    row_count: 1500,
    columns: [{ name: "n", dtype: "number", null_count: 0, meta: { kind: "number" } }],
    sample_rows: [{ n: 1 }],
    detected_domain: "general",
  };

  it("builds a schema and stamps the identity the HOST chose, not the client's", () => {
    const schema = parseWasmSchemaEnvelope({ exitCode: 0, output: good }, "cid-1", "f.parquet");
    expect(schema.csv_id).toBe("cid-1");
    expect(schema.filename).toBe("f.parquet");
    expect(schema.row_count).toBe(1500);
    expect(schema.source_type).toBe("file");
  });

  it("accepts the profile as a JSON STRING too — the worker reads a file", () => {
    const schema = parseWasmSchemaEnvelope(
      { exitCode: 0, output: JSON.stringify(good) },
      "cid",
      "f"
    );
    expect(schema.columns).toHaveLength(1);
  });

  it("surfaces the worker's stderr on a non-zero exit instead of a blank failure", () => {
    expect(() =>
      parseWasmSchemaEnvelope(
        { exitCode: 1, output: null, stderr: "duckdb: IO Error: 403" },
        "cid",
        "f"
      )
    ).toThrow(/403/);
  });

  it("still fails with a usable message when a failed run said nothing", () => {
    expect(() => parseWasmSchemaEnvelope({ exitCode: 1, output: null }, "cid", "f")).toThrow(
      /built-in runtime/i
    );
  });

  it("REFUSES a profile with no columns rather than storing an empty schema", () => {
    // An empty schema does not fail loudly downstream — it produces confidently
    // wrong prompts about a source with no columns.
    expect(() =>
      parseWasmSchemaEnvelope({ exitCode: 0, output: { ...good, columns: [] } }, "cid", "f")
    ).toThrow(/no columns/i);
  });

  it("refuses anything that is not a profile at all", () => {
    for (const output of [null, "not json", 42, { columns: "nope" }]) {
      expect(() => parseWasmSchemaEnvelope({ exitCode: 0, output }, "cid", "f")).toThrow();
    }
  });

  it("never lets a bad row_count become NaN in the schema", () => {
    // NaN would serialize into the prompt and into every downstream row-cap check.
    const schema = parseWasmSchemaEnvelope(
      { exitCode: 0, output: { ...good, row_count: "banana" } },
      "cid",
      "f"
    );
    expect(schema.row_count).toBe(0);
    const negative = parseWasmSchemaEnvelope(
      { exitCode: 0, output: { ...good, row_count: -5 } },
      "cid",
      "f"
    );
    expect(negative.row_count).toBe(0);
  });

  it("tolerates a missing sample_rows / correlations instead of throwing", () => {
    const schema = parseWasmSchemaEnvelope(
      { exitCode: 0, output: { row_count: 1, columns: good.columns } },
      "cid",
      "f"
    );
    expect(schema.sample_rows).toEqual([]);
    expect(schema.correlations).toBeUndefined();
    expect(schema.detected_domain).toBe("general");
  });
});

describe("singleObjectAlias", () => {
  it("keeps the key path, so hive columns are still derivable from it", () => {
    expect(singleObjectAlias("s3://bucket/release/theme=b/part-0.parquet")).toBe(
      "release/theme=b/part-0.parquet"
    );
    expect(singleObjectAlias("https://h.example.com/a/b.parquet")).toBe("a/b.parquet");
  });

  it("never returns an empty name", () => {
    expect(singleObjectAlias("s3://bucket")).toBe("remote.parquet");
  });
});

describe("wasm schema lease store", () => {
  const lease = (id: string, expiresAt: number) =>
    ({
      requestId: id,
      tokens: ["t1"],
      csvId: "c",
      filename: "f",
      readUrl: "s3://b/p",
      isHivePartitioned: false,
      sourceKey: "k",
      expiresAt,
    }) as Parameters<ReturnType<typeof createWasmSchemaLeaseStore>["put"]>[0];

  it("is SINGLE-USE — a replayed envelope cannot re-enter the cache-write path", () => {
    const store = createWasmSchemaLeaseStore();
    store.put(lease("a", 10_000));
    expect(store.take("a", 1_000)).toBeDefined();
    expect(store.take("a", 1_000)).toBeUndefined();
  });

  it("refuses an id it never issued", () => {
    expect(createWasmSchemaLeaseStore().take("forged", 1)).toBeUndefined();
  });

  it("refuses a lapsed lease, and still consumes it", () => {
    const store = createWasmSchemaLeaseStore();
    store.put(lease("a", 1_000));
    expect(store.take("a", 1_000)).toBeUndefined(); // dead AT the deadline
    expect(store.size()).toBe(0);
  });

  it("sweeps only what has lapsed", () => {
    const store = createWasmSchemaLeaseStore();
    store.put(lease("dead", 1_000));
    store.put(lease("live", 9_000));
    expect(store.sweep(5_000)).toBe(1);
    expect(store.size()).toBe(1);
    expect(store.take("live", 5_000)).toBeDefined();
  });

  it("leases the browser a window long enough to boot a cold worker", () => {
    // A cold Pyodide + DuckDB boot plus the profile; shorter and a slow machine
    // loses the connect after doing all the work.
    expect(CONNECT_LEASE_MS).toBeGreaterThanOrEqual(5 * 60 * 1000);
    expect(CONNECT_LEASE_MS).toBeLessThanOrEqual(30 * 60 * 1000);
  });
});

describe("prepareWasmRemoteSchemaJob", () => {
  const enumerate = vi.fn();
  const register = vi.fn();
  const resolvePlan = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    enumerate.mockReset();
    register.mockReset();
    resolvePlan.mockReset();
    let n = 0;
    register.mockImplementation(() => `tok${++n}`);
    vi.doMock("@/lib/sandbox/remote-fetch", () => ({
      enumerateRemoteParquetFiles: enumerate,
      resolveRemoteHttpsFetch: resolvePlan,
    }));
    vi.doMock("@/lib/sandbox/wasm/range-singleton", () => ({
      getRangeRegistry: () => ({ register }),
    }));
  });

  const args = {
    readUrl: "s3://bucket/release/theme=buildings",
    csvId: "cid",
    filename: "buildings",
    sourceKey: "k",
    isHivePartitioned: true,
  };

  it("mints ONE token per file, each bound to a resolved URL the worker never sees", async () => {
    enumerate.mockResolvedValue({
      host: "bucket.s3.us-west-2.amazonaws.com",
      objects: [
        { key: "release/theme=buildings/part-0.parquet", size: 100 },
        { key: "release/theme=buildings/part-1.parquet", size: 200 },
      ],
    });
    const { prepareWasmRemoteSchemaJob } = await import("@/lib/parquet/wasm-schema-job");
    const { job, lease } = await prepareWasmRemoteSchemaJob(args);

    expect(register).toHaveBeenCalledTimes(2);
    // A prefix-scoped token would let the worker name files it was never granted.
    expect(register.mock.calls[0]![0].url).toContain("part-0.parquet");
    expect(job.request.duckdb!.aliases).toHaveLength(2);
    expect(lease.tokens).toEqual(["tok1", "tok2"]);
  });

  it("gives every token a LEASE, because no run will ever release it", async () => {
    enumerate.mockResolvedValue({
      host: "h",
      objects: [{ key: "a/part-0.parquet", size: 10 }],
    });
    const { prepareWasmRemoteSchemaJob } = await import("@/lib/parquet/wasm-schema-job");
    const now = 1_000_000;
    const { lease } = await prepareWasmRemoteSchemaJob({ ...args, now: () => now });
    expect(register.mock.calls[0]![0].expiresAt).toBe(now + CONNECT_LEASE_MS);
    expect(register.mock.calls[0]![0].runId).toBeUndefined();
    expect(lease.expiresAt).toBe(now + CONNECT_LEASE_MS);
  });

  it("the worker job addresses ONLY this origin — no upstream URL reaches it", async () => {
    enumerate.mockResolvedValue({
      host: "bucket.s3.us-west-2.amazonaws.com",
      objects: [{ key: "release/theme=b/part-0.parquet", size: 10 }],
    });
    const { prepareWasmRemoteSchemaJob } = await import("@/lib/parquet/wasm-schema-job");
    const { job } = await prepareWasmRemoteSchemaJob(args);
    const serialized = JSON.stringify(job.request);
    expect(serialized).not.toContain("amazonaws.com");
    expect(serialized).not.toContain("s3://");
    expect(job.request.duckdb!.aliases[0]!.url).toBe("/api/wasm-range/tok1");
  });

  it("fails closed when no safe egress host derives from the URL", async () => {
    const { prepareWasmRemoteSchemaJob } = await import("@/lib/parquet/wasm-schema-job");
    await expect(
      prepareWasmRemoteSchemaJob({ ...args, readUrl: "https://169.254.169.254/x.parquet" })
    ).rejects.toThrow(/no safe egress host/i);
    expect(register).not.toHaveBeenCalled();
  });

  it("does NOT list a single-file s3:// source — that prefix lists to nothing", async () => {
    // splitS3Prefix() succeeds on a literal key too, so keying off it would have
    // turned `s3://b/a/f.parquet` into a LIST of `a/f.parquet/` and failed with
    // "No Parquet files found". The discriminant is the query path's: glob or hive.
    resolvePlan.mockResolvedValue({
      ok: true,
      url: "https://b.s3.amazonaws.com/a/f.parquet",
      allowlist: ["b.s3.amazonaws.com"],
    });
    const { prepareWasmRemoteSchemaJob } = await import("@/lib/parquet/wasm-schema-job");
    const { job } = await prepareWasmRemoteSchemaJob({
      ...args,
      readUrl: "s3://bucket/a/f.parquet",
      isHivePartitioned: false,
    });
    expect(enumerate).not.toHaveBeenCalled();
    expect(job.request.duckdb!.aliases).toEqual([
      { name: "a/f.parquet", url: "/api/wasm-range/tok1" },
    ]);
  });

  it("ENUMERATES a glob source even when it is not hive-partitioned", async () => {
    enumerate.mockResolvedValue({ host: "h", objects: [{ key: "a/p-0.parquet", size: 10 }] });
    const { prepareWasmRemoteSchemaJob } = await import("@/lib/parquet/wasm-schema-job");
    await prepareWasmRemoteSchemaJob({
      ...args,
      readUrl: "s3://bucket/a/**/*.parquet",
      isHivePartitioned: false,
    });
    expect(enumerate).toHaveBeenCalledTimes(1);
  });

  it("refuses an empty prefix rather than building read_parquet([])", async () => {
    enumerate.mockResolvedValue({ host: "h", objects: [] });
    const { prepareWasmRemoteSchemaJob } = await import("@/lib/parquet/wasm-schema-job");
    await expect(prepareWasmRemoteSchemaJob(args)).rejects.toThrow(/No Parquet files/i);
  });
});
