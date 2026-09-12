/**
 * Runtime-aware skill guidance: under wasm delivery the geo skill appends the
 * alias-idiom override (run 9ee0e56b: Docker glob idioms killed the run); the
 * DEFAULT render stays BYTE-IDENTICAL — which is what keeps the equivalence
 * snapshot and the golden transcripts (docker-only) untouched.
 */
import { describe, it, expect } from "vitest";
import { activateSkills } from "@/lib/skills/registry";
import type { CSVSchema } from "@/lib/contracts/data-schema";

const GEO_SCHEMA = {
  filename: "buildings.parquet",
  row_count: 100,
  columns: [{ name: "geometry", dtype: "object", sample_values: [] }],
  sample_rows: [],
} as unknown as CSVSchema;

describe("runtime-aware geo guidance", () => {
  it("wasm render carries the alias override; docker/default does not", () => {
    const skills = activateSkills({ schema: GEO_SCHEMA }, { builtinOnly: true });
    const wasm = skills.prefixGuidance({ schema: GEO_SCHEMA, runtime: "wasm" });
    expect(wasm).toContain("WASM DELIVERY OVERRIDE");
    expect(wasm).toContain("alias-list expression");
    expect(wasm).toContain("do NOT construct a path by swapping theme=");

    const dockerDefault = skills.prefixGuidance({ schema: GEO_SCHEMA });
    expect(dockerDefault).not.toContain("WASM DELIVERY OVERRIDE");
  });

  it("the default render is BYTE-IDENTICAL with runtime absent or 'docker' (golden/snapshot safety)", () => {
    const skills = activateSkills({ schema: GEO_SCHEMA }, { builtinOnly: true });
    const absent = skills.prefixGuidance({ schema: GEO_SCHEMA });
    const docker = skills.prefixGuidance({ schema: GEO_SCHEMA, runtime: "docker" });
    expect(docker).toBe(absent);
    // The wasm render only APPENDS — everything the default teaches survives.
    const wasm = skills.prefixGuidance({ schema: GEO_SCHEMA, runtime: "wasm" });
    expect(wasm.startsWith(absent.slice(0, 200))).toBe(true);
    expect(wasm).toContain("NAMED REGION = POLYGON");
  });
});
