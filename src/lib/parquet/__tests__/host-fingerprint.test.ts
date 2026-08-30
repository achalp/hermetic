import { describe, it, expect, vi, beforeEach } from "vitest";
import { fingerprintFromListing, fingerprintFromSize } from "@/lib/parquet/host-fingerprint";

/**
 * The host-side freshness fingerprint (build log D26). The digest rules are the
 * whole contract — a cache that mis-answers "has this source changed?" either
 * re-extracts forever or serves a stale schema.
 */

describe("fingerprintFromListing", () => {
  const A = { key: "release/theme=b/part-1.parquet", size: 200 };
  const B = { key: "release/theme=a/part-0.parquet", size: 100 };

  it("is stable across listing ORDER — S3 does not promise order across pages", () => {
    expect(fingerprintFromListing([A, B])).toBe(fingerprintFromListing([B, A]));
  });

  it("changes when a file is added or removed", () => {
    const base = fingerprintFromListing([A, B]);
    expect(fingerprintFromListing([A])).not.toBe(base);
    expect(fingerprintFromListing([A, B, { key: "release/theme=c/p.parquet", size: 1 }])).not.toBe(
      base
    );
  });

  it("changes when a file is REWRITTEN under the same name (size moved)", () => {
    // The name-only digest the Docker path uses is blind to this; including the
    // size closes it for free, since the listing already carries it.
    expect(fingerprintFromListing([{ ...A, size: 999 }, B])).not.toBe(
      fingerprintFromListing([A, B])
    );
  });

  it("carries the file COUNT in the clear, so a cache entry is legible", () => {
    expect(fingerprintFromListing([A, B])).toMatch(/^s3list:2:[0-9a-f]{32}$/);
    expect(fingerprintFromListing([])).toMatch(/^s3list:0:/);
  });

  it("cannot be confused with the Docker digest — different prefix", () => {
    // The Docker path emits `files:N:md5` over `s3://…` strings. Comparing the two
    // would call an unchanged source changed (harmless) or, worse, invite someone
    // to "unify" them and compare incomparable digests.
    expect(fingerprintFromListing([A])).not.toMatch(/^files:/);
    expect(fingerprintFromListing([A]).startsWith("s3list:")).toBe(true);
  });

  it("does not collide on a key that CONTAINS the separator", () => {
    // "a:1" + size 0 must not digest the same as key "a" + size 10.
    expect(fingerprintFromListing([{ key: "a:1", size: 0 }])).not.toBe(
      fingerprintFromListing([{ key: "a", size: 10 }])
    );
  });
});

describe("fingerprintFromSize", () => {
  it("uses the object size when the source is a single file", () => {
    expect(fingerprintFromSize(525687024)).toBe("size:525687024");
  });

  it("stays a STABLE value when the size is unknown, rather than throwing", () => {
    // An unknown size must not become a random/absent fingerprint: that would
    // either bypass the cache forever or crash the connect.
    expect(fingerprintFromSize(null)).toBe("size:unknown");
  });
});

describe("computeRemoteParquetFingerprintHost — routing", () => {
  const enumerate = vi.fn();
  const fetchRange = vi.fn();
  const resolvePlan = vi.fn();

  beforeEach(() => {
    enumerate.mockReset();
    fetchRange.mockReset();
    resolvePlan.mockReset();
    vi.resetModules();
    vi.doMock("@/lib/sandbox/remote-fetch", () => ({
      enumerateRemoteParquetFiles: enumerate,
      resolveRemoteHttpsFetch: resolvePlan,
    }));
    vi.doMock("@/lib/sandbox/egress-fetch", () => ({ fetchRemoteRange: fetchRange }));
  });

  it("LISTS an s3:// prefix", async () => {
    enumerate.mockResolvedValue({ host: "b.s3.amazonaws.com", objects: [{ key: "k", size: 4 }] });
    const { computeRemoteParquetFingerprintHost } = await import("@/lib/parquet/host-fingerprint");
    const fp = await computeRemoteParquetFingerprintHost("s3://b/release/theme=x");
    expect(fp).toMatch(/^s3list:1:/);
    expect(fetchRange).not.toHaveBeenCalled();
  });

  it("falls back to a ONE-BYTE ranged read for a single https object", async () => {
    resolvePlan.mockResolvedValue({ ok: true, url: "https://h/x.parquet", allowlist: ["h"] });
    fetchRange.mockResolvedValue({ body: Buffer.alloc(1), contentRange: "", total: 99 });
    const { computeRemoteParquetFingerprintHost } = await import("@/lib/parquet/host-fingerprint");
    expect(await computeRemoteParquetFingerprintHost("https://h/x.parquet")).toBe("size:99");
    // One byte, never the object: the size arrives in Content-Range.
    expect(fetchRange).toHaveBeenCalledWith(expect.objectContaining({ range: "bytes=0-0" }));
    expect(enumerate).not.toHaveBeenCalled();
  });

  it("forwards CREDENTIALS and the SIGNAL, and omits them when absent", async () => {
    enumerate.mockResolvedValue({ host: "h", objects: [] });
    const { computeRemoteParquetFingerprintHost } = await import("@/lib/parquet/host-fingerprint");
    const ctl = new AbortController();
    const creds = { s3AccessKeyId: "AK", s3SecretAccessKey: "SK" };
    await computeRemoteParquetFingerprintHost("s3://b/p", creds, { signal: ctl.signal });
    expect(enumerate).toHaveBeenCalledWith(expect.objectContaining({ remoteCreds: creds }), {
      signal: ctl.signal,
    });

    enumerate.mockClear();
    await computeRemoteParquetFingerprintHost("s3://b/p");
    // A private bucket and a public one are different sources; passing an
    // explicit `undefined` where the shape expects absence has bitten before.
    expect(enumerate.mock.calls[0]![0]).not.toHaveProperty("remoteCreds");
    expect(enumerate.mock.calls[0]![1]).toEqual({});
  });

  it("forwards the signal on the single-object path too", async () => {
    resolvePlan.mockResolvedValue({ ok: true, url: "https://h/x", allowlist: ["h"] });
    fetchRange.mockResolvedValue({ body: Buffer.alloc(1), contentRange: "", total: 5 });
    const { computeRemoteParquetFingerprintHost } = await import("@/lib/parquet/host-fingerprint");
    const ctl = new AbortController();
    await computeRemoteParquetFingerprintHost("https://h/x.parquet", undefined, {
      signal: ctl.signal,
    });
    expect(fetchRange.mock.calls[0]![0].signal).toBe(ctl.signal);
  });

  it("refuses rather than fingerprinting a source with no safe fetch plan", async () => {
    resolvePlan.mockResolvedValue({ ok: false, unsupported: "internal host" });
    const { computeRemoteParquetFingerprintHost } = await import("@/lib/parquet/host-fingerprint");
    await expect(
      computeRemoteParquetFingerprintHost("https://169.254.169.254/x.parquet")
    ).rejects.toThrow(/Cannot fingerprint/);
  });
});
