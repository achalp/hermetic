import { describe, it, expect } from "vitest";
import {
  parsePlannerOutput,
  MAX_DEPENDS_PER_SUBQUESTION,
  __testing,
} from "@/lib/llm/investigate-planner";

const { extractJsonObject, normalizeDependsOn, parseReplannerOutput, buildPlannerUserPrompt } =
  __testing;

describe("buildPlannerUserPrompt — scoped follow-up (drill-as-sub-investigation)", () => {
  it("omits the scope block and asks for 3-5 sub-questions when unscoped", () => {
    const p = buildPlannerUserPrompt("What drives revenue?", null, undefined);
    expect(p).not.toContain("Prior Investigation Context");
    expect(p).toContain("3-5 sub-questions");
  });

  it("injects prior approach + already-explored steps and asks for 2-4 when scoped", () => {
    const p = buildPlannerUserPrompt("Why did it spike in March?", null, undefined, {
      parent_question: "What drives revenue?",
      prior_approach: "Break revenue down by region and month",
      prior_steps: ["Revenue by region", "Revenue by month"],
    });
    expect(p).toContain("Prior Investigation Context");
    expect(p).toContain("What drives revenue?");
    expect(p).toContain("Break revenue down by region and month");
    expect(p).toContain("Revenue by region");
    expect(p).toContain("do NOT repeat");
    expect(p).toContain("2-4 sub-questions");
  });

  it("emits a hard segment-scope instruction when drill filters are present", () => {
    const p = buildPlannerUserPrompt('Analyze the "West" segment', null, undefined, {
      parent_question: "Top regions?",
      filters: [
        { column: "region", value: "West" },
        { column: "tier", value: "Enterprise" },
      ],
      segment_label: "West / Enterprise",
    });
    expect(p).toContain("SCOPE every sub-question to this segment");
    expect(p).toContain("region = West AND tier = Enterprise");
    expect(p).toContain("within this segment");
  });
});

describe("normalizeDependsOn", () => {
  it("returns [] for null/undefined/strings/booleans", () => {
    expect(normalizeDependsOn(null, 2)).toEqual([]);
    expect(normalizeDependsOn(undefined, 2)).toEqual([]);
    expect(normalizeDependsOn("1", 2)).toEqual([]);
    expect(normalizeDependsOn(true, 2)).toEqual([]);
  });

  it("wraps a valid scalar number in an array (legacy form)", () => {
    expect(normalizeDependsOn(0, 1)).toEqual([0]);
    expect(normalizeDependsOn(1, 2)).toEqual([1]);
  });

  it("returns [] for out-of-range scalar numbers", () => {
    expect(normalizeDependsOn(-1, 2)).toEqual([]);
    expect(normalizeDependsOn(2, 2)).toEqual([]); // == self
    expect(normalizeDependsOn(5, 2)).toEqual([]); // > self
    expect(normalizeDependsOn(1.5, 2)).toEqual([]); // non-integer
  });

  it("filters arrays to valid integer entries < selfIndex", () => {
    expect(normalizeDependsOn([0, 1, 3, -1, "x", 2.5], 3)).toEqual([0, 1]);
  });

  it("de-duplicates array entries, preserving first occurrence order", () => {
    expect(normalizeDependsOn([1, 0, 1, 0], 2)).toEqual([1, 0]);
  });

  it("caps array entries at MAX_DEPENDS_PER_SUBQUESTION", () => {
    expect(normalizeDependsOn([0, 1, 2, 3], 4)).toHaveLength(MAX_DEPENDS_PER_SUBQUESTION);
  });
});

describe("extractJsonObject", () => {
  it("returns the object as-is when input is plain JSON", () => {
    const raw = '{"approach":"x","subQuestions":[]}';
    expect(extractJsonObject(raw)).toBe(raw);
  });

  it("strips ```json ... ``` markdown fences", () => {
    const raw = '```json\n{"approach":"x","subQuestions":[]}\n```';
    expect(extractJsonObject(raw)).toBe('{"approach":"x","subQuestions":[]}');
  });

  it("strips bare ``` fences", () => {
    const raw = '```\n{"a":1}\n```';
    expect(extractJsonObject(raw)).toBe('{"a":1}');
  });

  it("strips text before/after the JSON object", () => {
    const raw = 'Here is the plan:\n{"approach":"x","subQuestions":[]}\nThanks!';
    expect(extractJsonObject(raw)).toBe('{"approach":"x","subQuestions":[]}');
  });
});

describe("parsePlannerOutput", () => {
  it("accepts a well-formed plan with 3 sub-questions (legacy scalar deps)", () => {
    const raw = JSON.stringify({
      approach: "Decompose by time and segment.",
      subQuestions: [
        { question: "Trend over time?", rationale: "establish baseline", depends_on: null },
        { question: "By region?", rationale: "find segments", depends_on: null },
        { question: "Drill into top region", rationale: "understand drivers", depends_on: 1 },
      ],
    });
    const result = parsePlannerOutput(raw);
    if (!result.ok) throw new Error(`expected ok; got error: ${result.error}`);
    expect(result.plan.subQuestions).toHaveLength(3);
    expect(result.plan.subQuestions[0].depends_on).toEqual([]);
    expect(result.plan.subQuestions[1].depends_on).toEqual([]);
    expect(result.plan.subQuestions[2].depends_on).toEqual([1]);
    expect(result.plan.approach).toContain("Decompose");
  });

  it("accepts the new array form of depends_on", () => {
    const raw = JSON.stringify({
      approach: "Compare top and bottom regions.",
      subQuestions: [
        { question: "Find top region", rationale: "", depends_on: [] },
        { question: "Find bottom region", rationale: "", depends_on: [] },
        { question: "Compare them on growth", rationale: "", depends_on: [0, 1] },
      ],
    });
    const result = parsePlannerOutput(raw);
    if (!result.ok) throw new Error(`expected ok; got error: ${result.error}`);
    expect(result.plan.subQuestions[2].depends_on).toEqual([0, 1]);
  });

  it("rejects plans with fewer than 2 usable sub-questions", () => {
    const raw = JSON.stringify({
      approach: "x",
      subQuestions: [{ question: "only one", rationale: "", depends_on: null }],
    });
    const result = parsePlannerOutput(raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/usable sub-questions/);
  });

  it("drops sub-questions with too-short text", () => {
    const raw = JSON.stringify({
      approach: "x",
      subQuestions: [
        { question: "Q1?", rationale: "", depends_on: null }, // 3 chars: dropped (<5)
        { question: "Long enough question one?", rationale: "", depends_on: null },
        { question: "Long enough question two?", rationale: "", depends_on: null },
      ],
    });
    const result = parsePlannerOutput(raw);
    if (!result.ok) throw new Error("expected ok");
    expect(result.plan.subQuestions).toHaveLength(2);
  });

  it("normalizes invalid depends_on values to []", () => {
    const raw = JSON.stringify({
      approach: "",
      subQuestions: [
        { question: "First question with text", rationale: "", depends_on: 5 }, // 5 >= self idx 0
        { question: "Second question with text", rationale: "", depends_on: -1 }, // negative
        { question: "Third question with text", rationale: "", depends_on: "1" }, // wrong type
      ],
    });
    const result = parsePlannerOutput(raw);
    if (!result.ok) throw new Error("expected ok");
    for (const sq of result.plan.subQuestions) {
      expect(sq.depends_on).toEqual([]);
    }
  });

  it("strips forward and out-of-range entries from depends_on arrays", () => {
    const raw = JSON.stringify({
      approach: "",
      subQuestions: [
        { question: "First question text", rationale: "", depends_on: [] },
        { question: "Second question text", rationale: "", depends_on: [0, 3, -1, "x"] }, // 3 is forward, -1 invalid, "x" wrong type
        { question: "Third question text", rationale: "", depends_on: [1, 1, 0] }, // dupe 1, valid 0
      ],
    });
    const result = parsePlannerOutput(raw);
    if (!result.ok) throw new Error("expected ok");
    expect(result.plan.subQuestions[0].depends_on).toEqual([]);
    expect(result.plan.subQuestions[1].depends_on).toEqual([0]);
    expect(result.plan.subQuestions[2].depends_on).toEqual([1, 0]); // dedup preserves first
  });

  it("caps depends_on arrays at MAX_DEPENDS_PER_SUBQUESTION", () => {
    const raw = JSON.stringify({
      approach: "",
      subQuestions: [
        { question: "Q0 with enough chars", rationale: "", depends_on: [] },
        { question: "Q1 with enough chars", rationale: "", depends_on: [] },
        { question: "Q2 with enough chars", rationale: "", depends_on: [] },
        { question: "Q3 with enough chars", rationale: "", depends_on: [] },
        { question: "Q4 with enough chars", rationale: "", depends_on: [0, 1, 2, 3] },
      ],
    });
    const result = parsePlannerOutput(raw);
    if (!result.ok) throw new Error("expected ok");
    expect(result.plan.subQuestions[4].depends_on).toHaveLength(MAX_DEPENDS_PER_SUBQUESTION);
  });

  it("hard-caps at 7 sub-questions", () => {
    const raw = JSON.stringify({
      approach: "",
      subQuestions: Array.from({ length: 12 }, (_, i) => ({
        question: `Question number ${i} with enough text`,
        rationale: "",
        depends_on: null,
      })),
    });
    const result = parsePlannerOutput(raw);
    if (!result.ok) throw new Error("expected ok");
    expect(result.plan.subQuestions).toHaveLength(7);
  });

  it("handles markdown-fenced output", () => {
    const inner = JSON.stringify({
      approach: "ok",
      subQuestions: [
        { question: "Question one is here", rationale: "", depends_on: null },
        { question: "Question two is here", rationale: "", depends_on: null },
      ],
    });
    const raw = "Here is the plan:\n```json\n" + inner + "\n```";
    const result = parsePlannerOutput(raw);
    expect(result.ok).toBe(true);
  });

  it("returns ParseError on invalid JSON", () => {
    const result = parsePlannerOutput("not json {{{ broken");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/not valid JSON/);
  });

  it("returns ParseError on missing subQuestions", () => {
    const result = parsePlannerOutput('{"approach":"x"}');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/missing subQuestions/);
  });
});

describe("parseReplannerOutput", () => {
  it("accepts a continue decision", () => {
    const raw = JSON.stringify({
      action: "continue",
      rationale: "Plan on track.",
      addSubQuestions: [],
      removeSubQuestionIndices: [],
    });
    const r = parseReplannerOutput(raw, 3);
    if (!r.ok) throw new Error(r.error);
    expect(r.decision.action).toBe("continue");
    expect(r.decision.addSubQuestions).toHaveLength(0);
    expect(r.decision.removeSubQuestionIndices).toHaveLength(0);
  });

  it("accepts a stop decision", () => {
    const raw = JSON.stringify({
      action: "stop",
      rationale: "Findings clear.",
      addSubQuestions: [],
      removeSubQuestionIndices: [],
    });
    const r = parseReplannerOutput(raw, 4);
    if (!r.ok) throw new Error(r.error);
    expect(r.decision.action).toBe("stop");
  });

  it("accepts an amend decision with new sub-questions", () => {
    // currentPlanLength = 3 → new sub-questions start at index 3.
    // First new (index 3) can depend on [0, 1, 2]; second new (index 4)
    // can depend on [0, 1, 2, 3].
    const raw = JSON.stringify({
      action: "amend",
      rationale: "Drill into top region.",
      addSubQuestions: [
        {
          question: "Drill into top region",
          rationale: "explore further",
          depends_on: [0, 1],
        },
        {
          question: "Compare with the drill-down result",
          rationale: "tie back",
          depends_on: [3],
        },
      ],
      removeSubQuestionIndices: [2],
    });
    const r = parseReplannerOutput(raw, 3);
    if (!r.ok) throw new Error(r.error);
    expect(r.decision.action).toBe("amend");
    expect(r.decision.addSubQuestions).toHaveLength(2);
    expect(r.decision.addSubQuestions[0].depends_on).toEqual([0, 1]);
    expect(r.decision.addSubQuestions[1].depends_on).toEqual([3]);
    expect(r.decision.removeSubQuestionIndices).toEqual([2]);
  });

  it("strips forward depends_on in newly added sub-questions", () => {
    // currentPlanLength = 2, position 0 → selfIndex = 2.
    // depends_on: [5] is forward → dropped to [].
    const raw = JSON.stringify({
      action: "amend",
      rationale: "",
      addSubQuestions: [{ question: "New sub-question", rationale: "", depends_on: [5] }],
      removeSubQuestionIndices: [],
    });
    const r = parseReplannerOutput(raw, 2);
    if (!r.ok) throw new Error(r.error);
    expect(r.decision.addSubQuestions[0].depends_on).toEqual([]);
  });

  it("caps added sub-questions at 3", () => {
    const raw = JSON.stringify({
      action: "amend",
      rationale: "",
      addSubQuestions: Array.from({ length: 8 }, (_, k) => ({
        question: `New question ${k} with enough chars`,
        rationale: "",
        depends_on: [],
      })),
      removeSubQuestionIndices: [],
    });
    const r = parseReplannerOutput(raw, 1);
    if (!r.ok) throw new Error(r.error);
    expect(r.decision.addSubQuestions).toHaveLength(3);
  });

  it("filters out-of-range remove indices and dedupes", () => {
    const raw = JSON.stringify({
      action: "amend",
      rationale: "",
      addSubQuestions: [],
      removeSubQuestionIndices: [0, 0, 1, 5, -1, "x"],
    });
    const r = parseReplannerOutput(raw, 3);
    if (!r.ok) throw new Error(r.error);
    expect(r.decision.removeSubQuestionIndices).toEqual([0, 1]);
  });

  it("rejects malformed JSON", () => {
    const r = parseReplannerOutput("not json {{{", 3);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/not valid JSON/);
  });

  it("rejects an invalid action value", () => {
    const raw = JSON.stringify({
      action: "explode",
      rationale: "",
      addSubQuestions: [],
      removeSubQuestionIndices: [],
    });
    const r = parseReplannerOutput(raw, 3);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/Invalid action/);
  });

  it("handles markdown-fenced output", () => {
    const inner = JSON.stringify({
      action: "continue",
      rationale: "Looking good.",
      addSubQuestions: [],
      removeSubQuestionIndices: [],
    });
    const raw = "Here is my decision:\n```json\n" + inner + "\n```";
    const r = parseReplannerOutput(raw, 3);
    expect(r.ok).toBe(true);
  });

  it("drops new sub-questions with too-short text", () => {
    const raw = JSON.stringify({
      action: "amend",
      rationale: "",
      addSubQuestions: [
        { question: "Hi?", rationale: "", depends_on: [] }, // 3 chars → drop
        { question: "Long enough question text", rationale: "", depends_on: [] },
      ],
      removeSubQuestionIndices: [],
    });
    const r = parseReplannerOutput(raw, 2);
    if (!r.ok) throw new Error(r.error);
    expect(r.decision.addSubQuestions).toHaveLength(1);
  });
});
