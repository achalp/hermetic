import { describe, it, expect } from "vitest";
import { resolveSpecPlaceholders } from "@/lib/llm/resolve-placeholders";

// Lever 2: the composer sometimes references a chart_data key the analysis code
// produced under a slightly different name. We repair confident, unique near-
// misses against produced keys, but never guess between unrelated candidates
// (a wrong bind is worse than a blank chart).
describe("resolveSpecPlaceholders — chartData key repair", () => {
  it("repairs a confident near-miss (singular/plural drift) to the produced key", () => {
    const out = resolveSpecPlaceholders(
      '{"data": "$chartData:tower_markers"}',
      {},
      { tower_marker: [{ x: 1 }] }
    );
    expect(out).toBe('{"data": [{"x":1}]}');
  });

  it("leaves a genuinely hallucinated key as null (no wrong bind)", () => {
    const out = resolveSpecPlaceholders(
      '{"data": "$chartData:top_30_badge_heavy_low_contrib"}',
      {},
      { dumbbell_badge_vs_contributions: [{ a: 1 }], tier_bar: [{ b: 2 }] }
    );
    expect(out).toBe('{"data": null}');
  });

  it("does not bind when two candidates are equally plausible (ambiguous)", () => {
    const out = resolveSpecPlaceholders(
      '{"data": "$chartData:revenue"}',
      {},
      { revenue_by_region: [{ a: 1 }], revenue_by_product: [{ b: 2 }] }
    );
    expect(out).toBe('{"data": null}');
  });

  it("still resolves an exact key directly", () => {
    const out = resolveSpecPlaceholders('{"data": "$chartData:sales"}', {}, { sales: [{ n: 5 }] });
    expect(out).toBe('{"data": [{"n":5}]}');
  });
});
