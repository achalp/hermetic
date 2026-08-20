import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * /api/learning — the exemplar bank review surface. GET lists exemplars
 * sorted by attempts desc; DELETE ?exemplar=<id> removes one (400 without
 * an id, 404 when the store reports no such exemplar).
 */
const listExemplars = vi.fn();
const deleteExemplar = vi.fn();
vi.mock("@/lib/learning/exemplars", () => ({
  listExemplars: (...a: unknown[]) => listExemplars(...a),
  deleteExemplar: (...a: unknown[]) => deleteExemplar(...a),
}));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  serializeError: (e: unknown) => ({ error: String(e) }),
}));

import { GET, DELETE } from "@/app/api/learning/route";

beforeEach(() => vi.clearAllMocks());

describe("GET /api/learning", () => {
  it("returns exemplars sorted by attempts descending", async () => {
    listExemplars.mockResolvedValue([
      { id: "a", attempts: 1 },
      { id: "b", attempts: 5 },
    ]);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.exemplars.map((e: { id: string }) => e.id)).toEqual(["b", "a"]);
  });

  it("maps a load failure to a 500", async () => {
    listExemplars.mockRejectedValue(new Error("nope"));
    const res = await GET();
    expect(res.status).toBe(500);
  });
});

describe("DELETE /api/learning", () => {
  const del = (qs: string) =>
    DELETE(new Request(`http://x/api/learning${qs}`, { method: "DELETE" }));

  it("400s when no exemplar id is provided", async () => {
    const res = await del("");
    expect(res.status).toBe(400);
    expect(deleteExemplar).not.toHaveBeenCalled();
  });

  it("deletes an existing exemplar", async () => {
    deleteExemplar.mockResolvedValue(true);
    const res = await del("?exemplar=ex1");
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("deleted");
    expect(deleteExemplar).toHaveBeenCalledWith("ex1");
  });

  it("404s when the exemplar does not exist", async () => {
    deleteExemplar.mockResolvedValue(false);
    const res = await del("?exemplar=missing");
    expect(res.status).toBe(404);
  });
});
