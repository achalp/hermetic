import { describe, it, expect, beforeEach } from "vitest";
import {
  tryConsumeAutoInvestigation,
  resetAutoInvestigationBudget,
} from "@/lib/pipeline/auto-investigation-budget";

describe("auto-investigation budget", () => {
  beforeEach(() => resetAutoInvestigationBudget());

  it("allows up to `max` auto-investigations, then refuses", () => {
    const key = "csv-1";
    expect(tryConsumeAutoInvestigation(key, 2)).toBe(true);
    expect(tryConsumeAutoInvestigation(key, 2)).toBe(true);
    expect(tryConsumeAutoInvestigation(key, 2)).toBe(false);
    expect(tryConsumeAutoInvestigation(key, 2)).toBe(false);
  });

  it("tracks budgets independently per data source", () => {
    expect(tryConsumeAutoInvestigation("a", 1)).toBe(true);
    expect(tryConsumeAutoInvestigation("a", 1)).toBe(false);
    expect(tryConsumeAutoInvestigation("b", 1)).toBe(true);
  });

  it("resets after the TTL window elapses", () => {
    const key = "csv-ttl";
    const t0 = 1_000_000;
    expect(tryConsumeAutoInvestigation(key, 1, t0)).toBe(true);
    expect(tryConsumeAutoInvestigation(key, 1, t0 + 1000)).toBe(false);
    // 31 minutes later → fresh window
    expect(tryConsumeAutoInvestigation(key, 1, t0 + 31 * 60 * 1000)).toBe(true);
  });
});
