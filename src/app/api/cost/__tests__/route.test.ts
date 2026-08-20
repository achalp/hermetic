import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * /api/cost — thin reader over lib/cost/storage. Success returns { rows };
 * a storage throw maps to the standard apiError 500 { error } body.
 */
const listCostRows = vi.fn();
vi.mock("@/lib/cost/storage", () => ({ listCostRows: (...a: unknown[]) => listCostRows(...a) }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  serializeError: (e: unknown) => ({ error: String(e) }),
}));

import { GET } from "@/app/api/cost/route";

beforeEach(() => vi.clearAllMocks());

describe("GET /api/cost", () => {
  it("returns the cost rows", async () => {
    listCostRows.mockResolvedValue([{ id: "r1", cost_usd: 0.5 }]);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rows: [{ id: "r1", cost_usd: 0.5 }] });
  });

  it("maps a storage failure to a 500 { error } body", async () => {
    listCostRows.mockRejectedValue(new Error("disk gone"));
    const res = await GET();
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("disk gone");
  });
});
