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

describe("DockerWarmBackend.writeFiles — per-run cleanup + staging order", () => {
  it("cleans per-run leftovers (findings/step_*/hermetic_*) BEFORE staging, without nuking the runtime dir", async () => {
    await new DockerWarmBackend().writeFiles([{ path: "/data/step_1.csv", content: "a\n1\n" }]);
    const cleanup = joined().find((c) => c.includes("rm -f /data/script.py"));
    expect(cleanup).toBeDefined();
    expect(cleanup).toContain("/data/findings.jsonl");
    expect(cleanup).toContain("/data/step_*");
    // hermetic_* removed via `find -type f` so the hermetic_runtime PACKAGE dir
    // (whose staged contents the P1 skip set relies on) is never deleted.
    expect(cleanup).toContain("find /data -maxdepth 1 -type f -name 'hermetic_*' -delete");
  });

  it("REGRESSION (latent step-frame bug): cleanup runs BEFORE the current run's frames are staged, and executeScript never deletes step_*", async () => {
    // Old order — writeFiles staged /data/step_1.csv, THEN executeScript's
    // cleanup deleted /data/step_* — so dependent warm steps read a MISSING
    // frame. New order: cleanup (in writeFiles) precedes staging; executeScript
    // must not delete step frames at all.
    const backend = new DockerWarmBackend();
    await backend.writeFiles([{ path: "/data/step_1.csv", content: "a\n1\n" }]);
    const cmds = joined();
    const cleanupIdx = cmds.findIndex((c) => c.includes("/data/step_*"));
    const stageIdx = cmds.findIndex((c) => c.startsWith("cp -"));
    expect(cleanupIdx).toBeGreaterThanOrEqual(0);
    expect(stageIdx).toBeGreaterThan(cleanupIdx); // cleanup strictly first

    mockedRun.mockClear();
    await backend.executeScript("import pandas as pd\npd.read_csv('/data/step_1.csv')");
    const execCmds = joined();
    expect(execCmds.some((c) => c.includes("/data/step_*"))).toBe(false);
  });

  it("P1: identical nested runtime files are NOT re-staged on the next run; changed/top-level files are", async () => {
    const backend = new DockerWarmBackend();
    const runtimeFile = { path: "/data/hermetic_runtime/findings.py", content: "x = 1\n" };
    const stepFile = { path: "/data/step_1.csv", content: "a\n1\n" };

    await backend.writeFiles([runtimeFile, stepFile]);
    expect(joined().filter((c) => c.startsWith("cp -"))).toHaveLength(1);

    // Second run, same files: only the TOP-LEVEL step frame is re-staged (the
    // per-run cleanup deletes it); the identical nested runtime file is skipped.
    mockedRun.mockClear();
    await backend.writeFiles([runtimeFile, stepFile]);
    const cp = mockedRun.mock.calls.find(([, args]) => args[0] === "cp");
    expect(cp).toBeDefined();
    const archive = (cp![2] as { input: Buffer }).input;
    expect(archive.includes("step_1.csv")).toBe(true);
    expect(archive.includes("findings.py")).toBe(false);

    // Changed runtime content → re-staged.
    mockedRun.mockClear();
    await backend.writeFiles([{ ...runtimeFile, content: "x = 2\n" }, stepFile]);
    const cp2 = mockedRun.mock.calls.find(([, args]) => args[0] === "cp");
    expect((cp2![2] as { input: Buffer }).input.includes("findings.py")).toBe(true);
  });

  it("P1: loadData's full wipe resets the skip set — runtime files re-stage after it", async () => {
    const backend = new DockerWarmBackend();
    const runtimeFile = { path: "/data/hermetic_runtime/findings.py", content: "x = 1\n" };
    await backend.writeFiles([runtimeFile]);

    mockedRun.mockClear();
    await backend.loadData("csv-1", "a\n1\n", null, [runtimeFile]);
    const cp = mockedRun.mock.calls.find(([, args]) => args[0] === "cp");
    expect(cp).toBeDefined();
    const archive = (cp![2] as { input: Buffer }).input;
    expect(archive.includes("findings.py")).toBe(true); // wiped → must re-stage
    expect(archive.includes("input.csv")).toBe(true); // csv rides the same tar
  });

  it("P1: nothing to stage → NO docker cp at all (cleanup only)", async () => {
    const backend = new DockerWarmBackend();
    const runtimeFile = { path: "/data/hermetic_runtime/findings.py", content: "x = 1\n" };
    await backend.writeFiles([runtimeFile]);
    mockedRun.mockClear();
    await backend.writeFiles([runtimeFile]); // identical, nested-only
    expect(mockedRun.mock.calls.some(([, args]) => args[0] === "cp")).toBe(false);
    expect(joined().some((c) => c.includes("rm -f /data/script.py"))).toBe(true);
  });

  it("P1: a FAILED docker cp does not teach the skip set (retried next run)", async () => {
    const backend = new DockerWarmBackend();
    const runtimeFile = { path: "/data/hermetic_runtime/findings.py", content: "x = 1\n" };
    mockedRun.mockImplementation(async (_cmd, args) =>
      args[0] === "cp"
        ? { stdout: "", stderr: "daemon error", exitCode: 1 }
        : { stdout: "0", stderr: "", exitCode: 0 }
    );
    await backend.writeFiles([runtimeFile]);

    mockedRun.mockClear();
    mockedRun.mockResolvedValue({ stdout: "0", stderr: "", exitCode: 0 });
    await backend.writeFiles([runtimeFile]);
    // Not recorded as staged → written again now that cp succeeds.
    expect(mockedRun.mock.calls.some(([, args]) => args[0] === "cp")).toBe(true);
  });
});

describe("DockerWarmBackend.executeScript", () => {
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

it("L3: a nonzero-exit FALLBACK write does not teach the skip set", async () => {
  const backend = new DockerWarmBackend();
  // Non-ASCII path → tar builder rejects → per-file fallback; the write FAILS.
  const weird = { path: "/data/skill_lib/héllo.py", content: "x" };
  mockedRun.mockImplementation(async (_c, args) =>
    args.join(" ").includes("cat > ")
      ? { stdout: "", stderr: "disk full", exitCode: 1 }
      : { stdout: "0", stderr: "", exitCode: 0 }
  );
  await backend.writeFiles([weird]);
  // Not recorded → retried (and now succeeding) on the next run.
  mockedRun.mockResolvedValue({ stdout: "0", stderr: "", exitCode: 0 });
  mockedRun.mockClear();
  await backend.writeFiles([weird]);
  expect(mockedRun.mock.calls.some(([, a]) => a.join(" ").includes("cat > "))).toBe(true);
});
