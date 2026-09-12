/**
 * Regression: run 175e9f0a, "explain the housing gap in king county, WA".
 *
 * The composer emitted 12 elements and a root whose children were
 * ['header-text', 'caveat-annotation', 'dc-main'] — with `dc-main` never
 * defined. The renderer walks root through `children`, so nine elements (three
 * StatCards, an AreaChart, a BarChart, a LineChart, two grids, the narrative)
 * were unreachable and simply did not appear. The user saw a title and a caveat.
 *
 * Nothing failed: the analysis produced four chart series with real rows, all
 * correctly bound, and the run reported outcome "ok". `meta.chartTypes` recorded
 * ['TextBlock','Annotation'] — the system knew it had rendered almost nothing.
 *
 * The fixture below is that spec's exact shape.
 */
import { describe, it, expect } from "vitest";
import { analyzeReachability, repairReachability } from "@/lib/compose/reachability";

/** The real tree from run 175e9f0a. */
const brokenSpec = {
  root: "root-col",
  elements: {
    "root-col": {
      type: "LayoutColumn",
      props: { gap: 16 },
      children: ["header-text", "caveat-annotation", "dc-main"],
    },
    "header-text": { type: "TextBlock", props: {}, children: [] },
    "caveat-annotation": { type: "Annotation", props: {}, children: [] },
    "headline-grid": {
      type: "LayoutGrid",
      props: {},
      children: ["tile-gap", "tile-year", "tile-ami"],
    },
    "tile-gap": { type: "StatCard", props: {}, children: [] },
    "tile-year": { type: "StatCard", props: {}, children: [] },
    "tile-ami": { type: "StatCard", props: {}, children: [] },
    "charts-row": {
      type: "LayoutGrid",
      props: {},
      children: ["annual-gap-chart", "band-gap-chart"],
    },
    "annual-gap-chart": { type: "AreaChart", props: {}, children: [] },
    "band-gap-chart": { type: "BarChart", props: {}, children: [] },
    "band-year-chart": { type: "LineChart", props: {}, children: [] },
    "narrative-block": { type: "TextBlock", props: {}, children: [] },
  },
};

describe("analyzeReachability", () => {
  it("names the dangling reference and every element it stranded", () => {
    const { missing, orphaned } = analyzeReachability(brokenSpec);
    expect(missing).toEqual(["dc-main"]);
    expect(orphaned).toEqual([
      "headline-grid",
      "tile-gap",
      "tile-year",
      "tile-ami",
      "charts-row",
      "annual-gap-chart",
      "band-gap-chart",
      "band-year-chart",
      "narrative-block",
    ]);
  });

  it("reports nothing for a sound tree", () => {
    const ok = {
      root: "r",
      elements: {
        r: { type: "LayoutColumn", children: ["a"] },
        a: { type: "TextBlock", children: [] },
      },
    };
    expect(analyzeReachability(ok)).toEqual({ missing: [], orphaned: [] });
  });

  it("survives cycles instead of spinning", () => {
    const cyclic = {
      root: "a",
      elements: {
        a: { type: "LayoutColumn", children: ["b"] },
        b: { type: "LayoutColumn", children: ["a"] },
      },
    };
    expect(analyzeReachability(cyclic)).toEqual({ missing: [], orphaned: [] });
  });

  it("tolerates the untyped wire shape — missing/!array children", () => {
    const ragged = {
      root: "r",
      elements: {
        r: { type: "LayoutColumn", children: ["leaf", "weird"] },
        leaf: { type: "TextBlock" },
        weird: { type: "TextBlock", children: "not-an-array" },
      },
    };
    expect(analyzeReachability(ragged)).toEqual({ missing: [], orphaned: [] });
  });
});

describe("repairReachability", () => {
  it("rebuilds the missing container with the orphans in declaration order", () => {
    const { synthesized, unresolved } = repairReachability(brokenSpec);
    expect(Object.keys(synthesized)).toEqual(["dc-main"]);
    const container = synthesized["dc-main"]!;
    expect(container.type).toBe("LayoutColumn");
    // Declaration order is the order the composer intended them read.
    expect(container.children[0]).toBe("headline-grid");
    expect(container.children).toHaveLength(9);
    expect(unresolved).toEqual([]);
  });

  it("makes the whole tree reachable once applied — the charts come back", () => {
    const { synthesized } = repairReachability(brokenSpec);
    const repaired = {
      root: brokenSpec.root,
      elements: { ...brokenSpec.elements, ...synthesized },
    };
    const after = analyzeReachability(repaired);
    expect(after).toEqual({ missing: [], orphaned: [] });
  });

  it("does nothing to a sound spec", () => {
    const ok = { root: "r", elements: { r: { type: "LayoutColumn", children: [] } } };
    expect(repairReachability(ok)).toEqual({
      report: { missing: [], orphaned: [] },
      synthesized: {},
      unresolved: [],
    });
  });

  it("REFUSES to guess when several ids are missing", () => {
    // Which orphan belongs under which container is unknowable; inventing a
    // layout the model never described is worse than reporting the failure.
    const twoHoles = {
      root: "r",
      elements: {
        r: { type: "LayoutColumn", children: ["gone-a", "gone-b"] },
        orphan: { type: "BarChart", children: [] },
      },
    };
    const { synthesized, unresolved } = repairReachability(twoHoles);
    expect(synthesized).toEqual({});
    expect(unresolved).toEqual(["orphan"]);
  });

  it("does not synthesize an empty container when nothing was stranded", () => {
    const danglingOnly = {
      root: "r",
      elements: { r: { type: "LayoutColumn", children: ["gone"] } },
    };
    const { synthesized, unresolved } = repairReachability(danglingOnly);
    expect(synthesized).toEqual({});
    expect(unresolved).toEqual([]);
  });
});
