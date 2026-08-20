import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * /api/diagnostics — reader over listRunDiagnostics. The route clamps the
 * ?limit query into [1, 500] (default 100) before delegating.
 */
const listRunDiagnostics = vi.fn();
vi.mock("@/lib/diagnostics/run-diagnostics", () => ({
  listRunDiagnostics: (...a: unknown[]) => listRunDiagnostics(...a),
}));

import { GET } from "@/app/api/diagnostics/route";

const req = (qs = "") => new Request(`http://x/api/diagnostics${qs}`);

beforeEach(() => {
  vi.clearAllMocks();
  listRunDiagnostics.mockResolvedValue([{ runId: "a" }]);
});

describe("GET /api/diagnostics", () => {
  it("defaults to a limit of 100 and returns { runs }", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ runs: [{ runId: "a" }] });
    expect(listRunDiagnostics).toHaveBeenCalledWith(100);
  });

  it("passes an explicit limit through", async () => {
    await GET(req("?limit=25"));
    expect(listRunDiagnostics).toHaveBeenCalledWith(25);
  });

  it("clamps an over-large limit to 500", async () => {
    await GET(req("?limit=99999"));
    expect(listRunDiagnostics).toHaveBeenCalledWith(500);
  });

  it("clamps a non-positive/garbage limit up to at least 1 (falls back to default)", async () => {
    await GET(req("?limit=abc"));
    expect(listRunDiagnostics).toHaveBeenCalledWith(100);
  });
});
