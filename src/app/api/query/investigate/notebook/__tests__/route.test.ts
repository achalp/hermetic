import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * POST /api/query/investigate/notebook — persist a user notebook layout onto
 * the cached investigation trail. 400 without csv_id or with a malformed
 * layout, 404 when no trail is cached, 200 + re-cache on success. Also checks
 * the layout sanitizer keeps valid step/markdown cells and drops junk.
 */
const cacheArtifacts = vi.fn();
const getCachedArtifacts = vi.fn();
vi.mock("@/lib/pipeline/artifacts-cache", () => ({
  cacheArtifacts: (...a: unknown[]) => cacheArtifacts(...a),
  getCachedArtifacts: (...a: unknown[]) => getCachedArtifacts(...a),
}));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  serializeError: (e: unknown) => ({ error: String(e) }),
}));

import { POST } from "@/app/api/query/investigate/notebook/route";

const req = (b: unknown) => new Request("http://x", { method: "POST", body: JSON.stringify(b) });

beforeEach(() => vi.clearAllMocks());

describe("POST /api/query/investigate/notebook", () => {
  it("400s without a csv_id", async () => {
    expect((await POST(req({ layout: { cells: [] } }))).status).toBe(400);
  });

  it("400s on a layout that is not an object with a cells array", async () => {
    expect((await POST(req({ csv_id: "c1", layout: { cells: "nope" } }))).status).toBe(400);
  });

  it("404s when no investigation trail is cached", async () => {
    getCachedArtifacts.mockReturnValue({ investigation: undefined });
    expect((await POST(req({ csv_id: "c1", layout: { cells: [] } }))).status).toBe(404);
  });

  it("saves a sanitized layout onto the trail and re-caches it", async () => {
    const prior = { investigation: { steps: [] } as Record<string, unknown> };
    getCachedArtifacts.mockReturnValue(prior);
    const res = await POST(
      req({
        csv_id: "c1",
        layout: {
          cells: [
            { kind: "step", stepNo: 1 },
            { kind: "markdown", id: "m1", content: "hello" },
            { kind: "bogus" }, // dropped
          ],
        },
      })
    );
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    // Sanitizer kept exactly the two valid cells.
    expect((prior.investigation.notebook as { cells: unknown[] }).cells).toHaveLength(2);
    expect(cacheArtifacts).toHaveBeenCalledWith("c1", prior);
  });
});
