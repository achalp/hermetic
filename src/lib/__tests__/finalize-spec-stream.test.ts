import { describe, it, expect } from "vitest";
import { createSpecFinalizer } from "@/lib/llm/finalize-spec-stream";

describe("createSpecFinalizer", () => {
  it("skips blank and fenced lines", () => {
    const f = createSpecFinalizer({ results: {}, chartData: {} });
    expect(f("").skip).toBe(true);
    expect(f("   ").skip).toBe(true);
    expect(f("```json").skip).toBe(true);
  });

  it("resolves $result placeholders via the shared resolver", () => {
    const f = createSpecFinalizer({ results: { total: 1234 }, chartData: {} });
    const r = f('{"op":"add","path":"/elements/s","value":{"props":{"value":"$result:total"}}}');
    expect(r.skip).toBe(false);
    expect(r.line).toContain('"value":1234');
    expect(r.patch?.path).toBe("/elements/s");
  });

  it("resolves $chartData placeholders", () => {
    const data = [{ x: 1 }, { x: 2 }];
    const f = createSpecFinalizer({ results: {}, chartData: { bars: data } });
    const r = f('{"op":"add","path":"/elements/c","value":{"props":{"data":"$chartData:bars"}}}');
    expect(r.line).toContain('"data":[{"x":1},{"x":2}]');
  });

  it("inlines image placeholders before resolution", () => {
    const f = createSpecFinalizer({
      results: {},
      chartData: {},
      imagePlaceholders: { fig1: "data:image/png;base64,AAA" },
    });
    const r = f(
      '{"op":"add","path":"/elements/i","value":{"props":{"src":"IMAGE_PLACEHOLDER_fig1"}}}'
    );
    expect(r.line).toContain("data:image/png;base64,AAA");
  });

  it("repairs drifted $state bindings when validStateKeys is supplied", () => {
    const f = createSpecFinalizer({
      results: {},
      chartData: {},
      validStateKeys: { computed: new Set(["windrose"]), datasets: new Set(["main"]) },
    });
    const r = f(
      '{"op":"add","path":"/elements/w","value":{"type":"WindRose","props":{"data":{"$state":"/computed/wind_rose"}}}}'
    );
    expect(r.line).toContain("/computed/windrose");
    expect(r.line).not.toContain("wind_rose");
  });

  it("harvests DataController outputs so a later chart binding repairs", () => {
    const valid = { computed: new Set<string>(), datasets: new Set<string>() };
    const f = createSpecFinalizer({ results: {}, chartData: {}, validStateKeys: valid });
    // DataController declares /computed/sales_data
    f(
      '{"op":"add","path":"/elements/dc","value":{"type":"DataController","props":{"outputs":[{"statePath":"/computed/sales_data"}]}}}'
    );
    // Later chart drifts to /computed/salesdata → repaired
    const r = f(
      '{"op":"add","path":"/elements/bar","value":{"type":"BarChart","props":{"data":{"$state":"/computed/salesdata"}}}}'
    );
    expect(r.line).toContain("/computed/sales_data");
  });

  it("runs mutatePatch and re-serializes when it mutates", () => {
    const f = createSpecFinalizer({
      results: {},
      chartData: {},
      mutatePatch: (patch) => {
        if (patch.path === "/state" && patch.value && typeof patch.value === "object") {
          (patch.value as Record<string, unknown>).injected = true;
          return true;
        }
        return false;
      },
    });
    const r = f('{"op":"add","path":"/state","value":{"a":1}}');
    expect(r.line).toContain('"injected":true');
  });

  it("passes non-JSON lines through untouched with a null patch", () => {
    const f = createSpecFinalizer({ results: {}, chartData: {} });
    const r = f("not json {partial");
    expect(r.skip).toBe(false);
    expect(r.patch).toBeNull();
    expect(r.line).toBe("not json {partial");
  });

  it("exposes the trimmed pre-resolution raw line", () => {
    const f = createSpecFinalizer({ results: { x: 1 }, chartData: {} });
    const r = f('  {"v":"$result:x"}  ');
    expect(r.raw).toBe('{"v":"$result:x"}');
    expect(r.line).toContain('"v":1');
  });
});
