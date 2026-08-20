import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * GET /api/query/active — reattach discovery behind the localhost-origin
 * gate. With ?csvId returns the most recent active run for that source;
 * without it, all active runs. 403 off-origin.
 */
const validateLocalOrigin = vi.fn();
const findActiveRunForCsv = vi.fn();
const listActiveRuns = vi.fn();
vi.mock("@/lib/local-files/security", () => ({
  validateLocalOrigin: (...a: unknown[]) => validateLocalOrigin(...a),
}));
vi.mock("@/lib/pipeline/run-stream-hub", () => ({
  findActiveRunForCsv: (...a: unknown[]) => findActiveRunForCsv(...a),
  listActiveRuns: (...a: unknown[]) => listActiveRuns(...a),
}));

import { GET } from "@/app/api/query/active/route";

const get = (qs = "") => GET(new Request(`http://localhost/api/query/active${qs}`));

beforeEach(() => {
  vi.clearAllMocks();
  validateLocalOrigin.mockReturnValue(true);
});

describe("GET /api/query/active", () => {
  it("403s off-origin", async () => {
    validateLocalOrigin.mockReturnValue(false);
    expect((await get()).status).toBe(403);
  });

  it("returns the active run for a csvId", async () => {
    findActiveRunForCsv.mockReturnValue({ runId: "r1" });
    const res = await get("?csvId=c1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ run: { runId: "r1" } });
    expect(findActiveRunForCsv).toHaveBeenCalledWith("c1");
  });

  it("lists all active runs without a csvId", async () => {
    listActiveRuns.mockReturnValue([{ runId: "r1" }, { runId: "r2" }]);
    const res = await get("");
    expect(await res.json()).toEqual({ runs: [{ runId: "r1" }, { runId: "r2" }] });
  });
});
