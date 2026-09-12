/**
 * Regression: a column whose `meta` crossed an untyped boundary as null.
 *
 * The remote profiler used to emit `meta: None` for skipped GEOMETRY/BLOB
 * columns. `CSVColumn.meta` is a required discriminated union, so the null
 * travelled undetected through `JSON.parse(...) as CSVSchema` and the schema
 * cache, then threw on `c.meta.kind` inside the question-suggestion heuristics
 * as the page rendered — and would have thrown again in `formatColumnMeta`
 * while building any manifest prompt.
 */
import { describe, it, expect } from "vitest";
import { healSchemaColumnMeta, healColumnMeta } from "@/lib/csv/schema-heal";
import { generateSuggestions } from "@/lib/suggest-questions";
import { formatColumnMeta } from "@/lib/llm/prompts";
import type { CSVColumn, CSVSchema } from "@/lib/contracts/data-schema";

const numberCol: CSVColumn = {
  name: "height",
  dtype: "number",
  null_count: 0,
  sample_values: ["3"],
  meta: {
    kind: "number",
    is_integer: true,
    decimal_precision: 0,
    is_currency: false,
    is_percentage: false,
    min: 1,
    max: 9,
    mean: 5,
    median: 5,
    std_dev: 2,
    p25: 3,
    p75: 7,
    zero_count: 0,
    negative_count: 0,
  },
};

/** What an older build wrote for a skipped geometry column. */
const poisoned = {
  name: "geometry",
  dtype: "string",
  null_count: 0,
  sample_values: [],
  meta: null,
} as unknown as CSVColumn;

function schemaWith(columns: CSVColumn[]): CSVSchema {
  return {
    csv_id: "c1",
    filename: "division_boundary",
    row_count: 100,
    columns,
    sample_rows: [],
  };
}

describe("healSchemaColumnMeta", () => {
  it("turns a null meta into the explicit UNPROFILED variant, not a fabricated stat", () => {
    const healed = healColumnMeta(poisoned);
    expect(healed.meta.kind).toBe("unprofiled");
    // Nothing was measured, so nothing numeric is asserted: a zeroed
    // categorical meta would tell a planner this column has 0 distinct values.
    expect(healed.meta).not.toHaveProperty("distinct_count");
    expect(healed.meta).not.toHaveProperty("min");
  });

  it("rejects a meta with an unknown kind the same way", () => {
    const weird = { ...poisoned, meta: { kind: "geometry" } } as unknown as CSVColumn;
    expect(healColumnMeta(weird).meta.kind).toBe("unprofiled");
  });

  it("is identity for a valid schema — same object, no allocation", () => {
    const schema = schemaWith([numberCol]);
    expect(healSchemaColumnMeta(schema)).toBe(schema);
  });

  it("preserves the healthy columns while healing the broken one", () => {
    const healed = healSchemaColumnMeta(schemaWith([numberCol, poisoned]));
    expect(healed.columns[0]).toBe(numberCol);
    expect(healed.columns[1]!.meta.kind).toBe("unprofiled");
    expect(healed.columns[1]!.name).toBe("geometry");
  });
});

describe("consumers survive an unprofiled column", () => {
  it("generateSuggestions does not throw on the healed schema (the crash site)", () => {
    const healed = healSchemaColumnMeta(schemaWith([numberCol, poisoned]));
    expect(() => generateSuggestions(healed)).not.toThrow();
  });

  it("a prompt SAYS the column was not profiled instead of staying silent", () => {
    const healed = healColumnMeta(poisoned);
    const line = formatColumnMeta(healed);
    expect(line).toContain("geometry");
    expect(line).toContain("NOT PROFILED");
    // It is still queryable — the model must not conclude the column is absent.
    expect(line).toContain("usable in queries");
  });
});
