import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Contract tests for the /api/remote-parquet/schema POST handler.
 *
 * Scope: the local-origin gate, URL validation / injection rejection, and the
 * happy path. The sandbox schema extraction and the in-memory store are mocked
 * so importing the route runs no docker and touches no real storage.
 */

const validateLocalOrigin = vi.fn(() => true);
vi.mock("@/lib/local-files/security", () => ({
  validateLocalOrigin: () => validateLocalOrigin(),
}));

const extractRemoteParquetSchema = vi.fn();
vi.mock("@/lib/parquet/schema-extractor", () => ({
  extractRemoteParquetSchema: (...args: unknown[]) => extractRemoteParquetSchema(...args),
}));

const storeRemoteParquetRef = vi.fn();
vi.mock("@/lib/csv/storage", () => ({
  storeRemoteParquetRef: (...args: unknown[]) => storeRemoteParquetRef(...args),
}));

vi.mock("@/lib/runtime-config", () => ({
  getActiveSandboxRuntime: vi.fn(() => "docker"),
}));

import { POST } from "../route";

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/remote-parquet/schema", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  validateLocalOrigin.mockReturnValue(true);
  extractRemoteParquetSchema.mockResolvedValue({ row_count: 42, columns: [] });
});

describe("POST /api/remote-parquet/schema", () => {
  it("returns 403 for a non-local origin and never reads the file", async () => {
    validateLocalOrigin.mockReturnValue(false);
    const res = await POST(makeRequest({ url: "s3://b/x.parquet" }));
    expect(res.status).toBe(403);
    expect(extractRemoteParquetSchema).not.toHaveBeenCalled();
  });

  it("rejects an unsafe / injection URL with 400 before touching the sandbox", async () => {
    const res = await POST(makeRequest({ url: "s3://b/x.parquet'); DROP TABLE t; --" }));
    expect(res.status).toBe(400);
    expect(extractRemoteParquetSchema).not.toHaveBeenCalled();
    expect(storeRemoteParquetRef).not.toHaveBeenCalled();
  });

  it("rejects a non-object-store scheme with 400", async () => {
    const res = await POST(makeRequest({ url: "file:///etc/passwd" }));
    expect(res.status).toBe(400);
    expect(extractRemoteParquetSchema).not.toHaveBeenCalled();
  });

  it("extracts + stores and returns a csv_id/schema on the happy path", async () => {
    const res = await POST(makeRequest({ url: "s3://bucket/data/*.parquet" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(typeof json.csv_id).toBe("string");
    expect(json.schema).toEqual({ row_count: 42, columns: [] });
    expect(extractRemoteParquetSchema).toHaveBeenCalledOnce();
    expect(storeRemoteParquetRef).toHaveBeenCalledOnce();
  });

  it("normalizes a bare Overture prefix into a recursive glob with hive on", async () => {
    await POST(
      makeRequest({
        url: "s3://overturemaps-us-west-2/release/2026-06-17.0/theme=buildings/type=building",
      })
    );
    const [readUrl, , , , isHive] = extractRemoteParquetSchema.mock.calls[0]!;
    expect(readUrl).toBe(
      "s3://overturemaps-us-west-2/release/2026-06-17.0/theme=buildings/type=building/**/*.parquet"
    );
    expect(isHive).toBe(true);
    // The stored reference uses the same normalized read URL + hive flag.
    const storeArgs = storeRemoteParquetRef.mock.calls[0]!;
    expect(storeArgs[2]).toBe(readUrl);
    expect(storeArgs[4]).toBe(true);
  });

  it("forwards only the recognized credential fields (drops unknown keys)", async () => {
    await POST(
      makeRequest({
        url: "s3://bucket/x.parquet",
        creds: {
          s3AccessKeyId: "AKIA",
          s3SecretAccessKey: "shh",
          s3Region: "us-west-2",
          s3Endpoint: "minio.local",
          evil: "rm -rf",
        },
      })
    );
    const credsArg = extractRemoteParquetSchema.mock.calls[0]?.[5];
    expect(credsArg).toEqual({
      s3AccessKeyId: "AKIA",
      s3SecretAccessKey: "shh",
      s3Region: "us-west-2",
      s3Endpoint: "minio.local",
    });
    expect(credsArg).not.toHaveProperty("evil");
  });

  it("returns 500 when the sandbox extraction fails", async () => {
    extractRemoteParquetSchema.mockRejectedValue(new Error("network unreachable"));
    const res = await POST(makeRequest({ url: "https://host/file.parquet" }));
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toContain("network unreachable");
  });
});
