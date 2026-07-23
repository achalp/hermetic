import { describe, it, expect } from "vitest";
import { buildGeospatialGuidance } from "@/lib/llm/prompts";
import type { CSVSchema } from "@/lib/types";

/**
 * Byte-for-byte equivalence lock for the geo-monolith → skills split.
 *
 * These snapshots were recorded from the PRE-refactor monolithic
 * buildGeospatialGuidance. The refactored delegate (three built-in skills
 * concatenated by the registry) must reproduce them exactly — any diff means
 * the split changed emitted prompt text, which is a bug in the split, not a
 * snapshot to update. Do NOT regenerate these snapshots to make a failure go
 * away; fix the skill bodies instead.
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
