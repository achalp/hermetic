import { describe, it, expect } from "vitest";
import {
  parseProduct,
  productRolesIndex,
  ownedValueKeys,
  declaredUnitMap,
  mergeStepProducts,
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
import { lintComponentSignature } from "@/lib/product/signatures";

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

describe("mergeStepProducts (investigate namespacing, spec §7)", () => {
  it("prefixes data ids with step_N_ and fact refs with step_N. — no dangling refs", () => {
    const { product, issues } = mergeStepProducts([
      { stepNo: 2, series: [SERIES], values: [{ key: "total", value: 9, label: "Total" }] },
      {
        stepNo: 3,
        values: [{ key: "slope", value: 0.4, of: "price_trend.slope_per_period" }],
      },
    ]);
    expect(issues).toEqual([]);
    const s = product.series[0];
    // Data namespace (underscore) matches the composer's merged chart keys.
    expect(s.id).toBe("step_2_annual_prices");
    // Fact namespace (dot) matches namespaceFindings' manifest renames.
    const screened = s.roles.measures.find((m) => m.column === "price_clean")!;
    expect(screened.of).toBe("step_2.price_peak");
    expect(screened.screened_by).toBe("step_2.price_screen");
    // Column-local refs are untouched by the rename.
    expect(screened.variant_of).toBe("price");
    expect(product.values.map((v) => v.key)).toEqual(["step_2_total", "step_3_slope"]);
    expect(product.values[1].of).toBe("step_3.price_trend.slope_per_period");
  });

  it("the merged roles index keys the merged chart namespace", () => {
    const { product } = mergeStepProducts([{ stepNo: 1, series: [SERIES] }]);
    const idx = productRolesIndex(product.series);
    const info = idx.get("step_1_annual_prices")!;
    expect(info.countCol).toBe("n");
    expect(info.screens[0].checkName).toBe("step_1.price_screen");
  });

  it("step-tags validation issues from invalid entries", () => {
    const { product, issues } = mergeStepProducts([
      { stepNo: 4, values: [{ key: "naked", value: 7 }] },
    ]);
    expect(product.values).toEqual([]);
    expect(issues[0].kind).toBe("invalid_value");
    expect(issues[0].detail).toMatch(/^step 4:/);
  });
});

describe("component role signatures", () => {
  const catSeries: SeriesEntry = {
    id: "by_cuisine",
    rows: [{ cuisine: "french", median_price: 12 }],
    roles: {
      x: { column: "cuisine", kind: "categorical" },
      measures: [{ column: "median_price", unit: "usd" }],
    },
  };
  const idx = productRolesIndex([catSeries, SERIES]);
  const line = (type: string, binding: string) =>
    JSON.stringify({
      op: "add",
      path: "/elements/c1",
      value: {
        type,
        props: { title: null, data: binding, x_key: "x", y_keys: ["y"] },
        children: [],
      },
    });

  it("flags a LineChart over a declared categorical x", () => {
    const issues = lintComponentSignature(line("LineChart", "$chartData:by_cuisine"), idx);
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe("component_role_mismatch");
    expect(issues[0].detail).toContain("categorical");
  });

  it("accepts matching kinds, unmapped components, and undeclared keys", () => {
    // temporal series in a LineChart: fine.
    expect(lintComponentSignature(line("LineChart", "$chartData:annual_prices"), idx)).toEqual([]);
    // BarChart has no signature: any x kind is fine.
    expect(lintComponentSignature(line("BarChart", "$chartData:by_cuisine"), idx)).toEqual([]);
    // Undeclared chart key: no roles to check against.
    expect(lintComponentSignature(line("LineChart", "$chartData:mystery"), idx)).toEqual([]);
  });

  it("checks the $series alias and flags a PieChart over temporal x", () => {
    const issues = lintComponentSignature(line("PieChart", "$series:annual_prices"), idx);
    expect(issues).toHaveLength(1);
    expect(issues[0].detail).toContain("PieChart");
  });
});

describe("declaredUnitMap", () => {
  it("maps value units and finding-mirror units, normalizing pct spellings", () => {
    const map = declaredUnitMap(
      [
        { key: "total", value: 1, label: "Total", unit: "items" },
        { key: "share", value: 2, label: "Share", unit: "pct" },
        { key: "unitless", value: 3, label: "X" },
      ],
      [
        { name: "price_peak", unit: "usd" },
        { name: "step_2.era_delta", unit: "pp" },
        { name: "no_unit" },
      ]
    );
    expect(map.total).toBe("items");
    expect(map.share).toBe("%");
    expect(map.price_peak).toBe("usd");
    expect(map.price_peak_value).toBe("usd");
    expect(map.era_delta).toBe("pp"); // step prefix stripped like mirrors
    expect(map.unitless).toBeUndefined();
    expect(map.no_unit).toBeUndefined();
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

describe("regime-policy enforcement lints (compiled-run review 2026-08-09)", () => {
  it("zero_sentinel_unapplied: declared policy, zeros still present", async () => {
    const { lintRegimePolicy, lintUnaggregatedRollup } = await import("@/lib/findings/lints");
    const rows = [
      { yr: 1859, price: 0, n: 100 },
      { yr: 1900, price: 0.3, n: 5000 },
      { yr: 1901, price: 0, n: 200 },
      { yr: 1902, price: 0.4, n: 4000 },
    ];
    const s: SeriesEntry = {
      id: "annual_prices",
      rows,
      roles: {
        x: { column: "yr", kind: "temporal" },
        measures: [{ column: "price", unit: "usd" }],
        count: { column: "n" },
      },
    };
    const idx = productRolesIndex([s]);
    const regimes = {
      annual_prices: { zero_share: 0.5, flags: ["ZERO_INFLATED", "MONETARY"] },
    };
    const issues = lintRegimePolicy(regimes, { annual_prices: rows }, idx);
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe("zero_sentinel_unapplied");
    expect(issues[0].detail).toContain("2 zero-valued rows");
    // Applied policy (zeros gone): quiet.
    const clean = rows.filter((r) => r.price !== 0);
    expect(lintRegimePolicy(regimes, { annual_prices: clean }, idx)).toHaveLength(0);
    // Count-corroborated zeros are REAL (runtime _zero_screen, run
    // d82a39ce): a $0 row whose count is also 0 is a period nothing
    // happened — the policy is supposed to KEEP it, so it is not
    // "unapplied policy".
    const corroborated = rows.map((r) => (r.price === 0 ? { ...r, n: 0 } : r));
    expect(lintRegimePolicy(regimes, { annual_prices: corroborated }, idx)).toHaveLength(0);
    // Non-monetary: quiet.
    expect(
      lintRegimePolicy(
        { annual_prices: { flags: ["ZERO_INFLATED"] } },
        { annual_prices: rows },
        idx
      )
    ).toHaveLength(0);
    // Unaggregated rollup: repeated consecutive x + interval labels.
    const era: SeriesEntry = {
      id: "price_by_era",
      rows: [
        { era: "(1850.999, 1916.0]", median: 0.3 },
        { era: "(1850.999, 1916.0]", median: 0.35 },
        { era: "(1850.999, 1916.0]", median: 0.4 },
        { era: "(1916.0, 1970.0]", median: 0.9 },
      ],
      roles: { x: { column: "era", kind: "categorical" }, measures: [{ column: "median" }] },
    };
    const eraIssues = lintUnaggregatedRollup({ price_by_era: era.rows }, productRolesIndex([era]));
    expect(eraIssues).toHaveLength(1);
    expect(eraIssues[0].kind).toBe("unaggregated_rollup");
    expect(eraIssues[0].detail).toContain("Interval");
    // Properly grouped rollup (unique x, named buckets): quiet.
    const grouped = [
      { era: "1850-1916", median: 0.33 },
      { era: "1917-1970", median: 0.9 },
      { era: "1971-2012", median: 4.5 },
      { era: "all", median: 0.5 },
    ];
    expect(
      lintUnaggregatedRollup(
        { price_by_era: grouped },
        productRolesIndex([{ ...era, rows: grouped }])
      )
    ).toHaveLength(0);
  });
});
