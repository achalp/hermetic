import { describe, it, expect } from "vitest";

/**
 * POST /api/warehouse/schema — retired endpoint kept as a 410 Gone stub that
 * points callers at /api/warehouse/query.
 */
import { POST } from "@/app/api/warehouse/schema/route";

describe("POST /api/warehouse/schema", () => {
  it("returns 410 Gone with a redirect hint", async () => {
    const res = await POST();
    expect(res.status).toBe(410);
    expect((await res.json()).error).toContain("/api/warehouse/query");
  });
});
