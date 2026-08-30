import { describe, it, expect } from "vitest";
import { enumerateRemoteParquetFiles } from "@/lib/sandbox/remote-fetch";
import { prefetchFooters, FOOTER_TAIL_BYTES } from "@/lib/sandbox/wasm/footer-prefetch";
import { createWarmCache } from "@/lib/sandbox/wasm/range-registry";
import { encodeS3Key } from "@/lib/sandbox/wasm/remote-hive";

/** LIVE: prove parallel prefetch actually warms real parquet footers. */
const gated = process.env.HERMETIC_LIVE_EGRESS_TEST ? describe : describe.skip;
const HOST = "overturemaps-us-west-2.s3.amazonaws.com";

gated("footer prefetch — live", () => {
  it("warms real parquet tails in parallel, and they end with the PAR1 trailer", async () => {
    const { host, objects } = await enumerateRemoteParquetFiles({
      remoteParquetUrl:
        "s3://overturemaps-us-west-2/release/2026-07-22.0/theme=buildings/type=building",
      isHivePartitioned: true,
    });
    expect(host).toBe(HOST);
    // A slice is enough to prove the mechanism without pulling 512 × 256KiB.
    const slice = objects.slice(0, 8);
    const cache = createWarmCache();
    const t0 = Date.now();
    const res = await prefetchFooters(
      slice.map((o) => ({
        url: `https://${host}/${encodeS3Key(o.key)}`,
        allowlist: [HOST],
        sizeBytes: o.size,
      })),
      (url, start, body) => cache.put(url, start, body),
      { concurrency: 8 }
    );
    const ms = Date.now() - t0;

    expect(res.warmed).toBe(8);
    expect(res.failed).toBe(0);
    expect(res.bytes).toBe(8 * FOOTER_TAIL_BYTES);

    // Each warmed tail really is the end of a parquet file.
    for (const o of slice) {
      const url = `https://${host}/${encodeS3Key(o.key)}`;
      const start = o.size - FOOTER_TAIL_BYTES;
      const tail = cache.get(url, start, o.size - 1);
      expect(tail).toBeDefined();
      expect(tail!.subarray(-4).toString("latin1")).toBe("PAR1");
    }
    // 8 files in parallel should be far quicker than 8 serial round trips.
    console.log(`[prefetch] 8 footers warmed in ${ms}ms (${Math.round(res.bytes / 1e6)}MB)`);
  }, 240_000);
});
