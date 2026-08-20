import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * GET /api/warehouse/sample — table preview. Requires warehouse_id + table
 * (400), a live warehouse + connector (404), and the table to be one the
 * connection introspected (400 — the injection guard). On success it parses
 * the connector's CSV into { headers, rows }.
 */
const getStoredWarehouse = vi.fn();
const getWarehouseConnector = vi.fn();
vi.mock("@/lib/warehouse/storage", () => ({
  getStoredWarehouse: (...a: unknown[]) => getStoredWarehouse(...a),
  getWarehouseConnector: (...a: unknown[]) => getWarehouseConnector(...a),
}));
vi.mock("@/lib/warehouse/engine-descriptor", () => ({
  ENGINES: { duckdb: { sampleQuery: (t: string) => `SELECT * FROM ${t} LIMIT 10` } },
}));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  serializeError: (e: unknown) => ({ error: String(e) }),
}));

import { GET } from "@/app/api/warehouse/sample/route";

const get = (qs: string) => GET(new Request(`http://x/api/warehouse/sample${qs}`));
const warehouse = { config: { type: "duckdb" }, tables: [{ schema: "main", name: "sales" }] };

beforeEach(() => {
  vi.clearAllMocks();
  getStoredWarehouse.mockReturnValue(warehouse);
  getWarehouseConnector.mockReturnValue({ executeSQL: vi.fn().mockResolvedValue("a,b\n1,2\n3,4") });
});

describe("GET /api/warehouse/sample", () => {
  it("400s without warehouse_id and table", async () => {
    expect((await get("?warehouse_id=w1")).status).toBe(400);
  });

  it("404s when the warehouse is not stored", async () => {
    getStoredWarehouse.mockReturnValue(undefined);
    expect((await get("?warehouse_id=w1&table=sales")).status).toBe(404);
  });

  it("400s for a table not in the connection's introspected set", async () => {
    const res = await get("?warehouse_id=w1&table=secret_table");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("Unknown table");
  });

  it("parses the connector CSV into headers + rows", async () => {
    const res = await get("?warehouse_id=w1&table=sales");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.headers).toEqual(["a", "b"]);
    expect(body.rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });
});
