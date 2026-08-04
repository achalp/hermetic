import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WarehouseTableSchema } from "@/lib/contracts/warehouse-schema";

const generateTextMock = vi.fn();
vi.mock("ai", () => ({ generateText: (...a: unknown[]) => generateTextMock(...a) }));
vi.mock("@/lib/llm/client", () => ({
  getModel: () => ({}),
  cachedSystem: (s: string) => s,
}));

import { pickMaterializationScope } from "@/lib/warehouse/materialization-scope";

const TABLES = [
  {
    schema: "default",
    name: "checks",
    columns: [
      { name: "check_name", type: "String", nullable: true },
      { name: "check_start_time", type: "DateTime", nullable: true },
    ],
    row_count_estimate: 1_000_000_000,
  },
] as unknown as WarehouseTableSchema[];

beforeEach(() => generateTextMock.mockReset());

describe("pickMaterializationScope", () => {
  it("returns the validated table + time column", async () => {
    generateTextMock.mockResolvedValueOnce({
      text: '{"table":"default.checks","dateColumn":"check_start_time"}',
    });
    const scope = await pickMaterializationScope("q", TABLES);
    expect(scope).toEqual({ table: "checks", dateColumn: "check_start_time" });
  });

  it("rejects a hallucinated table/column (not in schema)", async () => {
    generateTextMock.mockResolvedValueOnce({
      text: '{"table":"default.nope","dateColumn":"whenever"}',
    });
    expect(await pickMaterializationScope("q", TABLES)).toBeNull();
  });

  it("returns null when the model declines (needs a join)", async () => {
    generateTextMock.mockResolvedValueOnce({ text: '{"table":null}' });
    expect(await pickMaterializationScope("q", TABLES)).toBeNull();
  });

  it("returns null on a model error (best-effort)", async () => {
    generateTextMock.mockRejectedValueOnce(new Error("boom"));
    expect(await pickMaterializationScope("q", TABLES)).toBeNull();
  });
});
