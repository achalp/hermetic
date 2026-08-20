import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * POST /api/query/stop — the cancel button. Behind the localhost-origin gate
 * (403), requires a runId (400), and delegates to stopRun. `false` (run
 * already gone) is a normal 200, not an error.
 */
const validateLocalOrigin = vi.fn();
const stopRun = vi.fn();
vi.mock("@/lib/local-files/security", () => ({
  validateLocalOrigin: (...a: unknown[]) => validateLocalOrigin(...a),
}));
vi.mock("@/lib/pipeline/run-control", () => ({ stopRun: (...a: unknown[]) => stopRun(...a) }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  serializeError: (e: unknown) => ({ error: String(e) }),
}));

import { POST } from "@/app/api/query/stop/route";

const req = (b: unknown) =>
  new Request("http://localhost/api/query/stop", { method: "POST", body: JSON.stringify(b) });

beforeEach(() => {
  vi.clearAllMocks();
  validateLocalOrigin.mockReturnValue(true);
});

describe("POST /api/query/stop", () => {
  it("403s off-origin", async () => {
    validateLocalOrigin.mockReturnValue(false);
    expect((await POST(req({ runId: "r1" }))).status).toBe(403);
  });

  it("400s without a runId", async () => {
    expect((await POST(req({}))).status).toBe(400);
    expect(stopRun).not.toHaveBeenCalled();
  });

  it("stops the run and reports stopped:true", async () => {
    stopRun.mockResolvedValue(true);
    const res = await POST(req({ runId: "r1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stopped: true });
  });

  it("reports stopped:false for an already-finished run (not an error)", async () => {
    stopRun.mockResolvedValue(false);
    const res = await POST(req({ runId: "r1" }));
    expect(res.status).toBe(200);
    expect((await res.json()).stopped).toBe(false);
  });
});
