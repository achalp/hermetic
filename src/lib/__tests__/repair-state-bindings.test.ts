import { describe, it, expect } from "vitest";
import {
  repairStateBindings,
  harvestStateKeys,
  type ValidStateKeys,
} from "@/lib/llm/resolve-placeholders";

const keys = (computed: string[], datasets: string[]): ValidStateKeys => ({
  computed: new Set(computed),
  datasets: new Set(datasets),
});

describe("repairStateBindings", () => {
  it("rewrites an underscore-drifted /computed binding to the produced key", () => {
    const valid = keys(["windrose"], ["main"]);
    const el = { type: "WindRose", props: { data: { $state: "/computed/wind_rose" } } };
    const n = repairStateBindings(el, valid);
    expect(n).toBe(1);
    expect(el.props.data.$state).toBe("/computed/windrose");
  });

  it("leaves an already-valid binding untouched", () => {
    const valid = keys(["windrose"], ["main"]);
    const el = { props: { data: { $state: "/computed/windrose" } } };
    expect(repairStateBindings(el, valid)).toBe(0);
    expect(el.props.data.$state).toBe("/computed/windrose");
  });

  it("preserves a trailing field path when repairing the base key", () => {
    const valid = keys(["stats"], []);
    const el = { props: { value: { $state: "/computed/Stats/revenue" } } };
    repairStateBindings(el, valid);
    expect(el.props.value.$state).toBe("/computed/stats/revenue");
  });

  it("repairs /datasets bindings too", () => {
    const valid = keys([], ["sales_main"]);
    const el = { props: { data: { $state: "/datasets/salesmain" } } };
    repairStateBindings(el, valid);
    expect(el.props.data.$state).toBe("/datasets/sales_main");
  });

  it("does not rewrite when no normalized match exists", () => {
    const valid = keys(["revenue"], ["main"]);
    const el = { props: { data: { $state: "/computed/totally_different" } } };
    expect(repairStateBindings(el, valid)).toBe(0);
    expect(el.props.data.$state).toBe("/computed/totally_different");
  });

  it("ignores non-$state objects and other prefixes", () => {
    const valid = keys(["windrose"], ["main"]);
    const el = { props: { ref: { $ref: "/computed/wind_rose" }, p: { $state: "/inputs/x" } } };
    expect(repairStateBindings(el, valid)).toBe(0);
  });

  it("walks arrays and deeply nested props", () => {
    const valid = keys(["a_b"], []);
    const el = { props: { series: [{ data: { $state: "/computed/ab" } }] } };
    repairStateBindings(el, valid);
    expect(el.props.series[0].data.$state).toBe("/computed/a_b");
  });
});

describe("harvestStateKeys", () => {
  it("collects DataController output statePaths", () => {
    const valid = keys([], []);
    harvestStateKeys(
      {
        op: "add",
        path: "/elements/dc1",
        value: {
          type: "DataController",
          props: { outputs: [{ statePath: "/computed/bar_data" }, { statePath: "/computed/pie" }] },
        },
      },
      valid
    );
    expect(valid.computed.has("bar_data")).toBe(true);
    expect(valid.computed.has("pie")).toBe(true);
  });

  it("collects keys from a /state seed object", () => {
    const valid = keys([], []);
    harvestStateKeys(
      { op: "add", path: "/state", value: { computed: { windrose: [] }, datasets: { main: [] } } },
      valid
    );
    expect(valid.computed.has("windrose")).toBe(true);
    expect(valid.datasets.has("main")).toBe(true);
  });

  it("collects from a direct /state/computed/<key> add", () => {
    const valid = keys([], []);
    harvestStateKeys({ op: "add", path: "/state/computed/windrose", value: [] }, valid);
    expect(valid.computed.has("windrose")).toBe(true);
  });

  it("end-to-end: harvested key enables a later repair", () => {
    const valid = keys([], []);
    harvestStateKeys({ op: "add", path: "/state/computed/windrose", value: [] }, valid);
    const el = { props: { data: { $state: "/computed/wind_rose" } } };
    repairStateBindings(el, valid);
    expect(el.props.data.$state).toBe("/computed/windrose");
  });
});
