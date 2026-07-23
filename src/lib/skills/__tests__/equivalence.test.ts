import { describe, it, expect } from "vitest";
import { buildGeospatialGuidance } from "@/lib/llm/prompts";
import type { CSVSchema } from "@/lib/types";

/**
 * Byte-for-byte equivalence lock for the geo guidance text.
 *
 * Originally recorded from the PRE-refactor monolithic buildGeospatialGuidance
 * and reproduced exactly by the Phase-1 split. Phase 3 then DELIBERATELY
 * extended the text: planet-scale-superlative ships a helper module, and the
 * registry appends its generated import advertisement — snapshots were updated
 * knowingly for that one change. The lock's job is unchanged: any OTHER diff
 * means the split/registry changed emitted prompt text unintentionally — fix
 * the skill bodies, do NOT regenerate snapshots to make a failure go away.
 */

function schemaWith(cols: string[], extra: Partial<CSVSchema> = {}): CSVSchema {
  return {
    filename: "buildings.parquet",
    row_count: 1000,
    columns: cols.map((name) => ({ name, dtype: "object", sample_values: [] })),
    ...extra,
  } as CSVSchema;
}

describe("geo guidance equivalence (monolith ≡ skills split)", () => {
  it("geometry + bbox + memory cap", () => {
    expect(
      buildGeospatialGuidance(schemaWith(["id", "geometry", "bbox"]), "4.6")
    ).toMatchSnapshot();
  });

  it("geometry without bbox, no memory cap", () => {
    expect(buildGeospatialGuidance(schemaWith(["id", "geometry"]), null)).toMatchSnapshot();
  });

  it("alternate geometry column name (the_geom)", () => {
    expect(buildGeospatialGuidance(schemaWith(["the_geom", "bbox"]), "2.0")).toMatchSnapshot();
  });

  it("no geometry column → empty", () => {
    expect(buildGeospatialGuidance(schemaWith(["id", "name", "value"]), "4.6")).toBe("");
  });

  it("geometry but has_geojson → empty (geojson path has its own guidance)", () => {
    expect(buildGeospatialGuidance(schemaWith(["geometry"], { has_geojson: true }), "4.6")).toBe(
      ""
    );
  });
});
