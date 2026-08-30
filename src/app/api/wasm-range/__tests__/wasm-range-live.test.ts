import { describe, it, expect } from "vitest";
import { GET, HEAD } from "@/app/api/wasm-range/[token]/route";
import { getRangeRegistry } from "@/lib/sandbox/wasm/range-singleton";
import { NextRequest } from "next/server";

/**
 * LIVE end-to-end proof of the D18 range endpoint: the route → the Rust egress
 * core (`egress-fetch` in RANGE mode) → real S3, reading byte ranges out of a
 * 525 MB Overture parquet part file WITHOUT downloading it.
 *
 * Gated (HERMETIC_LIVE_EGRESS_TEST) because it needs the network and the built
 * Rust binary; the pure pieces are covered offline in range-registry.test.ts and
 * the Rust suite (parse_byte_range fails closed on every malformed form).
 *
 * Run: cargo build --bin egress-fetch && HERMETIC_LIVE_EGRESS_TEST=1 pnpm vitest run \
 *      src/app/api/wasm-range/__tests__/wasm-range-live.test.ts
 */
const gated = process.env.HERMETIC_LIVE_EGRESS_TEST ? describe : describe.skip;

const HOST = "overturemaps-us-west-2.s3.us-west-2.amazonaws.com";
const URL_ =
  `https://${HOST}/release/2026-07-22.0/theme=buildings/type=building/` +
  `part-00000-9ec87dd0-a7e0-5767-b796-1c3c023ddb23-c000.zstd.parquet`;
/** Measured in the D18 spike; the file is immutable within a release. */
const TOTAL = 525687024;

function ctx(token: string) {
  return { params: Promise.resolve({ token }) };
}
function rangeReq(spec?: string) {
  return new NextRequest("http://localhost/api/wasm-range/x", {
    headers: spec ? { range: spec } : {},
  });
}

gated("/api/wasm-range — live ranged reads through the Rust core", () => {
  const mint = (budgetBytes = 8 * 1024 * 1024) =>
    getRangeRegistry().register({ url: URL_, allowlist: [HOST], budgetBytes, runId: "live" });

  it("HEAD reports the object size without downloading it", async () => {
    // No Range on this probe → 200. DuckDB's own probe sends `Range: bytes=0-`
    // and requires 206; that shape is pinned offline in route-protocol.test.ts.
    const res = await HEAD(rangeReq(), ctx(mint()));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe(String(TOTAL));
    expect(res.headers.get("accept-ranges")).toBe("bytes");
  }, 120_000);

  it("GET with a Range returns 206 + the exact bytes (parquet magic at offset 0)", async () => {
    const res = await GET(rangeReq("bytes=0-3"), ctx(mint()));
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 0-3/${TOTAL}`);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.length).toBe(4);
    expect(body.toString("latin1")).toBe("PAR1");
  }, 120_000);

  it("serves a footer-sized range from deep in the file (the real DuckDB access pattern)", async () => {
    const start = TOTAL - 1024;
    const res = await GET(rangeReq(`bytes=${start}-${TOTAL - 1}`), ctx(mint()));
    expect(res.status).toBe(206);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.length).toBe(1024);
    // Parquet ends with the 4-byte magic trailer.
    expect(body.subarray(-4).toString("latin1")).toBe("PAR1");
  }, 120_000);

  it("an unknown token is a 404 — the worker cannot guess its way to a fetch", async () => {
    expect((await GET(rangeReq("bytes=0-3"), ctx("not-a-real-token"))).status).toBe(404);
    expect((await HEAD(rangeReq(), ctx("not-a-real-token"))).status).toBe(404);
  });

  it("a malformed or absent range is refused before any network call", async () => {
    const token = mint();
    for (const bad of [undefined, "bytes=0-1,5-6", "bytes=-500", "bytes=9-2", "0-3", "items=0-1"]) {
      const res = await GET(rangeReq(bad), ctx(token));
      expect(res.status).toBe(416);
    }
    // nothing was charged, because nothing was fetched
    expect(getRangeRegistry().spent(token)).toBe(0);
  });

  it("the per-token budget is a hard ceiling on total bytes served", async () => {
    const token = mint(10); // 10-byte budget
    const ok = await GET(rangeReq("bytes=0-3"), ctx(token)); // charges 4
    expect(ok.status).toBe(206);
    const over = await GET(rangeReq("bytes=0-99"), ctx(token)); // 100 > remaining 6
    expect(over.status).toBe(509);
  }, 120_000);
});
