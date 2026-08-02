import { describe, it, expect } from "vitest";
import { warehouseSourceKey, warehouseTablesFingerprint } from "@/lib/warehouse/schema-fingerprint";
import type { WarehouseConnectionConfig } from "@/lib/contracts/connection-configs";
import type { WarehouseTableInfo } from "@/lib/contracts/warehouse-schema";

const tbl = (
  schema: string,
  name: string,
  column_count: number,
  row_count_estimate = 0
): WarehouseTableInfo => ({ schema, name, column_count, row_count_estimate });

describe("warehouseSourceKey", () => {
  it("keys on identity fields and OMITS secrets", () => {
    const cfg: WarehouseConnectionConfig = {
      type: "postgresql",
      host: "db.example.com",
      port: 5432,
      database: "analytics",
      user: "reader",
      password: "SUPER-SECRET",
      schema: "public",
    };
    const key = warehouseSourceKey(cfg);
    expect(key).toContain("postgresql");
    expect(key).toContain("db.example.com");
    expect(key).toContain("analytics");
    expect(key).toContain("public");
    // The password must never appear in the cache key.
    expect(key).not.toContain("SUPER-SECRET");
  });

  it("distinguishes different databases/schemas but is stable for the same target", () => {
    const base = {
      type: "postgresql" as const,
      host: "h",
      port: 5432,
      user: "u",
      password: "p",
    };
    const a = warehouseSourceKey({ ...base, database: "d1", schema: "s" });
    const b = warehouseSourceKey({ ...base, database: "d2", schema: "s" });
    const a2 = warehouseSourceKey({ ...base, database: "d1", schema: "s", password: "changed" });
    expect(a).not.toBe(b); // different db → different key
    expect(a).toBe(a2); // password change → SAME key (schema is identical)
  });
});

describe("warehouseTablesFingerprint", () => {
  it("is order-independent (sorted) and stable", () => {
    const a = warehouseTablesFingerprint([tbl("public", "orders", 5), tbl("public", "users", 3)]);
    const b = warehouseTablesFingerprint([tbl("public", "users", 3), tbl("public", "orders", 5)]);
    expect(a).toBe(b);
  });

  it("changes when a column is added or dropped (structural)", () => {
    const before = warehouseTablesFingerprint([tbl("public", "orders", 5)]);
    const after = warehouseTablesFingerprint([tbl("public", "orders", 6)]);
    expect(before).not.toBe(after);
  });

  it("changes when a table is added or dropped", () => {
    const one = warehouseTablesFingerprint([tbl("public", "orders", 5)]);
    const two = warehouseTablesFingerprint([tbl("public", "orders", 5), tbl("public", "users", 3)]);
    expect(one).not.toBe(two);
  });

  it("does NOT change on data-volume drift (row-count estimate excluded)", () => {
    const before = warehouseTablesFingerprint([tbl("public", "orders", 5, 1000)]);
    const after = warehouseTablesFingerprint([tbl("public", "orders", 5, 5_000_000)]);
    expect(before).toBe(after); // same structure → cache stays valid despite inserts
  });
});
