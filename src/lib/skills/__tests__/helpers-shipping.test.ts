import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  setRunIdProvider: vi.fn(),
}));

import { activateSkills } from "@/lib/skills/registry";
import { planetScaleSuperlative } from "@/lib/skills/builtin/planet-scale-superlative";
import { resetUserSkillCacheForTests } from "@/lib/skills/user-skills";
import type { CSVSchema } from "@/lib/contracts/data-schema";

function schemaWith(cols: string[]): CSVSchema {
  return {
    filename: "t.parquet",
    row_count: 10,
    columns: cols.map((name) => ({ name, dtype: "object", sample_values: [] })),
  } as unknown as CSVSchema;
}

let dir: string;
beforeEach(() => {
  resetUserSkillCacheForTests();
  vi.clearAllMocks();
  dir = mkdtempSync(path.join(tmpdir(), "hermetic-helpers-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("built-in planet-scale helper", () => {
  it("ships as skill_lib/planet_scale.py when the geo skills activate", () => {
    const active = activateSkills(
      { schema: schemaWith(["geometry", "bbox"]) },
      { builtinOnly: true }
    );
    expect(active.helperFiles.map((f) => f.path)).toEqual(["/data/skill_lib/planet_scale.py"]);
    expect(active.helperFiles[0].content).toContain("def occ_aware_ub");
  });

  it("advertises the module + extracted signatures inside the guidance", () => {
    const schema = schemaWith(["geometry", "bbox"]);
    const active = activateSkills({ schema }, { builtinOnly: true });
    const guidance = active.prefixGuidance({ schema, sandboxMemoryGb: "4.6" });
    expect(guidance).toContain("from skill_lib.planet_scale import");
    expect(guidance).toContain("occ_aware_ub(occ, k, s)");
    expect(guidance).toContain("scalar_nn_sql(");
  });

  it("ships nothing when no skill with helpers is active", () => {
    const active = activateSkills({ schema: schemaWith(["id"]) }, { builtinOnly: true });
    expect(active.helperFiles).toEqual([]);
  });

  const hasPython = (() => {
    try {
      execFileSync("python3", ["--version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!hasPython)("the helper module is valid python with correct math", () => {
    const helper = planetScaleSuperlative.helpers![0].content;
    const file = path.join(dir, "planet_scale.py");
    writeFileSync(file, helper);
    const check = `
import sys; sys.path.insert(0, ${JSON.stringify(dir)})
import math
from planet_scale import occ_aware_ub, chebyshev_k, scalar_nn_sql
# occ-aware UB: a multi-occupant cell is bounded by its own diagonal...
assert abs(occ_aware_ub(5, 10, 1000) - 1000 * math.sqrt(2)) < 1e-9
# ...only a lone building may use the ring bound.
assert abs(occ_aware_ub(1, 2, 1000) - 3000 * math.sqrt(2)) < 1e-9
assert chebyshev_k(0, 0, [(0, 0), (3, 4)]) == 4
assert chebyshev_k(0, 0, [(0, 0)]) is None
sql = scalar_nn_sql(-120.5, 45.25, 0.5, source="data")
assert "min(ST_Distance_Sphere" in sql and "BETWEEN -121.0 AND -120.0" in sql
assert "NOT (abs(" in sql  # excludes the candidate itself
print("OK")
`;
    const out = execFileSync("python3", ["-c", check], { encoding: "utf8" });
    expect(out.trim()).toBe("OK");
  });
});

describe("user skill helpers.py", () => {
  function writeSkill(withHelpers: boolean): void {
    const skillDir = path.join(dir, "cohort-retention");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      path.join(skillDir, "SKILL.md"),
      `---\nname: cohort-retention\ndescription: d\ntriggers:\n  always: true\n---\nBody.`
    );
    if (withHelpers) {
      writeFileSync(
        path.join(skillDir, "helpers.py"),
        `def retention_matrix(source="data"):\n    """Cohort retention pivot computed in DuckDB."""\n    pass\n`
      );
    }
  }

  it("ships a sibling helpers.py as skill_lib.<name_with_underscores> and advertises it", () => {
    writeSkill(true);
    const schema = schemaWith(["id"]);
    const active = activateSkills({ schema }, { userSkillsDir: dir });
    expect(active.helperFiles.map((f) => f.path)).toEqual(["/data/skill_lib/cohort_retention.py"]);
    const guidance = active.prefixGuidance({ schema });
    expect(guidance).toContain("from skill_lib.cohort_retention import");
    expect(guidance).toContain('retention_matrix(source="data") — Cohort retention pivot');
  });

  it("re-parses when only helpers.py changes (combined mtime cache key)", () => {
    writeSkill(false);
    let active = activateSkills({ schema: schemaWith(["id"]) }, { userSkillsDir: dir });
    expect(active.helperFiles).toEqual([]);
    writeSkill(true); // add helpers.py after the first cached load
    active = activateSkills({ schema: schemaWith(["id"]) }, { userSkillsDir: dir });
    expect(active.helperFiles).toHaveLength(1);
  });
});
