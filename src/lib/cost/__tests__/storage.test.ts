import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory fs/promises mock keyed by full path.
const files = new Map<string, string>();
vi.mock("fs/promises", () => ({
  mkdir: async () => undefined,
  writeFile: async (p: string, c: string) => {
    files.set(p, c);
  },
  readFile: async (p: string) => {
    if (!files.has(p)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return files.get(p)!;
  },
  readdir: async () => [...files.keys()].map((p) => p.split("/").pop()!),
}));

import { appendCostRow, listCostRows } from "@/lib/cost/storage";

function row(overrides: Partial<Parameters<typeof appendCostRow>[0]> = {}) {
  return {
    timestamp: "2026-06-19T10:00:00.000Z",
    date: "2026-06-19",
    dataset: "sales.csv",
    question: "What drives revenue?",
    mode: "investigate",
    models: "claude-sonnet-4-6",
    llm_calls: 12,
    input_tokens: 45000,
    cache_read_tokens: 30000,
    cache_write_tokens: 5000,
    output_tokens: 8000,
    cost_usd: 0.1234,
    ...overrides,
  };
}

beforeEach(() => files.clear());

describe("cost storage round-trip", () => {
  it("appends a row and reads it back", async () => {
    await appendCostRow(row());
    const rows = await listCostRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].dataset).toBe("sales.csv");
    expect(rows[0].question).toBe("What drives revenue?");
    expect(rows[0].cost_usd).toBe("0.123400");
    expect(rows[0].llm_calls).toBe("12");
  });

  it("appends multiple rows to the same day file", async () => {
    await appendCostRow(row({ question: "q1" }));
    await appendCostRow(row({ question: "q2" }));
    const rows = await listCostRows();
    expect(rows.map((r) => r.question).sort()).toEqual(["q1", "q2"]);
    // One day file, not two.
    expect([...files.keys()].filter((p) => p.endsWith("2026-06-19.csv"))).toHaveLength(1);
  });

  it("quotes a question containing commas and quotes", async () => {
    await appendCostRow(row({ question: 'Compare "A", "B", and C' }));
    const rows = await listCostRows();
    expect(rows[0].question).toBe('Compare "A", "B", and C');
  });

  it("concatenates rows across day files, newest analysis first", async () => {
    await appendCostRow(
      row({ date: "2026-06-18", timestamp: "2026-06-18T09:00:00.000Z", question: "old" })
    );
    await appendCostRow(
      row({ date: "2026-06-19", timestamp: "2026-06-19T09:00:00.000Z", question: "new" })
    );
    const rows = await listCostRows();
    expect(rows.map((r) => r.question)).toEqual(["new", "old"]);
  });

  it("returns [] when the cost dir is empty/missing", async () => {
    expect(await listCostRows()).toEqual([]);
  });
});
