/**
 * Regression: the metadata profile — the model's only view of the data — used
 * to carry literal values of identifier columns. A column of unique emails has
 * >30 distinct values, so it took the "top 10" branch, and with every count 1
 * that meant ten arbitrary real emails in every code-gen prompt (and in MCP
 * get_schema, the investigate planner, and the synthetic example rows).
 */
import { describe, it, expect } from "vitest";
import { extractSchema } from "@/lib/csv/schema";
import { healSchemaColumnMeta } from "@/lib/csv/schema-heal";
import { withholdIdentifierValues } from "@/lib/csv/value-exposure";
import { formatColumnMeta, buildCodeGenUserPrompt } from "@/lib/llm/prompts";
import type { ParsedCSV } from "@/lib/csv/parser";
import type { CategoricalMeta, CSVColumn, CSVSchema } from "@/lib/contracts/data-schema";

function parsed(columns: Record<string, string[]>): ParsedCSV {
  const headers = Object.keys(columns);
  const n = columns[headers[0]!]!.length;
  const data = Array.from({ length: n }, (_, i) =>
    Object.fromEntries(headers.map((h) => [h, columns[h]![i]!]))
  );
  return { headers, data, rowCount: n } as ParsedCSV;
}

function meta(schema: CSVSchema, name: string): CategoricalMeta {
  return schema.columns.find((c) => c.name === name)!.meta as CategoricalMeta;
}

const emails = Array.from({ length: 40 }, (_, i) => `person${i}@corp.example`);
const names = ["Ada Lovelace", "Alan Turing", "Grace Hopper", "Edsger Dijkstra"];

describe("identifier values never reach the prompt", () => {
  it("withholds a unique email column (the >30 top-values branch)", () => {
    const schema = extractSchema(parsed({ email: emails }), "id", "f.csv");
    const m = meta(schema, "email");
    expect(m.values_withheld).toBe(true);
    expect(m.top_values).toBeUndefined();
    expect(m.distinct_values).toBeUndefined();
    expect(m.distinct_count).toBe(40); // shape survives

    const line = formatColumnMeta(schema.columns[0]!);
    expect(line).toContain("values withheld (identifier-like)");
    for (const e of emails) expect(line).not.toContain(e);
  });

  it("withholds a small all-unique column (the ≤30 distinct-values branch)", () => {
    const schema = extractSchema(parsed({ name: names }), "id", "f.csv");
    const m = meta(schema, "name");
    expect(m.values_withheld).toBe(true);
    expect(m.distinct_values).toBeUndefined();
  });

  it("withholds an email-pattern column even when values repeat", () => {
    const repeated = [...emails.slice(0, 5), ...emails.slice(0, 5)];
    const schema = extractSchema(parsed({ email: repeated }), "id", "f.csv");
    expect(meta(schema, "email").values_withheld).toBe(true);
  });

  it("drops singletons from a top list but keeps the repeated modes", () => {
    const values = [...Array(50).fill("hot"), ...emails.map((e) => e.split("@")[0]!)];
    const schema = extractSchema(parsed({ tag: values }), "id", "f.csv");
    const m = meta(schema, "tag");
    expect(m.top_values).toEqual([{ value: "hot", count: 50 }]);
    expect(m.values_withheld).toBeUndefined();
  });

  it("leaves a real dimension untouched", () => {
    const plans = ["Starter", "Pro", "Pro", "Enterprise", "Starter", "Pro"];
    const schema = extractSchema(parsed({ plan: plans }), "id", "f.csv");
    const m = meta(schema, "plan");
    expect(m.distinct_values).toEqual(["Enterprise", "Pro", "Starter"]);
    expect(m.values_withheld).toBeUndefined();
    expect(withholdIdentifierValues(m)).toBe(m);
  });

  it("keeps identifier values out of the synthetic example rows", () => {
    const schema = extractSchema(
      parsed({ email: emails, plan: emails.map((_, i) => (i % 2 ? "Pro" : "Starter")) }),
      "id",
      "f.csv"
    );
    const prompt = buildCodeGenUserPrompt(schema, "How many customers per plan?");
    for (const e of emails) expect(prompt).not.toContain(e);
    expect(prompt).toContain("Starter");
  });
});

describe("the schema-heal boundary (Parquet profiles, cached schemas)", () => {
  // What the DuckDB profiler emits for unique-with-nulls: is_unique is
  // distinct_count == row_count, so the nulls make it false, and every top count is 1.
  const parquetCol: CSVColumn = {
    name: "account_id",
    dtype: "string",
    null_count: 3,
    sample_values: [],
    meta: {
      kind: "categorical",
      distinct_count: 97,
      distinct_values: undefined,
      top_values: [
        { value: "ACCT-0001", count: 1 },
        { value: "ACCT-0002", count: 1 },
      ],
      avg_length: 9,
      max_length: 9,
      min_length: 9,
      is_unique: false,
    },
  };
  const schema: CSVSchema = {
    csv_id: "p1",
    filename: "accounts.parquet",
    row_count: 100,
    columns: [parquetCol],
    sample_rows: [],
  };

  it("withholds values that arrive from a profiler or an older cache", () => {
    const healed = healSchemaColumnMeta(schema);
    const m = healed.columns[0]!.meta as CategoricalMeta;
    expect(m.values_withheld).toBe(true);
    expect(m.top_values).toBeUndefined();
    expect(JSON.stringify(healed)).not.toContain("ACCT-0001");
  });

  it("is idempotent — a withheld schema heals to itself", () => {
    const once = healSchemaColumnMeta(schema);
    expect(healSchemaColumnMeta(once)).toBe(once);
  });
});
