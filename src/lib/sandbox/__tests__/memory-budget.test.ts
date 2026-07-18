/**
 * Derivation of the sandbox memory cap from the Docker DAEMON's allocation
 * (`docker info` MemTotal), NOT the host OS total. `run` is stubbed so no daemon
 * is touched. The memo is reset before each case to isolate success/failure.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/sandbox/docker-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sandbox/docker-utils")>();
  return { ...actual, run: vi.fn() };
});

import { run } from "@/lib/sandbox/docker-utils";
import {
  getDaemonMemoryBytes,
  getSandboxMemoryLimitMb,
  getSandboxMemoryLimitGbLabel,
  sandboxMemoryRunArgs,
  resetDaemonMemoryCacheForTests,
} from "@/lib/sandbox/memory-budget";

const mockedRun = vi.mocked(run);
const GiB = 1024 * 1024 * 1024;

/** `docker info --format {{.MemTotal}}` returning `bytes`. */
const infoReturns = (bytes: number) =>
  mockedRun.mockResolvedValue({ stdout: `${bytes}\n`, stderr: "", exitCode: 0 });

beforeEach(() => {
  vi.clearAllMocks();
  resetDaemonMemoryCacheForTests();
  delete process.env.SANDBOX_MEMORY_FRACTION;
});
afterEach(() => {
  delete process.env.SANDBOX_MEMORY_FRACTION;
});

describe("sandbox memory budget", () => {
  it("reads the daemon MemTotal and derives the default-fraction cap", async () => {
    infoReturns(4 * GiB);
    expect(await getDaemonMemoryBytes()).toBe(4 * GiB);
    // 0.8 default × 4096 MiB = 3276 MiB
    expect(await getSandboxMemoryLimitMb()).toBe(Math.floor(4 * 1024 * 0.8));
    expect(await getSandboxMemoryLimitGbLabel()).toBe("3.2");
    // The probe queries the DAEMON, not os.totalmem.
    expect(mockedRun).toHaveBeenCalledWith(
      "docker",
      ["info", "--format", "{{.MemTotal}}"],
      expect.anything()
    );
  });

  it("emits --memory and --memory-swap at the derived cap", async () => {
    infoReturns(4 * GiB);
    const mb = Math.floor(4 * 1024 * 0.8);
    expect(await sandboxMemoryRunArgs()).toEqual(["--memory", `${mb}m`, "--memory-swap", `${mb}m`]);
  });

  it("honors SANDBOX_MEMORY_FRACTION override", async () => {
    process.env.SANDBOX_MEMORY_FRACTION = "0.5";
    infoReturns(8 * GiB);
    expect(await getSandboxMemoryLimitMb()).toBe(Math.floor(8 * 1024 * 0.5));
  });

  it("ignores an out-of-range fraction and falls back to the default", async () => {
    process.env.SANDBOX_MEMORY_FRACTION = "5"; // >1 → invalid
    infoReturns(4 * GiB);
    expect(await getSandboxMemoryLimitMb()).toBe(Math.floor(4 * 1024 * 0.8));
  });

  it("memoizes a successful probe (daemon size is fixed for the process)", async () => {
    infoReturns(4 * GiB);
    await getDaemonMemoryBytes();
    await getSandboxMemoryLimitMb();
    await sandboxMemoryRunArgs();
    expect(mockedRun).toHaveBeenCalledTimes(1);
  });

  it("returns null (→ no cap, no fake number) when docker info fails", async () => {
    mockedRun.mockRejectedValue(new Error("docker daemon down"));
    expect(await getDaemonMemoryBytes()).toBeNull();
    expect(await getSandboxMemoryLimitMb()).toBeNull();
    expect(await getSandboxMemoryLimitGbLabel()).toBeNull();
    expect(await sandboxMemoryRunArgs()).toEqual([]);
  });

  it("does NOT cache a failure — a later probe retries", async () => {
    mockedRun.mockRejectedValueOnce(new Error("transient"));
    expect(await getDaemonMemoryBytes()).toBeNull();
    infoReturns(2 * GiB);
    expect(await getDaemonMemoryBytes()).toBe(2 * GiB);
  });

  it("treats a zero/garbage MemTotal as unknown", async () => {
    mockedRun.mockResolvedValue({ stdout: "0\n", stderr: "", exitCode: 0 });
    expect(await getDaemonMemoryBytes()).toBeNull();
    resetDaemonMemoryCacheForTests();
    mockedRun.mockResolvedValue({ stdout: "not-a-number\n", stderr: "", exitCode: 0 });
    expect(await getDaemonMemoryBytes()).toBeNull();
  });
});
