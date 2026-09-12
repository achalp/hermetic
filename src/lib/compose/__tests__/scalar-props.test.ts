/**
 * Regression: the `[object Object]` StatCard in the King County correlation
 * dashboard.
 *
 * `hermetic_injected_tile_0` carried the whole correlation record as its value —
 * {pearson_r: 0.2637, pearson_p: 0.3422…, spearman_rho: 0.0893, spearman_p: …,
 * n: 15} — and the renderer string-coerced it. It sat beside a working card
 * showing the same 0.2637, because the injector's dedupe compares String(value):
 * "[object Object]" never matches "0.2637", so the duplicate passed the check
 * that exists to stop duplicates. One cause, two symptoms.
 */
import { describe, it, expect } from "vitest";
import { lintScalarProps, recoverScalar, scalarPropKeys } from "@/lib/compose/scalar-props";

/** The real tile from the run. */
const correlationRecord = {
  pearson_r: 0.2637,
  pearson_p: 0.3422322042236519,
  spearman_rho: 0.0893,
  spearman_p: 0.751672517350277,
  n: 15,
};

describe("scalarPropKeys (catalog-derived)", () => {
  it("finds the scalar props the schema actually declares", () => {
    const statCard = scalarPropKeys("StatCard");
    expect(statCard.has("label")).toBe(true);
    expect(statCard.has("description")).toBe(true);
  });

  it("exempts props that legitimately hold objects or rows", () => {
    // A chart's `data` must never be treated as a scalar slot.
    expect(scalarPropKeys("LineChart").has("data")).toBe(false);
  });

  it("does not rely on the catalog for StatCard.value, which is z.unknown()", () => {
    // value is untyped ON PURPOSE (it may hold a $state reference), so the
    // catalog cannot classify it — the lint checks it by name instead. If this
    // ever starts returning true the by-name list can shrink.
    expect(scalarPropKeys("StatCard").has("value")).toBe(false);
  });
});

describe("recoverScalar", () => {
  it("picks the headline statistic out of a correlation record", () => {
    expect(recoverScalar(correlationRecord)).toBe(0.2637);
  });

  it("takes the only scalar when a record has exactly one", () => {
    expect(recoverScalar({ total: 42, meta: { a: 1 } })).toBe(42);
  });

  it("refuses to guess when several scalars compete and none is conventional", () => {
    expect(recoverScalar({ alpha: 1, beta: 2, gamma: 3 })).toBeUndefined();
  });
});

describe("lintScalarProps", () => {
  it("repairs the observed [object Object] tile to the number it contained", () => {
    const elements = {
      hermetic_injected_tile_0: {
        type: "StatCard",
        props: { label: "Corr Vacancy Rate Vs Homeless Rate", value: correlationRecord },
        children: [],
      },
    };
    const { fixed, unrenderable } = lintScalarProps(elements);
    expect(unrenderable).toEqual([]);
    expect(fixed).toEqual([
      { elementId: "hermetic_injected_tile_0", prop: "value", recovered: 0.2637 },
    ]);
    expect(elements.hermetic_injected_tile_0.props.value).toBe(0.2637);
  });

  it("leaves a $state reference alone — rewriting it would freeze a live binding", () => {
    const elements = {
      tile: {
        type: "StatCard",
        props: { label: "Live", value: { $state: "/computed/current" } },
        children: [],
      },
    };
    const { fixed, unrenderable } = lintScalarProps(elements);
    expect(fixed).toEqual([]);
    expect(unrenderable).toEqual([]);
    expect(elements.tile.props.value).toEqual({ $state: "/computed/current" });
  });

  it("never touches a chart's data rows", () => {
    const rows = [{ year: "2015", gap: 1 }];
    const elements = {
      chart: { type: "LineChart", props: { title: "T", x_key: "year", data: rows }, children: [] },
    };
    const { fixed, unrenderable } = lintScalarProps(elements);
    expect(fixed).toEqual([]);
    expect(unrenderable).toEqual([]);
    expect(elements.chart.props.data).toBe(rows);
  });

  it("reports an unrecoverable object instead of inventing a number", () => {
    const elements = {
      tile: {
        type: "StatCard",
        props: { label: "Ambiguous", value: { alpha: 1, beta: 2, gamma: 3 } },
        children: [],
      },
    };
    const { fixed, unrenderable } = lintScalarProps(elements);
    expect(fixed).toEqual([]);
    expect(unrenderable).toEqual([
      { elementId: "tile", prop: "value", objectKeys: ["alpha", "beta", "gamma"] },
    ]);
    // Left as-is for the caller to decide — the lint does not silently blank it.
    expect(elements.tile.props.value).toEqual({ alpha: 1, beta: 2, gamma: 3 });
  });

  it("flags an array in a value slot", () => {
    const elements = {
      tile: { type: "StatCard", props: { label: "L", value: [1, 2, 3] }, children: [] },
    };
    expect(lintScalarProps(elements).unrenderable[0]).toMatchObject({
      prop: "value",
      objectKeys: ["array(3)"],
    });
  });

  it("is a no-op on a healthy spec", () => {
    const elements = {
      tile: { type: "StatCard", props: { label: "L", value: 0.26 }, children: [] },
      text: { type: "TextBlock", props: { content: "hi" }, children: [] },
    };
    expect(lintScalarProps(elements)).toEqual({ fixed: [], unrenderable: [] });
  });

  it("tolerates ragged wire shapes without throwing", () => {
    expect(() =>
      lintScalarProps({
        a: null,
        b: "not-an-element",
        c: { type: 42 },
        d: { type: "StatCard" },
        e: { type: "StatCard", props: null },
      } as unknown as Record<string, unknown>)
    ).not.toThrow();
  });
});
