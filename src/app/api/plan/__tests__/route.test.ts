import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * /api/plan — web adapter over the dashboard-edit library. GET ?csv_id
 * returns the edit surface (400 without csv_id); PATCH applies mutations
 * (400 on a malformed body, 422 when the edit is rejected, 200 + spec on
 * success).
 */
const editDashboard = vi.fn();
const getEditSurface = vi.fn();
vi.mock("@/lib/compose/edit", () => ({
  editDashboard: (...a: unknown[]) => editDashboard(...a),
  getEditSurface: (...a: unknown[]) => getEditSurface(...a),
}));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  serializeError: (e: unknown) => ({ error: String(e) }),
}));

import { GET, PATCH } from "@/app/api/plan/route";

const get = (qs: string) => GET(new Request(`http://x/api/plan${qs}`));
const patch = (b: unknown) =>
  PATCH(new Request("http://x/api/plan", { method: "PATCH", body: JSON.stringify(b) }));

beforeEach(() => vi.clearAllMocks());

describe("GET /api/plan", () => {
  it("400s without a csv_id", async () => {
    expect((await get("")).status).toBe(400);
  });

  it("returns the plan and surface", async () => {
    getEditSurface.mockResolvedValue({ doc: { title: "Plan" }, sections: [] });
    const res = await get("?csv_id=c1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.plan).toEqual({ title: "Plan" });
    expect(body.surface).toBeDefined();
  });

  it("returns a null plan when the surface is absent", async () => {
    getEditSurface.mockResolvedValue(null);
    const body = await (await get("?csv_id=c1")).json();
    expect(body.plan).toBeNull();
  });
});

describe("PATCH /api/plan", () => {
  it("400s on a malformed body", async () => {
    const res = await patch({ csv_id: "c1" }); // missing mutations
    expect(res.status).toBe(400);
    expect(editDashboard).not.toHaveBeenCalled();
  });

  it("422s when the edit is rejected", async () => {
    editDashboard.mockResolvedValue({ ok: false, errors: ["unknown section"] });
    const res = await patch({ csv_id: "c1", mutations: [{ op: "x" }] });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain("unknown section");
  });

  it("applies mutations and returns the new spec", async () => {
    editDashboard.mockResolvedValue({ ok: true, spec: { root: {} }, doc: { title: "P" } });
    const res = await patch({ csv_id: "c1", mutations: [{ op: "x" }] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, spec: { root: {} }, plan: { title: "P" } });
  });
});
