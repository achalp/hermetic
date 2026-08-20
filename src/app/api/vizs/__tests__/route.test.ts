import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * GET /api/vizs — thin listing over saved storage. Success returns { vizs };
 * a storage throw maps to the standard apiError 500.
 */
const listSavedVisualizations = vi.fn();
vi.mock("@/lib/saved/storage", () => ({
  listSavedVisualizations: (...a: unknown[]) => listSavedVisualizations(...a),
}));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  serializeError: (e: unknown) => ({ error: String(e) }),
}));

import { GET } from "@/app/api/vizs/route";

beforeEach(() => vi.clearAllMocks());

describe("GET /api/vizs", () => {
  it("lists saved visualizations", async () => {
    listSavedVisualizations.mockResolvedValue([{ id: "v1", question: "q" }]);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ vizs: [{ id: "v1", question: "q" }] });
  });

  it("maps a storage failure to a 500", async () => {
    listSavedVisualizations.mockRejectedValue(new Error("boom"));
    const res = await GET();
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("boom");
  });
});
