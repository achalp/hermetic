/**
 * The agreed per-purpose limits (2026 principle: rigor is FLAT, succinctness is
 * the differentiator, breadth scales only for cost/latency, presentation caps
 * are guardrails not definitions). This pins the numbers so a drift is caught.
 */
import { describe, it, expect } from "vitest";
import { PURPOSE_MODES } from "@/lib/purpose-prompts";
import { PLAN_BUDGETS } from "@/lib/compose/plan";
import { maxTilesFor } from "@/lib/findings/headline-plan";

describe("per-purpose limits", () => {
  it("breadth (maxSubQuestions) scales by cost/latency; brief is tightest at 2", () => {
    expect(PURPOSE_MODES.brief.maxSubQuestions).toBe(2);
    expect(PURPOSE_MODES.dashboard.maxSubQuestions).toBe(3);
    expect(PURPOSE_MODES.report.maxSubQuestions).toBe(4);
    expect(PURPOSE_MODES["deep-dive"].maxSubQuestions).toBe(10);
  });

  it("narration (maxNodes) is the succinctness lever — unchanged progression", () => {
    expect(PLAN_BUDGETS.brief.maxNodes).toBe(7);
    expect(PLAN_BUDGETS.dashboard.maxNodes).toBe(12);
    expect(PLAN_BUDGETS.report.maxNodes).toBe(22);
    expect(PLAN_BUDGETS["deep-dive"].maxNodes).toBe(28);
  });

  it("view caps are relaxed guardrails (charts are cheap; don't hide analysis)", () => {
    expect(PLAN_BUDGETS.brief.maxViews).toBe(3);
    expect(PLAN_BUDGETS.dashboard.maxViews).toBe(6);
    expect(PLAN_BUDGETS.report.maxViews).toBe(10);
    expect(PLAN_BUDGETS["deep-dive"].maxViews).toBe(16);
  });

  it("headline tiles are purpose-scaled presentation (brief leads with prose, not 5 cards)", () => {
    expect(maxTilesFor("brief")).toBe(3);
    expect(maxTilesFor("dashboard")).toBe(5);
    expect(maxTilesFor("report")).toBe(4);
    expect(maxTilesFor("deep-dive")).toBe(5);
    expect(maxTilesFor(undefined)).toBe(5); // default
    expect(maxTilesFor("executive-summary")).toBe(3); // legacy → brief
  });

  it("the code-gen scope no longer gates chart COUNT (presentation ≠ analysis)", () => {
    expect(PURPOSE_MODES.brief.codegenScope).not.toContain("AT MOST ONE");
    expect(PURPOSE_MODES.dashboard.codegenScope).not.toContain("2-4 chart_data");
    // but the rigor floor clause is still referenced in every purpose
    for (const id of ["brief", "dashboard", "report", "deep-dive"]) {
      expect(PURPOSE_MODES[id].codegenScope).toContain("Computed Findings battery");
    }
  });
});
