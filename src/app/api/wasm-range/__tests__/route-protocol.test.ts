import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * The wire contract `/api/wasm-range` owes DuckDB-WASM (build log D31).
 *
 * These are offline — the upstream fetch is mocked — because the thing under test
 * is the PROTOCOL, and the protocol is what the first live Overture connect got
 * wrong. The gated live test next door proves the bytes; this proves the shape.
 */

const fetchRemoteRange = vi.fn();
vi.mock("@/lib/sandbox/egress-fetch", () => ({
  fetchRemoteRange: (...a: unknown[]) => fetchRemoteRange(...a),
  EgressFetchError: class extends Error {},
}));

import { GET, HEAD } from "@/app/api/wasm-range/[token]/route";
import { getRangeRegistry } from "@/lib/sandbox/wasm/range-singleton";

const TOTAL = 525687024;
const ctx = (token: string) => ({ params: Promise.resolve({ token }) });
const req = (range?: string) =>
  new NextRequest("http://localhost/api/wasm-range/x", {
    headers: range ? { range } : {},
  });

function mint(budgetBytes = 64 * 1024 * 1024) {
  return getRangeRegistry().register({
    url: "https://b.s3.amazonaws.com/part-0.parquet",
    allowlist: ["b.s3.amazonaws.com"],
    budgetBytes,
  });
}

beforeEach(() => {
  fetchRemoteRange.mockReset();
  fetchRemoteRange.mockResolvedValue({
    body: Buffer.alloc(4),
    contentRange: `bytes 0-3/${TOTAL}`,
    total: TOTAL,
  });
});

describe("HEAD — the size probe DuckDB actually issues", () => {
  it("answers 206 with Content-Range when the probe carries a Range", async () => {
    // duckdb-wasm opens an HTTP file with
    //   HEAD + `Range: bytes=0-`, then `if (contentLength !== null && status == 206)`.
    // Returning 200 here made the probe fail on EVERY file and sent DuckDB down a
    // fallback that ends in a whole-object GET — the first live connect's death.
    const res = await HEAD(req("bytes=0-"), ctx(mint()));
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 0-${TOTAL - 1}/${TOTAL}`);
    // DuckDB reads Content-Length as the FILE SIZE, and for `bytes=0-` they agree.
    expect(res.headers.get("content-length")).toBe(String(TOTAL));
    expect(res.headers.get("accept-ranges")).toBe("bytes");
  });

  it("still answers a plain 200 for a HEAD with no Range", async () => {
    const res = await HEAD(req(), ctx(mint()));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-range")).toBeNull();
  });

  it("clamps a probe that runs past the end of the object", async () => {
    const res = await HEAD(req(`bytes=0-${TOTAL + 999}`), ctx(mint()));
    expect(res.headers.get("content-range")).toBe(`bytes 0-${TOTAL - 1}/${TOTAL}`);
  });

  it("404s an unknown token before probing anything upstream", async () => {
    expect((await HEAD(req("bytes=0-"), ctx("ghost"))).status).toBe(404);
    expect(fetchRemoteRange).not.toHaveBeenCalled();
  });
});

describe("GET — a refusal must say why", () => {
  it("refuses a bare GET, and NAMES the missing header", async () => {
    // Still refused: a whole-object read is what this endpoint exists to prevent.
    // But the 416 used to carry no diagnostic at all, which is how the live
    // failure presented — the same empty-diagnostics trap as the egress gateway.
    const res = await GET(req(), ctx(mint()));
    expect(res.status).toBe(416);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Range header is required/i);
    expect(body.error).toMatch(/never serves a whole object/i);
    expect(fetchRemoteRange).not.toHaveBeenCalled();
  });

  it("echoes the offending spec back for a malformed Range", async () => {
    const res = await GET(req("bytes=-500"), ctx(mint())); // suffix form: unsupported
    expect(res.status).toBe(416);
    expect(((await res.json()) as { error: string }).error).toContain("bytes=-500");
  });

  it("serves a well-formed window as 206", async () => {
    const res = await GET(req("bytes=0-3"), ctx(mint()));
    expect(res.status).toBe(206);
    expect(fetchRemoteRange).toHaveBeenCalledWith(expect.objectContaining({ range: "bytes=0-3" }));
  });
});
