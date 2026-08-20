import { describe, it, expect, vi, beforeEach } from "vitest";

const getActiveSandboxRuntime = vi.fn();
const getActiveProvider = vi.fn();
const getApiKey = vi.fn();
const run = vi.fn();

vi.mock("@/lib/runtime-config", () => ({
  getActiveSandboxRuntime: () => getActiveSandboxRuntime(),
}));
vi.mock("@/lib/llm/client", () => ({ getActiveProvider: () => getActiveProvider() }));
vi.mock("@/lib/secrets", () => ({ getApiKey: (id: string) => getApiKey(id) }));
vi.mock("@/lib/sandbox/docker-utils", () => ({ run: (...a: unknown[]) => run(...a) }));

import { logBootHealth } from "@/lib/health/boot-health";
import { logger } from "@/lib/logger";

let warn: ReturnType<typeof vi.spyOn>;
let info: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.restoreAllMocks(); // drop prior logger spies so calls don't accumulate
  getActiveSandboxRuntime.mockReset();
  getActiveProvider.mockReset();
  getApiKey.mockReset();
  run.mockReset();
  warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
  info = vi.spyOn(logger, "info").mockImplementation(() => {});
  // Sensible healthy defaults; each test overrides what it exercises.
  getActiveProvider.mockReturnValue("anthropic");
  getActiveSandboxRuntime.mockReturnValue("docker");
  run.mockResolvedValue({ stdout: "27.0.1", stderr: "", exitCode: 0 });
  getApiKey.mockReturnValue("key");
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

  it("does NOT probe Docker when the active runtime is E2B (keys on the active runtime)", async () => {
    getActiveSandboxRuntime.mockReturnValue("e2b");
    getApiKey.mockImplementation((id: string) => (id === "e2b" ? "e2b-key" : undefined));
    await logBootHealth();
    expect(run).not.toHaveBeenCalled(); // never shells out to docker
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns when E2B is active but its API key is missing", async () => {
    getActiveSandboxRuntime.mockReturnValue("e2b");
    getApiKey.mockReturnValue(undefined);
    await logBootHealth();
    expect(warnedAbout("no E2B API key")).toBe(true);
  });

  it("does not warn about a missing key for self-hostable microsandbox", async () => {
    getActiveSandboxRuntime.mockReturnValue("microsandbox");
    getApiKey.mockReturnValue(undefined);
    await logBootHealth();
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns when no LLM provider is configured (getActiveProvider throws)", async () => {
    getActiveProvider.mockImplementation(() => {
      throw new Error("No LLM provider configured");
    });
    await logBootHealth();
    expect(warnedAbout("no LLM provider is configured")).toBe(true);
  });

  it("never throws, even if a check blows up", async () => {
    getActiveSandboxRuntime.mockImplementation(() => {
      throw new Error("config read failed");
    });
    await expect(logBootHealth()).resolves.toBeUndefined();
  });
});
