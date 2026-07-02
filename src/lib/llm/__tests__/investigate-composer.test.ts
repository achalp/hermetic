import { describe, it, expect } from "vitest";
import { __testing, buildComposerSystemPrompt } from "@/lib/llm/investigate-composer";

const { parseGapCheckOutput } = __testing;

describe("buildComposerSystemPrompt — report vs step structure", () => {
  it("uses semantic sections and drops (Step N) citations in report mode", () => {
    const p = buildComposerSystemPrompt("report");
    expect(p).toMatch(/SEMANTIC sections/);
    expect(p).toMatch(/does not cite internal analysis steps/i);
    expect(p).not.toMatch(/Section per successful step/);
    expect(p).not.toMatch(/ending with its citation "\(Step N\)"/);
  });

  it("keeps the step-driven backbone + (Step N) citations for non-report modes", () => {
    const p = buildComposerSystemPrompt("dashboard");
    expect(p).toMatch(/Section per successful step/);
    expect(p).toMatch(/MUST cite the step it came from, written as "\(Step N\)"/);
    expect(p).not.toMatch(/SEMANTIC sections/);
  });

  it("preserves $result number grounding in BOTH modes", () => {
    for (const mode of ["report", "dashboard"]) {
      const p = buildComposerSystemPrompt(mode);
      expect(p).toMatch(/Every number MUST be a \$result placeholder/);
    }
  });
});

describe("parseGapCheckOutput", () => {
  it("returns empty needs for the happy path of {needs: [], rationale: '...'}", () => {
    const raw = JSON.stringify({ needs: [], rationale: "all sufficient" });
    const r = parseGapCheckOutput(raw, 3);
    expect(r.needs).toEqual([]);
    expect(r.rationale).toBe("all sufficient");
  });

  it("returns up to 2 valid sub-questions", () => {
    const raw = JSON.stringify({
      needs: [
        { question: "Need denominator", rationale: "for rate", depends_on: [0] },
        { question: "Need confirmation lag", rationale: "for trust", depends_on: [1] },
        // 3rd would push past cap; should be dropped
        { question: "Yet another item", rationale: "", depends_on: [] },
      ],
      rationale: "missing two pieces",
    });
    const r = parseGapCheckOutput(raw, 2);
    expect(r.needs).toHaveLength(2);
    expect(r.needs[0].question).toBe("Need denominator");
    expect(r.needs[0].depends_on).toEqual([0]);
  });

  it("filters out-of-range depends_on indices in new sub-questions", () => {
    const raw = JSON.stringify({
      needs: [
        { question: "New follow-up here", rationale: "", depends_on: [5, -1, 0] }, // existingStepCount = 2 → 5 out, -1 out
      ],
      rationale: "",
    });
    const r = parseGapCheckOutput(raw, 2);
    expect(r.needs[0].depends_on).toEqual([0]);
  });

  it("accepts a legacy scalar depends_on number", () => {
    const raw = JSON.stringify({
      needs: [{ question: "New follow-up here", rationale: "", depends_on: 1 }],
      rationale: "",
    });
    const r = parseGapCheckOutput(raw, 2);
    expect(r.needs[0].depends_on).toEqual([1]);
  });

  it("drops new sub-questions with too-short text", () => {
    const raw = JSON.stringify({
      needs: [
        { question: "x", rationale: "", depends_on: [] }, // 1 char
        { question: "Long enough question text", rationale: "", depends_on: [] },
      ],
      rationale: "",
    });
    const r = parseGapCheckOutput(raw, 1);
    expect(r.needs).toHaveLength(1);
  });

  it("returns safe fallback on invalid JSON", () => {
    const r = parseGapCheckOutput("not json {{{", 2);
    expect(r.needs).toEqual([]);
    expect(r.rationale).toMatch(/not valid JSON|composing as-is/);
  });

  it("returns safe fallback on missing needs", () => {
    const r = parseGapCheckOutput(JSON.stringify({ rationale: "x" }), 2);
    expect(r.needs).toEqual([]);
  });

  it("handles markdown-fenced output", () => {
    const inner = JSON.stringify({ needs: [], rationale: "good" });
    const raw = "```json\n" + inner + "\n```";
    const r = parseGapCheckOutput(raw, 2);
    expect(r.rationale).toBe("good");
  });

  it("dedupes and caps depends_on at 3", () => {
    const raw = JSON.stringify({
      needs: [{ question: "New follow-up here", rationale: "", depends_on: [0, 0, 1, 2, 3] }],
      rationale: "",
    });
    const r = parseGapCheckOutput(raw, 5);
    expect(r.needs[0].depends_on).toEqual([0, 1, 2]); // de-dup + cap
  });
});
