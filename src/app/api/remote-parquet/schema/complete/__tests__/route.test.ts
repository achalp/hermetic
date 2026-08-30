import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `/api/remote-parquet/schema/complete` — hop 2 of connect-time schema extraction
 * on the built-in runtime (build log D27).
 *
 * The load-bearing property is what this handler does NOT take from the request:
 * the source URL, the credentials and the csvId all come from the server's own
 * lease table. The body contributes only a profile. These tests pin that.
 */

vi.mock("@/lib/local-files/security", () => ({ validateLocalOrigin: () => true }));
vi.mock("@/lib/sources/recent-sources", () => ({ recordRecentSource: vi.fn(async () => {}) }));

const storeRemoteParquetRef = vi.fn();
vi.mock("@/lib/csv/storage", () => ({
  storeRemoteParquetRef: (...a: unknown[]) => storeRemoteParquetRef(...a),
}));

const writeSchemaCache = vi.fn<(...a: unknown[]) => Promise<void>>();
vi.mock("@/lib/schema-cache", () => ({
  writeSchemaCache: (...a: unknown[]) => writeSchemaCache(...a),
}));
const fingerprint = vi.fn<(...a: unknown[]) => Promise<string>>();
vi.mock("@/lib/parquet/host-fingerprint", () => ({
  computeRemoteParquetFingerprintHost: (...a: unknown[]) => fingerprint(...a),
}));

const release = vi.fn();
vi.mock("@/lib/sandbox/wasm/range-singleton", () => ({
  getRangeRegistry: () => ({ release }),
}));

const take = vi.fn();
vi.mock("@/lib/parquet/wasm-schema-lease-store", () => ({
  getWasmSchemaLeaseStore: () => ({ take, sweep: vi.fn(), put: vi.fn(), size: () => 0 }),
}));

const LEASE = {
  requestId: "req-1",
  tokens: ["tokA", "tokB"],
  csvId: "server-chosen-id",
  filename: "buildings",
  readUrl: "s3://bucket/release/theme=buildings",
  isHivePartitioned: true,
  sourceKey: "k",
  expiresAt: Date.now() + 60_000,
};

const PROFILE = {
  row_count: 1500,
  columns: [{ name: "n", dtype: "number", null_count: 0, meta: { kind: "number" } }],
  sample_rows: [],
  detected_domain: "general",
};

function post(body: unknown): Request {
  return new Request("http://localhost/api/remote-parquet/schema/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  storeRemoteParquetRef.mockClear();
  release.mockClear();
  writeSchemaCache.mockReset();
  writeSchemaCache.mockResolvedValue(undefined);
  take.mockReset();
  fingerprint.mockReset();
  fingerprint.mockResolvedValue("s3list:1:abc");
});

/** The cache write is fire-and-forget; let its microtasks settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("POST /api/remote-parquet/schema/complete", () => {
  it("stores the schema against the LEASE's identity, not anything in the body", async () => {
    take.mockReturnValue(LEASE);
    const { POST } = await import("../route");
    const res = await POST(
      post({
        requestId: "req-1",
        envelope: { exitCode: 0, output: PROFILE },
        // A hostile body cannot redirect where this lands:
        csvId: "attacker-id",
        readUrl: "s3://other-bucket/x",
      })
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { csv_id: string };
    expect(data.csv_id).toBe("server-chosen-id");
    expect(storeRemoteParquetRef).toHaveBeenCalledWith(
      "server-chosen-id",
      expect.objectContaining({ row_count: 1500 }),
      "s3://bucket/release/theme=buildings",
      undefined,
      true
    );
  });

  it("RELEASES every range token — the lease TTL is a backstop, not the lifetime", async () => {
    take.mockReturnValue(LEASE);
    const { POST } = await import("../route");
    await POST(post({ requestId: "req-1", envelope: { exitCode: 0, output: PROFILE } }));
    expect(release).toHaveBeenCalledWith("tokA");
    expect(release).toHaveBeenCalledWith("tokB");
  });

  it("releases the tokens even when the profile is REJECTED", async () => {
    take.mockReturnValue(LEASE);
    const { POST } = await import("../route");
    const res = await POST(
      post({ requestId: "req-1", envelope: { exitCode: 1, stderr: "IO Error" } })
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    // A failed extraction that leaked its capabilities would be the worse bug.
    expect(release).toHaveBeenCalledTimes(2);
    expect(storeRemoteParquetRef).not.toHaveBeenCalled();
  });

  it("caches under a FRESHLY computed fingerprint, not one captured at hand-out", async () => {
    // If the source changed while the worker profiled it, the entry must describe
    // what was actually read — otherwise the next connect serves a stale schema
    // under a fingerprint that never matched the bytes.
    take.mockReturnValue(LEASE);
    const { POST } = await import("../route");
    await POST(post({ requestId: "req-1", envelope: { exitCode: 0, output: PROFILE } }));
    await settle();
    expect(fingerprint).toHaveBeenCalledWith(LEASE.readUrl, undefined);
    expect(writeSchemaCache).toHaveBeenCalledWith(
      "k",
      "s3list:1:abc",
      expect.objectContaining({ row_count: 1500 })
    );
  });

  it("still returns the schema when the cache write FAILS — caching is not the job", async () => {
    // A source that has become unlistable must not turn a successful extraction
    // into a failed connect.
    take.mockReturnValue(LEASE);
    fingerprint.mockRejectedValue(new Error("bucket gone"));
    const { POST } = await import("../route");
    const res = await POST(
      post({ requestId: "req-1", envelope: { exitCode: 0, output: PROFILE } })
    );
    await settle();
    expect(res.status).toBe(200);
    expect(writeSchemaCache).not.toHaveBeenCalled();
  });

  it("404s an unknown / replayed / expired requestId and stores nothing", async () => {
    take.mockReturnValue(undefined);
    const { POST } = await import("../route");
    const res = await POST(
      post({ requestId: "forged", envelope: { exitCode: 0, output: PROFILE } })
    );
    expect(res.status).toBe(404);
    expect(storeRemoteParquetRef).not.toHaveBeenCalled();
    expect(writeSchemaCache).not.toHaveBeenCalled();
  });

  it("400s a body missing requestId or envelope, without consuming a lease", async () => {
    const { POST } = await import("../route");
    expect((await POST(post({ envelope: { exitCode: 0 } }))).status).toBe(400);
    expect((await POST(post({ requestId: "req-1" }))).status).toBe(400);
    expect(take).not.toHaveBeenCalled();
  });
});
