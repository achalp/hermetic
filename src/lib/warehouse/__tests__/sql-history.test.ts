import { describe, it, expect } from "vitest";
import { buildSQLHistorySection } from "@/lib/warehouse/sql-generation";
import type { ConversationTurn } from "@/lib/contracts/storage-types";

function turn(question: string, sql?: string): ConversationTurn {
  return {
    question,
    analysisSummary: { resultKeys: {}, chartDataShapes: {} },
    specSummary: "",
    ...(sql ? { sql } : {}),
  };
}

describe("buildSQLHistorySection", () => {
  it("returns empty for no turns", () => {
    expect(buildSQLHistorySection(undefined)).toBe("");
    expect(buildSQLHistorySection([])).toBe("");
  });

  it("includes each prior question and its SQL in a fenced block", () => {
    const section = buildSQLHistorySection([
      turn(
        "Revenue in Q2, excluding cancelled orders?",
        "SELECT SUM(revenue) FROM orders WHERE status != 'cancelled'"
      ),
    ]);
    expect(section).toContain('Turn 1: "Revenue in Q2, excluding cancelled orders?"');
    expect(section).toContain("```sql");
    expect(section).toContain("status != 'cancelled'");
  });

  it("still includes the question when a turn has no SQL", () => {
    const section = buildSQLHistorySection([turn("what changed?")]);
    expect(section).toContain('Turn 1: "what changed?"');
    expect(section).not.toContain("```sql");
  });

  it("instructs preserving the most recent turn's filters and window", () => {
    const section = buildSQLHistorySection([turn("q", "SELECT 1")]);
    expect(section).toContain("MOST RECENT turn's SQL as the baseline population");
    expect(section).toContain("PRESERVE its filters, joins, and time window");
  });

  it("truncates oversized prior SQL instead of flooding the prompt", () => {
    const huge = "SELECT " + "x".repeat(10_000);
    const section = buildSQLHistorySection([turn("big", huge)]);
    expect(section).toContain("…truncated…");
    expect(section.length).toBeLessThan(6_000);
  });

  it("numbers multiple turns in order", () => {
    const section = buildSQLHistorySection([turn("first", "SELECT 1"), turn("second", "SELECT 2")]);
    expect(section.indexOf('Turn 1: "first"')).toBeGreaterThan(-1);
    expect(section.indexOf('Turn 2: "second"')).toBeGreaterThan(section.indexOf('Turn 1: "first"'));
  });
});
