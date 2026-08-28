import { describe, it, expect } from "vitest";
import { resolveRemoteHttpsFetch } from "@/lib/sandbox/remote-fetch";

/**
 * Resolve a stored remote source → an HTTPS fetch URL + allowlist (build log D13).
 * s3:// → vhost HTTPS (pre-signed when keys present); https:// passthrough;
 * unsupported shapes fail explicitly (routed to Docker). A live fetch is a manual
 * smoke — CI can't reach a real bucket.
 */
describe("resolveRemoteHttpsFetch", () => {
  it("passes an https:// url through and derives its allowlist", async () => {
    const r = await resolveRemoteHttpsFetch({
      remoteParquetUrl: "https://data.example.com/city.parquet",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.url).toBe("https://data.example.com/city.parquet");
      expect(r.allowlist).toContain("data.example.com");
    }
  });

  it("builds a vhost HTTPS url for an s3:// source (region-aware) and PRE-SIGNS with keys", async () => {
    const r = await resolveRemoteHttpsFetch({
      remoteParquetUrl: "s3://my-bucket/data/city.parquet",
      remoteCreds: {
        s3Region: "us-west-2",
        s3AccessKeyId: "AKIAIOSFODNN7EXAMPLE",
        s3SecretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const u = new URL(r.url);
      expect(u.hostname).toBe("my-bucket.s3.us-west-2.amazonaws.com");
      expect(u.pathname).toBe("/data/city.parquet");
      expect(u.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
      expect(r.allowlist).toContain("my-bucket.s3.us-west-2.amazonaws.com");
    }
  });

  it("does NOT presign an s3:// source with no keys (public bucket)", async () => {
    const r = await resolveRemoteHttpsFetch({ remoteParquetUrl: "s3://open-data/x.parquet" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.url).toBe("https://open-data.s3.amazonaws.com/x.parquet");
      expect(r.url).not.toContain("X-Amz-Signature");
    }
  });

  it("rejects folder globs, hive trees, and non-http(s) schemes explicitly", async () => {
    expect((await resolveRemoteHttpsFetch({ remoteParquetUrl: "s3://b/dir/*" })).ok).toBe(false);
    expect(
      (await resolveRemoteHttpsFetch({ remoteParquetUrl: "s3://b/t", isHivePartitioned: true })).ok
    ).toBe(false);
    expect((await resolveRemoteHttpsFetch({ remoteParquetUrl: "gs://b/x.parquet" })).ok).toBe(
      false
    );
  });
});
