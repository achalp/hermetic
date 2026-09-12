/**
 * Regression: "HDI Composite Distress, Rental Vacancy Rate & Homelessness Rate
 * Over Time" in the King County correlation dashboard.
 *
 * Three series went onto one 0–800 axis: homelessness (~230–730), the composite
 * score (~66–76) and vacancy rate (~3–5.5). Two of the three rendered as flat
 * lines along the bottom — in the legend, saying nothing. DualAxisChart exists in
 * the catalog for exactly this ("for series on different scales/units") and the
 * composer did not reach for it.
 *
 * The numbers below are the real shape of that data.
 */
import { describe, it, expect } from "vitest";
import {
  measureSeries,
  groupByScale,
  lintSeriesScale,
  humanizeSeriesKey,
} from "@/lib/compose/series-scale";

/** The observed series, abbreviated but to scale. */
const kingCountyRows = [
  { year: "2015", homeless_rate: 470, hdi_composite: 66.4, vacancy_rate: 3.1 },
  { year: "2016", homeless_rate: 495, hdi_composite: 71.2, vacancy_rate: 3.6 },
  { year: "2017", homeless_rate: 540, hdi_composite: 76.2, vacancy_rate: 4.2 },
  { year: "2021", homeless_rate: 230, hdi_composite: 73.1, vacancy_rate: 5.4 },
  { year: "2024", homeless_rate: 730, hdi_composite: 72.9, vacancy_rate: 4.6 },
];

describe("measureSeries", () => {
  it("uses the median magnitude, so one spike cannot define a series", () => {
    const [homeless] = measureSeries(kingCountyRows, ["homeless_rate"]);
    expect(homeless!.min).toBe(230);
    expect(homeless!.max).toBe(730);
    expect(homeless!.magnitude).toBe(495);
  });

  it("skips series with no numeric values rather than inventing a scale", () => {
    expect(measureSeries(kingCountyRows, ["year"])).toEqual([]);
  });
});

describe("groupByScale", () => {
  it("finds THREE groups in the observed chart — two axes could not have helped", () => {
    // magnitudes 495 / 72.9 / 4.2. The widest-gap two-way cut leaves homelessness
    // and the composite sharing an axis at ~7x, which is the same defect at a
    // smaller size. Grouping by what can honestly share an axis says: three.
    const scales = measureSeries(kingCountyRows, [
      "homeless_rate",
      "hdi_composite",
      "vacancy_rate",
    ]);
    const g = groupByScale(scales);
    expect(g.mismatched).toBe(true);
    expect(g.ratio).toBeGreaterThan(100);
    expect(g.groups).toEqual([["homeless_rate"], ["hdi_composite"], ["vacancy_rate"]]);
  });

  it("leaves comparable series alone", () => {
    const rows = [
      { a: 10, b: 12 },
      { a: 14, b: 9 },
    ];
    expect(groupByScale(measureSeries(rows, ["a", "b"])).mismatched).toBe(false);
  });

  it("groups series that genuinely share an axis, and separates those that do not", () => {
    const rows = [{ big: 1000, big2: 900, small: 2 }];
    expect(groupByScale(measureSeries(rows, ["big", "big2", "small"])).groups).toEqual([
      ["big", "big2"],
      ["small"],
    ]);
  });

  it("ignores all-zero series instead of dividing by them", () => {
    const rows = [
      { z: 0, a: 5 },
      { z: 0, a: 6 },
    ];
    expect(() => groupByScale(measureSeries(rows, ["z", "a"]))).not.toThrow();
  });
});

describe("lintSeriesScale", () => {
  it("splits the observed three-scale chart into one chart per measure", () => {
    const elements = {
      "trend-chart": {
        type: "LineChart",
        props: {
          title: "HDI Composite Distress, Rental Vacancy Rate & Homelessness Rate Over Time",
          data: kingCountyRows,
          x_key: "year",
          y_keys: ["homeless_rate", "hdi_composite", "vacancy_rate"],
          label_map: { homeless_rate: "Homelessness Rate" },
        },
        children: [],
      },
    };
    const { rewritten, added } = lintSeriesScale(elements);
    expect(rewritten).toHaveLength(1);
    expect(rewritten[0]!.kind).toBe("split");

    // The ORIGINAL id becomes the container, so nothing that pointed at this
    // chart needs rewiring and the tree stays reachable.
    const el = elements["trend-chart"] as unknown as {
      type: string;
      props: Record<string, unknown>;
      children: string[];
    };
    expect(el.type).toBe("LayoutColumn");
    expect(el.children).toEqual(rewritten[0]!.createdIds);
    expect(Object.keys(added)).toEqual(el.children);

    // One chart per measure, each keeping the original chart type and rows.
    const first = added[el.children[0]!] as { type: string; props: Record<string, unknown> };
    expect(first.type).toBe("LineChart");
    expect(first.props.y_keys).toEqual(["homeless_rate"]);
    expect(first.props.data).toBe(kingCountyRows);
    // The title names the measure, since the shared legend is gone — and it
    // inherits the composer's own wording via label_map where there is one.
    expect(String(first.props.title)).toContain("Homelessness Rate");
    const second = added[el.children[1]!] as { props: Record<string, unknown> };
    expect(String(second.props.title)).toContain("Hdi composite");
  });

  it("leaves a chart whose series share a scale exactly as it was", () => {
    const props = {
      title: "Fine",
      data: [{ x: "a", p: 10, q: 12 }],
      x_key: "x",
      y_keys: ["p", "q"],
    };
    const elements = { c: { type: "LineChart", props, children: [] } };
    expect(lintSeriesScale(elements).rewritten).toEqual([]);
    expect(elements.c.type).toBe("LineChart");
    expect(elements.c.props).toBe(props);
  });

  it("uses a DUAL AXIS when exactly two groups fit, keeping the shared x", () => {
    const rows = [{ x: "a", revenue: 1_000_000, margin_pct: 12 }];
    const elements = {
      c: {
        type: "LineChart",
        props: {
          title: "Revenue vs margin",
          data: rows,
          x_key: "x",
          y_keys: ["revenue", "margin_pct"],
        },
        children: [],
      },
    };
    const { rewritten, added } = lintSeriesScale(elements);
    expect(rewritten[0]!.kind).toBe("dual-axis");
    expect(added).toEqual({});
    const el = elements.c as unknown as { type: string; props: Record<string, unknown> };
    expect(el.type).toBe("DualAxisChart");
    expect(el.props.left_series).toEqual(["revenue"]);
    expect(el.props.right_series).toEqual(["margin_pct"]);
    // The axis labels a single-axis chart could not carry at all.
    expect(el.props.left_label).toBe("Revenue");
    expect(el.props.right_label).toBe("Margin pct");
    expect(el.props.x_label).toBe("X");
  });

  it("ignores single-series charts — one series cannot mismatch itself", () => {
    const elements = {
      c: {
        type: "LineChart",
        props: { data: kingCountyRows, x_key: "year", y_keys: ["homeless_rate"] },
        children: [],
      },
    };
    expect(lintSeriesScale(elements).rewritten).toEqual([]);
  });

  it("tolerates ragged wire shapes", () => {
    expect(() =>
      lintSeriesScale({
        a: null,
        b: { type: "LineChart" },
        c: { type: "LineChart", props: { data: "nope", y_keys: ["a", "b"] } },
        d: { type: "ScatterPlot", props: { data: [], y_keys: ["a", "b"] } },
      } as unknown as Record<string, unknown>)
    ).not.toThrow();
  });
});

describe("humanizeSeriesKey", () => {
  it("turns a column identifier into axis wording", () => {
    expect(humanizeSeriesKey("rental_vacancy_rate")).toBe("Rental vacancy rate");
  });
});
