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

  describe("warm/ephemeral fallback (Docker)", () => {
    it("docker local CSV with a csvId → warm", () => {
      expect(plan({ runtime: "docker" }).kind).toBe("warm");
    });
    it("docker local CSV without a csvId → ephemeral", () => {
      expect(plan({ runtime: "docker", hasCsvId: false }).kind).toBe("ephemeral");
    });
  });

  // The `wasm` runtime (Pyodide+DuckDB-WASM) is registered so the capability gate
  // + type system account for it, but ALL its capabilities are false until its
  // executor + the §7 escape suite land (Phase 1c). So the gate must REJECT every
  // wasm run today — the honest "switch to Docker" behavior, never a silent run
  // on an un-isolated runtime. This re-activates the reject branch that went dormant
  // when E2B/microsandbox were removed.
  describe("wasm runtime — registered but honestly gated off", () => {
    it("wasm local CSV → reject (network isolation not enforceable yet)", () => {
      const p = plan({ runtime: "wasm" });
      expect(p.kind).toBe("reject");
      if (p.kind === "reject") {
        expect(p.error).toMatch(/network isolation/i);
        expect(p.error).toMatch(/docker/i); // actionable: switch to Docker
      }
    });

    it("wasm with a bind-mount → reject (mount unsupported)", () => {
      expect(plan({ runtime: "wasm", hasMount: true }).kind).toBe("reject");
    });

    it("wasm with a remote source + remote code → reject (remote IO unsupported)", () => {
      const p = plan({
        runtime: "wasm",
        remoteParquetUrl: "s3://b/x.parquet",
        code: REMOTE_CODE,
      });
      expect(p.kind).toBe("reject");
    });

    it("wasm never reaches warm/ephemeral (no capability lets a run through)", () => {
      // Contrast with docker: same inputs, docker → warm, wasm → reject.
      expect(plan({ runtime: "docker" }).kind).toBe("warm");
      expect(plan({ runtime: "wasm" }).kind).toBe("reject");
    });
  });
});
