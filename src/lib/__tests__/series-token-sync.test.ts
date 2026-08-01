import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { THEME_CHART_COLORS } from "@/lib/chart-theme";

/**
 * The --color-series-1..3 CSS tokens in globals.css exist so SSR'd chart
 * previews resolve colors via the cascade (the theme attribute is stamped
 * pre-hydration; a JS-read palette would hydration-mismatch). They MUST stay
 * in sync with THEME_CHART_COLORS — this test is the guard.
 */
describe("series color tokens", () => {
  const css = readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8");

  // Theme blocks in declaration order: :root is vanilla, then one block per
  // named theme. Collect each block's series token values.
  function seriesVarsAfter(anchor: string): string[] {
    const from = css.indexOf(anchor);
    expect(from, `theme anchor ${anchor} present`).toBeGreaterThan(-1);
    const scope = css.slice(from, from + 4000);
    return [1, 2, 3].map((n) => {
      const m = scope.match(new RegExp(`--color-series-${n}:\\s*([^;]+);`));
      expect(m, `--color-series-${n} defined after ${anchor}`).toBeTruthy();
      return m![1].trim().toLowerCase();
    });
  }

  const CASES: [keyof typeof THEME_CHART_COLORS, string][] = [
    // Vanilla's tokens live in the @theme registration block (Tailwind v4
    // emits those as :root vars); the other themes override per data-theme.
    ["vanilla", "@theme {"],
    ["stamen", '[data-theme="stamen"] {'],
    ["iib", '[data-theme="iib"] {'],
    ["pentagram", '[data-theme="pentagram"] {'],
  ];

  for (const [theme, anchor] of CASES) {
    it(`${theme} tokens match THEME_CHART_COLORS`, () => {
      const expected = THEME_CHART_COLORS[theme].slice(0, 3).map((c) => c.toLowerCase());
      expect(seriesVarsAfter(anchor)).toEqual(expected);
    });
  }
});
