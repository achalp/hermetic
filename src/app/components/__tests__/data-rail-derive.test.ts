/**
 * Source labels: a connected manifest labels the SOURCE as the catalog —
 * per-question table selection means the previewed entity's filename implied
 * a scope that never existed (the incoherence found in the manifest UX
 * review, 2026-09-11).
 */
import { describe, it, expect } from "vitest";
import { buildDatasetLabel, buildSourceLabel } from "../data-rail-derive";
import type { CSVSchema } from "@/lib/contracts/data-schema";

const SCHEMA = {
  csv_id: "c1",
  filename: "place.parquet",
  row_count: 100,
  columns: [{ name: "x", dtype: "number", sample_values: [] }],
  sample_rows: [],
} as unknown as CSVSchema;
const NO_WH = { isConnected: false, warehouseType: null, tableCount: 0, totalColumns: 0 } as never;

describe("manifest-aware source labels", () => {
  it("a manifest labels the CATALOG, never the previewed entity's filename", () => {
    const label = buildDatasetLabel(SCHEMA, NO_WH, { title: "Housing hub", entityCount: 15 });
    expect(label).toBe("Housing hub · ask across 15 tables");
    expect(label).not.toContain("place.parquet");
    expect(buildSourceLabel(SCHEMA, NO_WH, { title: "Housing hub", entityCount: 15 })).toBe(
      "✓ Housing hub · 15 tables"
    );
  });

  it("without a manifest the existing labels are unchanged", () => {
    expect(buildDatasetLabel(SCHEMA, NO_WH)).toBe("place.parquet");
    expect(buildSourceLabel(SCHEMA, NO_WH)).toContain("place.parquet");
    expect(buildDatasetLabel(SCHEMA, NO_WH, null)).toBe("place.parquet");
  });

  it("an untitled manifest gets the generic catalog name", () => {
    expect(buildDatasetLabel(null, NO_WH, { entityCount: 3 })).toBe(
      "Dataset catalog · ask across 3 tables"
    );
  });
});
