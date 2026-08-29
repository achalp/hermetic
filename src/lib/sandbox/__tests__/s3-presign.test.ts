import { describe, it, expect } from "vitest";
import { presignS3GetUrl } from "@/lib/sandbox/s3-presign";

/**
 * SigV4 query pre-signing (build log D13). Uses @smithy/signature-v4, so we assert
 * STRUCTURE + DETERMINISM (a fixed signingDate → a stable signature) rather than a
 * golden vector; the algorithm is the SDK's. A live-bucket fetch is a manual smoke
 * (a real S3 GET can't run in CI — the egress policy blocks loopback / there is no
 * bucket). Keys are inputs only — they never appear in the signed URL.
 */
const CREDS = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  region: "us-east-1",
};
const AT = new Date("2026-01-02T03:04:05Z");

describe("presignS3GetUrl", () => {
  it("adds the SigV4 query params and preserves scheme/host/path", async () => {
    const url = await presignS3GetUrl({
      httpsUrl: "https://my-bucket.s3.us-east-1.amazonaws.com/data/city.parquet",
      ...CREDS,
      signingDate: AT,
    });
    const u = new URL(url);
    expect(u.protocol).toBe("https:");
    expect(u.hostname).toBe("my-bucket.s3.us-east-1.amazonaws.com");
    expect(u.pathname).toBe("/data/city.parquet");
    expect(u.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(u.searchParams.get("X-Amz-Credential")).toContain("/us-east-1/s3/aws4_request");
    expect(u.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(u.searchParams.get("X-Amz-Expires")).toBe("900");
  });

  it("is deterministic for a fixed signingDate, and the secret never leaks into the URL", async () => {
    const args = {
      httpsUrl: "https://my-bucket.s3.us-east-1.amazonaws.com/x.parquet",
      ...CREDS,
      signingDate: AT,
    };
    const a = await presignS3GetUrl(args);
    const b = await presignS3GetUrl(args);
    expect(a).toBe(b); // same inputs + time → identical signature
    expect(a).not.toContain(CREDS.secretAccessKey);
    // a different secret changes the signature
    const c = await presignS3GetUrl({
      ...args,
      secretAccessKey: "different-secret-value-000000000000000000",
    });
    expect(new URL(c).searchParams.get("X-Amz-Signature")).not.toBe(
      new URL(a).searchParams.get("X-Amz-Signature")
    );
  });

  it("honors a custom expiry", async () => {
    const url = await presignS3GetUrl({
      httpsUrl: "https://b.s3.amazonaws.com/k",
      ...CREDS,
      expiresIn: 120,
      signingDate: AT,
    });
    expect(new URL(url).searchParams.get("X-Amz-Expires")).toBe("120");
  });
});
