/**
 * Baseline replay for DataController recipes — shapes lifted from run
 * 861ef499: a "Latest Year" chart whose recipe aggregated ALL years shipped
 * wrong figures the moment the controller mounted, and unverified recipes had
 * no gate at all. A recipe that cannot reproduce its own Python-derived seed
 * is stripped (the chart stays on the seed); one that reproduces it survives.
 */
import { describe, it, expect } from "vitest";
import { auditControllerRecipes, framesMatch } from "@/lib/pipeline/controller-recipe-audit";
import type { PatchLike } from "@/lib/pipeline/computed-key-audit";

// Two years × two bands: latest-year pct differs from the all-years mean, so
// an all-years recipe cannot reproduce a latest-year seed.
const MAIN = [
  { year: 2023, band: "low", pct: 40, households: 400 },
  { year: 2023, band: "high", pct: 60, households: 600 },
  { year: 2024, band: "low", pct: 48, households: 500 },
  { year: 2024, band: "high", pct: 52, households: 540 },
];

const controller = (outputs: unknown[]): PatchLike[] => [
  { op: "add", path: "/state", value: { filters: { year: "All" }, datasets: { main: MAIN } } },
  {
    op: "add",
    path: "/elements/data-ctrl",
    value: {
      type: "DataController",
      props: {
        source: { statePath: "/datasets/main" },
        filters: [{ key: "year", column: "year", bindTo: "/filters/year", allowAll: true }],
        pipeline: [{ op: "filter" }],
        outputs,
      },
      children: [],
    },
  },
];

const seedPatch = (path: string, rows: unknown[]): PatchLike => ({
  op: "add",
  path: `/state${path}`,
  value: rows,
});

describe("auditControllerRecipes", () => {
  it("keeps a recipe that reproduces its seed (numeric-vs-string years, python rounding tolerated)", () => {
    const patches = [
      ...controller([
        {
          statePath: "/computed/by_year",
          pipeline: [
            {
              op: "groupBy",
              columns: ["year"],
              aggregations: [{ column: "households", fn: "sum", as: "households" }],
            },
            { op: "sort", column: "year", direction: "asc" },
          ],
        },
      ]),
      // Seed as Python wrote it: string years, 1-dp rounding.
      seedPatch("/computed/by_year", [
        { year: "2023", households: 1000 },
        { year: "2024", households: 1040 },
      ]),
    ];
    const audit = auditControllerRecipes(patches);
    expect(audit.stripped).toEqual([]);
    expect(audit.correctedPatches).toEqual([]);
  });

  it("STRIPS the run-861ef499 shape: an all-years recipe under a latest-year seed", () => {
    const patches = [
      ...controller([
        {
          statePath: "/computed/band_dist",
          pipeline: [
            {
              op: "groupBy",
              columns: ["band"],
              aggregations: [{ column: "pct", fn: "mean", as: "pct" }],
            },
          ],
        },
      ]),
      // The seed holds LATEST-YEAR values; the recipe means across all years
      // (low: 44 vs seeded 48 — beyond rounding tolerance).
      seedPatch("/computed/band_dist", [
        { band: "low", pct: 48 },
        { band: "high", pct: 52 },
      ]),
    ];
    const audit = auditControllerRecipes(patches);
    expect(audit.stripped).toEqual([{ elementId: "data-ctrl", statePath: "/computed/band_dist" }]);
    expect(audit.correctedPatches).toHaveLength(1);
    const fixed = audit.correctedPatches[0]!.value as {
      props: { outputs: unknown[]; filters: unknown[] };
    };
    expect(fixed.props.outputs).toEqual([]); // the bad output is gone
    expect(fixed.props.filters).toHaveLength(1); // the rest of the controller survives
  });

  it("strips an output whose aggregated column would not survive (unknown fn → NaN ≠ seed)", () => {
    const patches = [
      ...controller([
        {
          statePath: "/computed/x",
          pipeline: [
            {
              op: "groupBy",
              columns: ["year"],
              aggregations: [{ column: "pct", fn: "stddev", as: "pct" }],
            },
          ],
        },
      ]),
      seedPatch("/computed/x", [
        { year: "2023", pct: 50 },
        { year: "2024", pct: 50 },
      ]),
    ];
    expect(auditControllerRecipes(patches).stripped).toHaveLength(1);
  });

  it("only strips the failing output; a sibling that replays clean survives", () => {
    const patches = [
      ...controller([
        {
          statePath: "/computed/good",
          pipeline: [
            {
              op: "groupBy",
              columns: ["year"],
              aggregations: [{ column: "households", fn: "sum", as: "households" }],
            },
          ],
        },
        {
          statePath: "/computed/bad",
          pipeline: [
            {
              op: "groupBy",
              columns: ["band"],
              aggregations: [{ column: "pct", fn: "mean", as: "pct" }],
            },
          ],
        },
      ]),
      seedPatch("/computed/good", [
        { year: "2023", households: 1000 },
        { year: "2024", households: 1040 },
      ]),
      seedPatch("/computed/bad", [
        { band: "low", pct: 48 },
        { band: "high", pct: 52 },
      ]),
    ];
    const audit = auditControllerRecipes(patches);
    expect(audit.stripped.map((s) => s.statePath)).toEqual(["/computed/bad"]);
    const fixed = audit.correctedPatches[0]!.value as {
      props: { outputs: { statePath: string }[] };
    };
    expect(fixed.props.outputs.map((o) => o.statePath)).toEqual(["/computed/good"]);
  });

  it("consumer-aware: a recipe may drop a seed column NO element reads (run 861ef499 renter shape)", () => {
    const patches = [
      ...controller([
        {
          statePath: "/computed/renter",
          pipeline: [
            {
              op: "groupBy",
              columns: ["year"],
              aggregations: [{ column: "households", fn: "sum", as: "households" }],
            },
            { op: "sort", column: "year", direction: "asc" },
          ],
        },
      ]),
      // Seed carries an extra Python-derived column the chart never binds.
      seedPatch("/computed/renter", [
        { year: "2023", households: 1000, python_only_label: "a" },
        { year: "2024", households: 1040, python_only_label: "b" },
      ]),
      {
        op: "add",
        path: "/elements/renter-chart",
        value: {
          type: "LineChart",
          props: {
            data: { $state: "/computed/renter" },
            x_key: "year",
            y_keys: ["households"],
          },
          children: [],
        },
      },
    ];
    expect(auditControllerRecipes(patches).stripped).toEqual([]);
  });

  it("leaves alone what it cannot prove: empty seeds, non-rows formats, shared-pipeline outputs", () => {
    const patches = [
      ...controller([
        { statePath: "/computed/unseeded", pipeline: [{ op: "filter" }] },
        { statePath: "/computed/stats", format: "stats", pipeline: [{ op: "filter" }] },
        { statePath: "/computed/shared" }, // no own pipeline
      ]),
      seedPatch("/computed/stats", [{ total: 1 }]),
      seedPatch("/computed/shared", [{ a: 1 }]),
    ];
    const audit = auditControllerRecipes(patches);
    expect(audit.stripped).toEqual([]);
  });
});

describe("framesMatch tolerances", () => {
  it("tolerates 1-dp python rounding and 1% float drift, in any row order", () => {
    expect(
      framesMatch(
        [
          { year: "2024", pct: 47.1 },
          { year: "2010", pct: 49.6 },
        ],
        [
          { year: 2010, pct: 49.60000000000001 },
          { year: 2024, pct: 47.149 },
        ]
      )
    ).toBe(true);
  });

  it("rejects real drift and missing seed columns", () => {
    expect(framesMatch([{ pct: 17.1 }], [{ pct: 16.54 }])).toBe(false);
    expect(framesMatch([{ pct: 17.1 }], [{ other: 17.1 }])).toBe(false);
    expect(framesMatch([{ a: 1 }, { a: 2 }], [{ a: 1 }])).toBe(false);
  });
});
