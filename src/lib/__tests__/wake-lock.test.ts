import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";

// Capture spawned "caffeinate" processes so we can assert ref-counted sharing.
// vi.hoisted so the (hoisted) vi.mock factory can reference it without TDZ.
const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(() => ({ on: vi.fn(), kill: vi.fn() })),
}));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { acquireWakeLock, withWakeLock } from "@/lib/wake-lock";

// The lock is a macOS power assertion — force the darwin path so the ref-count
// logic is exercised on any CI platform.
const realPlatform = process.platform;
beforeAll(() => Object.defineProperty(process, "platform", { value: "darwin" }));
afterAll(() => Object.defineProperty(process, "platform", { value: realPlatform }));
beforeEach(() => spawnMock.mockClear());

describe("wake lock (ref-counted)", () => {
  it("spawns ONE caffeinate for overlapping holds and kills it on the last release", () => {
    const release1 = acquireWakeLock("run");
    const release2 = acquireWakeLock("sandbox"); // nested — same process
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const proc = spawnMock.mock.results[0].value as { kill: ReturnType<typeof vi.fn> };

    release1();
    expect(proc.kill).not.toHaveBeenCalled(); // still held by the inner one

    release2();
    expect(proc.kill).toHaveBeenCalledTimes(1); // last release frees the machine
  });

  it("release is idempotent (double-release can't over-decrement the count)", () => {
    const release = acquireWakeLock("run");
    const proc = spawnMock.mock.results[0].value as { kill: ReturnType<typeof vi.fn> };
    release();
    release(); // no-op
    expect(proc.kill).toHaveBeenCalledTimes(1);

    // A fresh acquire after full release spawns a NEW process (count went 0→1).
    acquireWakeLock("run2")();
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it("withWakeLock acquires for the duration and releases in a finally", async () => {
    await withWakeLock("wrapped", async () => {
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });
    const proc = spawnMock.mock.results[0].value as { kill: ReturnType<typeof vi.fn> };
    expect(proc.kill).toHaveBeenCalledTimes(1);
  });
});
