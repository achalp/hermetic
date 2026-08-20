import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * GET /api/history — thin listing over listHistory.
 */
const listHistory = vi.fn();
vi.mock("@/lib/history/storage", () => ({ listHistory: (...a: unknown[]) => listHistory(...a) }));

import { GET } from "@/app/api/history/route";

beforeEach(() => vi.clearAllMocks());

describe("GET /api/history", () => {
  it("returns the history entries", async () => {
    listHistory.mockResolvedValue([{ id: "h1", question: "q" }]);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ entries: [{ id: "h1", question: "q" }] });
  });
});
