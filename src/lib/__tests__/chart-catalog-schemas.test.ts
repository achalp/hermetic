import { describe, it, expect } from "vitest";
import { catalog } from "@/lib/catalog";

// Validates that each newly-added chart component is (a) registered in the
// catalog and (b) accepts a representative, LLM-shaped spec through the
// catalog's render-tree validator — the exact contract the composer must
// satisfy. This catches accidental schema drift and unregistered components.
// One valid sample per component; negative cases guard required/typed fields.

const cat = catalog as unknown as {
  componentNames: string[];
  validate: (tree: unknown) => { success: boolean };
};

/** Wrap a component's props in a minimal valid render tree and validate. */
function validateNode(type: string, props: Record<string, unknown>): boolean {
  return cat.validate({
    root: "n1",
    elements: { n1: { type, props, children: [] } },
  }).success;
}

// name -> a valid props sample (nulls included to mirror the composer output)
const VALID_SAMPLES: Record<string, Record<string, unknown>> = {
  ErrorBarChart: {
    title: "Mean ± SE by group",
    data: [
      { group: "A", mean: 10, se: 1.2 },
      { group: "B", mean: 14, se: 0.9 },
    ],
    x_key: "group",
    y_key: "mean",
    error_key: "se",
    error_minus_key: null,
    group_key: null,
    mode: "markers",
    y_log: null,
    x_label: null,
    y_label: "Mean",
    color_map: null,
  },
  DualAxisChart: {
    title: "Revenue vs. margin",
    data: [
      { month: "Jan", revenue: 100, margin: 0.2 },
      { month: "Feb", revenue: 120, margin: 0.25 },
    ],
    x_key: "month",
    left_series: [{ key: "revenue", label: "Revenue", type: "bar", color: null }],
    right_series: [{ key: "margin", label: "Margin %", type: "line", color: "emerald" }],
    left_label: "Revenue",
    right_label: "Margin %",
    left_log: null,
    right_log: null,
    x_label: null,
  },
  FunnelChart: {
    title: "Signup funnel",
    data: [
      { label: "Visited", value: 1000 },
      { label: "Signed up", value: 420 },
      { label: "Purchased", value: 110 },
    ],
    orientation: "horizontal",
    show_percent: "initial",
    colors: null,
  },
  GaugeChart: {
    title: "SLA attainment",
    value: 96.4,
    min: 0,
    max: 100,
    target: 99,
    ranges: [
      { to: 90, color: "rose" },
      { to: 99, color: "amber" },
      { to: 100, color: "emerald" },
    ],
    reference: 95,
    bar_color: null,
    suffix: "%",
    prefix: null,
    number_format: null,
  },
  Sparkline: {
    title: null,
    data: [{ v: 3 }, { v: 5 }, { v: 4 }, { v: 7 }],
    value_key: "v",
    label: "Sessions",
    show_value: true,
    area: true,
    show_last_point: true,
    color: null,
  },
};

describe("chart catalog schemas — Batch 1 (capability + analytics)", () => {
  for (const [name, sample] of Object.entries(VALID_SAMPLES)) {
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

// name -> a valid props sample for the statistics charts.
const BATCH2_SAMPLES: Record<string, Record<string, unknown>> = {
  ParetoChart: {
    title: "Defects by cause",
    data: [
      { label: "Scratch", value: 80 },
      { label: "Dent", value: 40 },
      { label: "Misprint", value: 12 },
    ],
    threshold_percent: 80,
    bar_color: null,
    line_color: null,
  },
  QQPlot: {
    title: "Normality check",
    data: [{ v: -1.2 }, { v: 0.1 }, { v: 0.9 }, { v: 2.3 }],
    value_key: "v",
    theoretical_key: null,
    sample_key: null,
    x_label: null,
    y_label: null,
    color: null,
  },
  ECDFChart: {
    title: "Latency ECDF",
    data: [{ ms: 12 }, { ms: 18 }, { ms: 25 }, { ms: 40 }],
    value_key: "ms",
    group_key: null,
    x_label: "Latency (ms)",
    complementary: null,
    color_map: null,
  },
  SurvivalChart: {
    title: "Retention",
    curves: [
      {
        label: "Cohort A",
        points: [
          { time: 0, survival: 1, lower: 1, upper: 1 },
          { time: 30, survival: 0.82, lower: 0.78, upper: 0.86 },
          { time: 60, survival: 0.65, lower: 0.6, upper: 0.7 },
        ],
      },
    ],
    x_label: "Days",
    y_label: null,
    show_ci: true,
    color_map: null,
  },
  ForestPlot: {
    title: "Subgroup effects",
    data: [
      { label: "Overall", estimate: 1.2, lower: 1.05, upper: 1.38 },
      { label: "Region A", estimate: 0.9, lower: 0.7, upper: 1.16 },
    ],
    reference_value: 1,
    x_label: "Hazard ratio",
    x_log: true,
    color: null,
  },
  ControlChart: {
    title: "Process mean",
    data: [{ v: 9.8 }, { v: 10.1 }, { v: 9.9 }, { v: 12.5 }, { v: 10.0 }],
    value_key: "v",
    x_key: null,
    center: null,
    ucl: null,
    lcl: null,
    sigma_multiple: 3,
    x_label: null,
    y_label: null,
    color: null,
  },
  Correlogram: {
    title: "ACF",
    data: [
      { lag: 0, value: 1 },
      { lag: 1, value: 0.6 },
      { lag: 2, value: 0.3 },
    ],
    n: 120,
    conf_band: null,
    kind: "acf",
    color: null,
  },
};

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
