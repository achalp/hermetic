import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * GET /api/sources/schema — returns a stored csvId's schema behind the
 * localhost-origin gate. 403 off-origin, 400 without csvId, 404 on a miss.
 */
const validateLocalOrigin = vi.fn();
const getStoredCSV = vi.fn();
vi.mock("@/lib/local-files/security", () => ({
  validateLocalOrigin: (...a: unknown[]) => validateLocalOrigin(...a),
}));
vi.mock("@/lib/csv/storage", () => ({ getStoredCSV: (...a: unknown[]) => getStoredCSV(...a) }));

import { GET } from "@/app/api/sources/schema/route";

const get = (qs = "") => GET(new Request(`http://localhost/api/sources/schema${qs}`));

beforeEach(() => {
  vi.clearAllMocks();
  validateLocalOrigin.mockReturnValue(true);
});

describe("GET /api/sources/schema", () => {
  it("403s off-origin", async () => {
    validateLocalOrigin.mockReturnValue(false);
    const res = await get("?csvId=c1");
    expect(res.status).toBe(403);
  });

  it("400s without a csvId", async () => {
    const res = await get("");
    expect(res.status).toBe(400);
  });

  it("404s when the source is not stored", async () => {
    getStoredCSV.mockReturnValue(null);
    const res = await get("?csvId=gone");
    expect(res.status).toBe(404);
  });

  it("returns the stored schema", async () => {
    getStoredCSV.mockReturnValue({ schema: { row_count: 3, columns: [] } });
    const res = await get("?csvId=c1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ csv_id: "c1", schema: { row_count: 3, columns: [] } });
  });
});
