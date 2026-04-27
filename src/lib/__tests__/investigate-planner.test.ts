import { describe, it, expect } from "vitest";
import { parsePlannerOutput, __testing } from "@/lib/llm/investigate-planner";

const { extractJsonObject } = __testing;

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
  it("accepts a well-formed plan with 3 sub-questions", () => {
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
    expect(result.plan.subQuestions[2].depends_on).toBe(1);
    expect(result.plan.approach).toContain("Decompose");
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

  it("normalizes invalid depends_on values to null", () => {
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
      expect(sq.depends_on).toBeNull();
    }
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
