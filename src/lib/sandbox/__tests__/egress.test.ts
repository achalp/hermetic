/**
 * Egress allowlist derivation + tiering (lib/sandbox/egress.ts).
 *
 * Derivation is deny-by-default and VHOST-ONLY for AWS/GCS: CONNECT tunnels
 * are opaque TLS, the proxy filters by hostname alone, and a generic
 * path-style host (s3.amazonaws.com) would allow every bucket on AWS —
 * re-opening the exfiltration door the allowlist exists to close.
 *
 * Policy is tiered by what the CONTAINER holds (settlement 2026-08-13):
 * no creds → open (nothing secret to guard; the relay cost 30x on
 * planet-scale scans); creds → allowlist; creds + underivable → deny.
 */
import { describe, it, expect } from "vitest";
import { deriveAllowedEgressHosts, egressPolicyFor } from "../egress";

describe("deriveAllowedEgressHosts", () => {
  it("s3 without region: the bucket's vhost host ONLY — no generic path-style", () => {
    expect(deriveAllowedEgressHosts("s3://mybucket/data/x.parquet")).toEqual([
      "mybucket.s3.amazonaws.com",
    ]);
  });

  it("s3 with region adds the regional vhost, never the generic regional host", () => {
    const hosts = deriveAllowedEgressHosts("s3://b/x.parquet", { s3Region: "eu-west-1" });
    expect(hosts.sort()).toEqual(["b.s3.amazonaws.com", "b.s3.eu-west-1.amazonaws.com"]);
    expect(hosts).not.toContain("s3.eu-west-1.amazonaws.com");
    expect(hosts).not.toContain("s3.amazonaws.com");
  });

  it("custom endpoint (R2/MinIO) keeps the bare endpoint host (account-scoped)", () => {
    const hosts = deriveAllowedEgressHosts("s3://b/x.parquet", {
      s3Endpoint: "https://accountid.r2.cloudflarestorage.com",
    });
    expect(hosts.sort()).toEqual([
      "accountid.r2.cloudflarestorage.com",
      "b.accountid.r2.cloudflarestorage.com",
    ]);
    expect(hosts.join(",")).not.toContain("amazonaws");
  });

  it("https URL: exactly its host", () => {
    expect(deriveAllowedEgressHosts("https://data.example.org/dumps/t.parquet")).toEqual([
      "data.example.org",
    ]);
  });

  it("gs URL: the bucket's vhost host only", () => {
    expect(deriveAllowedEgressHosts("gs://pub/x")).toEqual(["pub.storage.googleapis.com"]);
  });

  it("garbage grants nothing", () => {
    expect(deriveAllowedEgressHosts("not a url")).toEqual([]);
    expect(deriveAllowedEgressHosts("https://")).toEqual([]);
  });
});

describe("egressPolicyFor — tiered by what the container holds", () => {
  it("credential-less remote source: open egress, no proxy", () => {
    // The Overture case (run e1c88a71): public bucket, no creds in the
    // container env — the proxy guarded an empty vault at 30x runtime.
    expect(egressPolicyFor("s3://overturemaps-us-west-2/release/x.parquet")).toEqual({
      mode: "open",
    });
    expect(egressPolicyFor("s3://b/x", { s3Region: "us-east-1" }).mode).toBe("open");
  });

  it("stored credentials: bucket-scoped allowlist", () => {
    const p = egressPolicyFor("s3://private-bucket/x.parquet", {
      s3AccessKeyId: "AKIA...",
      s3SecretAccessKey: "secret",
      s3Region: "us-west-2",
    });
    expect(p.mode).toBe("allowlist");
    expect(p.hosts?.sort()).toEqual([
      "private-bucket.s3.amazonaws.com",
      "private-bucket.s3.us-west-2.amazonaws.com",
    ]);
  });

  it("credentials with no derivable host FAIL CLOSED", () => {
    // Previously a latent hole: an empty host list fell through to open
    // egress WITH creds sitting in the container env.
    expect(egressPolicyFor("not a url", { s3SecretAccessKey: "secret" })).toEqual({
      mode: "deny",
    });
  });

  it("no url at all: open (not a remote-source run)", () => {
    expect(egressPolicyFor(undefined)).toEqual({ mode: "open" });
  });
});
