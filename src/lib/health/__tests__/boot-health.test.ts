import { describe, it, expect, vi, beforeEach } from "vitest";

const getActiveProvider = vi.fn();
const run = vi.fn();
const getRuntimeConfig = vi.fn(() => ({}) as Record<string, unknown>);
const setRuntimeConfig = vi.fn();
const envConfigMock: Record<string, string | undefined> = {};

vi.mock("@/lib/llm/client", () => ({ getActiveProvider: () => getActiveProvider() }));
vi.mock("@/lib/sandbox/docker-utils", () => ({ run: (...a: unknown[]) => run(...a) }));
vi.mock("@/lib/runtime-config", () => ({
  getRuntimeConfig: () => getRuntimeConfig(),
  setRuntimeConfig: (p: unknown) => setRuntimeConfig(p),
}));
vi.mock("@/lib/harness-slot", async (orig) => {
  const actual = await orig<typeof import("@/lib/harness-slot")>();
  return { ...actual, envConfig: () => envConfigMock };
});

import { logBootHealth } from "@/lib/health/boot-health";
import { logger } from "@/lib/logger";

let warn: ReturnType<typeof vi.spyOn>;
let info: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.restoreAllMocks(); // drop prior logger spies so calls don't accumulate
  getActiveProvider.mockReset();
  run.mockReset();
  getRuntimeConfig.mockReset();
  getRuntimeConfig.mockReturnValue({});
  setRuntimeConfig.mockReset();
  for (const k of Object.keys(envConfigMock)) delete envConfigMock[k];
  warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
  info = vi.spyOn(logger, "info").mockImplementation(() => {});
  // Sensible healthy defaults; each test overrides what it exercises.
  getActiveProvider.mockReturnValue("anthropic");
  run.mockResolvedValue({ stdout: "27.0.1", stderr: "", exitCode: 0 });
});

const warnedAbout = (needle: string) =>
  warn.mock.calls.some(
    (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes(needle)
  );

describe("logBootHealth", () => {
  it("all-clear: reachable Docker + a provider → no warnings", async () => {
    await logBootHealth();
    expect(warn).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalled();
  });

  it("warns when Docker is the active runtime but the daemon is unreachable", async () => {
    run.mockResolvedValue({ stdout: "", stderr: "Cannot connect", exitCode: 1 });
    await logBootHealth();
    expect(warnedAbout("Docker daemon is not reachable")).toBe(true);
  });

  it("warns when the docker probe itself throws (docker binary absent)", async () => {
    run.mockRejectedValue(new Error("spawn docker ENOENT"));
    await logBootHealth();
    expect(warnedAbout("Docker daemon is not reachable")).toBe(true);
  });

  it("warns when no LLM provider is configured (getActiveProvider throws)", async () => {
    getActiveProvider.mockImplementation(() => {
      throw new Error("No LLM provider configured");
    });
    await logBootHealth();
    expect(warnedAbout("no LLM provider is configured")).toBe(true);
  });

  it("never throws, even if a check blows up", async () => {
    // A SYNC throw from the docker probe skips its internal .catch and reaches
    // logBootHealth's outer guard.
    run.mockImplementation(() => {
      throw new Error("sync boom");
    });
    await expect(logBootHealth()).resolves.toBeUndefined();
  });
});

describe("logBootHealth — whose Docker absence is worth a warning", () => {
  /**
   * Regression: keying this off the ACTIVE runtime made the warning unreachable.
   * Boot health persists dockerAvailable:false, resolveActiveRuntime then answers
   * "wasm", and the warning for a stopped daemon never fired — the web user who
   * needs it most got silence and a different engine. It keys off INTENT instead.
   */
  it("still warns on the web path (no wasm fallback configured, nothing pinned)", async () => {
    run.mockResolvedValue({ stdout: "", stderr: "Cannot connect", exitCode: 1 });
    await logBootHealth();
    expect(warnedAbout("Docker daemon is not reachable")).toBe(true);
  });

  it("warns when the user PINNED docker, whatever the channel default", async () => {
    envConfigMock.HERMETIC_DEFAULT_RUNTIME = "wasm";
    getRuntimeConfig.mockReturnValue({ sandboxRuntime: "docker" });
    run.mockResolvedValue({ stdout: "", stderr: "Cannot connect", exitCode: 1 });
    await logBootHealth();
    expect(warnedAbout("Docker daemon is not reachable")).toBe(true);
  });

  it("does NOT warn on a channel that falls back to wasm — the packaged desktop app", async () => {
    // It announced "analyses will fail until Docker is running" on every launch
    // while running fine. A warning that is wrong every time trains people to
    // ignore the ones that are right.
    envConfigMock.HERMETIC_DEFAULT_RUNTIME = "wasm";
    getRuntimeConfig.mockReturnValue({});
    run.mockResolvedValue({ stdout: "", stderr: "Cannot connect", exitCode: 1 });
    await logBootHealth();
    expect(warnedAbout("Docker daemon is not reachable")).toBe(false);
    expect(info).toHaveBeenCalledWith(expect.stringContaining("built-in engine"));
  });

  it("records the probe so runtime resolution has a real value to use", async () => {
    run.mockResolvedValue({ stdout: "", stderr: "Cannot connect", exitCode: 1 });
    await logBootHealth();
    expect(setRuntimeConfig).toHaveBeenCalledWith({ dockerAvailable: false });
  });
});
