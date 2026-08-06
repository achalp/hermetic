import { describe, it, expect } from "vitest";
import { parseSkillMd, SkillParseError } from "@/lib/skills/skill-md";
import type { CSVSchema } from "@/lib/contracts/data-schema";

const schema = {
  filename: "sales.csv",
  row_count: 5,
  columns: [{ name: "signup_date", dtype: "object", sample_values: [] }],
} as unknown as CSVSchema;

const VALID = `---
name: cohort-retention
description: Cohort analyses pivot period-over-period
order: 42
triggers:
  columns: ["^signup_date$"]
  question: ["retention"]
requires: ["geo-overture"]
reviewGate: true
reviewRules: |
  COHORT-PIVOT — flag when retention is computed row-wise in Python.
failureHints:
  - pattern: "pivot"
    hint: "Aggregate the cohort matrix in DuckDB."
---
## Guidance
Cap is {{sandboxMemoryGb}} GB for {{filename}}.
`;

describe("parseSkillMd", () => {
  it("parses a fully-populated skill", () => {
    const s = parseSkillMd(VALID, "/x/SKILL.md");
    expect(s.name).toBe("cohort-retention");
    expect(s.order).toBe(42);
    expect(s.origin).toBe("user");
    expect(s.sourcePath).toBe("/x/SKILL.md");
    expect(s.triggers.columns).toEqual(["^signup_date$"]);
    expect(s.requires).toEqual(["geo-overture"]);
    expect(s.reviewGate).toBe(true);
    expect(s.reviewRules).toContain("COHORT-PIVOT");
    expect(s.failureHints).toEqual([
      { pattern: "pivot", hint: "Aggregate the cohort matrix in DuckDB." },
    ]);
  });

  it("renders placeholders and prefixes a titled section", () => {
    const s = parseSkillMd(VALID, "/x/SKILL.md");
    const text = s.buildGuidance({ schema, sandboxMemoryGb: "4.6" });
    expect(text).toContain("## Skill: cohort-retention");
    expect(text).toContain("Cap is 4.6 GB for sales.csv.");
    expect(s.buildGuidance({ schema, sandboxMemoryGb: null })).toContain("Cap is unknown GB");
  });

  it("falls back to the whole body when there is no ## Guidance heading", () => {
    const s = parseSkillMd(
      `---\nname: x\ndescription: d\ntriggers:\n  always: true\n---\nJust text.`,
      "/x/SKILL.md"
    );
    expect(s.buildGuidance({ schema })).toContain("Just text.");
  });

  it("applies defaults: order 1000, no review gate", () => {
    const s = parseSkillMd(
      `---\nname: x\ndescription: d\ntriggers:\n  always: true\n---\nBody.`,
      "/x/SKILL.md"
    );
    expect(s.order).toBe(1000);
    expect(s.reviewGate).toBe(false);
  });

  const rejects: [string, string, string][] = [
    ["missing frontmatter", `no frontmatter here`, "missing YAML frontmatter"],
    [
      "invalid yaml",
      `---\nname: [unclosed\ndescription: d\n---\nBody.`,
      "invalid YAML frontmatter",
    ],
    [
      "non-kebab name",
      `---\nname: Bad Name\ndescription: d\ntriggers:\n  always: true\n---\nBody.`,
      "kebab-case",
    ],
    [
      "no triggers declared",
      `---\nname: x\ndescription: d\ntriggers: {}\n---\nBody.`,
      "declare triggers",
    ],
    [
      "invalid column regex",
      `---\nname: x\ndescription: d\ntriggers:\n  columns: ["([bad"]\n---\nBody.`,
      "invalid regex",
    ],
    [
      "invalid failure-hint regex",
      `---\nname: x\ndescription: d\ntriggers:\n  always: true\nfailureHints:\n  - pattern: "([bad"\n    hint: "h"\n---\nBody.`,
      "invalid regex",
    ],
    ["empty body", `---\nname: x\ndescription: d\ntriggers:\n  always: true\n---\n`, "no guidance"],
  ];
  it.each(rejects)("rejects %s with a readable reason", (_label, text, fragment) => {
    expect(() => parseSkillMd(text, "/x/SKILL.md")).toThrowError(SkillParseError);
    expect(() => parseSkillMd(text, "/x/SKILL.md")).toThrowError(new RegExp(fragment, "i"));
  });
});
