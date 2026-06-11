import { describe, it, expect } from "vitest";
import { assembleCellSpec, flattenResultScalars } from "@/lib/llm/step-cell-composer";

const RESULTS = { total_revenue: 142300, top_region: "West" };
const CHART_DATA = {
  bars: [
    { region: "West", revenue: 89000 },
    { region: "East", revenue: 53300 },
  ],
};

describe("assembleCellSpec", () => {
  it("assembles JSONL patches into a complete spec with placeholders resolved", () => {
    const raw = [
      '{"op":"add","path":"/root","value":"cell"}',
      '{"op":"add","path":"/elements/cell","value":{"type":"LayoutColumn","props":{"gap":4},"children":["chart","insight"]}}',
      '{"op":"add","path":"/elements/chart","value":{"type":"BarChart","props":{"title":null,"data":"$chartData:bars","x_key":"region","y_keys":["revenue"]}}}',
      '{"op":"add","path":"/elements/insight","value":{"type":"TextBlock","props":{"content":"Revenue reached $result:total_revenue, led by $result:top_region.","variant":"insight"}}}',
    ].join("\n");

    const spec = assembleCellSpec(raw, RESULTS, CHART_DATA);
    expect(spec).not.toBeNull();
    expect(spec!.root).toBe("cell");
    expect(Object.keys(spec!.elements)).toHaveLength(3);

    const chart = spec!.elements.chart as unknown as { props: { data: unknown } };
    expect(chart.props.data).toEqual(CHART_DATA.bars);

    const insight = spec!.elements.insight as unknown as { props: { content: string } };
    expect(insight.props.content).toContain("142300");
    expect(insight.props.content).toContain("West");
    expect(insight.props.content).not.toContain("$result:");
  });

  it("skips markdown fences, blank lines, and malformed patches", () => {
    const raw = [
      "```jsonl",
      "",
      "not json at all",
      '{"op":"add","path":"/root","value":"cell"}',
      '{"op":"add","path":"/elements/cell","value":{"type":"TextBlock","props":{"content":"hi"}}}',
      "```",
    ].join("\n");

    const spec = assembleCellSpec(raw, {}, {});
    expect(spec).not.toBeNull();
    expect(spec!.root).toBe("cell");
  });

  it("returns null when output yields no renderable spec", () => {
    expect(assembleCellSpec("", RESULTS, CHART_DATA)).toBeNull();
    expect(assembleCellSpec("complete garbage", RESULTS, CHART_DATA)).toBeNull();
    // Root set but no elements
    expect(assembleCellSpec('{"op":"add","path":"/root","value":"x"}', {}, {})).toBeNull();
  });

  it("resolves object-form placeholders the LLM sometimes emits", () => {
    // Observed in real cell composes: {"$result": "key"} instead of
    // "$result:key" — previously rendered "[object Object]" in StatCards
    // and a dict instead of rows in charts.
    const raw = [
      '{"op":"add","path":"/root","value":"cell"}',
      '{"op":"add","path":"/elements/cell","value":{"type":"LayoutColumn","props":{"gap":4},"children":["stat","chart"]}}',
      '{"op":"add","path":"/elements/stat","value":{"type":"StatCard","props":{"label":"Total","value":{"$result":"total_revenue"}}}}',
      '{"op":"add","path":"/elements/chart","value":{"type":"BarChart","props":{"title":null,"data":{"$chartData":"bars"},"x_key":"region","y_keys":["revenue"]}}}',
    ].join("\n");

    const spec = assembleCellSpec(raw, RESULTS, CHART_DATA);
    expect(spec).not.toBeNull();
    const stat = spec!.elements.stat as unknown as { props: { value: unknown } };
    expect(stat.props.value).toBe(142300);
    const chart = spec!.elements.chart as unknown as { props: { data: unknown } };
    expect(chart.props.data).toEqual(CHART_DATA.bars);
  });
});

describe("flattenResultScalars", () => {
  it("flattens nested objects into scalar leaf keys with safe names", () => {
    const flat = flattenResultScalars({
      total: 100,
      region_summaries: {
        "Asia Pacific": { total_growth_pct_6m: 142.5, top_product: "Cloud" },
        Europe: { total_growth_pct_6m: 115.04 },
      },
    });
    expect(flat.total).toBe(100);
    expect(flat.region_summaries_Asia_Pacific_total_growth_pct_6m).toBe(142.5);
    expect(flat.region_summaries_Asia_Pacific_top_product).toBe("Cloud");
    expect(flat.region_summaries_Europe_total_growth_pct_6m).toBe(115.04);
    // Every key is placeholder-safe
    for (const k of Object.keys(flat)) expect(k).toMatch(/^[a-zA-Z0-9_]+$/);
  });

  it("unwraps {value, format} wrappers and keeps short scalar arrays", () => {
    const flat = flattenResultScalars({
      revenue: { value: 506, format: "n0", label: "Total Deals" },
      top_regions: ["North", "South"],
      rows: [{ a: 1 }, { a: 2 }], // row-like — dropped
    });
    expect(flat.revenue).toBe(506);
    expect(flat.top_regions).toEqual(["North", "South"]);
    expect(flat.rows).toBeUndefined();
  });
});
