import { describe, it, expect } from "vitest";
import { catalog, catalogComponents } from "@/lib/catalog";
import {
  BATCH1_SAMPLES,
  BATCH2_SAMPLES,
  BATCH3_SAMPLES,
  BATCH4_SAMPLES,
} from "./fixtures/catalog-samples";

// Validates that each newly-added chart component is (a) registered in the
// catalog and (b) accepts a representative, LLM-shaped props object against
// its OWN zod schema. We parse the component prop schema directly rather than
// the json-render render-tree validator, whose contract drifts across the
// floating 0.x dependency (which made this suite pass locally but fail in CI).
// One valid sample per component; a negative case guards unregistered names.

const cat = catalog as unknown as { componentNames: string[] };

const components = catalogComponents as unknown as Record<
  string,
  { props: { safeParse: (v: unknown) => { success: boolean } } }
>;

/** True if `type` is a registered component whose zod schema accepts `props`. */
function validateNode(type: string, props: Record<string, unknown>): boolean {
  const def = components[type];
  return !!def && def.props.safeParse(props).success;
}

describe("chart catalog schemas — Batch 1 (capability + analytics)", () => {
  for (const [name, sample] of Object.entries(BATCH1_SAMPLES)) {
    it(`${name} is registered in the catalog`, () => {
      expect(cat.componentNames).toContain(name);
    });

    it(`${name} accepts a representative spec`, () => {
      expect(validateNode(name, sample)).toBe(true);
    });
  }

  it("rejects an unregistered component type", () => {
    expect(validateNode("NotARealChart", {})).toBe(false);
  });
});

describe("chart catalog schemas — Batch 2 (statistics)", () => {
  for (const [name, sample] of Object.entries(BATCH2_SAMPLES)) {
    it(`${name} is registered in the catalog`, () => {
      expect(cat.componentNames).toContain(name);
    });

    it(`${name} accepts a representative spec`, () => {
      expect(validateNode(name, sample)).toBe(true);
    });
  }
});

describe("chart catalog schemas — Batch 3 (data science / ML)", () => {
  for (const [name, sample] of Object.entries(BATCH3_SAMPLES)) {
    it(`${name} is registered in the catalog`, () => {
      expect(cat.componentNames).toContain(name);
    });

    it(`${name} accepts a representative spec`, () => {
      expect(validateNode(name, sample)).toBe(true);
    });
  }
});

describe("chart catalog schemas — Batch 4 (commerce / scientific)", () => {
  for (const [name, sample] of Object.entries(BATCH4_SAMPLES)) {
    it(`${name} is registered in the catalog`, () => {
      expect(cat.componentNames).toContain(name);
    });

    it(`${name} accepts a representative spec`, () => {
      expect(validateNode(name, sample)).toBe(true);
    });
  }
});
