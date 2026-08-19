/** Trino connector: config→client, streamed rows→CSV, the read-only gate, and
 *  schema introspection (testConnection / listTables / introspectAllTables).
 *  Driver mocked SQL-aware; no live Trino. */
import { describe, it, expect, vi } from "vitest";

/** One result page per query shape the connector issues. */
function pageFor(sql: string) {
  if (/col_count|count\(\*\)/i.test(sql))
    return {
      columns: [{ name: "table_name" }, { name: "col_count" }],
      data: [
        ["orders", 2],
        ["customers", 3],
      ],
    };
  if (/information_schema\.columns/i.test(sql))
    return {
      columns: [
        { name: "table_name" },
        { name: "column_name" },
        { name: "data_type" },
        { name: "is_nullable" },
      ],
      data: [
        ["orders", "id", "bigint", "NO"],
        ["orders", "total", "double", "YES"],
        ["customers", "id", "bigint", "NO"],
      ],
    };
  if (/information_schema\.tables/i.test(sql))
    return { columns: [{ name: "table_name" }], data: [["orders"], ["customers"]] };
  if (/^\s*SELECT 1/i.test(sql)) return { columns: [{ name: "_col0" }], data: [[1]] };
  return {
    columns: [{ name: "a" }, { name: "b" }],
    data: [
      [1, 2],
      [3, 4],
    ],
  };
}

vi.mock("trino-client", () => ({
  Trino: {
    create: vi.fn(() => ({
      query: vi.fn(async (sql: string) => {
        let i = 0;
        const page = pageFor(sql);
        return {
          next: async () =>
            i++ === 0 ? { done: false, value: page } : { done: true, value: undefined },
        };
      }),
    })),
  },
  BasicAuth: class {},
}));

import { createConnector } from "../connector";
import type { TrinoConnectionConfig } from "@/lib/contracts/connection-configs";

const CONFIG: TrinoConnectionConfig = {
  type: "trino",
  host: "h",
  port: 8080,
  user: "u",
  catalog: "c",
  schema: "s",
  password: "",
  ssl: false,
};
const conn = () => createConnector(CONFIG);

describe("trino connector", () => {
  it("executeSQL streams the driver's rows into CSV (columns + data)", async () => {
    expect(await conn().executeSQL("SELECT x, y FROM t")).toBe("a,b\n1,2\n3,4\n");
  });
  it("rejects a write at the read-only gate", async () => {
    await expect(async () => conn().executeSQL("DELETE FROM t")).rejects.toThrow();
  });
  it("testConnection runs a probe query without throwing", async () => {
    await expect(conn().testConnection()).resolves.toBeUndefined();
  });
  it("listTables returns names with per-table column counts", async () => {
    const tables = await conn().listTables();
    expect(tables.map((t) => t.name)).toEqual(["orders", "customers"]);
    expect(tables.find((t) => t.name === "orders")?.column_count).toBe(2);
    expect(tables.find((t) => t.name === "customers")?.column_count).toBe(3);
  });
  it("introspectAllTables groups columns per table with types + nullability", async () => {
    const schemas = await conn().introspectAllTables();
    const orders = schemas.find((s) => s.name === "orders")!;
    expect(orders.columns.map((c) => c.name)).toEqual(["id", "total"]);
    expect(orders.columns.find((c) => c.name === "total")).toMatchObject({
      type: "double",
      nullable: true,
    });
    expect(orders.columns.find((c) => c.name === "id")).toMatchObject({ nullable: false });
    expect(schemas.find((s) => s.name === "customers")!.columns).toHaveLength(1);
  });
});
