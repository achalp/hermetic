import { describe, it, expect } from "vitest";
import { catalogComponents } from "@/lib/catalog";
import { catalogLayoutTables } from "@/lib/catalog-components/layout-tables";
import { catalogCoreCharts } from "@/lib/catalog-components/core-charts";
import { catalogStatistical } from "@/lib/catalog-components/statistical";
import { catalogControls } from "@/lib/catalog-components/controls";

/**
 * Guards the L7 split of catalog.ts into catalog-components/ family objects
 * merged by spread. A dropped entry, or a duplicate key that silently
 * overwrites across families, both show up as a key-count mismatch here —
 * before the render-smoke/prompt-snapshot suites have to catch it downstream.
 */
describe("catalog component merge (L7 split)", () => {
  it("merges every family with no dropped or duplicated key", () => {
    const families = [catalogLayoutTables, catalogCoreCharts, catalogStatistical, catalogControls];
    const sumOfKeys = families.reduce((n, f) => n + Object.keys(f).length, 0);
    const mergedKeys = Object.keys(catalogComponents).length;
    // If any two families shared a key, the spread would collapse it and the
    // merged count would be less than the sum.
    expect(mergedKeys).toBe(sumOfKeys);
    expect(mergedKeys).toBe(84);
  });

  it("every merged entry carries a zod props schema", () => {
    for (const [name, def] of Object.entries(catalogComponents)) {
      expect((def as { props?: unknown }).props, name).toBeDefined();
    }
  });
});
