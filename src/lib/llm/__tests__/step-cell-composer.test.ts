import { describe, it, expect } from "vitest";
import { assembleCellSpec } from "@/lib/llm/step-cell-composer";

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
});
