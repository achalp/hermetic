import { describe, it, expect, vi, beforeEach } from "vitest";

const getActiveProvider = vi.fn();
const run = vi.fn();

vi.mock("@/lib/llm/client", () => ({ getActiveProvider: () => getActiveProvider() }));
vi.mock("@/lib/sandbox/docker-utils", () => ({ run: (...a: unknown[]) => run(...a) }));

import { logBootHealth } from "@/lib/health/boot-health";
import { logger } from "@/lib/logger";

let warn: ReturnType<typeof vi.spyOn>;
let info: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.restoreAllMocks(); // drop prior logger spies so calls don't accumulate
  getActiveProvider.mockReset();
  run.mockReset();
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
