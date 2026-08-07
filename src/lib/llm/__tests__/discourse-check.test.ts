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
