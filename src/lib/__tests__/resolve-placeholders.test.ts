import { describe, it, expect } from "vitest";
import { resolveSpecPlaceholders } from "@/lib/llm/resolve-placeholders";

describe("resolveSpecPlaceholders — $result", () => {
  it("substitutes a standalone string placeholder with the raw JSON value", () => {
    const line =
      '{"op":"add","path":"/elements/k1","value":{"type":"StatCard","value":"$result:total"}}';
    const out = resolveSpecPlaceholders(line, { total: 1234 }, {});
    expect(out).toContain('"value":1234');
  });

  it("substitutes step_N_-prefixed keys (investigate use case)", () => {
    const line = '{"value":"$result:step_2_total_revenue"}';
    const out = resolveSpecPlaceholders(line, { step_2_total_revenue: 5000 }, {});
    expect(out).toBe('{"value":5000}');
  });

  it("formats inline placeholders inside strings as humanized text", () => {
    const line = '{"text":"Revenue grew to $result:step_1_revenue this quarter"}';
    const out = resolveSpecPlaceholders(line, { step_1_revenue: 1234.5678 }, {});
    expect(out).toContain("1234.5678");
    expect(out).not.toContain("$result");
  });

  it("formats integers without trailing decimals", () => {
    const line = '{"text":"Total: $result:n"}';
    const out = resolveSpecPlaceholders(line, { n: 42 }, {});
    expect(out).toBe('{"text":"Total: 42"}');
  });

  it("trims numbers to 4 decimal places", () => {
    const line = '{"text":"Avg: $result:m"}';
    const out = resolveSpecPlaceholders(line, { m: 3.14159265 }, {});
    expect(out).toBe('{"text":"Avg: 3.1416"}');
  });

  it("refuses booleans inline — a flag in a word slot is stripped, never rendered", () => {
    // Was: rendered "Yes"/"No". A values-blind composer can't know a key is a
    // flag, so "rates are Yes"-class prose is prevented at the resolver seam.
    const line = '{"text":"Significant: $result:sig"}';
    const out = resolveSpecPlaceholders(line, { sig: true }, {});
    expect(out).toBe('{"text":""}');
    expect(out).not.toContain("Yes");
  });

  it("blanks an unresolved placeholder to null — never leaks the raw token to the UI", () => {
    const line = '{"value":"$result:nonexistent"}';
    const out = resolveSpecPlaceholders(line, { other: 1 }, {});
    expect(out).toBe('{"value":null}');
    expect(out).not.toContain("$result:");
  });

  it("resolves nested dot-paths", () => {
    const line = '{"value":"$result:summary.avg_price"}';
    const out = resolveSpecPlaceholders(line, { summary: { avg_price: 7.5 } }, {});
    expect(out).toBe('{"value":7.5}');
  });

  it("matches greedy literal-dot keys (e.g. significant_at_0.05)", () => {
    const line = '{"value":"$result:significant_at_0.05"}';
    const out = resolveSpecPlaceholders(line, { "significant_at_0.05": true }, {});
    expect(out).toBe('{"value":true}');
  });

  it("resolves inline placeholder followed by closing paren", () => {
    const line = '{"text":"correlation (r = $result:corr) is strong"}';
    const out = resolveSpecPlaceholders(line, { corr: -0.85 }, {});
    expect(out).toBe('{"text":"correlation (r = -0.85) is strong"}');
  });

  it("resolves sentence-final inline placeholder followed by a period", () => {
    const line = '{"text":"Growth was led by $result:top_region."}';
    const out = resolveSpecPlaceholders(line, { top_region: "West" }, {});
    expect(out).toBe('{"text":"Growth was led by West."}');
  });

  it("resolves object-form result placeholders", () => {
    const line = '{"value":{"$result":"total"},"other":{ "$result" : "rate" }}';
    const out = resolveSpecPlaceholders(line, { total: 506, rate: 0.12 }, {});
    expect(out).toBe('{"value":506,"other":0.12}');
  });

  it("resolves object-form chartData placeholders and nulls unresolved ones", () => {
    const line = '{"data":{"$chartData":"bars"},"missing":{"$chartData":"nope"}}';
    const out = resolveSpecPlaceholders(line, {}, { bars: [{ x: 1 }] });
    expect(out).toBe('{"data":[{"x":1}],"missing":null}');
  });

  it("leaves unresolved object-form result placeholders intact", () => {
    const line = '{"value":{"$result":"nonexistent"}}';
    const out = resolveSpecPlaceholders(line, { other: 1 }, {});
    expect(out).toBe(line);
  });

  it("unwraps single-key {rows: [...]} chart data wrappers", () => {
    const line = '{"data":"$chartData:trend"}';
    const out = resolveSpecPlaceholders(line, {}, { trend: { rows: [{ m: "Jan", v: 1 }] } });
    expect(out).toBe('{"data":[{"m":"Jan","v":1}]}');
  });

  it("unwraps full chart-config payloads ({data, x_key, y_keys}) to the rows array", () => {
    const line = '{"data":"$chartData:trend"}';
    const payload = { data: [{ month: "Jan", north: 1 }], x_key: "month", y_keys: ["north"] };
    const out = resolveSpecPlaceholders(line, {}, { trend: payload });
    expect(out).toBe('{"data":[{"month":"Jan","north":1}]}');
  });

  it("leaves multi-key chart data objects (named series, globe) untouched", () => {
    const line = '{"data":"$chartData:globe"}';
    const globe = { points: [{ lat: 1, lng: 2 }], arcs: [] };
    const out = resolveSpecPlaceholders(line, {}, { globe });
    expect(out).toBe(`{"data":${JSON.stringify(globe)}}`);
  });

  it("resolves inline placeholder followed by percent sign", () => {
    const line = '{"text":"Spread is $result:spread_pct% of revenue"}';
    const out = resolveSpecPlaceholders(line, { spread_pct: 23.4 }, {});
    expect(out).toBe('{"text":"Spread is 23.4% of revenue"}');
  });

  it("resolves inline placeholder followed by colon or semicolon", () => {
    const line = '{"text":"deals: $result:n; revenue: $result:rev;"}';
    const out = resolveSpecPlaceholders(line, { n: 42, rev: 1000 }, {});
    expect(out).toBe('{"text":"deals: 42; revenue: 1000;"}');
  });

  it("unwraps scalar-wrapped values like {value: N, format: 'n0'}", () => {
    const line = '{"props":{"value":"$result:total"}}';
    const out = resolveSpecPlaceholders(
      line,
      { total: { value: 506, format: "n0", label: "Total Deals" } },
      {}
    );
    expect(out).toBe('{"props":{"value":506}}');
  });

  it("unwraps scalar-wrapped string values", () => {
    const line = '{"props":{"value":"$result:top_product"}}';
    const out = resolveSpecPlaceholders(
      line,
      { top_product: { value: "Enterprise Suite", label: "Top Product" } },
      {}
    );
    expect(out).toBe('{"props":{"value":"Enterprise Suite"}}');
  });

  it("does NOT unwrap when object has unexpected non-presentation keys", () => {
    const line = '{"props":{"data":"$result:nested"}}';
    const nested = { value: 1, children: [1, 2, 3] };
    const out = resolveSpecPlaceholders(line, { nested }, {});
    expect(out).toBe('{"props":{"data":' + JSON.stringify(nested) + "}}");
  });

  it("does NOT unwrap when inner value is not a primitive", () => {
    const line = '{"props":{"data":"$result:wrap"}}';
    const wrap = { value: { nested: 1 }, format: "n0" };
    const out = resolveSpecPlaceholders(line, { wrap }, {});
    expect(out).toBe('{"props":{"data":' + JSON.stringify(wrap) + "}}");
  });
});

describe("resolveSpecPlaceholders — $chartData", () => {
  it("substitutes top-level chart data", () => {
    const line = '{"props":{"data":"$chartData:bar_data"}}';
    const data = [{ x: "A", y: 1 }];
    const out = resolveSpecPlaceholders(line, {}, { bar_data: data });
    expect(out).toContain(JSON.stringify(data));
  });

  it("substitutes nested keys with dot-notation", () => {
    const line = '{"props":{"z":"$chartData:heatmap.z"}}';
    const out = resolveSpecPlaceholders(line, {}, { heatmap: { z: [[1, 2]] } });
    expect(out).toContain('"z":[[1,2]]');
  });

  it("resolves step_N_-prefixed chart data keys", () => {
    const line = '{"props":{"data":"$chartData:step_3_trend"}}';
    const series = [{ x: 1, y: 1 }];
    const out = resolveSpecPlaceholders(line, {}, { step_3_trend: series });
    expect(out).toContain(JSON.stringify(series));
  });

  it("returns null for unresolved chartData placeholders", () => {
    const line = '{"props":{"data":"$chartData:missing"}}';
    const out = resolveSpecPlaceholders(line, {}, { other: [] });
    expect(out).toContain('"data":null');
  });
});
