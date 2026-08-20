import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * /api/warehouse/dbt-metadata — bind/clear a dbt manifest to a warehouse.
 * POST validates warehouse_id + manifestPath, validates the path, then
 * applies it (404 when the warehouse is unknown). DELETE clears the binding.
 */
const setDbtManifestPath = vi.fn();
const validateManifestPath = vi.fn();
vi.mock("@/lib/warehouse/storage", () => ({
  setDbtManifestPath: (...a: unknown[]) => setDbtManifestPath(...a),
}));
vi.mock("@/lib/warehouse/dbt-metadata", () => ({
  validateManifestPath: (...a: unknown[]) => validateManifestPath(...a),
}));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  serializeError: (e: unknown) => ({ error: String(e) }),
}));

import { POST, DELETE } from "@/app/api/warehouse/dbt-metadata/route";

const mk = (method: string, b: unknown) =>
  new Request("http://x/api/warehouse/dbt-metadata", { method, body: JSON.stringify(b) });

beforeEach(() => {
  vi.clearAllMocks();
  validateManifestPath.mockResolvedValue({ ok: true });
});

describe("POST /api/warehouse/dbt-metadata", () => {
  it("400s without warehouse_id", async () => {
    expect((await POST(mk("POST", { manifestPath: "/p/manifest.json" }))).status).toBe(400);
  });

  it("400s without manifestPath", async () => {
    expect((await POST(mk("POST", { warehouse_id: "w1" }))).status).toBe(400);
  });

  it("400s when the manifest path fails validation", async () => {
    validateManifestPath.mockResolvedValue({ ok: false, error: "not a manifest.json" });
    const res = await POST(mk("POST", { warehouse_id: "w1", manifestPath: "/bad" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("not a manifest.json");
  });

  it("404s when the warehouse is unknown", async () => {
    setDbtManifestPath.mockResolvedValue(null);
    const res = await POST(mk("POST", { warehouse_id: "gone", manifestPath: "/p/manifest.json" }));
    expect(res.status).toBe(404);
  });

  it("applies the manifest and reports enriched table counts", async () => {
    setDbtManifestPath.mockResolvedValue({
      enrichedTableCount: 3,
      stored: { tableSchemas: [1, 2, 3, 4] },
    });
    const res = await POST(mk("POST", { warehouse_id: "w1", manifestPath: "/p/manifest.json" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, enrichedTableCount: 3, totalTableCount: 4 });
  });
});

describe("DELETE /api/warehouse/dbt-metadata", () => {
  it("400s without warehouse_id", async () => {
    expect((await DELETE(mk("DELETE", {}))).status).toBe(400);
  });

  it("clears the binding", async () => {
    setDbtManifestPath.mockResolvedValue({ enrichedTableCount: 0, stored: { tableSchemas: [] } });
    const res = await DELETE(mk("DELETE", { warehouse_id: "w1" }));
    expect(res.status).toBe(200);
    expect(setDbtManifestPath).toHaveBeenCalledWith("w1", null);
  });

  it("404s when clearing an unknown warehouse", async () => {
    setDbtManifestPath.mockResolvedValue(null);
    expect((await DELETE(mk("DELETE", { warehouse_id: "gone" }))).status).toBe(404);
  });
});
