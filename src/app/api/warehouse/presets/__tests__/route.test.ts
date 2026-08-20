import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * /api/warehouse/presets — CRUD over persisted warehouse connections.
 * GET lists, PATCH renames (400 without id/name), DELETE removes (400
 * without id). Persistence layer mocked.
 */
const loadConnections = vi.fn();
const removeConnection = vi.fn();
const renameConnection = vi.fn();
vi.mock("@/lib/warehouse/persist-env", () => ({
  loadConnections: (...a: unknown[]) => loadConnections(...a),
  removeConnection: (...a: unknown[]) => removeConnection(...a),
  renameConnection: (...a: unknown[]) => renameConnection(...a),
}));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  serializeError: (e: unknown) => ({ error: String(e) }),
}));

import { GET, PATCH, DELETE } from "@/app/api/warehouse/presets/route";

const body = (b: unknown, method: string) =>
  new Request("http://x/api/warehouse/presets", { method, body: JSON.stringify(b) });

beforeEach(() => vi.clearAllMocks());

describe("GET /api/warehouse/presets", () => {
  it("returns the stored connections", async () => {
    loadConnections.mockResolvedValue([{ id: "c1", name: "prod" }]);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connections: [{ id: "c1", name: "prod" }] });
  });
});

describe("PATCH /api/warehouse/presets", () => {
  it("renames a connection", async () => {
    renameConnection.mockResolvedValue(undefined);
    const res = await PATCH(body({ id: "c1", name: "staging" }, "PATCH"));
    expect(res.status).toBe(200);
    expect(renameConnection).toHaveBeenCalledWith("c1", "staging");
  });

  it("400s without id and name", async () => {
    const res = await PATCH(body({ id: "c1" }, "PATCH"));
    expect(res.status).toBe(400);
    expect(renameConnection).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/warehouse/presets", () => {
  it("removes a connection", async () => {
    removeConnection.mockResolvedValue(undefined);
    const res = await DELETE(body({ id: "c1" }, "DELETE"));
    expect(res.status).toBe(200);
    expect(removeConnection).toHaveBeenCalledWith("c1");
  });

  it("400s without an id", async () => {
    const res = await DELETE(body({}, "DELETE"));
    expect(res.status).toBe(400);
    expect(removeConnection).not.toHaveBeenCalled();
  });
});
