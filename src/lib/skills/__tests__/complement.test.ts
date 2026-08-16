/**
 * Complement skills (`extends`) — the learned-lesson vehicle: a user-level
 * `<parent>-learned` skill rides a shipped built-in's activation without
 * touching it (specs/learning-loops-2026-08-05.md opportunity #1).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("@/lib/logger", () => ({
  errMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  setRunIdProvider: vi.fn(),
}));

import { activateSkills } from "@/lib/skills/registry";
import { logger } from "@/lib/logger";
import type { CSVSchema } from "@/lib/contracts/data-schema";

function schemaWith(cols: string[]): CSVSchema {
  return {
    filename: "t.parquet",
    row_count: 10,
    columns: cols.map((name) => ({ name, dtype: "object", sample_values: [] })),
  } as unknown as CSVSchema;
}

const geoSchema = schemaWith(["geometry", "bbox"]);
const plainSchema = schemaWith(["id", "value"]);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "skills-complement-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function writeSkill(name: string, md: string) {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "SKILL.md"), md);
}

const LEARNED = `---
name: geo-overture-learned
description: Learned lessons complementing geo-overture
extends: geo-overture
reviewRules: |
  LEARNED-REGION — flag division_area queries filtering on region.
failureHints:
  - pattern: "division"
    hint: "Drop the region filter."
---
## Guidance
- division_area locality lookups: filter country + subtype + names.primary; do NOT filter region.
`;

describe("complement skills (extends)", () => {
  it("activates with its parent, ordered adjacent, and contributes all surfaces", () => {
    writeSkill("geo-overture-learned", LEARNED);
    const active = activateSkills({ schema: geoSchema }, { userSkillsDir: dir });
    const names = active.skills.map((s) => s.def.name);
    // Adjacent to the parent (order 10 + ε), ahead of order-20 built-ins.
    expect(names.slice(0, 2)).toEqual(["geo-overture", "geo-overture-learned"]);
    const learned = active.skills.find((s) => s.def.name === "geo-overture-learned")!;
    expect(learned.reason).toBe('complements "geo-overture"');
    expect(active.reviewRules.join("\n")).toContain("LEARNED-REGION");
    expect(active.failureHints.some((h) => h.skill === "geo-overture-learned")).toBe(true);
    expect(active.prefixGuidance({ schema: geoSchema })).toContain("do NOT filter region");
  });

  it("does not activate when the parent does not", () => {
    writeSkill("geo-overture-learned", LEARNED);
    const active = activateSkills({ schema: plainSchema }, { userSkillsDir: dir });
    expect(active.skills.map((s) => s.def.name)).not.toContain("geo-overture-learned");
  });

  it("a complement may ALSO activate via its own triggers", () => {
    writeSkill(
      "geo-overture-learned",
      LEARNED.replace(
        "extends: geo-overture",
        'extends: geo-overture\ntriggers:\n  question: ["overture"]'
      )
    );
    const active = activateSkills(
      { schema: plainSchema, question: "use overture data" },
      { userSkillsDir: dir }
    );
    expect(active.skills.map((s) => s.def.name)).toContain("geo-overture-learned");
  });

  it("extends of an unknown skill warns and is ignored", () => {
    writeSkill(
      "orphan-learned",
      LEARNED.replace("name: geo-overture-learned", "name: orphan-learned").replace(
        "extends: geo-overture",
        "extends: no-such-skill"
      )
    );
    const active = activateSkills({ schema: geoSchema }, { userSkillsDir: dir });
    expect(active.skills.map((s) => s.def.name)).not.toContain("orphan-learned");
    expect(logger.warn).toHaveBeenCalledWith(
      "Skill extends an unknown skill — ignored",
      expect.objectContaining({ skill: "orphan-learned" })
    );
  });

  it("a pure complement (no triggers) parses — extends satisfies the trigger requirement", () => {
    writeSkill("geo-overture-learned", LEARNED);
    const active = activateSkills({ schema: geoSchema }, { userSkillsDir: dir });
    expect(active.skills.some((s) => s.def.name === "geo-overture-learned")).toBe(true);
  });
});
