import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The BUILT-IN (wasm) branch of `/api/remote-parquet/schema` — hop 1 of the
 * two-hop connect (build log D27). There is no container to profile the source
 * in, so this handler either serves a cached schema or hands the browser a job.
 *
 * The sibling suite (route.test.ts) covers the Docker branch; this one exists
 * because the discriminant between "here is a schema" and "here is a job" is the
 * whole protocol, and a response missing `needs_worker` would read as a schema
 * with no columns.
 */

vi.mock("@/lib/local-files/security", () => ({ validateLocalOrigin: () => true }));
vi.mock("@/lib/sources/recent-sources", () => ({ recordRecentSource: vi.fn(async () => {}) }));
vi.mock("@/lib/runtime-config", () => ({ getActiveSandboxRuntime: () => "wasm" }));

const extractRemoteParquetSchema = vi.fn<(...a: unknown[]) => Promise<unknown>>();
const computeRemoteParquetFingerprint = vi.fn<(...a: unknown[]) => Promise<string>>();
vi.mock("@/lib/parquet/schema-extractor", () => ({
  extractRemoteParquetSchema: (...a: unknown[]) => extractRemoteParquetSchema(...a),
  computeRemoteParquetFingerprint: (...a: unknown[]) => computeRemoteParquetFingerprint(...a),
}));

const readWasmSchemaCache = vi.fn<(o: unknown) => Promise<unknown>>();
const resolveWithCache = vi.fn<(o: unknown) => Promise<unknown>>();
vi.mock("@/lib/schema-cache", () => ({
  readWasmSchemaCache: (o: unknown) => readWasmSchemaCache(o),
  resolveWithCache: (o: unknown) => resolveWithCache(o),
}));

const prepareWasmRemoteSchemaJob = vi.fn<(a: unknown) => Promise<unknown>>();
vi.mock("@/lib/parquet/wasm-schema-job", () => ({
  prepareWasmRemoteSchemaJob: (a: unknown) => prepareWasmRemoteSchemaJob(a),
}));

const put = vi.fn();
const sweep = vi.fn();
vi.mock("@/lib/parquet/wasm-schema-lease-store", () => ({
  getWasmSchemaLeaseStore: () => ({ put, sweep, take: vi.fn(), size: () => 0 }),
}));

const storeRemoteParquetRef = vi.fn<(...a: unknown[]) => void>();
vi.mock("@/lib/csv/storage", () => ({
  storeRemoteParquetRef: (...a: unknown[]) => storeRemoteParquetRef(...a),
}));

import { POST } from "../route";

const CACHED = { row_count: 99, columns: [{ name: "n" }], sample_rows: [] };
const JOB = {
  job: { requestId: "req-1", request: { type: "wasm-execute", id: "x" } },
  lease: { requestId: "req-1", tokens: ["t1"] },
};

function post(body: unknown): Request {
  return new Request("http://localhost/api/remote-parquet/schema", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  computeRemoteParquetFingerprint.mockResolvedValue("s3list:2:abc");
  extractRemoteParquetSchema.mockResolvedValue({});
  resolveWithCache.mockResolvedValue({});
  // Invoke the fingerprint callback the route passes in, the way the real cache
  // does — otherwise the wiring inside it is never exercised.
  readWasmSchemaCache.mockImplementation(async (o: unknown) => {
    await (o as { fingerprint: () => Promise<string> }).fingerprint();
    return null;
  });
  prepareWasmRemoteSchemaJob.mockResolvedValue(JOB);
});

describe("POST /api/remote-parquet/schema — built-in runtime", () => {
  it("hands back a JOB on a cache miss, flagged so it cannot read as a schema", async () => {
    const res = await POST(post({ url: "s3://b/release/theme=x" }));
    const data = (await res.json()) as { needs_worker?: boolean; job?: { requestId: string } };
    expect(res.status).toBe(200);
    expect(data.needs_worker).toBe(true);
    expect(data.job?.requestId).toBe("req-1");
    // Nothing is stored yet: there is no schema until the worker answers.
    expect(storeRemoteParquetRef).not.toHaveBeenCalled();
  });

  it("records the lease so hop 2 can recognize the id it issued", async () => {
    await POST(post({ url: "s3://b/release/theme=x" }));
    expect(put).toHaveBeenCalledWith(JOB.lease);
    // ...and reaps abandoned connects while it is here.
    expect(sweep).toHaveBeenCalled();
  });

  it("serves a CACHE HIT directly, without minting a job or any tokens", async () => {
    readWasmSchemaCache.mockResolvedValue(CACHED);
    const res = await POST(post({ url: "s3://b/release/theme=x" }));
    const data = (await res.json()) as { schema: { row_count: number }; cache_status: string };
    expect(data.cache_status).toBe("hit");
    expect(data.schema.row_count).toBe(99);
    expect(prepareWasmRemoteSchemaJob).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("re-stamps the cached schema with THIS request's identity", async () => {
    // The cache holds the intrinsic schema only; csv_id differs per connect.
    readWasmSchemaCache.mockResolvedValue(CACHED);
    const res = await POST(post({ url: "s3://b/release/theme=x" }));
    const data = (await res.json()) as { csv_id: string; schema: { csv_id: string } };
    expect(data.schema.csv_id).toBe(data.csv_id);
    expect(storeRemoteParquetRef).toHaveBeenCalledWith(
      data.csv_id,
      expect.objectContaining({ row_count: 99 }),
      "s3://b/release/theme=x/**/*.parquet",
      undefined,
      true
    );
  });

  it("passes `force` through, so 'ignore cache' still means ignore cache", async () => {
    await POST(post({ url: "s3://b/release/theme=x", force: true }));
    expect(readWasmSchemaCache).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
  });

  it("NEVER reaches the container extractor on this runtime", async () => {
    await POST(post({ url: "s3://b/release/theme=x" }));
    expect(extractRemoteParquetSchema).not.toHaveBeenCalled();
    expect(resolveWithCache).not.toHaveBeenCalled();
  });

  it("threads CREDENTIALS into both the fingerprint probe and the job", async () => {
    const creds = { s3AccessKeyId: "AK", s3SecretAccessKey: "SK" };
    await POST(post({ url: "s3://b/release/theme=x", creds }));
    expect(computeRemoteParquetFingerprint).toHaveBeenCalledWith(
      expect.any(String),
      "wasm",
      expect.objectContaining(creds)
    );
    expect(prepareWasmRemoteSchemaJob).toHaveBeenCalledWith(
      expect.objectContaining({ creds: expect.objectContaining(creds) })
    );
  });

  it("omits creds from the job when the source is public", async () => {
    await POST(post({ url: "s3://b/release/theme=x" }));
    expect(prepareWasmRemoteSchemaJob.mock.calls[0]![0]).not.toHaveProperty("creds");
  });

  it("400s a malformed body before doing any work", async () => {
    const res = await POST(post({ notAUrl: 1 }));
    expect(res.status).toBe(400);
    expect(prepareWasmRemoteSchemaJob).not.toHaveBeenCalled();
  });

  it("rejects an unsafe URL before enumerating or minting anything", async () => {
    const res = await POST(post({ url: "s3://b/x.parquet'); DROP TABLE t; --" }));
    expect(res.status).toBe(400);
    expect(prepareWasmRemoteSchemaJob).not.toHaveBeenCalled();
  });

  it("surfaces a preparation failure as an error, not as an empty schema", async () => {
    prepareWasmRemoteSchemaJob.mockRejectedValue(new Error("no safe egress host"));
    const res = await POST(post({ url: "s3://b/release/theme=x" }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(put).not.toHaveBeenCalled();
  });
});
