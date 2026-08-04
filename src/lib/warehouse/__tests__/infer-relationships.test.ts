import { describe, it, expect } from "vitest";
import { inferRelationships } from "@/lib/warehouse/infer-relationships";
import type { WarehouseTableSchema, WarehouseColumnInfo } from "@/lib/contracts/warehouse-schema";

function col(name: string): WarehouseColumnInfo {
  return { name, type: "string", nullable: true };
}

function table(name: string, columnNames: string[]): WarehouseTableSchema {
  return {
    schema: "public",
    name,
    columns: columnNames.map(col),
    row_count_estimate: 0,
  };
}

describe("inferRelationships", () => {
  it("returns an empty array for empty input", () => {
    expect(inferRelationships([])).toEqual([]);
  });

  it("detects a clear <table>_id FK pointing at the referenced table's id column", () => {
    const out = inferRelationships([
      table("users", ["id", "name"]),
      table("orders", ["id", "user_id", "total"]),
    ]);
    const orders = out.find((t) => t.name === "orders")!;
    expect(orders.foreign_keys).toEqual([
      { column: "user_id", references_table: "users", references_column: "id" },
    ]);
    // users has no FK columns → no foreign_keys added.
    const users = out.find((t) => t.name === "users")!;
    expect(users.foreign_keys).toBeUndefined();
  });

  it("resolves singular FK prefix to a plural table name (user_id → users)", () => {
    // "users" only registers as itself + singular "user" via normalization.
    const out = inferRelationships([table("users", ["id"]), table("events", ["id", "user_id"])]);
    const events = out.find((t) => t.name === "events")!;
    expect(events.foreign_keys).toEqual([
      { column: "user_id", references_table: "users", references_column: "id" },
    ]);
  });

  it("detects camelCase FK columns (userId → users.id)", () => {
    const out = inferRelationships([table("users", ["id"]), table("sessions", ["id", "userId"])]);
    const sessions = out.find((t) => t.name === "sessions")!;
    expect(sessions.foreign_keys).toEqual([
      { column: "userId", references_table: "users", references_column: "id" },
    ]);
  });

  it("supports _key and _code suffixes", () => {
    const out = inferRelationships([
      table("products", ["id"]),
      table("lineitems", ["id", "product_key"]),
    ]);
    const li = out.find((t) => t.name === "lineitems")!;
    expect(li.foreign_keys).toEqual([
      { column: "product_key", references_table: "products", references_column: "id" },
    ]);
  });

  it("does not infer an FK when no referenced table name aligns", () => {
    const out = inferRelationships([table("orders", ["id", "shipper_id"]), table("users", ["id"])]);
    const orders = out.find((t) => t.name === "orders")!;
    expect(orders.foreign_keys).toBeUndefined();
  });

  it("does not infer an FK when the referenced table lacks an id column", () => {
    const out = inferRelationships([
      table("users", ["name", "email"]), // no id / ID, and no "user_id" column
      table("orders", ["id", "user_id"]),
    ]);
    const orders = out.find((t) => t.name === "orders")!;
    expect(orders.foreign_keys).toBeUndefined();
  });

  it("falls back to the prefix column name when the ref table has no id but shares the column", () => {
    // users has no "id" but has a "user_id" column → refCol falls back to col.name.
    const out = inferRelationships([
      table("users", ["user_id", "name"]),
      table("orders", ["id", "user_id"]),
    ]);
    const orders = out.find((t) => t.name === "orders")!;
    expect(orders.foreign_keys).toEqual([
      { column: "user_id", references_table: "users", references_column: "user_id" },
    ]);
  });

  it("ignores self-referential matches (prefix equals current table)", () => {
    // An "order_id" column inside the "orders" table must not self-reference.
    const out = inferRelationships([table("orders", ["id", "order_id"])]);
    const orders = out[0];
    expect(orders.foreign_keys).toBeUndefined();
  });

  it("ignores a bare suffix column like '_id' with empty prefix", () => {
    const out = inferRelationships([table("users", ["id"]), table("orders", ["id", "_id"])]);
    const orders = out.find((t) => t.name === "orders")!;
    expect(orders.foreign_keys).toBeUndefined();
  });

  it("preserves existing foreign_keys and skips inference for that table", () => {
    const orders: WarehouseTableSchema = {
      ...table("orders", ["id", "user_id"]),
      foreign_keys: [{ column: "user_id", references_table: "users", references_column: "id" }],
    };
    const out = inferRelationships([table("users", ["id"]), orders]);
    const got = out.find((t) => t.name === "orders")!;
    // Unchanged — returned as-is (same single, pre-existing FK).
    expect(got.foreign_keys).toEqual([
      { column: "user_id", references_table: "users", references_column: "id" },
    ]);
    expect(got).toBe(orders);
  });

  it("infers multiple FKs within one table", () => {
    const out = inferRelationships([
      table("users", ["id"]),
      table("products", ["id"]),
      table("orders", ["id", "user_id", "product_id"]),
    ]);
    const orders = out.find((t) => t.name === "orders")!;
    expect(orders.foreign_keys).toEqual([
      { column: "user_id", references_table: "users", references_column: "id" },
      { column: "product_id", references_table: "products", references_column: "id" },
    ]);
  });

  it("does not duplicate an FK across the suffix and camelCase passes", () => {
    // "userId" matches the camelCase pass; ensure it's only added once.
    const out = inferRelationships([table("users", ["id"]), table("logins", ["id", "userId"])]);
    const logins = out.find((t) => t.name === "logins")!;
    expect(logins.foreign_keys).toHaveLength(1);
  });
});
