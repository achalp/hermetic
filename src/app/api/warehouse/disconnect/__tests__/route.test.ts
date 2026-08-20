import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * POST /api/warehouse/disconnect — drops a stored warehouse. 400 without an
 * id, otherwise delegates to removeWarehouse and returns { ok: true }.
 */
const removeWarehouse = vi.fn();
vi.mock("@/lib/warehouse/storage", () => ({
  removeWarehouse: (...a: unknown[]) => removeWarehouse(...a),
}));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  serializeError: (e: unknown) => ({ error: String(e) }),
}));

import { POST } from "@/app/api/warehouse/disconnect/route";

const req = (b: unknown) =>
  new Request("http://x/api/warehouse/disconnect", { method: "POST", body: JSON.stringify(b) });

beforeEach(() => vi.clearAllMocks());

describe("POST /api/warehouse/disconnect", () => {
  it("removes the named warehouse", async () => {
    const res = await POST(req({ warehouse_id: "wh1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(removeWarehouse).toHaveBeenCalledWith("wh1");
  });

  it("400s without a warehouse_id", async () => {
    const res = await POST(req({}));
    expect(res.status).toBe(400);
    expect(removeWarehouse).not.toHaveBeenCalled();
  });
});
