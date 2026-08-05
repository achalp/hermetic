import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory fs/promises mock keyed by full path.
const files = new Map<string, string>();
vi.mock("fs/promises", () => ({
  mkdir: async () => undefined,
  writeFile: async (p: string, c: string) => {
    files.set(p, c);
  },
  appendFile: async (p: string, c: string) => {
    files.set(p, (files.get(p) ?? "") + c);
  },
  readFile: async (p: string) => {
    if (!files.has(p)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return files.get(p)!;
  },
  readdir: async () => [...files.keys()].map((p) => p.split("/").pop()!),
  unlink: async (p: string) => {
    if (!files.delete(p)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  },
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

  it("does not drop rows on concurrent appends (the old read-modify-rewrite loss)", async () => {
    // Regression: concurrent finishes (Ask + Investigate + compose-cell)
    // raced on read→rewrite and silently lost rows.
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => appendCostRow(row({ question: `q${i}` })))
    );
    const rows = await listCostRows();
    expect(rows.map((r) => r.question).sort()).toEqual(
      Array.from({ length: 8 }, (_, i) => `q${i}`).sort()
    );
  });

  it("prunes day files past the retention window on write, keeps the rest", async () => {
    const day = 24 * 60 * 60 * 1000;
    const dateOf = (msAgo: number) => new Date(Date.now() - msAgo).toISOString().slice(0, 10);
    const oldDate = dateOf(120 * day); // beyond the 90-day retention
    const freshDate = dateOf(0);

    // Learn the module's real dir from a fresh append, then seed an
    // out-of-retention day file directly (appending to it would race with the
    // append's own fire-and-forget prune).
    await appendCostRow(row({ date: freshDate, question: "current" }));
    const freshPath = [...files.keys()].find((p) => p.endsWith(`${freshDate}.csv`))!;
    const oldPath = freshPath.replace(freshDate, oldDate);
    files.set(oldPath, "timestamp\n2020-01-01T00:00:00.000Z\n");

    await appendCostRow(row({ date: freshDate, question: "another" }));
    // Prune is fire-and-forget after the append resolves — wait for it.
    await vi.waitFor(() => expect(files.has(oldPath)).toBe(false));
    expect(files.has(freshPath)).toBe(true);
  });

  it("migrates a day file with a stale header (pre-run_id) once, then appends", async () => {
    // Simulate an old-format file: no run_id column.
    files.set(
      "/dev/null-cost/2026-06-19.csv", // path shape doesn't matter to the mock…
      ""
    );
    files.clear();
    const oldCsv =
      "timestamp,date,dataset,question,mode,models,llm_calls,input_tokens,cache_read_tokens,cache_write_tokens,output_tokens,cost_usd,phase_breakdown\r\n" +
      "2026-06-19T08:00:00.000Z,2026-06-19,old.csv,legacy question,ask,m,1,10,0,0,5,0.000100,\r\n";
    const dayPath = [...files.keys()][0];
    void dayPath;
    // Seed under the real path the module will use.
    await appendCostRow(row({ question: "seed" })); // creates the file, learn its path
    const realPath = [...files.keys()][0];
    files.set(realPath, oldCsv);

    await appendCostRow(row({ question: "post-migration" }));
    const rows = await listCostRows();
    const questions = rows.map((r) => r.question).sort();
    expect(questions).toEqual(["legacy question", "post-migration"]);
    // Both rows readable under the new header set (run_id column present).
    expect(files.get(realPath)!.split("\n")[0]).toContain("run_id");
  });
});
