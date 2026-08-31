import { describe, it, expect } from "vitest";
import {
  buildEntityIndex,
  buildSelectionPrompt,
  parseSelection,
  SELECT_DEFAULT_K,
  SELECT_HARD_CAP,
} from "@/lib/manifest/select";
import type { ManifestRecord } from "@/lib/manifest/store";

/**
 * The entity-selection pre-step (spec §7; review: K=4/cap 6, code-gen tier).
 * The core claim under test: selection needs NO schemas — the index is built
 * from manifest metadata alone, so pending entities are as selectable as ready
 * ones, and only the chosen few get introspected afterward.
 */

function record(): ManifestRecord {
  const entities = new Map();
  const add = (name: string, description: string, rowCountHint?: number, rowCount?: number) =>
    entities.set(name, {
      entity: { name, url: `https://h/data/${name}.parquet`, description, rowCountHint },
      status: rowCount !== undefined ? "ready" : "pending",
      ...(rowCount !== undefined ? { rowCount } : {}),
    });
  add("housing-gap", "Renter housing gap by AMI band (years covered: 2010–2024)", 950_120);
  add("housing-landscape", "Occupied units by AMI band", undefined, 762_840);
  add("homelessness-landscape", "PIT counts by geography", 120_000);
  add("geographies", "Geography lookup: FIPS to names", 3_293);
  add("coverage", "Data coverage flags per geography-year", 40_000);
  return {
    manifestId: "m1",
    manifest: { manifestUrl: "https://h/data/manifest.json", format: "files-array", entities: [] },
    excluded: [],
    entities,
    manifestHash: "h",
    connectedAt: 0,
  };
}

describe("buildEntityIndex — selection without schemas", () => {
  it("carries name, size, and the publisher's description for EVERY entity", () => {
    const index = buildEntityIndex(record());
    // Pending entities are fully selectable: their line comes from the manifest.
    expect(index).toContain("- housing-gap (~950,120 rows): Renter housing gap");
    // Ready entities show EXACT rows (no ~).
    expect(index).toContain("- housing-landscape (762,840 rows)");
    // Year spans folded into descriptions reach the model — that is often the
    // deciding signal for time-scoped questions.
    expect(index).toContain("2010–2024");
    expect(index.split("\n")).toHaveLength(5);
  });

  it("prompt asks for the FEWEST sufficient entities and a strict JSON reply", () => {
    const prompt = buildSelectionPrompt(record(), "what is the renter housing gap?");
    expect(prompt).toContain("FEWEST that suffice");
    expect(prompt).toContain('{"entities":');
    expect(prompt).toContain("what is the renter housing gap?");
  });
});

describe("parseSelection", () => {
  const q = "what is the renter housing gap for king county?";

  it("accepts a clean pick and validates names against the catalog", () => {
    const { entities, usedFallback } = parseSelection(
      '{"entities": ["housing-gap", "geographies", "not-a-real-entity"]}',
      record(),
      q
    );
    expect(entities).toEqual(["housing-gap", "geographies"]);
    expect(usedFallback).toBe(false);
  });

  it("tolerates prose around the JSON (models narrate)", () => {
    const { entities } = parseSelection(
      'Looking at the catalog, you need:\n{"entities": ["housing-gap"]}\nThat suffices.',
      record(),
      q
    );
    expect(entities).toEqual(["housing-gap"]);
  });

  it("an entity NAMED in the question is always included, whatever the model said", () => {
    const { entities } = parseSelection(
      '{"entities": ["housing-gap"]}',
      record(),
      "join housing-gap with coverage to check completeness"
    );
    expect(entities).toContain("coverage");
  });

  it("caps at SELECT_HARD_CAP even when the model picks everything", () => {
    const rec = record();
    for (let i = 0; i < 10; i++)
      rec.entities.set(`extra-${i}`, {
        entity: { name: `extra-${i}`, url: `https://h/e${i}.parquet` },
        status: "pending",
      });
    const all = JSON.stringify({ entities: [...rec.entities.keys()] });
    const { entities } = parseSelection(all, rec, q);
    expect(entities.length).toBeLessThanOrEqual(SELECT_HARD_CAP);
  });

  it("falls back to keyword overlap on an unusable reply — never zero entities", () => {
    const { entities, usedFallback } = parseSelection("I cannot help with that.", record(), q);
    expect(usedFallback).toBe(true);
    expect(entities.length).toBeGreaterThan(0);
    expect(entities.length).toBeLessThanOrEqual(SELECT_DEFAULT_K);
    // "housing" + "gap" overlap → the gap entity leads the fallback.
    expect(entities[0]).toBe("housing-gap");
  });

  it("zero keyword overlap still yields the largest entity as the least-wrong pick", () => {
    const { entities, usedFallback } = parseSelection("", record(), "zzz qqq xxyy");
    expect(usedFallback).toBe(true);
    expect(entities).toEqual(["housing-gap"]); // largest by row hint
  });
});
