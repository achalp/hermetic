import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The ingest gate that used to read `if (runtime !== "docker") throw` (build log
 * D24). A container was never what made LOCAL parquet profiling possible, so a
 * non-Docker runtime now routes to the in-process profiler instead of failing.
 */

const hostSpy = vi.fn();
const fpSpy = vi.fn(() => Promise.resolve("s3list:2:abc"));
vi.mock("@/lib/parquet/host-fingerprint", () => ({
  computeRemoteParquetFingerprintHost: (...a: unknown[]) => fpSpy(...(a as [])),
}));
vi.mock("@/lib/parquet/host-schema", () => ({
  extractParquetSchemaHost: (args: unknown) => {
    hostSpy(args);
    return Promise.resolve({
      csv_id: "cid",
      filename: "f.parquet",
      row_count: 7,
      columns: [],
      sample_rows: [],
      detected_domain: "general",
      source_type: "file",
    });
  },
}));
// The Docker path must never be entered on a wasm run — fail loudly if it is.
vi.mock("@/lib/sandbox/docker-utils", () => ({
  run: vi.fn(() => {
    throw new Error("docker must not be invoked on the wasm runtime");
  }),
}));

beforeEach(() => {
  hostSpy.mockClear();
  fpSpy.mockClear();
});

describe("extractParquetSchema — runtime routing", () => {
  it("profiles on the HOST for the built-in runtime, never shelling out to docker", async () => {
    const { extractParquetSchema } = await import("@/lib/parquet/schema-extractor");
    const schema = await extractParquetSchema("/d/f.parquet", "cid", "f.parquet", false, "wasm");
    expect(schema.row_count).toBe(7);
    expect(hostSpy).toHaveBeenCalledTimes(1);
  });

  it("passes the folder + hive flags through, so partition columns survive", async () => {
    const { extractParquetSchema } = await import("@/lib/parquet/schema-extractor");
    await extractParquetSchema("/d/set", "cid", "set", true, "wasm", true);
    expect(hostSpy).toHaveBeenCalledWith(
      expect.objectContaining({ localPath: "/d/set", isFolder: true, isHivePartitioned: true })
    );
  });

  it("omits isHivePartitioned rather than passing undefined when it was not supplied", async () => {
    const { extractParquetSchema } = await import("@/lib/parquet/schema-extractor");
    await extractParquetSchema("/d/f.parquet", "cid", "f.parquet", false, "wasm");
    expect(hostSpy.mock.calls[0]![0]).not.toHaveProperty("isHivePartitioned");
  });

  it("still uses the Docker path for the docker runtime", async () => {
    const { extractParquetSchema } = await import("@/lib/parquet/schema-extractor");
    await expect(
      extractParquetSchema("/d/f.parquet", "cid", "f.parquet", false, "docker")
    ).rejects.toThrow(/docker must not be invoked/);
    expect(hostSpy).not.toHaveBeenCalled();
  });
});

describe("computeRemoteParquetFingerprint — runtime routing", () => {
  it("lists from the HOST on the built-in runtime instead of requiring Docker", async () => {
    const { computeRemoteParquetFingerprint } = await import("@/lib/parquet/schema-extractor");
    // This used to throw "Remote Parquet fingerprint requires the Docker sandbox
    // runtime." — the first error the built-in runtime actually reported (D24).
    await expect(computeRemoteParquetFingerprint("s3://b/release/theme=x", "wasm")).resolves.toBe(
      "s3list:2:abc"
    );
    expect(fpSpy).toHaveBeenCalledTimes(1);
  });

  it("still uses the Docker path for the docker runtime", async () => {
    const { computeRemoteParquetFingerprint } = await import("@/lib/parquet/schema-extractor");
    await expect(
      computeRemoteParquetFingerprint("s3://b/release/theme=x", "docker")
    ).rejects.toThrow();
    expect(fpSpy).not.toHaveBeenCalled();
  });
});
