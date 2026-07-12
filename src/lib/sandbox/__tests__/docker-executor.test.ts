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
    await executeSandbox("", "code", null, undefined, "/Users/me/data");
    const create = createCall();
    const vIdx = create.indexOf("-v");
    expect(vIdx).toBeGreaterThan(-1);
    expect(create[vIdx + 1]).toMatch(/^\/Users\/me\/data:.*:ro$/);
    // No `cat > /data/input.csv` exec when data comes from the mount.
    const stdinWrites = calls().filter((a) => a.join(" ").includes("cat > /data/input.csv"));
    expect(stdinWrites).toHaveLength(0);
  });

  it("docker-cps a materialized parquet into the container", async () => {
    await executeSandbox("", "code", null, undefined, undefined, "/tmp/m.parquet");
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
    expect(joined.some((c) => c.includes("python3 /data/script.py"))).toBe(true);
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

  it("reports a timeout with the applied budget in the error", async () => {
    // create + writes fine, exec times out
    mockedRun.mockImplementation(async (_cmd, args) => {
      if (args.join(" ").includes("python3 /data/script.py")) {
        throw new Error("Sandbox execution timed out");
      }
      return { stdout: "0", stderr: "", exitCode: 0 };
    });
    const result = await executeSandbox("csv", "code");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/timed out after \d+ms/);
  });
});
