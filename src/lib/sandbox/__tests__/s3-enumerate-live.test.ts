import { describe, it, expect } from "vitest";
import { enumerateRemoteParquetFiles } from "@/lib/sandbox/remote-fetch";

/**
 * LIVE enumeration of the real Overture hive source through the Rust egress core.
 * Gated (HERMETIC_LIVE_EGRESS_TEST) — needs the network and the built binary.
 */
const gated = process.env.HERMETIC_LIVE_EGRESS_TEST ? describe : describe.skip;

gated("enumerateRemoteParquetFiles — live", () => {
  it("lists every part file under the hive prefix, in deterministic order", async () => {
    const { host, objects } = await enumerateRemoteParquetFiles({
      remoteParquetUrl:
        "s3://overturemaps-us-west-2/release/2026-07-22.0/theme=buildings/type=building",
      isHivePartitioned: true,
    });
    expect(host).toBe("overturemaps-us-west-2.s3.amazonaws.com");
    // Measured in D18: 512 part files, ~257GB.
    expect(objects.length).toBe(512);
    expect(objects.every((o) => o.key.endsWith(".parquet"))).toBe(true);
    expect(objects.every((o) => o.size > 0)).toBe(true);
    // Hive segments survive — they become DuckDB partition columns.
    expect(objects[0].key).toContain("theme=buildings/type=building");
    // Deterministic ordering (goldens depend on it).
    const keys = objects.map((o) => o.key);
    expect(keys).toEqual([...keys].sort());
    const total = objects.reduce((n, o) => n + o.size, 0);
    expect(total).toBeGreaterThan(200e9);
  }, 180_000);
});
