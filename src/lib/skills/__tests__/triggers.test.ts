import { describe, it, expect } from "vitest";
import { evaluateSkill, hasBareGeometryColumn } from "@/lib/skills/triggers";
import type { SkillDefinition } from "@/lib/skills/types";
import type { CSVSchema } from "@/lib/contracts/data-schema";

function schemaWith(cols: string[], extra: Partial<CSVSchema> = {}): CSVSchema {
  return {
    filename: "t.csv",
    row_count: 10,
    columns: cols.map((name) => ({ name, dtype: "object", sample_values: [] })),
    ...extra,
  } as CSVSchema;
}

function skill(triggers: SkillDefinition["triggers"]): SkillDefinition {
  return {
    name: "t",
    description: "t",
    order: 1,
    origin: "builtin",
    triggers,
    buildGuidance: () => "g",
  };
}

describe("evaluateSkill", () => {
  it("matches a column regex and names the matching column in the reason", () => {
    const match = evaluateSkill(skill({ columns: ["^geo", "^bbox$"] }), {
      schema: schemaWith(["id", "bbox"]),
    });
    expect(match).toEqual({ reason: 'column "bbox" matched /^bbox$/i', viaQuestion: false });
  });

  it("matches question keywords case-insensitively and marks viaQuestion", () => {
    const match = evaluateSkill(skill({ question: ["Most Isolated"] }), {
      schema: schemaWith(["id"]),
      question: "which building is the MOST isolated?",
    });
    expect(match?.viaQuestion).toBe(true);
    expect(match?.reason).toContain("Most Isolated");
  });

  it("schema-based matches take precedence over question matches (cache-prefix-safe)", () => {
    const match = evaluateSkill(skill({ columns: ["^bbox$"], question: ["isolated"] }), {
      schema: schemaWith(["bbox"]),
      question: "most isolated",
    });
    expect(match?.viaQuestion).toBe(false);
  });

  it("matches on source kind, defaulting an unset source_type to 'file'", () => {
    expect(
      evaluateSkill(skill({ sources: ["warehouse"] }), {
        schema: schemaWith(["id"], { source_type: "warehouse" }),
      })?.reason
    ).toContain("warehouse");
    expect(
      evaluateSkill(skill({ sources: ["file"] }), { schema: schemaWith(["id"]) })?.viaQuestion
    ).toBe(false);
    expect(
      evaluateSkill(skill({ sources: ["warehouse"] }), { schema: schemaWith(["id"]) })
    ).toBeNull();
  });

  it("always + when fire with their label", () => {
    expect(evaluateSkill(skill({ always: true, label: "L" }), { schema: schemaWith([]) })).toEqual({
      reason: "L",
      viaQuestion: false,
    });
    expect(
      evaluateSkill(skill({ when: (ctx) => ctx.schema.row_count > 5, label: "big" }), {
        schema: schemaWith(["id"]),
      })?.reason
    ).toBe("big");
  });

  it("returns null when nothing matches (and without a question for question triggers)", () => {
    expect(
      evaluateSkill(skill({ columns: ["^nope$"] }), { schema: schemaWith(["id"]) })
    ).toBeNull();
    expect(
      evaluateSkill(skill({ question: ["isolated"] }), { schema: schemaWith(["id"]) })
    ).toBeNull();
  });

  it("skips an invalid column regex instead of throwing", () => {
    expect(
      evaluateSkill(skill({ columns: ["([bad"] }), { schema: schemaWith(["([bad"]) })
    ).toBeNull();
  });
});

describe("hasBareGeometryColumn", () => {
  it("requires a geometry-named column and no GeoJSON sidecar", () => {
    expect(hasBareGeometryColumn({ schema: schemaWith(["geometry"]) })).toBe(true);
    expect(hasBareGeometryColumn({ schema: schemaWith(["the_geom"]) })).toBe(true);
    expect(hasBareGeometryColumn({ schema: schemaWith(["id"]) })).toBe(false);
    expect(hasBareGeometryColumn({ schema: schemaWith(["geometry"], { has_geojson: true }) })).toBe(
      false
    );
  });
});
