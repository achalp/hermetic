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
import { L3_BLOCKED_CIDRS, l3DropRuleSpec, L3_SANDBOX_SUBNET } from "../egress-l3";

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
  it("credential-less remote source: L3-blocked bridge, no L7 proxy", () => {
    // The Overture case (run e1c88a71): public bucket, no creds in the
    // container env — native egress on a kernel-blocked bridge, not the
    // 30x-slower L7 relay, and no longer unrestricted open egress.
    expect(egressPolicyFor("s3://overturemaps-us-west-2/release/x.parquet")).toEqual({
      mode: "l3blocked",
    });
    expect(egressPolicyFor("s3://b/x", { s3Region: "us-east-1" }).mode).toBe("l3blocked");
  });

  it("stored credentials: bucket-scoped allowlist (L7 proxy)", () => {
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

  it("no url at all: DENY — local/underivable data never earns network", () => {
    // Network is a property of the SOURCE (finding 01): a local CSV run must
    // get --network none, not open bridge egress with the user's data in /data.
    expect(egressPolicyFor(undefined)).toEqual({ mode: "deny" });
  });
});

describe("L3 block list (egress-l3.ts)", () => {
  it("covers cloud metadata, all RFC-1918 ranges, and loopback (v4 + v6)", () => {
    expect(L3_BLOCKED_CIDRS).toContain("169.254.169.254/32"); // instance metadata
    expect(L3_BLOCKED_CIDRS).toContain("169.254.0.0/16"); // link-local
    expect(L3_BLOCKED_CIDRS).toContain("10.0.0.0/8"); // RFC-1918
    expect(L3_BLOCKED_CIDRS).toContain("172.16.0.0/12"); // RFC-1918
    expect(L3_BLOCKED_CIDRS).toContain("192.168.0.0/16"); // RFC-1918
    expect(L3_BLOCKED_CIDRS).toContain("127.0.0.0/8"); // IPv4 loopback
    expect(L3_BLOCKED_CIDRS).toContain("::1/128"); // IPv6 loopback
    expect(L3_BLOCKED_CIDRS).toContain("fc00::/7"); // IPv6 ULA
  });

  it("builds idempotent (-C then -I) DROP rule specs, v4 scoped to the sandbox subnet", () => {
    const v4 = l3DropRuleSpec("169.254.169.254/32");
    expect(v4.bin).toBe("iptables");
    expect(v4.check).toEqual([
      "-C",
      "DOCKER-USER",
      "-s",
      L3_SANDBOX_SUBNET,
      "-d",
      "169.254.169.254/32",
      "-j",
      "DROP",
    ]);
    expect(v4.insert[0]).toBe("-I");
    expect(v4.insert).toContain("DOCKER-USER");
    expect(v4.insert).toContain("DROP");

    const v6 = l3DropRuleSpec("::1/128");
    expect(v6.bin).toBe("ip6tables");
    // v6 rules omit the IPv4 subnet source match.
    expect(v6.check).not.toContain(L3_SANDBOX_SUBNET);
    expect(v6.check).toContain("::1/128");
  });
});
