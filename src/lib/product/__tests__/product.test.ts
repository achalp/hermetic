import { describe, it, expect } from "vitest";
import {
  parseProduct,
  productRolesIndex,
  ownedValueKeys,
  buildSeriesCatalogLines,
  buildValueCatalogLines,
} from "@/lib/product";
import type { SeriesEntry } from "@/lib/contracts/product";
import {
  lintScreenScopeMismatch,
  lintSeriesConsumption,
  lintUndeclaredScreen,
  lintThinSuperlative,
  lintWellAttestedScreened,
  lintUnscreenedSuperlative,
} from "@/lib/findings/lints";
import type { FindingEntry } from "@/lib/contracts/findings";

const SERIES: SeriesEntry = {
  id: "annual_prices",
  rows: [
    { yr: 1900, price: 10, price_clean: 10, n: 100 },
    { yr: 1901, price: 3000, price_clean: null, n: 4 },
    { yr: 1902, price: 12, price_clean: 12, n: 110 },
    { yr: 1903, price: 13, price_clean: 13, n: 120 },
    { yr: 1904, price: 14, price_clean: null, n: 130 },
  ],
  roles: {
    x: { column: "yr", kind: "temporal" },
    measures: [
      { column: "price", unit: "usd" },
      {
        column: "price_clean",
        unit: "usd",
        of: "price_peak",
        screened_by: "price_screen",
        variant_of: "price",
      },
    ],
    count: { column: "n" },
  },
};

function check(name: string, value: unknown): FindingEntry {
  return {
    name,
    definition: `${name} over the observed years`,
    dtype: "check",
    value,
  } as FindingEntry;
}

describe("parseProduct", () => {
  it("keeps valid entries and types them", () => {
    const { product, issues } = parseProduct(
      [SERIES],
      [
        { key: "total", value: 42, label: "Total listings" },
        { key: "slope", value: 0.4, of: "price_trend.slope_per_period" },
      ]
    );
    expect(issues).toEqual([]);
    expect(product.series[0].roles.x.kind).toBe("temporal");
    expect(product.values).toHaveLength(2);
  });

  it("drops a series whose role columns are absent from its rows, with an issue", () => {
    const bad = {
      ...SERIES,
      roles: { ...SERIES.roles, count: { column: "no_such_col" } },
    };
    const { product, issues } = parseProduct([bad], []);
    expect(product.series).toEqual([]);
    expect(issues[0]).toMatchObject({ kind: "invalid_series", name: "annual_prices" });
    expect(issues[0].detail).toContain("no_such_col");
  });

  it("drops malformed series (bad kind) and context-free values", () => {
    const badKind = JSON.parse(JSON.stringify(SERIES)) as Record<string, unknown>;
    (badKind.roles as { x: { kind: string } }).x.kind = "chronological";
    const { product, issues } = parseProduct([badKind], [{ key: "naked", value: 7 }]);
    expect(product.series).toEqual([]);
    expect(product.values).toEqual([]);
    expect(issues.map((i) => i.kind).sort()).toEqual(["invalid_series", "invalid_value"]);
  });

  it("handles absent envelopes (legacy runs) with an empty product", () => {
    const { product, issues } = parseProduct(undefined, undefined);
    expect(product).toEqual({ series: [], values: [] });
    expect(issues).toEqual([]);
  });
});

describe("productRolesIndex / ownedValueKeys", () => {
  it("indexes roles by chart key with screen pairs resolved", () => {
    const idx = productRolesIndex([SERIES]);
    const info = idx.get("annual_prices")!;
    expect(info.xCol).toBe("yr");
    expect(info.countCol).toBe("n");
    expect(info.screens).toEqual([
      { screenedCol: "price_clean", rawCol: "price", checkName: "price_screen" },
    ]);
  });

  it("withholds of-carrying value keys from the binding vocabulary", () => {
    expect(
      ownedValueKeys([
        { key: "total", value: 1, label: "Total" },
        { key: "slope", value: 2, of: "t.slope" },
      ])
    ).toEqual(new Set(["slope"]));
  });
});

describe("binding catalog", () => {
  it("renders typed series lines with roles and refs", () => {
    const [line] = buildSeriesCatalogLines([SERIES]);
    expect(line).toContain('"$chartData:annual_prices"');
    expect(line).toContain("x: yr (temporal)");
    expect(line).toContain("screened by price_screen");
    expect(line).toContain("of finding price_peak");
    expect(line).toContain("count: n");
    expect(line).toContain("5 rows");
  });

  it("lists only standalone values (of-refs bind via their finding)", () => {
    const lines = buildValueCatalogLines([
      { key: "total", value: 1, label: "Total listings", unit: "items" },
      { key: "slope", value: 2, of: "t.slope" },
    ]);
    expect(lines).toEqual(['- "$result:total" — Total listings (items)']);
  });
});

describe("structured-first lints (roles index paths)", () => {
  const chartData = { annual_prices: SERIES.rows };
  const idx = productRolesIndex([SERIES]);

  it("screen scope: dereferences the declared check exactly, no token match", () => {
    // Applied exclusions {1901, 1904}; the check only declares 1901.
    const issues = lintScreenScopeMismatch(
      chartData,
      [check("price_screen", { outliers: [1901] })],
      idx
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe("screen_scope_mismatch");
    expect(issues[0].name).toBe("price_screen");
    expect(issues[0].detail).toContain("1904");
  });

  it("screen scope: clean when the declared evidence covers the exclusions", () => {
    const issues = lintScreenScopeMismatch(
      chartData,
      [check("price_screen", { outliers: [1901, 1904] })],
      idx
    );
    expect(issues).toEqual([]);
  });

  it("undeclared screen: a dangling screened_by check ref is flagged", () => {
    const issues = lintUndeclaredScreen(chartData, [check("some_other_check", {})], idx);
    expect(issues.some((i) => i.detail.includes("price_screen"))).toBe(true);
  });

  it("undeclared screen: a variant with no screened_by is flagged", () => {
    const s: SeriesEntry = JSON.parse(JSON.stringify(SERIES));
    delete s.roles.measures[1].screened_by;
    const issues = lintUndeclaredScreen({ annual_prices: s.rows }, [], productRolesIndex([s]));
    expect(issues[0].kind).toBe("undeclared_screen");
    expect(issues[0].detail).toContain("variant of price");
  });

  it("series consumption: a second series consuming raw while a screen exists", () => {
    const rawOnly: SeriesEntry = {
      id: "decade_rollup",
      rows: [{ decade: 1900, price: 11 }],
      roles: {
        x: { column: "decade", kind: "ordinal" },
        measures: [{ column: "price" }],
      },
    };
    const issues = lintSeriesConsumption(
      { annual_prices: SERIES.rows, decade_rollup: rawOnly.rows },
      productRolesIndex([SERIES, rawOnly])
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe("undeclared_series_choice");
    expect(issues[0].detail).toContain("decade_rollup");
  });

  it("thin superlative: declared count column drives attestation (no name regex)", () => {
    // Count column "n" matches no naming convention a regex would find only
    // via the declared role when renamed — use an unconventional name.
    const s: SeriesEntry = JSON.parse(JSON.stringify(SERIES));
    s.rows = s.rows.map((r) => ({ yr: r.yr, price: r.price, menus_seen: r.n }));
    s.roles.count = { column: "menus_seen" };
    s.roles.measures = [{ column: "price", unit: "usd" }];
    const peak: FindingEntry = {
      name: "price_peak",
      definition: "max price year",
      dtype: "superlative",
      value: { period: 1901, value: 3000 },
    } as FindingEntry;
    const issues = lintThinSuperlative({ annual_prices: s.rows }, [peak], productRolesIndex([s]));
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe("thin_superlative");
    expect(issues[0].detail).toContain("menus_seen");
  });

  it("well-attested screened: declared pair catches a high-n exclusion", () => {
    // 1904 (n=130, above median 110) is screened out — miscalibration.
    const issues = lintWellAttestedScreened(chartData, idx);
    expect(issues.some((i) => i.kind === "well_attested_screened")).toBe(true);
    expect(issues[0].detail).toContain("1904");
  });

  it("unscreened superlative: of-linkage finds the measure without token overlap", () => {
    // Finding name shares NO tokens with the column name — only of= links them.
    const s: SeriesEntry = JSON.parse(JSON.stringify(SERIES));
    s.roles.measures[1].of = "headline_peak";
    const peak: FindingEntry = {
      name: "headline_peak",
      definition: "max over years",
      dtype: "superlative",
      value: { period: 1901, value: 3000 },
    } as FindingEntry;
    const issues = lintUnscreenedSuperlative(
      { annual_prices: s.rows },
      [peak],
      productRolesIndex([s])
    );
    // The screen nulled 1901's clean value, so the peak WAS screened — no issue.
    expect(issues).toEqual([]);
    // Now un-null the screened cell at the peak: the screen let it through.
    const rows = s.rows.map((r) => (r.yr === 1901 ? { ...r, price_clean: 3000 } : r));
    const issues2 = lintUnscreenedSuperlative(
      { annual_prices: rows },
      [peak],
      productRolesIndex([s])
    );
    expect(issues2).toHaveLength(1);
    expect(issues2[0].kind).toBe("screen_missed_superlative");
  });
});
