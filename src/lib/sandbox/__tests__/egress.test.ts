/**
 * Egress allowlist derivation + tiering (lib/sandbox/egress.ts).
 *
 * Derivation is deny-by-default and VHOST-ONLY for AWS/GCS: CONNECT tunnels
 * are opaque TLS, the proxy filters by hostname alone, and a generic
 * path-style host (s3.amazonaws.com) would allow every bucket on AWS —
 * re-opening the exfiltration door the allowlist exists to close.
 *
 * Policy: any remote source (public or credentialed) → the L7 host-allowlist
 * proxy (the only tier that stops exfiltration; the splice relay makes it fast);
 * an underivable host or no URL → deny. There is no open/native tier.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/sandbox/docker-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sandbox/docker-utils")>();
  return { ...actual, run: vi.fn() };
});

import { deriveAllowedEgressHosts, egressPolicyFor, setupEgressNetwork } from "../egress";
import { run } from "@/lib/sandbox/docker-utils";
import { resetDaemonCpuCacheForTests } from "@/lib/sandbox/hardening";
import { resetDaemonMemoryCacheForTests } from "@/lib/sandbox/memory-budget";

const mockedRun = vi.mocked(run);

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

  it("refuses an https source host that is an internal / metadata target (finding M2)", () => {
    expect(deriveAllowedEgressHosts("https://169.254.169.254/latest/x.parquet")).toEqual([]);
    expect(deriveAllowedEgressHosts("http://10.0.0.5/x.parquet")).toEqual([]);
    expect(deriveAllowedEgressHosts("http://127.1/x.parquet")).toEqual([]); // encoded loopback
    expect(deriveAllowedEgressHosts("http://metadata.google.internal/x.parquet")).toEqual([]);
    expect(deriveAllowedEgressHosts("http://svc.cluster.internal/x.parquet")).toEqual([]);
  });

  it("refuses a custom s3Endpoint pointed at an internal host, but keeps a public one", () => {
    expect(
      deriveAllowedEgressHosts("s3://b/x.parquet", { s3Endpoint: "http://169.254.169.254" })
    ).toEqual([]);
    // A public custom endpoint is unaffected.
    const ok = deriveAllowedEgressHosts("s3://b/x.parquet", {
      s3Endpoint: "https://minio.example.com",
    });
    expect(ok.sort()).toEqual(["b.minio.example.com", "minio.example.com"]);
  });
});

describe("egressPolicyFor — tiered by what the container holds", () => {
  it("credential-less remote source: L7 host-allowlist (not open/native)", () => {
    // The Overture case (run fcf84399): public bucket, no creds — still routed
    // through the L7 host-allowlist proxy so injected code can reach ONLY the
    // bucket host, closing the exfiltration gap that the old native tiers left
    // open. The splice relay keeps it fast.
    const p = egressPolicyFor("s3://overturemaps-us-west-2/release/x.parquet");
    expect(p.mode).toBe("allowlist");
    expect(p.hosts).toContain("overturemaps-us-west-2.s3.amazonaws.com");
    // regioned vhost is allowed too when a region is known
    expect(egressPolicyFor("s3://b/x", { s3Region: "us-east-1" }).hosts).toContain(
      "b.s3.us-east-1.amazonaws.com"
    );
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

describe("setupEgressNetwork — gateway hardening (finding M5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDaemonCpuCacheForTests();
    resetDaemonMemoryCacheForTests();
    mockedRun.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
  });

  it("applies cap-drop / pids-limit / memory to the gateway container", async () => {
    await setupEgressNetwork("testrunid1234", ["b.s3.amazonaws.com"]);
    const gatewayCreate = mockedRun.mock.calls
      .map(([, args]) => args)
      .find((a) => a[0] === "run" && a.includes("--name") && a.join(" ").includes("egress-gw"));
    expect(gatewayCreate).toBeDefined();
    expect(gatewayCreate).toContain("--cap-drop");
    expect(gatewayCreate).toContain("ALL");
    expect(gatewayCreate).toContain("--pids-limit");
    // The proxy binds an unprivileged port (3128) + plain outbound TCP — no
    // capability is needed, so full cap-drop is safe.
    expect(gatewayCreate).not.toContain("--privileged");
  });
});
