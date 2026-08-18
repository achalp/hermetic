/**
 * Derivation of the sandbox `--cpus` value from the Docker DAEMON's CPU count
 * (`docker info` NCPU), clamped against the host-derived budget. `run` is
 * stubbed so no daemon is touched; the memo is reset per case.
 *
 * WHY this exists: on macOS the daemon runs in a VM whose CPU slice can be far
 * smaller than the host's core count (10-core Mac, 4-CPU colima VM). Docker
 * REJECTS `--cpus` above the daemon's count, so the old host-only derivation
 * made every container creation fail — silently, because run() never throws.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/sandbox/docker-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sandbox/docker-utils")>();
  return { ...actual, run: vi.fn() };
});

import { run } from "@/lib/sandbox/docker-utils";
import {
  sandboxCpuBudget,
  sandboxCpuLimit,
  getDaemonCpuCount,
  sandboxHardeningRunArgs,
  resetDaemonCpuCacheForTests,
} from "@/lib/sandbox/hardening";

const mockedRun = vi.mocked(run);

/** `docker info --format {{.NCPU}}` returning `cpus`. */
const infoReturns = (cpus: number) =>
  mockedRun.mockResolvedValue({ stdout: `${cpus}\n`, stderr: "", exitCode: 0 });

beforeEach(() => {
  vi.clearAllMocks();
  resetDaemonCpuCacheForTests();
});

describe("sandbox CPU limit", () => {
  it("probes the DAEMON's NCPU, not just host cores", async () => {
    infoReturns(4);
    expect(await getDaemonCpuCount()).toBe(4);
    expect(mockedRun).toHaveBeenCalledWith(
      "docker",
      ["info", "--format", "{{.NCPU}}"],
      expect.anything()
    );
  });

  it("clamps the host budget to the daemon's CPU count (the colima-VM case)", async () => {
    // A 1-CPU daemon is below any host budget (budget floor is 1), so the
    // clamp must win regardless of the machine running this test.
    infoReturns(1);
    expect(await sandboxCpuLimit()).toBe(1);
  });

  it("never exceeds the host budget even on a huge daemon", async () => {
    infoReturns(1024);
    expect(await sandboxCpuLimit()).toBe(sandboxCpuBudget());
  });

  it("emits the clamped value as --cpus", async () => {
    infoReturns(1);
    const args = await sandboxHardeningRunArgs();
    const idx = args.indexOf("--cpus");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("1");
  });

  it("falls back to the host budget when the probe fails (docker down)", async () => {
    mockedRun.mockRejectedValue(new Error("docker daemon down"));
    expect(await getDaemonCpuCount()).toBeNull();
    expect(await sandboxCpuLimit()).toBe(sandboxCpuBudget());
  });

  it("treats zero/garbage NCPU as unknown", async () => {
    mockedRun.mockResolvedValue({ stdout: "0\n", stderr: "", exitCode: 0 });
    expect(await getDaemonCpuCount()).toBeNull();
    resetDaemonCpuCacheForTests();
    mockedRun.mockResolvedValue({ stdout: "not-a-number\n", stderr: "", exitCode: 0 });
    expect(await getDaemonCpuCount()).toBeNull();
  });

  it("memoizes a successful probe (daemon size is fixed for the process)", async () => {
    infoReturns(4);
    await sandboxCpuLimit();
    await sandboxCpuLimit();
    await sandboxHardeningRunArgs();
    expect(mockedRun).toHaveBeenCalledTimes(1);
  });

  it("does NOT cache a failure — a later probe retries", async () => {
    mockedRun.mockRejectedValueOnce(new Error("transient"));
    expect(await getDaemonCpuCount()).toBeNull();
    infoReturns(2);
    expect(await getDaemonCpuCount()).toBe(2);
  });
});
