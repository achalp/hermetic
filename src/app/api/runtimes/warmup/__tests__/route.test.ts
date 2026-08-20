import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * POST /api/runtimes/warmup — warms local sandbox pools. E2B is skipped
 * (ephemeral); docker/microsandbox warm via warmupAllSandboxes, and a
 * warmup throw maps to a 500 { status: error }.
 */
const warmupAllSandboxes = vi.fn();
const getActiveSandboxRuntime = vi.fn();
vi.mock("@/lib/sandbox", () => ({
  warmupAllSandboxes: (...a: unknown[]) => warmupAllSandboxes(...a),
}));
vi.mock("@/lib/runtime-config", () => ({
  getActiveSandboxRuntime: () => getActiveSandboxRuntime(),
}));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  errMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

import { POST } from "@/app/api/runtimes/warmup/route";

beforeEach(() => vi.clearAllMocks());

describe("POST /api/runtimes/warmup", () => {
  it("warms the pool for docker", async () => {
    getActiveSandboxRuntime.mockReturnValue("docker");
    warmupAllSandboxes.mockResolvedValue(undefined);
    const res = await POST();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", runtime: "docker" });
    expect(warmupAllSandboxes).toHaveBeenCalled();
  });

  it("maps a warmup failure to a 500", async () => {
    getActiveSandboxRuntime.mockReturnValue("docker");
    warmupAllSandboxes.mockRejectedValue(new Error("image pull failed"));
    const res = await POST();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.status).toBe("error");
    expect(body.error).toContain("image pull failed");
  });
});
