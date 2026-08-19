/**
 * The sandbox NETWORK-DISPATCH decision table (planSandboxRouting) — the
 * security-critical seam that decides whether a run gets no network, a
 * source-scoped egress allowlist, or a hard deny. Previously only exercised
 * indirectly; a wrong branch here is an exfiltration hole or a silently broken
 * remote read, so it earns a direct, exhaustive table test.
 */
import { describe, it, expect } from "vitest";
import { planSandboxRouting, type SandboxRouteInput } from "@/lib/sandbox/index";

const REMOTE_CODE = "duckdb.sql(\"select * from read_parquet('s3://b/x.parquet')\")";
const LOCAL_CODE = "import pandas as pd\npd.read_csv('/data/input.csv')";

const base: SandboxRouteInput = {
  runtime: "docker",
  network: "auto",
  hasMount: false,
  code: LOCAL_CODE,
  hasCsvId: true,
};
const plan = (over: Partial<SandboxRouteInput>) => planSandboxRouting({ ...base, ...over });

describe("planSandboxRouting — the network-dispatch table", () => {
  it("local CSV with a csvId → warm (always --network none)", () => {
    expect(plan({}).kind).toBe("warm");
  });

  it("local CSV without a csvId → ephemeral", () => {
    expect(plan({ hasCsvId: false }).kind).toBe("ephemeral");
  });

  it("a bind-mount / copied parquet → docker-mount, network forced off", () => {
    expect(plan({ hasMount: true }).kind).toBe("docker-mount");
    // even if the code looks like remote IO, LOCAL data stays offline
    expect(plan({ hasMount: true, code: REMOTE_CODE }).kind).toBe("docker-mount");
  });

  it("remote source + remote-reading code → docker-egress scoped to the derived host", () => {
    const p = plan({ remoteParquetUrl: "s3://b/x.parquet", code: REMOTE_CODE });
    expect(p.kind).toBe("docker-egress");
    if (p.kind === "docker-egress") expect(p.hosts).toEqual(["b.s3.amazonaws.com"]);
  });

  it("remote source but NON-network code → warm; the code only NARROWS the grant", () => {
    // The source could reach the bucket, but this code doesn't — so no egress.
    expect(plan({ remoteParquetUrl: "s3://b/x.parquet", code: LOCAL_CODE }).kind).toBe("warm");
  });

  it("network 'deny' forbids egress even for a remote source + remote code", () => {
    // The exfiltration guard: deny wins, source-grant is ignored.
    expect(
      plan({ remoteParquetUrl: "s3://b/x.parquet", code: REMOTE_CODE, network: "deny" }).kind
    ).toBe("warm");
  });

  it("an explicit egress allowlist (no source URL) → docker-egress with exactly those hosts", () => {
    const p = plan({ allowedEgressHosts: ["data.example.org"], code: REMOTE_CODE });
    expect(p.kind).toBe("docker-egress");
    if (p.kind === "docker-egress") expect(p.hosts).toEqual(["data.example.org"]);
  });

  it("remote source with NO derivable host → docker-deny (fail closed), never open egress", () => {
    expect(plan({ remoteParquetUrl: "not a url", code: REMOTE_CODE }).kind).toBe("docker-deny");
  });

  describe("capability gate — reject rather than silently degrade isolation", () => {
    it("e2b + remote-IO code is rejected (docker-only)", () => {
      const p = plan({ runtime: "e2b", remoteParquetUrl: "s3://b/x.parquet", code: REMOTE_CODE });
      expect(p.kind).toBe("reject");
      if (p.kind === "reject") expect(p.error).toMatch(/docker/i);
    });
    it("e2b + network 'deny' is rejected (no --network none guarantee)", () => {
      expect(plan({ runtime: "e2b", network: "deny" }).kind).toBe("reject");
    });
    it("e2b + a mount is rejected (no host filesystem access)", () => {
      expect(plan({ runtime: "e2b", hasMount: true }).kind).toBe("reject");
    });
  });

  describe("warm support varies by runtime", () => {
    it("e2b (no warm) local CSV → ephemeral", () => {
      expect(plan({ runtime: "e2b" }).kind).toBe("ephemeral");
    });
    it("microsandbox (warm) local CSV → warm", () => {
      expect(plan({ runtime: "microsandbox" }).kind).toBe("warm");
    });
  });
});
