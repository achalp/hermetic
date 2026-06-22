import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WarehouseTableSchema } from "@/lib/types";

// Mock the LLM layer: generateText returns the next queued SQL string.
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

import { generateSQLWithRepair } from "@/lib/warehouse/sql-generation";

const TABLES: WarehouseTableSchema[] = [
  {
    name: "posts",
    schema: "public",
    columns: [{ name: "id", type: "int", nullable: false }],
    row_count_estimate: 100,
  } as WarehouseTableSchema,
];

function queueSQL(...sqls: string[]) {
  generateTextMock.mockReset();
  for (const sql of sqls) generateTextMock.mockResolvedValueOnce({ text: sql });
}

describe("generateSQLWithRepair", () => {
  beforeEach(() => generateTextMock.mockReset());

  it("strips a readonly-forbidden ClickHouse SETTINGS clause (read-limit knobs)", async () => {
    queueSQL("SELECT * FROM t LIMIT 10 SETTINGS max_rows_to_read=50000000000");
    const execute = vi.fn().mockResolvedValue("col\n1");
    const out = await generateSQLWithRepair({
      tables: TABLES,
      question: "q",
      warehouseType: "clickhouse",
      execute,
    });
    expect(out.sql).toBe("SELECT * FROM t LIMIT 10");
    expect(out.sql).not.toMatch(/SETTINGS/i);
  });

  it("keeps a SETTINGS clause that doesn't touch read limits", async () => {
    queueSQL("SELECT * FROM t SETTINGS join_use_nulls = 1");
    const execute = vi.fn().mockResolvedValue("col\n1");
    const out = await generateSQLWithRepair({
      tables: TABLES,
      question: "q",
      warehouseType: "clickhouse",
      execute,
    });
    expect(out.sql).toContain("SETTINGS join_use_nulls = 1");
  });

  it("returns immediately when the first query executes", async () => {
    queueSQL("SELECT 1");
    const execute = vi.fn().mockResolvedValue("col\n1");
    const out = await generateSQLWithRepair({
      tables: TABLES,
      question: "q",
      warehouseType: "postgresql",
      execute,
    });
    expect(out.sql).toBe("SELECT 1");
    expect(out.result).toBe("col\n1");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(generateTextMock).toHaveBeenCalledTimes(1); // no repair
  });

  it("repairs once when the first query fails, then succeeds", async () => {
    queueSQL("SELECT bad", "SELECT good");
    const execute = vi
      .fn()
      .mockRejectedValueOnce(new Error("column bad is neither grouped nor aggregated"))
      .mockResolvedValueOnce("col\n1");
    const phases: string[] = [];
    const out = await generateSQLWithRepair({
      tables: TABLES,
      question: "q",
      warehouseType: "bigquery",
      execute,
      onAttempt: (_a, phase) => phases.push(phase),
    });
    expect(out.sql).toBe("SELECT good");
    expect(execute).toHaveBeenCalledTimes(2);
    // 1 initial generate + 1 repair
    expect(generateTextMock).toHaveBeenCalledTimes(2);
    expect(phases).toContain("repairing");
    // The repair carries the engine error + failed SQL in the uncached tail
    // (after the cached schema block), so it reuses the warm [system][schema]
    // cache from generation instead of re-sending the schema.
    const repairCall = generateTextMock.mock.calls[1][0] as {
      messages: { content: { text?: string }[] }[];
    };
    const tail = repairCall.messages[0].content.map((c) => c.text ?? "").join("");
    expect(tail).toContain("neither grouped nor aggregated");
    expect(tail).toContain("SELECT bad");
  });

  it("repair reuses generation's [system][schema] cache prefix verbatim", async () => {
    queueSQL("SELECT bad", "SELECT good");
    const execute = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce("ok");
    await generateSQLWithRepair({
      tables: TABLES,
      question: "q",
      warehouseType: "bigquery",
      execute,
    });

    type Call = {
      system: string;
      messages: { content: { type: string; text?: string }[] }[];
    };
    const gen = generateTextMock.mock.calls[0][0] as Call;
    const repair = generateTextMock.mock.calls[1][0] as Call;
    // Same system prompt and same (first) cached schema block → the API matches
    // the prefix and the repair READS the warm cache instead of re-sending it.
    expect(repair.system).toBe(gen.system);
    expect(repair.messages[0].content[0]).toEqual(gen.messages[0].content[0]);
  });

  it("throws the last error after exhausting repairs", async () => {
    queueSQL("q0", "q1", "q2"); // initial + 2 repairs
    const execute = vi.fn().mockRejectedValue(new Error("syntax error"));
    await expect(
      generateSQLWithRepair({
        tables: TABLES,
        question: "q",
        warehouseType: "postgresql",
        execute,
        maxRepairs: 2,
      })
    ).rejects.toThrow("syntax error");
    expect(execute).toHaveBeenCalledTimes(3); // initial + 2 repairs
  });

  it("treats an empty result as a failure the repair loop can recover from", async () => {
    queueSQL("SELECT empty", "SELECT full");
    const execute = vi
      .fn()
      .mockImplementationOnce(async () => {
        throw new Error("no rows");
      })
      .mockResolvedValueOnce("col\n1");
    const out = await generateSQLWithRepair({
      tables: TABLES,
      question: "q",
      warehouseType: "postgresql",
      execute,
    });
    expect(out.sql).toBe("SELECT full");
  });
});
