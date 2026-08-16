import { describe, it, expect } from "vitest";
import * as lints from "@/lib/findings/lints";

/**
 * Guards the L7 split of the former lints.ts god module into
 * lints/{derivation-language,charts-screens,superlatives-units}.ts: the barrel
 * must keep re-exporting every lint by name, so a future family-file edit that
 * drops or misplaces an export fails here rather than silently removing a lint
 * from the pipeline. SCREEN_LIKE_DTYPES stays internal and must NOT leak.
 */
const EXPECTED = [
  // derivation-language
  "lintDerivations",
  "lintCrossStepDerivations",
  "lintUnitPhrase",
  "lintSentinelInterpolation",
  "lintSignedLanguage",
  "lintTrendContract",
  "lintCheckGating",
  "lintDefinitionContradicted",
  // charts-screens
  "lintChartConsistency",
  "lintResultsProvenance",
  "lintUndeclaredScreen",
  "lintScreenScopeMismatch",
  "lintSeriesConsumption",
  "lintRegimePolicy",
  // superlatives-units
  "lintThinSuperlative",
  "lintDanglingFindingReference",
  "lintMixedUnitGroupSeries",
  "lintSignificanceMismatch",
  "lintShareBasisMismatch",
  "dedupeSurfacedTwins",
  "lintMislabeledAverage",
  "surfaceUndeclaredScreens",
  "surfaceUndeclaredFailedChecks",
] as const;

describe("lints barrel surface (L7 split)", () => {
  it("re-exports every lint as a callable function", () => {
    for (const name of EXPECTED) {
      expect(typeof (lints as Record<string, unknown>)[name], name).toBe("function");
    }
  });

  it("keeps the internal SCREEN_LIKE_DTYPES helper out of the public surface", () => {
    expect((lints as Record<string, unknown>).SCREEN_LIKE_DTYPES).toBeUndefined();
  });
});
