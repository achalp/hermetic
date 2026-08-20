/**
 * Warm Docker backend exec wiring (finding M5): the per-run cleanup command,
 * zombie reaping on abort/timeout, container registration, and signal
 * forwarding. `run` is stubbed, so these assert the docker command sequences
 * without a daemon.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/sandbox/docker-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sandbox/docker-utils")>();
  return {
    ...actual, // codeDoesRemoteIo stays real (pure)
    run: vi.fn(),
    parseExecutionOutput: vi.fn(),
  };
});

import { DockerWarmBackend } from "@/lib/sandbox/docker-warm-backend";
import { run, parseExecutionOutput } from "@/lib/sandbox/docker-utils";
import { resetDaemonCpuCacheForTests } from "@/lib/sandbox/hardening";

const mockedRun = vi.mocked(run);
const mockedParse = vi.mocked(parseExecutionOutput);

const calls = () => mockedRun.mock.calls.map(([, args]) => args);
const joined = () => calls().map((a) => a.join(" "));

beforeEach(() => {
  vi.clearAllMocks();
  resetDaemonCpuCacheForTests();
  mockedRun.mockResolvedValue({ stdout: "0", stderr: "", exitCode: 0 });
  mockedParse.mockResolvedValue({
    success: true,
    results: {},
    chart_data: {},
    images: {},
    execution_ms: 1,
  });
});

describe("DockerWarmBackend.executeScript", () => {
  it("cleans per-run leftovers (findings/step_*/hermetic_*) without nuking the runtime dir", async () => {
    await new DockerWarmBackend().executeScript("print('hi')");
    const cleanup = joined().find((c) => c.includes("rm -f /data/script.py"));
    expect(cleanup).toBeDefined();
    expect(cleanup).toContain("/data/findings.jsonl");
    expect(cleanup).toContain("/data/step_*");
    // hermetic_* removed via `find -type f` so the hermetic_runtime PACKAGE dir
    // (just installed by writeFiles) is never deleted.
    expect(cleanup).toContain("find /data -maxdepth 1 -type f -name 'hermetic_*' -delete");
  });

  it("registers and deregisters the shared warm container (finding M5)", async () => {
    const onContainerStart = vi.fn();
    const onContainerEnd = vi.fn();
    await new DockerWarmBackend().executeScript("print('hi')", {
      onContainerStart,
      onContainerEnd,
    });
    expect(onContainerStart).toHaveBeenCalledWith(DockerWarmBackend.CONTAINER);
    expect(onContainerEnd).toHaveBeenCalledWith(DockerWarmBackend.CONTAINER);
  });

  it("forwards the abort signal into the python3 exec", async () => {
    const signal = new AbortController().signal;
    await new DockerWarmBackend().executeScript("print('hi')", { signal });
    const execCall = mockedRun.mock.calls.find(([, args]) =>
      args.join(" ").includes("python3 /data/script.py")
    );
    expect(execCall).toBeDefined();
    expect((execCall![2] as { signal?: AbortSignal })?.signal).toBe(signal);
  });

  it("reaps the zombie python on timeout/abort before returning", async () => {
    // The python3 exec times out; only the docker-exec CLIENT dies, so the
    // in-container python must be pkill'd or it clobbers the next run's output.
    mockedRun.mockImplementation(async (_cmd, args) => {
      if (args.join(" ").includes("python3 /data/script.py")) {
        throw new Error("Sandbox execution timed out");
      }
      return { stdout: "0", stderr: "", exitCode: 0 };
    });
    const result = await new DockerWarmBackend().executeScript("print('hi')");
    expect(result.success).toBe(false);
    const pkill = calls().find((a) => a.includes("pkill") && a.includes("/data/script.py"));
    expect(pkill).toBeDefined();
    expect(pkill).toContain(DockerWarmBackend.CONTAINER);
  });

  it("uses a PER-PROCESS container name so co-tenant processes don't collide (H4)", () => {
    expect(DockerWarmBackend.CONTAINER).toBe(`hermetic-warm-${process.pid}`);
  });
});

describe("DockerWarmBackend.warmup", () => {
  it("applies container hardening flags (finding M10)", async () => {
    await new DockerWarmBackend().warmup();
    const create = calls().find((a) => a[0] === "run");
    expect(create).toBeDefined();
    expect(create).toContain("--pids-limit");
    expect(create).toContain("--cap-drop");
    // no-new-privileges was removed — it breaks python3 execve on this image
    // (see hardening.ts). The warm path shares sandboxHardeningRunArgs().
    expect(create).not.toContain("no-new-privileges");
  });

  it("reaps a dead process's warm container but spares a live one (finding H4)", async () => {
    const deadPid = 999_999_999; // no such process → not alive
    const alivePid = 1; // init — always alive (process.kill(1,0) → EPERM), ≠ our name
    mockedRun.mockImplementation(async (_cmd, args) => {
      if (args[0] === "ps") {
        return {
          stdout: `hermetic-warm-${deadPid}\nhermetic-warm-${alivePid}\n`,
          stderr: "",
          exitCode: 0,
        };
      }
      return { stdout: "0", stderr: "", exitCode: 0 };
    });
    await new DockerWarmBackend().warmup();
    const rmTargets = calls()
      .filter((a) => a[0] === "rm")
      .map((a) => a[a.length - 1]);
    expect(rmTargets).toContain(`hermetic-warm-${deadPid}`); // dead → reaped
    expect(rmTargets).not.toContain(`hermetic-warm-${alivePid}`); // live → spared
  });

  it("throws with the daemon's error when the warm create is rejected", async () => {
    // run() never throws, so a rejected create must be checked explicitly —
    // otherwise the warm container silently never exists and every later exec
    // degrades to "Unknown execution error" (the colima --cpus regression).
    mockedRun.mockImplementation(async (_cmd, args) => {
      if (args[0] === "run")
        return {
          stdout: "",
          stderr: "docker: Error response from daemon: Range of CPUs is from 0.01 to 4.00.",
          exitCode: 125,
        };
      return { stdout: "0", stderr: "", exitCode: 0 };
    });
    await expect(new DockerWarmBackend().warmup()).rejects.toThrow(/Range of CPUs/);
  });
});
