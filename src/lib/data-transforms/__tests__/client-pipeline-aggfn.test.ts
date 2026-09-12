/**
 * Aggregation-fn vocabulary robustness (run 861ef499): the composer's LLM
 * writes pandas names ("mean") where the documented vocabulary says "avg",
 * and nothing validates the fn — the unknown name fell through the switch to
 * `undefined`, silently DROPPING every aggregated column. Charts bound to
 * those columns rendered empty and a downstream percent() produced NaN.
 * Aliases are first-class now; a truly unknown fn yields NaN (visible, never
 * a fabricated number, never a silently absent column).
 */
import { describe, it, expect } from "vitest";
import { executePipeline, type PipelineStep } from "../client-pipeline";

const ROWS = [
  { year: 2010, band: "a", pct: 10, households: 100 },
  { year: 2010, band: "b", pct: 30, households: 300 },
  { year: 2011, band: "a", pct: 20, households: 200 },
  { year: 2011, band: "b", pct: 40, households: 400 },
];

const groupBy = (fn: string): PipelineStep[] => [
  {
    op: "groupBy",
    columns: ["year"],
    aggregations: [
      { column: "pct", fn: fn as never, as: "pct" },
      { column: "households", fn: "sum", as: "households" },
    ],
  },
  { op: "sort", column: "year", direction: "asc" },
];

describe("aggregation fn aliases (the run-861ef499 blank-chart bug)", () => {
  it('"mean" aggregates identically to "avg" — the column is PRESENT with the right value', () => {
    const viaMean = executePipeline(ROWS, groupBy("mean"), {}, []);
    const viaAvg = executePipeline(ROWS, groupBy("avg"), {}, []);
    expect(viaMean).toEqual(viaAvg);
    expect(viaMean).toEqual([
      { year: 2010, pct: 20, households: 400 },
      { year: 2011, pct: 30, households: 600 },
    ]);
  });

  it('"average" and "unique"/"distinct" resolve to their canonical fns', () => {
    const avg = executePipeline(ROWS, groupBy("average"), {}, []);
    expect(avg[0]!.pct).toBe(20);
    const uniq = executePipeline(
      ROWS,
      [
        {
          op: "groupBy",
          columns: [],
          aggregations: [{ column: "band", fn: "unique" as never, as: "bands" }],
        },
      ],
      {},
      []
    );
    expect(uniq[0]!.bands).toBe(2);
  });

  it("a truly unknown fn yields NaN — present and visibly broken, never a fabricated number or a dropped column", () => {
    const rows = executePipeline(ROWS, groupBy("stddev"), {}, []);
    expect(rows[0]).toHaveProperty("pct");
    expect(Number.isNaN(rows[0]!.pct)).toBe(true);
    // the well-formed sibling aggregation is unaffected
    expect(rows[0]!.households).toBe(400);
  });
});
