/**
 * Security F1: the remote-Parquet schema-extraction / fingerprint containers
 * must read through the L7 egress-allowlist gateway (never the default bridge),
 * and must FAIL CLOSED when no safe egress host derives from the URL. The local
 * bind-mount path must get `--network none`. These pin the fix for the SSRF
 * where a DNS name resolving to an internal IP reached a full-network container.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Real egressPolicyFor/deriveAllowedEgressHosts (the derivation is under test);
// stub only the network setup so no docker is touched. Hoisted so the spy exists
// when the (hoisted) vi.mock factory runs.
const { setupSpy } = vi.hoisted(() => ({
  setupSpy: vi.fn(async (_runId: string, hosts: string[]) => ({
    networkName: "hermetic-egress-FAKENET",
    env: { HTTP_PROXY: "http://gw:3128", HERMETIC_S3_URL_STYLE: "vhost" },
    proxyLogs: async () => "",
    teardown: vi.fn(async () => {}),
    _hosts: hosts,
  })),
}));
vi.mock("@/lib/sandbox/egress", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sandbox/egress")>();
  return { ...actual, setupEgressNetwork: setupSpy };
});

vi.mock("@/lib/sandbox/docker-utils", () => ({
  run: vi.fn(async (_cmd: string, cmdArgs: string[]) => {
    const joined = cmdArgs.join(" ");
    if (cmdArgs.includes("/data/output.json") && cmdArgs.includes("cat")) {
      return {
        stdout: JSON.stringify({
          row_count: 1,
          columns: [],
          sample_rows: [],
          correlations: null,
          detected_domain: "general",
        }),
        stderr: "",
        exitCode: 0,
      };
    }
    if (joined.includes("python3 /data/script.py")) {
      return { stdout: "0", stderr: "", exitCode: 0 }; // exit code echoed by the shell
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  }),
}));

import { run } from "@/lib/sandbox/docker-utils";
import { extractRemoteParquetSchema, extractParquetSchema } from "@/lib/parquet/schema-extractor";

const mockedRun = vi.mocked(run);
const createCalls = () =>
  mockedRun.mock.calls.map(([, a]) => a).filter((a) => a[0] === "run" && a.includes("--name"));

beforeEach(() => {
  vi.clearAllMocks();
  setupSpy.mockClear();
});

describe("remote schema extraction routes through the egress allowlist", () => {
  it("joins the derived egress network + proxy env, never the open bridge", async () => {
    await extractRemoteParquetSchema(
      "https://data.example.org/dumps/t.parquet",
      "cid",
      "t.parquet",
      "docker"
    );
    // The allowlist was derived from the URL host and handed to setupEgressNetwork.
    expect(setupSpy).toHaveBeenCalledTimes(1);
    expect(setupSpy.mock.calls[0][1]).toEqual(["data.example.org"]);

    const create = createCalls();
    expect(create).toHaveLength(1);
    const args = create[0];
    expect(args).toContain("--network");
    expect(args).toContain("hermetic-egress-FAKENET");
    expect(args).toContain("-e");
    expect(args.join(" ")).toContain("HTTP_PROXY=http://gw:3128");
    // Must NOT be an unrestricted container.
    expect(args).not.toContain("none");
  });

  it("FAILS CLOSED when the URL resolves to an internal host (no derivable egress)", async () => {
    await expect(
      extractRemoteParquetSchema(
        "https://169.254.169.254/latest/meta.parquet",
        "cid",
        "meta.parquet",
        "docker"
      )
    ).rejects.toThrow(/no safe egress host/i);
    // Never set up a network, never created a container.
    expect(setupSpy).not.toHaveBeenCalled();
    expect(createCalls()).toHaveLength(0);
  });
});

describe("local schema extraction earns no network", () => {
  it("runs the container with --network none and no egress gateway", async () => {
    await extractParquetSchema("/tmp/data/x.parquet", "cid", "x.parquet", false, "docker");
    expect(setupSpy).not.toHaveBeenCalled();
    const create = createCalls();
    expect(create).toHaveLength(1);
    const args = create[0];
    const netIdx = args.indexOf("--network");
    expect(netIdx).toBeGreaterThan(-1);
    expect(args[netIdx + 1]).toBe("none");
  });
});
