import { describe, it, expect } from "vitest";
import { authorizeEgress } from "@/lib/sandbox/wasm/egress-guard";
import type { EgressAuthorization } from "@/lib/sandbox/wasm/contract";

const AUTH: EgressAuthorization = {
  runId: "run-1",
  allowedHosts: ["bucket.s3.amazonaws.com", "data.example.org"],
};

describe("authorizeEgress — §6a provenance guard", () => {
  it("allows a request to an allowlisted host for the authorized run", () => {
    const v = authorizeEgress(
      { runId: "run-1", url: "https://bucket.s3.amazonaws.com/x.parquet" },
      AUTH
    );
    expect(v).toEqual({ allowed: true, host: "bucket.s3.amazonaws.com" });
  });

  it("host match is case-insensitive; path is an opaque object key", () => {
    const v = authorizeEgress(
      { runId: "run-1", url: "https://Bucket.S3.amazonaws.com/deep/key?with=query" },
      AUTH
    );
    expect(v.allowed).toBe(true);
  });

  it("REJECTS a request whose runId is not the authorized run (cross-source deputy)", () => {
    const v = authorizeEgress({ runId: "run-2", url: "https://bucket.s3.amazonaws.com/x" }, AUTH);
    expect(v).toMatchObject({ allowed: false, reason: /run mismatch/ });
  });

  it("REJECTS every fetch when the run has no authorized source (local-run parity)", () => {
    const v = authorizeEgress(
      { runId: "run-1", url: "https://bucket.s3.amazonaws.com/x" },
      { runId: "run-1", allowedHosts: [] }
    );
    expect(v).toMatchObject({ allowed: false, reason: /no remote source/ });
  });

  it("REJECTS an unparseable URL", () => {
    const v = authorizeEgress({ runId: "run-1", url: "not a url" }, AUTH);
    expect(v).toMatchObject({ allowed: false, reason: /unparseable/ });
  });

  it("REJECTS a non-http(s) scheme (no file:, no gopher:, no data:)", () => {
    const v = authorizeEgress({ runId: "run-1", url: "file:///etc/passwd" }, AUTH);
    expect(v).toMatchObject({ allowed: false, reason: /unsupported scheme/ });
  });

  it("REJECTS a host that is not on the stored-source allowlist (worker can't widen)", () => {
    const v = authorizeEgress({ runId: "run-1", url: "https://evil.example.net/x" }, AUTH);
    expect(v).toMatchObject({ allowed: false, reason: /not in the source allowlist/ });
  });

  it("does not treat the generic s3 host as allowed when only the vhost is (no widening)", () => {
    const v = authorizeEgress({ runId: "run-1", url: "https://s3.amazonaws.com/bucket/x" }, AUTH);
    expect(v.allowed).toBe(false);
  });

  it("allows plain http on an allowlisted host (scheme gate accepts http:)", () => {
    const v = authorizeEgress({ runId: "run-1", url: "http://data.example.org/x" }, AUTH);
    expect(v).toEqual({ allowed: true, host: "data.example.org" });
  });
});
