import { describe, it, expect } from "vitest";
import {
  PURPOSE_LIST,
  PURPOSE_MODES,
  DEFAULT_PURPOSE,
  resolvePurpose,
  getPurposePrompt,
  getPurposeMaxSubQuestions,
  getPurposePlanScope,
  stampedPurpose,
} from "@/lib/purpose-prompts";

describe("purpose taxonomy", () => {
  it("exposes exactly the four tightened styles in order", () => {
    expect(PURPOSE_LIST.map((p) => p.id)).toEqual(["dashboard", "brief", "report", "deep-dive"]);
    expect(DEFAULT_PURPOSE).toBe("dashboard");
  });

  it("every mode has a label, a one-line description, and a prompt", () => {
    for (const m of PURPOSE_LIST) {
      expect(m.label).toBeTruthy();
      expect(m.description.length).toBeGreaterThan(0);
      expect(m.prompt.length).toBeGreaterThan(40);
    }
  });

  it("resolves legacy ids to current ones (no broken saved defaults/vizs)", () => {
    expect(resolvePurpose("infographic")).toBe("dashboard");
    expect(resolvePurpose("executive-summary")).toBe("brief");
    expect(resolvePurpose("narrative")).toBe("report");
    expect(resolvePurpose("deep-analysis")).toBe("deep-dive");
    expect(resolvePurpose("presentation")).toBe("dashboard"); // Slides is now an export
  });

  it("falls back to the default for unknown/empty ids", () => {
    expect(resolvePurpose("nonsense")).toBe(DEFAULT_PURPOSE);
    expect(resolvePurpose(undefined)).toBe(DEFAULT_PURPOSE);
    expect(resolvePurpose(null)).toBe(DEFAULT_PURPOSE);
  });

  it("getPurposePrompt returns the resolved mode's prompt", () => {
    expect(getPurposePrompt("infographic")).toBe(PURPOSE_MODES.dashboard.prompt);
    expect(getPurposePrompt("report")).toBe(PURPOSE_MODES.report.prompt);
  });

  it("report mode specifies the Metric | A | B | Δ | Assessment comparison-table convention", () => {
    const p = PURPOSE_MODES.report.prompt;
    expect(p).toMatch(/Assessment/);
    expect(p).toMatch(/delta_columns/);
    expect(p).toMatch(/Δ/);
  });

  it("report mode opens with a provenance metadata header (source, window, scope)", () => {
    const p = PURPOSE_MODES.report.prompt;
    expect(p).toMatch(/METADATA HEADER/);
    expect(p).toMatch(/Source/);
    expect(p).toMatch(/do NOT invent an Author/);
  });

  it("report mode closes with an Appendix (definitions + methodology)", () => {
    const p = PURPOSE_MODES.report.prompt;
    expect(p).toMatch(/APPENDIX/);
    expect(p).toMatch(/Definitions/);
    expect(p).toMatch(/Methodology/);
  });

  it("scopes the sub-question budget to intent (dashboard/brief 3, report 4, deep-dive 5+)", () => {
    expect(getPurposeMaxSubQuestions("dashboard")).toBe(3);
    expect(getPurposeMaxSubQuestions("brief")).toBe(3);
    expect(getPurposeMaxSubQuestions("report")).toBe(4);
    expect(getPurposeMaxSubQuestions("deep-dive")).toBeGreaterThanOrEqual(5);
    // legacy id + unknown both resolve through the same path
    expect(getPurposeMaxSubQuestions("executive-summary")).toBe(3);
    expect(getPurposeMaxSubQuestions("nonsense")).toBe(3); // → dashboard default
  });

  it("every mode's planScope tells the planner a target count and to stay sharp", () => {
    for (const m of PURPOSE_LIST) {
      const scope = getPurposePlanScope(m.id);
      expect(scope.length).toBeGreaterThan(20);
      expect(scope).toMatch(/\d/); // names a number
    }
    // dashboard/brief cap the count; deep-dive opens it up
    expect(getPurposePlanScope("dashboard")).toMatch(/up to 3|at most 3|3/i);
    expect(getPurposePlanScope("deep-dive")).toMatch(/5 or more|or more|wide/i);
  });

  it("prompts steer FORM and explicitly leave chart count to the data", () => {
    // The corrected principle: styles never cap content. Each prompt should
    // hand the count/volume back to the model.
    for (const m of PURPOSE_LIST) {
      expect(m.prompt.toLowerCase()).toMatch(/data|question/);
    }
    expect(PURPOSE_MODES.dashboard.prompt).toMatch(/how many|fixed count/i);
  });

  it("stampedPurpose reads the run's own style from the spec, never fabricates one", () => {
    // The compose pipelines stamp state.__purpose; the header dropdown
    // adopts it on restore. A mislabeled dropdown costs a full re-run to
    // "correct" (its change handler re-runs the question).
    expect(stampedPurpose({ state: { __purpose: "report" } })).toBe("report");
    // Legacy alias in an old record resolves to the canonical id.
    expect(stampedPurpose({ state: { __purpose: "executive-summary" } })).toBe("brief");
    // Records that predate the stamp (or garbage) → null, dropdown untouched.
    expect(stampedPurpose({ state: {} })).toBeNull();
    expect(stampedPurpose({ state: { __purpose: 42 } })).toBeNull();
    expect(stampedPurpose({})).toBeNull();
    expect(stampedPurpose(null)).toBeNull();
    expect(stampedPurpose(undefined)).toBeNull();
    // An unknown-but-string style degrades to the default, not to null —
    // the record SAYS it was run with a style; the closest current id wins.
    expect(stampedPurpose({ state: { __purpose: "nonsense" } })).toBe("dashboard");
  });
});
