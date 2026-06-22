import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WarehouseTableSchema } from "@/lib/types";

const generateTextMock = vi.fn();
vi.mock("ai", () => ({
  generateText: (...args: unknown[]) => generateTextMock(...args),
}));
vi.mock("@/lib/llm/client", () => ({
  getModel: () => ({}),
  cachedSystem: (s: string) => s,
  cachedText: (s: string) => ({ type: "text", text: s }),
  getActiveProvider: () => "anthropic",
}));

import { selectRelevantTables } from "@/lib/warehouse/sql-generation";

function tbl(name: string, opts: Partial<WarehouseTableSchema> = {}): WarehouseTableSchema {
  return {
    name,
    schema: "public",
    columns: [{ name: "id", type: "int", nullable: false }],
    row_count_estimate: 100,
    ...opts,
  } as WarehouseTableSchema;
}

// 10 tables so we're over the selection threshold (8).
const MANY = Array.from({ length: 10 }, (_, i) => tbl(`t${i}`));

beforeEach(() => generateTextMock.mockReset());

describe("selectRelevantTables", () => {
  it("skips the LLM and returns all tables when at/under the threshold", async () => {
    const few = MANY.slice(0, 8);
    const out = await selectRelevantTables(few, "anything");
    expect(out).toBe(few);
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("prunes to the tables the model selects (by bare name)", async () => {
    generateTextMock.mockResolvedValueOnce({ text: '["t2", "t5"]' });
    const out = await selectRelevantTables(MANY, "q");
    expect(out.map((t) => t.name)).toEqual(["t2", "t5"]);
  });

  it("matches fully-qualified schema.name too", async () => {
    generateTextMock.mockResolvedValueOnce({ text: '["public.t3"]' });
    const out = await selectRelevantTables(MANY, "q");
    expect(out.map((t) => t.name)).toEqual(["t3"]);
  });

  it("tolerates prose/markdown around the JSON array", async () => {
    generateTextMock.mockResolvedValueOnce({
      text: 'Sure! Here you go:\n```json\n["t1"]\n```',
    });
    const out = await selectRelevantTables(MANY, "q");
    expect(out.map((t) => t.name)).toEqual(["t1"]);
  });

  it("includes foreign-key-referenced tables so joins survive", async () => {
    const tables = [
      ...MANY.slice(0, 9),
      tbl("orders", {
        foreign_keys: [
          { column: "customer_id", references_table: "public.t4", references_column: "id" },
        ],
      }),
    ];
    generateTextMock.mockResolvedValueOnce({ text: '["orders"]' });
    const out = await selectRelevantTables(tables, "q");
    expect(out.map((t) => t.name).sort()).toEqual(["orders", "t4"]);
  });

  it("falls back to ALL tables when the model returns no usable names", async () => {
    generateTextMock.mockResolvedValueOnce({ text: '["does_not_exist"]' });
    const out = await selectRelevantTables(MANY, "q");
    expect(out).toBe(MANY);
  });

  it("falls back to ALL tables on unparseable output", async () => {
    generateTextMock.mockResolvedValueOnce({ text: "I cannot help with that." });
    const out = await selectRelevantTables(MANY, "q");
    expect(out).toBe(MANY);
  });

  it("falls back to ALL tables when the model call throws", async () => {
    generateTextMock.mockRejectedValueOnce(new Error("boom"));
    const out = await selectRelevantTables(MANY, "q");
    expect(out).toBe(MANY);
  });
});
