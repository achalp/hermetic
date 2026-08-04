import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  setRunIdProvider: vi.fn(),
}));

import { loadUserSkills, resetUserSkillCacheForTests } from "@/lib/skills/user-skills";
import { activateSkills } from "@/lib/skills/registry";
import { logger } from "@/lib/logger";
import type { CSVSchema } from "@/lib/contracts/data-schema";

const VALID = `---
name: warehouse-costing
description: warehouse questions must consider scan cost
triggers:
  question: ["cost"]
---
## Guidance
Estimate scanned bytes first.
`;

let dir: string;
beforeEach(() => {
  resetUserSkillCacheForTests();
  vi.clearAllMocks();
  dir = mkdtempSync(path.join(tmpdir(), "hermetic-skills-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function writeSkill(name: string, content: string): string {
  const skillDir = path.join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  const file = path.join(skillDir, "SKILL.md");
  writeFileSync(file, content);
  return file;
}

function plainSchema(): CSVSchema {
  return {
    filename: "t.csv",
    row_count: 1,
    columns: [{ name: "id", dtype: "int64", sample_values: [] }],
  } as unknown as CSVSchema;
}

describe("loadUserSkills", () => {
  it("returns empty for a missing directory", () => {
    expect(loadUserSkills(path.join(dir, "absent"))).toEqual({ skills: [], errors: [] });
  });

  it("loads valid skills and logs them by name", () => {
    writeSkill("warehouse-costing", VALID);
    const { skills, errors } = loadUserSkills(dir);
    expect(skills.map((s) => s.name)).toEqual(["warehouse-costing"]);
    expect(errors).toEqual([]);
    expect(logger.info).toHaveBeenCalledWith(
      "User skill loaded",
      expect.objectContaining({ skill: "warehouse-costing" })
    );
  });

  it("skips an invalid skill, reports it, and warns ONCE per file version", () => {
    const file = writeSkill("broken", "not a skill");
    const first = loadUserSkills(dir);
    expect(first.skills).toEqual([]);
    expect(first.errors).toEqual([
      { path: file, reason: expect.stringContaining("missing YAML frontmatter") },
    ]);
    loadUserSkills(dir); // cached → no second warn
    expect(logger.warn).toHaveBeenCalledTimes(1);
    // The error stays visible on every load (the settings page reads it).
    expect(loadUserSkills(dir).errors).toHaveLength(1);
  });

  it("re-parses when the file's mtime changes", () => {
    const file = writeSkill("warehouse-costing", VALID);
    expect(loadUserSkills(dir).skills[0].description).toContain("scan cost");
    writeFileSync(file, VALID.replace("scan cost", "byte budgets"));
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    expect(loadUserSkills(dir).skills[0].description).toContain("byte budgets");
  });

  it("ignores a skill directory without a SKILL.md", () => {
    mkdirSync(path.join(dir, "empty-dir"));
    expect(loadUserSkills(dir)).toEqual({ skills: [], errors: [] });
  });
});

describe("activateSkills with user skills", () => {
  it("activates a question-triggered user skill into the question tail", () => {
    writeSkill("warehouse-costing", VALID);
    const active = activateSkills(
      { schema: plainSchema(), question: "what does this cost per month?" },
      { userSkillsDir: dir }
    );
    expect(active.skills.map((s) => s.def.name)).toEqual(["warehouse-costing"]);
    expect(active.skills[0].viaQuestion).toBe(true);
    const ctx = { schema: plainSchema() };
    expect(active.prefixGuidance(ctx)).toBe("");
    expect(active.questionGuidance(ctx)).toContain("Estimate scanned bytes first.");
  });

  it("closes over requires: a question-triggered user skill pulls in built-ins it requires", () => {
    writeSkill(
      "geo-costing",
      `---\nname: geo-costing\ndescription: d\ntriggers:\n  question: ["acreage"]\nrequires: ["geo-overture"]\n---\nBody.`
    );
    const active = activateSkills(
      { schema: plainSchema(), question: "total acreage?" },
      { userSkillsDir: dir }
    );
    const byName = Object.fromEntries(active.skills.map((s) => [s.def.name, s]));
    expect(byName["geo-costing"]).toBeDefined();
    expect(byName["geo-overture"].reason).toBe('required by "geo-costing"');
    expect(byName["geo-overture"].viaQuestion).toBe(true); // inherits placement
    // Requiring a review-gated built-in turns the gate on.
    expect(active.reviewGated).toBe(true);
  });

  it("rejects a user skill that shadows a built-in, with a warn", () => {
    writeSkill(
      "geo-overture",
      `---\nname: geo-overture\ndescription: d\ntriggers:\n  always: true\n---\nBody.`
    );
    const active = activateSkills({ schema: plainSchema() }, { userSkillsDir: dir });
    expect(active.skills.map((s) => s.def.name)).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      "User skill shadows a built-in — ignored",
      expect.objectContaining({ skill: "geo-overture" })
    );
  });

  it("aggregates user reviewRules and failureHints tagged with the skill name", () => {
    writeSkill(
      "hinted",
      `---\nname: hinted\ndescription: d\ntriggers:\n  always: true\nreviewRules: |\n  MY-RULE — flag it.\nfailureHints:\n  - pattern: "pivot"\n    hint: "Do it in DuckDB."\n---\nBody.`
    );
    const active = activateSkills({ schema: plainSchema() }, { userSkillsDir: dir });
    expect(active.reviewRules).toEqual(["MY-RULE — flag it."]);
    expect(active.failureHints).toEqual([
      { pattern: "pivot", hint: "Do it in DuckDB.", skill: "hinted" },
    ]);
  });
});
