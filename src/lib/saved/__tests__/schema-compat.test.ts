import { describe, it, expect } from "vitest";
import { schemaFingerprint, schemasCompatible } from "@/lib/saved/schema-compat";
import type { CSVSchema, CSVColumn } from "@/lib/contracts/data-schema";

function col(name: string, dtype: CSVColumn["dtype"]): CSVColumn {
  return {
    name,
    dtype,
    null_count: 0,
    // ColumnMeta shape is irrelevant to fingerprint/compat, which only read
    // name + dtype; an empty object is sufficient for these unit tests.
    meta: {} as CSVColumn["meta"],
    sample_values: [],
  };
}

function schema(columns: CSVColumn[], overrides: Partial<CSVSchema> = {}): CSVSchema {
  return {
    csv_id: "csv-1",
    filename: "data.csv",
    row_count: 100,
    columns,
    sample_rows: [],
    ...overrides,
  };
}

describe("saved/schema-compat", () => {
  describe("schemaFingerprint", () => {
    it("is stable for the same schema content", () => {
      const a = schema([col("id", "number"), col("name", "string")]);
      const b = schema([col("id", "number"), col("name", "string")]);
      expect(schemaFingerprint(a)).toBe(schemaFingerprint(b));
    });

    it("encodes name + dtype joined and sorted", () => {
      const s = schema([col("name", "string"), col("id", "number")]);
      // sorted alphabetically by the `name:dtype` token
      expect(schemaFingerprint(s)).toBe("id:number|name:string");
    });

    it("is order-independent (columns are sorted before joining)", () => {
      const a = schema([col("id", "number"), col("name", "string")]);
      const b = schema([col("name", "string"), col("id", "number")]);
      expect(schemaFingerprint(a)).toBe(schemaFingerprint(b));
    });

    it("changes when a column dtype changes", () => {
      const a = schema([col("id", "number")]);
      const b = schema([col("id", "string")]);
      expect(schemaFingerprint(a)).not.toBe(schemaFingerprint(b));
    });

    it("changes when a column is renamed", () => {
      const a = schema([col("id", "number")]);
      const b = schema([col("ident", "number")]);
      expect(schemaFingerprint(a)).not.toBe(schemaFingerprint(b));
    });

    it("changes when a column is added or removed", () => {
      const one = schema([col("id", "number")]);
      const two = schema([col("id", "number"), col("name", "string")]);
      expect(schemaFingerprint(one)).not.toBe(schemaFingerprint(two));
    });

    it("ignores fields outside columns (row_count, filename, csv_id, samples)", () => {
      const a = schema([col("id", "number")], { row_count: 1, filename: "a.csv", csv_id: "x" });
      const b = schema([col("id", "number")], {
        row_count: 999,
        filename: "b.csv",
        csv_id: "y",
        sample_rows: [{ id: "5" }],
      });
      expect(schemaFingerprint(a)).toBe(schemaFingerprint(b));
    });

    it("produces an empty string for a schema with no columns", () => {
      expect(schemaFingerprint(schema([]))).toBe("");
    });
  });

  describe("schemasCompatible", () => {
    it("is true when actual has exactly the expected columns/dtypes", () => {
      const expected = schema([col("id", "number"), col("name", "string")]);
      const actual = schema([col("id", "number"), col("name", "string")]);
      expect(schemasCompatible(expected, actual)).toBe(true);
    });

    it("is true regardless of column order", () => {
      const expected = schema([col("id", "number"), col("name", "string")]);
      const actual = schema([col("name", "string"), col("id", "number")]);
      expect(schemasCompatible(expected, actual)).toBe(true);
    });

    it("is true when actual has EXTRA columns (superset is OK)", () => {
      const expected = schema([col("id", "number")]);
      const actual = schema([col("id", "number"), col("extra", "string")]);
      expect(schemasCompatible(expected, actual)).toBe(true);
    });

    it("is false when an expected column is missing from actual", () => {
      const expected = schema([col("id", "number"), col("name", "string")]);
      const actual = schema([col("id", "number")]);
      expect(schemasCompatible(expected, actual)).toBe(false);
    });

    it("is false when an expected column was renamed in actual", () => {
      const expected = schema([col("id", "number")]);
      const actual = schema([col("ident", "number")]);
      expect(schemasCompatible(expected, actual)).toBe(false);
    });

    it("is false when an expected column changed dtype in actual", () => {
      const expected = schema([col("id", "number")]);
      const actual = schema([col("id", "string")]);
      expect(schemasCompatible(expected, actual)).toBe(false);
    });

    it("is true when expected has no columns (vacuously compatible)", () => {
      const expected = schema([]);
      const actual = schema([col("id", "number")]);
      expect(schemasCompatible(expected, actual)).toBe(true);
    });

    it("is not symmetric: extra-in-expected breaks compatibility", () => {
      const a = schema([col("id", "number"), col("name", "string")]);
      const b = schema([col("id", "number")]);
      // a expects name; b lacks it
      expect(schemasCompatible(a, b)).toBe(false);
      // but b's columns are all present (with matching dtype) in a
      expect(schemasCompatible(b, a)).toBe(true);
    });
  });
});
