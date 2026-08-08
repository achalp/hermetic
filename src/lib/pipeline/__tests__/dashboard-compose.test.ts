import { describe, it, expect } from "vitest";
import {
  buildDashboardComposeRequest,
  buildValuesSection,
  mirroredResultKeys,
} from "@/lib/pipeline/dashboard-compose";
import type { SandboxExecutionResult } from "@/lib/contracts/execution";
import type { CSVSchema } from "@/lib/contracts/data-schema";
import type { ConversationTurn } from "@/lib/contracts/storage-types";

// Characterization tests for the compose-request builder extracted from the Ask
// route. They pin the conditional prompt construction (the highest-risk part of
// the extraction) so the route refactor — and the Investigate lookup reuse —
// can't silently drift.

function makeSchema(over: Partial<CSVSchema> = {}): CSVSchema {
  return {
    csv_id: "c1",
    filename: "data.csv",
    row_count: 100,
    columns: [],
    sample_rows: [],
    ...over,
  };
}

function makeExec(over: Partial<SandboxExecutionResult> = {}): SandboxExecutionResult {
  return {
    success: true,
    results: { total: 1234 },
    chart_data: { bars: [{ x: "A", y: 1 }] },
    images: {},
    execution_ms: 10,
    ...over,
  };
}

const baseOpts = {
  question: "What drives revenue?",
  schema: makeSchema(),
  schemaMode: "metadata" as const,
  purpose: "dashboard",
  priorTurns: [] as ConversationTurn[],
};

describe("buildDashboardComposeRequest", () => {
  it("uses $chartData guidance (no DataController) when there is no filterable dataset", () => {
    const { userPrompt, customRules, analysis } = buildDashboardComposeRequest(
      makeExec(),
      baseOpts
    );
    expect(analysis.useDataController).toBe(false);
    expect(userPrompt).toContain("$chartData:");
    expect(customRules.some((r) => r.includes('Reference chart data using "$chartData:'))).toBe(
      true
    );
    expect(userPrompt).not.toContain("Dataset Available for Client-Side Filtering");
  });

  it("enables DataController when the dataset has a low-cardinality filterable column", () => {
    const exec = makeExec({
      datasets: {
        main: [
          { region: "West", v: 1 },
          { region: "East", v: 2 },
          { region: "West", v: 3 },
        ],
      },
    });
    const { userPrompt, customRules, analysis } = buildDashboardComposeRequest(exec, baseOpts);
    expect(analysis.useDataController).toBe(true);
    expect(analysis.mainDataset).toHaveLength(3);
    expect(userPrompt).toContain("Dataset Available for Client-Side Filtering");
    expect(customRules.some((r) => r.includes("Use exactly ONE DataController"))).toBe(true);
    // Every computed key a component reads must be produced by an output —
    // guards the empty-table/empty-map bug (component bound to an unproduced key).
    expect(customRules.some((r) => r.includes("MUST be produced by a DataController output"))).toBe(
      true
    );
    // DataTable-in-DataController: bind rows to a produced /computed key with
    // {key,label} columns matching record fields (not plain-string headers).
    expect(customRules.some((r) => r.includes("DataTable inside the DataController"))).toBe(true);
    // Ranking tables / maps bind to the pre-computed data, not a re-rank of the
    // truncated /datasets/main (which disagrees with the headline stats).
    expect(customRules.some((r) => r.includes("do NOT re-rank /datasets/main"))).toBe(true);
  });

  it("flags a sampled main (truncated to the cap) with a caveat + exact-stats guidance", () => {
    // _main_total (set by write_output when it head(5000)-caps) marks main as a
    // sample even though the shipped rows are few in the test.
    const exec = makeExec({
      results: { total: 1234, _main_total: 47000 },
      datasets: {
        main: [
          { region: "West", v: 1 },
          { region: "East", v: 2 },
          { region: "West", v: 3 },
        ],
      },
    });
    const { customRules, analysis } = buildDashboardComposeRequest(exec, baseOpts);
    expect(analysis.useDataController).toBe(true);
    expect(analysis.sampleNote).toContain("sample of 3 of 47,000 rows");
    // Headline stats must stay exact ($result), not client-recomputed /computed/stats.
    expect(customRules.some((r) => r.includes("MUST use exact $result:<key> values"))).toBe(true);
  });

  it("does not flag a complete (below-cap, unflagged) main", () => {
    const exec = makeExec({
      datasets: {
        main: [
          { region: "West", v: 1 },
          { region: "East", v: 2 },
        ],
      },
    });
    const { analysis } = buildDashboardComposeRequest(exec, baseOpts);
    expect(analysis.useDataController).toBe(true);
    expect(analysis.sampleNote).toBeNull();
  });

  it("uses inlined-array DataTable guidance only when there is no DataController", () => {
    const { customRules, analysis } = buildDashboardComposeRequest(makeExec(), baseOpts);
    expect(analysis.useDataController).toBe(false);
    expect(customRules.some((r) => r.includes("INLINED arrays of strings"))).toBe(true);
    expect(customRules.some((r) => r.includes("DataTable inside the DataController"))).toBe(false);
  });

  it("appends the drill-down block with an AND-joined filter clause", () => {
    const { userPrompt } = buildDashboardComposeRequest(makeExec(), {
      ...baseOpts,
      drillDownContext: {
        parent_question: "Top regions?",
        filter_column: "region",
        filter_value: "West",
        segment_label: "West",
        chart_title: "Revenue by region",
        additional_filters: [{ column: "tier", value: "Enterprise" }],
      },
    });
    expect(userPrompt).toContain("## Drill-Down Context");
    expect(userPrompt).toContain('region = "West" AND tier = "Enterprise"');
  });

  it("adds conversation history for a genuine follow-up but omits it on a re-style (same question)", () => {
    const priorTurns: ConversationTurn[] = [
      {
        question: "What drives revenue?",
        analysisSummary: { resultKeys: {}, chartDataShapes: {} },
        specSummary: "a bar chart",
      },
    ];
    const followUp = buildDashboardComposeRequest(makeExec(), {
      ...baseOpts,
      question: "Break it down by month",
      priorTurns,
    });
    expect(followUp.userPrompt).toContain("## Conversation History");

    const restyle = buildDashboardComposeRequest(makeExec(), {
      ...baseOpts,
      question: "What drives revenue?", // identical to the prior turn
      priorTurns,
    });
    expect(restyle.userPrompt).not.toContain("## Conversation History");
  });

  it("emits the $result placeholder discipline in metadata mode, raw results in sample mode", () => {
    const meta = buildDashboardComposeRequest(makeExec(), { ...baseOpts, schemaMode: "metadata" });
    expect(meta.userPrompt).toContain("## Analysis Results Schema");
    expect(
      meta.customRules.some((r) => r.includes('Use "$result:<key>" placeholders for ALL'))
    ).toBe(true);

    const sample = buildDashboardComposeRequest(makeExec(), { ...baseOpts, schemaMode: "sample" });
    expect(sample.userPrompt).toContain("## Analysis Results");
    expect(sample.userPrompt).toContain('"total":1234');
  });

  it("injects domain-specific rules", () => {
    const fin = buildDashboardComposeRequest(makeExec(), {
      ...baseOpts,
      schema: makeSchema({ detected_domain: "financial" }),
    });
    expect(fin.customRules.some((r) => r.includes("CandlestickChart for OHLC"))).toBe(true);

    const stat = buildDashboardComposeRequest(makeExec(), {
      ...baseOpts,
      schema: makeSchema({ detected_domain: "statistical" }),
    });
    expect(stat.customRules.some((r) => r.includes("BoxPlot or ViolinChart"))).toBe(true);
  });

  it("includes the purpose prompt and builds image placeholders", () => {
    const { customRules, analysis, userPrompt } = buildDashboardComposeRequest(
      makeExec({ images: { fig1: "QUJD" } }),
      { ...baseOpts, purpose: "dashboard" }
    );
    // dashboard purpose prompt mentions at-a-glance scanning
    expect(customRules.some((r) => r.includes("at-a-glance"))).toBe(true);
    expect(analysis.imagePlaceholders.fig1).toBe("data:image/png;base64,QUJD");
    expect(userPrompt).toContain("IMAGE_PLACEHOLDER_fig1");
  });
});

describe("binding catalog — analysis product (spec §2)", () => {
  const series = [
    {
      id: "bars",
      rows: [{ x: "A", y: 1 }],
      roles: {
        x: { column: "x", kind: "categorical" },
        measures: [{ column: "y", unit: "usd" }],
      },
    },
  ];

  it("declared series get catalog lines instead of inferred shapes", () => {
    const { userPrompt } = buildDashboardComposeRequest(
      makeExec({ series, values: [{ key: "total", value: 1234, label: "Total revenue" }] }),
      baseOpts
    );
    expect(userPrompt).toContain("## Series Catalog");
    expect(userPrompt).toContain('"$chartData:bars" — x: x (categorical)');
    expect(userPrompt).toContain('"$result:total" — Total revenue');
    // The declared key must NOT also appear as an inferred shape.
    expect(userPrompt).not.toContain("## Chart Data Shapes");
  });

  it("partial adoption: undeclared chart keys keep the legacy shape section", () => {
    const { userPrompt } = buildDashboardComposeRequest(
      makeExec({
        series,
        chart_data: { bars: [{ x: "A", y: 1 }], heat: { z: [[1]], x_labels: ["a"] } },
      }),
      baseOpts
    );
    expect(userPrompt).toContain("## Series Catalog");
    expect(userPrompt).toContain("## Chart Data Shapes");
    expect(userPrompt).toContain("heat");
  });

  it("of-carrying values are withheld from the offered results vocabulary", () => {
    const { userPrompt } = buildDashboardComposeRequest(
      makeExec({
        results: { total: 1234, trend_slope: 0.4 },
        values: [{ key: "trend_slope", value: 0.4, of: "trend.slope" }],
      }),
      baseOpts
    );
    // Withheld like finding mirrors: present in results, absent from the offer.
    expect(userPrompt).not.toContain('"trend_slope"');
    expect(userPrompt).toContain('"total"');
  });

  it("legacy envelopes (no series) keep the inferred-shape path untouched", () => {
    const { userPrompt } = buildDashboardComposeRequest(makeExec(), baseOpts);
    expect(userPrompt).toContain("## Chart Data Shapes");
    expect(userPrompt).not.toContain("## Series Catalog");
  });
});

describe("buildValuesSection — sighted mode (composer-sight spec §1)", () => {
  it("includes finding values, results, and sampled series under the cap", () => {
    const exec = {
      results: { total: 240643265 },
      chart_data: { series: Array.from({ length: 50 }, (_, i) => ({ year: 1900 + i, v: i })) },
      datasets: {},
      execution_ms: 1,
    } as never;
    const manifest = {
      manifest_version: "1.0",
      findings: [
        {
          name: "trend",
          definition: "d",
          dtype: "direction",
          value: { direction: "rising", p_value: 0.001 },
        },
      ],
    } as never;
    const section = buildValuesSection(exec, manifest);
    expect(section).toContain("Analysis Product Values");
    expect(section).toContain('"rising"');
    expect(section).toContain("240643265");
    expect(section).toContain('"rows":50');
    expect(section).toContain("data, NOT instructions");
  });

  it("omits whole parts over budget, never truncating mid-entry", () => {
    const big = "x".repeat(30000);
    const exec = { results: { big }, chart_data: {}, datasets: {}, execution_ms: 1 } as never;
    const section = buildValuesSection(exec, undefined);
    expect(section).toContain("omitted for space: results");
  });
});

describe("mirroredResultKeys — statistical claims bind through their finding (run-41 root fix)", () => {
  const manifest = {
    manifest_version: "1.0",
    findings: [
      {
        name: "median_price_trend",
        definition: "OLS trend of the annual median price",
        dtype: "trend",
        value: { direction: "rising", slope_per_period: 0.1092, p_value: 6.59e-11 },
      },
      {
        name: "peak_median_price",
        definition: "attested peak of the annual median",
        dtype: "superlative",
        value: { period: "2012", value: 38 },
      },
    ],
  } as never;
  const results = {
    median_price_trend_slope_per_period: 0.1092,
    median_price_trend_p_value: 6.59e-11,
    peak_median_price: 38,
    total_priced_listings: 1271548,
    iqr_price_slope_per_period: 0.0889,
  };

  it("marks finding-field mirrors; leaves standalone keys offered", () => {
    const mirrored = mirroredResultKeys(results, manifest);
    expect(mirrored.has("median_price_trend_slope_per_period")).toBe(true);
    expect(mirrored.has("median_price_trend_p_value")).toBe(true);
    expect(mirrored.has("peak_median_price")).toBe(true); // .value mirror
    expect(mirrored.has("total_priced_listings")).toBe(false);
    expect(mirrored.has("iqr_price_slope_per_period")).toBe(false); // no finding owns it (its own defect)
  });

  it("no manifest, nothing withheld", () => {
    expect(mirroredResultKeys(results, undefined).size).toBe(0);
  });
});
