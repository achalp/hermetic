import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/warehouse/materialization-scope", () => ({ pickMaterializationScope: vi.fn() }));
vi.mock("@/lib/warehouse/sql-generation", () => ({ generateSQLWithRepair: vi.fn() }));

import { runWarehouseQuery, scanWindowHint } from "@/lib/warehouse/run-query";
import { pickMaterializationScope } from "@/lib/warehouse/materialization-scope";
import { generateSQLWithRepair } from "@/lib/warehouse/sql-generation";

const mockedScope = vi.mocked(pickMaterializationScope);
const mockedRepair = vi.mocked(generateSQLWithRepair);

const TABLES = [{ schema: "default", name: "checks", columns: [], row_count_estimate: 1 }] as never;

beforeEach(() => {
  mockedScope.mockReset();
  mockedRepair.mockReset();
});

describe("scanWindowHint", () => {
  it("returns empty when the scope picker finds no primary table", async () => {
    mockedScope.mockResolvedValue(null);
    const hint = await scanWindowHint({
      question: "q",
      tables: TABLES,
      connector: { getScanSafeWindow: vi.fn() },
      scanRowBudget: 1_000_000,
    });
    expect(hint).toBe("");
  });

  it("returns empty when the connector can't size a window", async () => {
    mockedScope.mockResolvedValue({ table: "checks", dateColumn: "d" });
    const hint = await scanWindowHint({
      question: "q",
      tables: TABLES,
      connector: {}, // no getScanSafeWindow
      scanRowBudget: 1_000_000,
    });
    expect(hint).toBe("");
  });

  it("binds the window to the table it was sized for, naming the column + range", async () => {
    mockedScope.mockResolvedValue({ table: "checks", dateColumn: "d" });
    const getScanSafeWindow = vi.fn().mockResolvedValue({
      column: "_part",
      start: "2023-10-01",
      end: "2023-10-20",
      estimatedRows: 900000,
    });
    const hint = await scanWindowHint({
      question: "q",
      tables: TABLES,
      connector: { getScanSafeWindow },
      scanRowBudget: 1_000_000,
    });
    expect(getScanSafeWindow).toHaveBeenCalledWith("checks", "d", 1_000_000);
    expect(hint).toContain("`checks`");
    expect(hint).toContain("`_part`");
    expect(hint).toContain("2023-10-01");
    expect(hint).toContain("2023-10-20");
  });

  it("never throws — a scope/metadata error yields no hint", async () => {
    mockedScope.mockRejectedValue(new Error("boom"));
    const hint = await scanWindowHint({
      question: "q",
      tables: TABLES,
      connector: { getScanSafeWindow: vi.fn() },
      scanRowBudget: 1_000_000,
    });
    expect(hint).toBe("");
  });
});

describe("runWarehouseQuery", () => {
  it("appends the scan-window hint to the question and returns the executed result", async () => {
    mockedScope.mockResolvedValue({ table: "checks", dateColumn: "d" });
    const getScanSafeWindow = vi
      .fn()
      .mockResolvedValue({ column: "d", start: "2023-10-01", end: "2023-10-20", estimatedRows: 1 });
    const executeSQL = vi.fn().mockResolvedValue("a,b\n1,2\n");
    // Simulate the repair wrapper: run the execute callback once and return.
    mockedRepair.mockImplementation(async ({ question, execute }) => {
      const result = await execute("SELECT 1");
      return { sql: "SELECT 1", result, _q: question } as never;
    });

    const out = await runWarehouseQuery({
      tables: TABLES,
      connector: { executeSQL, getScanSafeWindow } as never,
      warehouseType: "clickhouse",
      question: "Which checks fail most?",
      model: "m",
      scanRowBudget: 1_000_000,
    });

    expect(out.sql).toBe("SELECT 1");
    expect(out.csv).toBe("a,b\n1,2\n");
    expect(executeSQL).toHaveBeenCalled();
    // The question handed to SQL-gen includes both the user question and the bound window.
    const passedQuestion = mockedRepair.mock.calls[0][0].question;
    expect(passedQuestion).toContain("Which checks fail most?");
    expect(passedQuestion).toContain("SCAN BUDGET");
  });

  it("treats an empty result as a failure (so the repair loop can retry)", async () => {
    mockedScope.mockResolvedValue(null);
    const executeSQL = vi.fn().mockResolvedValue("   ");
    mockedRepair.mockImplementation(async ({ execute }) => {
      // The execute callback must throw on empty so generateSQLWithRepair repairs.
      await execute("SELECT 1");
      return { sql: "x", result: "" } as never;
    });
    await expect(
      runWarehouseQuery({
        tables: TABLES,
        connector: { executeSQL } as never,
        warehouseType: "clickhouse",
        question: "q",
        model: "m",
        scanRowBudget: 1_000_000,
      })
    ).rejects.toThrow(/no results/i);
  });
});
