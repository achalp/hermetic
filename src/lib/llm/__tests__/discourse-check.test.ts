import { describe, it, expect } from "vitest";
import { checkDiscourseLine } from "@/lib/llm/discourse-check";

describe("checkDiscourseLine — the relational-claims bug class, one home", () => {
  it("flags backwards time across a sequencing word (run-16 headline bug)", () => {
    const line =
      '{"content": "The series climbed to its peak of 22547092 cases in 2021-04, then contracted to a trough of 24175 cases in 2020-01."}';
    const { line: out, issues } = checkDiscourseLine(line);
    expect(issues.some((i) => i.kind === "temporal_incoherence")).toBe(true);
    expect(out).toContain("2021-04"); // advisory only — prose not rewritten
  });

  it("accepts forward time and quarter tokens", () => {
    const ok = checkDiscourseLine(
      '{"content": "Cases peaked in 2020Q4, then declined through 2021Q2 and beyond, a long arc."}'
    );
    expect(ok.issues).toHaveLength(0);
  });

  it("drops zero-count template sentences (\'0 trailing month(s)\')", () => {
    const line =
      '{"content": "Totals are aggregated monthly across the full range. The latest 0 trailing month(s) with incomplete reporting are excluded from analysis. Peak was April."}';
    const { line: out, issues } = checkDiscourseLine(line);
    expect(issues.some((i) => i.kind === "zero_count_sentence")).toBe(true);
    expect(out).not.toContain("0 trailing");
    expect(out).toContain("Peak was April.");
  });

  it("flags and collapses empty interpolation gaps", () => {
    const line =
      '{"content": "used only calendar months present in both  and  to ensure a like-for-like match across years"}';
    const { line: out, issues } = checkDiscourseLine(line);
    expect(issues.some((i) => i.kind === "empty_interpolation")).toBe(true);
    expect(out).not.toMatch(/\S {2,}\S/);
  });

  it("leaves non-prose and short strings untouched", () => {
    const line = '{"op":"add","path":"/elements/x","value":{"type":"StatCard","value":1234}}';
    expect(checkDiscourseLine(line).line).toBe(line);
  });
});

describe("arithmetic coherence — the multiplier sentence (run-28)", () => {
  it("flags a multiplier no pair of the sentence's numbers produces", () => {
    const { issues } = checkDiscourseLine(
      '{"content": "The 2010s reached 7.64, up from 1.32 in the early window, a multiplier of 7.9 over the period."}'
    );
    expect(issues.some((i) => i.kind === "arithmetic_incoherence")).toBe(true);
  });

  it("accepts a multiplier the sentence's own numbers produce", () => {
    const ok = checkDiscourseLine(
      '{"content": "The late median of 10.43 against the early 1.32 is a multiplier of 7.9 across the corpus."}'
    );
    expect(ok.issues.filter((i) => i.kind === "arithmetic_incoherence")).toHaveLength(0);
  });
});

describe("interpreting insignificance (run-29: flat spread 'indicating' divergence)", () => {
  it("flags interpretive verbs on a visible p > 0.05", () => {
    const { issues } = checkDiscourseLine(
      '{"content": "The spread trend is flat (p = 0.129), indicating that premium offerings and ordinary dishes did not move in lockstep across the corpus."}'
    );
    expect(issues.some((i) => i.kind === "interpreting_insignificance")).toBe(true);
  });

  it("stays quiet on significant results and non-interpretive nulls", () => {
    expect(
      checkDiscourseLine(
        '{"content": "Median price is rising (p = 0.001), indicating sustained growth across the century of data."}'
      ).issues
    ).toHaveLength(0);
    expect(
      checkDiscourseLine(
        '{"content": "The spread trend is flat (p = 0.129); no divergence could be established from this data."}'
      ).issues
    ).toHaveLength(0);
  });
});

describe("count formatting — parenthesized counts rewritten (run-32, third recurrence)", () => {
  it("rewrites ': (8) years' to ': 8 years' and flags once", () => {
    const { line, issues } = checkDiscourseLine(
      '{"content": "Three screens were applied across the corpus data: (8) years where all prices are zero; (3) years where coverage collapsed entirely."}'
    );
    expect(issues.some((i) => i.kind === "count_formatting")).toBe(true);
    expect(line).toContain(": 8 years");
    expect(line).toContain("; 3 years");
    expect(line).not.toContain("(8)");
  });

  it("leaves legitimate parentheticals alone", () => {
    const ok = checkDiscourseLine(
      '{"content": "The median rose steadily over the century of observed data (1851 to 2015 inclusive)."}'
    );
    expect(ok.issues.filter((i) => i.kind === "count_formatting")).toHaveLength(0);
  });
});
