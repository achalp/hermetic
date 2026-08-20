import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * /api/sources/recent — recent-source list/rename/delete behind the
 * localhost-origin gate. GET lists; PATCH renames; DELETE removes one or
 * clears all. Real zod validation (readJsonBody/parseBody), storage mocked.
 */
const validateLocalOrigin = vi.fn();
const loadRecentSources = vi.fn();
const renameRecentSource = vi.fn();
const removeRecentSource = vi.fn();
const clearRecentSources = vi.fn();
vi.mock("@/lib/local-files/security", () => ({
  validateLocalOrigin: (...a: unknown[]) => validateLocalOrigin(...a),
}));
vi.mock("@/lib/sources/recent-sources", () => ({
  loadRecentSources: (...a: unknown[]) => loadRecentSources(...a),
  renameRecentSource: (...a: unknown[]) => renameRecentSource(...a),
  removeRecentSource: (...a: unknown[]) => removeRecentSource(...a),
  clearRecentSources: (...a: unknown[]) => clearRecentSources(...a),
}));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  serializeError: (e: unknown) => ({ error: String(e) }),
}));

import { GET, PATCH, DELETE } from "@/app/api/sources/recent/route";

const mk = (method: string, b?: unknown) =>
  new Request("http://localhost/api/sources/recent", {
    method,
    headers: { "Content-Type": "application/json" },
    body: b === undefined ? undefined : JSON.stringify(b),
  });

beforeEach(() => {
  vi.clearAllMocks();
  validateLocalOrigin.mockReturnValue(true);
});

describe("GET /api/sources/recent", () => {
  it("403s off-origin", async () => {
    validateLocalOrigin.mockReturnValue(false);
    expect((await GET(mk("GET"))).status).toBe(403);
  });

  it("lists recent sources", async () => {
    loadRecentSources.mockResolvedValue([{ id: "s1" }]);
    const res = await GET(mk("GET"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sources: [{ id: "s1" }] });
  });
});

describe("PATCH /api/sources/recent", () => {
  it("renames a source", async () => {
    renameRecentSource.mockResolvedValue(undefined);
    const res = await PATCH(mk("PATCH", { id: "s1", name: "renamed" }));
    expect(res.status).toBe(200);
    expect(renameRecentSource).toHaveBeenCalledWith("s1", "renamed");
  });

  it("400s on a body missing required fields", async () => {
    const res = await PATCH(mk("PATCH", { id: "s1" }));
    expect(res.status).toBe(400);
    expect(renameRecentSource).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/sources/recent", () => {
  it("removes a single source by id", async () => {
    removeRecentSource.mockResolvedValue(undefined);
    const res = await DELETE(mk("DELETE", { id: "s1" }));
    expect(res.status).toBe(200);
    expect(removeRecentSource).toHaveBeenCalledWith("s1");
    expect(clearRecentSources).not.toHaveBeenCalled();
  });

  it("clears all when all:true", async () => {
    clearRecentSources.mockResolvedValue(undefined);
    const res = await DELETE(mk("DELETE", { all: true }));
    expect(res.status).toBe(200);
    expect(clearRecentSources).toHaveBeenCalled();
  });
});
