/**
 * Targeted recipe repair: a failing DataController recipe gets one validated
 * LLM correction; a verified repair keeps interactivity, everything else
 * strips to the static seed (the audit's floor). Injected `generate` — no LLM.
 */
import { describe, it, expect, vi } from "vitest";
import { auditControllerRecipes } from "@/lib/pipeline/controller-recipe-audit";
import {
  repairControllerRecipes,
  parseRepairReply,
  buildRepairPrompt,
  REPAIR_CAP,
} from "@/lib/pipeline/controller-recipe-repair";
import type { PatchLike } from "@/lib/pipeline/computed-key-audit";

const MAIN = [
  { year: 2023, band: "low", pct: 40, households: 400 },
  { year: 2023, band: "high", pct: 60, households: 600 },
  { year: 2024, band: "low", pct: 48, households: 500 },
  { year: 2024, band: "high", pct: 52, households: 540 },
];

// The run-861ef499 shape: a latest-year seed under an all-years mean recipe.
const WRONG_PIPELINE = [
  { op: "groupBy", columns: ["band"], aggregations: [{ column: "pct", fn: "mean", as: "pct" }] },
];
const FIXED_PIPELINE = [
  { op: "topN", column: "year", n: 2, direction: "desc" },
  { op: "groupBy", columns: ["band"], aggregations: [{ column: "pct", fn: "mean", as: "pct" }] },
];

const patches = (): PatchLike[] => [
  {
    op: "add",
    path: "/state",
    value: { filters: { year: "All" }, datasets: { main: MAIN } },
  },
  {
    op: "add",
    path: "/elements/data-ctrl",
    value: {
      type: "DataController",
      props: {
        source: { statePath: "/datasets/main" },
        filters: [{ key: "year", column: "year", bindTo: "/filters/year", allowAll: true }],
        pipeline: [{ op: "filter" }],
        outputs: [{ statePath: "/computed/band_dist", pipeline: WRONG_PIPELINE }],
      },
      children: [],
    },
  },
  {
    op: "add",
    path: "/state/computed/band_dist",
    value: [
      { band: "low", pct: 48 },
      { band: "high", pct: 52 },
    ],
  },
];

describe("repairControllerRecipes", () => {
  it("a validated repair KEEPS the output with the corrected pipeline", async () => {
    const p = patches();
    const { failures } = auditControllerRecipes(p);
    expect(failures).toHaveLength(1);

    const generate = vi.fn(async () => JSON.stringify({ pipeline: FIXED_PIPELINE }));
    const result = await repairControllerRecipes(p, failures, generate);

    expect(result.repaired).toEqual([{ elementId: "data-ctrl", statePath: "/computed/band_dist" }]);
    expect(result.stripped).toEqual([]);
    const el = result.patches[0]!.value as { props: { outputs: { pipeline: unknown }[] } };
    expect(el.props.outputs).toHaveLength(1);
    expect(el.props.outputs[0]!.pipeline).toEqual(FIXED_PIPELINE);
  });

  it("an unparseable or still-wrong repair STRIPS the output (the audit floor)", async () => {
    const p = patches();
    const { failures } = auditControllerRecipes(p);

    for (const reply of ["not json at all", JSON.stringify({ pipeline: WRONG_PIPELINE })]) {
      const result = await repairControllerRecipes(p, failures, async () => reply);
      expect(result.repaired).toEqual([]);
      expect(result.stripped).toHaveLength(1);
      const el = result.patches[0]!.value as { props: { outputs: unknown[] } };
      expect(el.props.outputs).toEqual([]);
    }
  });

  it("a throwing generate still strips cleanly (repair is best-effort)", async () => {
    const p = patches();
    const { failures } = auditControllerRecipes(p);
    const result = await repairControllerRecipes(p, failures, async () => {
      throw new Error("llm down");
    });
    expect(result.stripped).toHaveLength(1);
    expect(result.patches).toHaveLength(1);
  });

  it("caps repair attempts; overflow failures strip WITHOUT a generate call", async () => {
    const p = patches();
    const { failures } = auditControllerRecipes(p);
    const many = Array.from({ length: REPAIR_CAP + 2 }, (_, i) => ({
      ...failures[0]!,
      statePath: `/computed/out_${i}`,
    }));
    const generate = vi.fn(async () => "garbage");
    const result = await repairControllerRecipes(p, many, generate);
    expect(generate).toHaveBeenCalledTimes(REPAIR_CAP);
    expect(result.stripped).toHaveLength(REPAIR_CAP + 2);
  });
});

describe("parseRepairReply / buildRepairPrompt", () => {
  it("parses a fenced or prefixed JSON object and rejects non-pipelines", () => {
    expect(parseRepairReply(`Sure!\n{"pipeline": [{"op": "filter"}]}`)).toEqual([{ op: "filter" }]);
    expect(parseRepairReply(`{"pipeline": []}`)).toBeNull();
    expect(parseRepairReply(`{"pipeline": [{"noop": true}]}`)).toBeNull();
    expect(parseRepairReply(`nothing here`)).toBeNull();
  });

  it("the prompt carries the dataset shape, the seed target, and the wrong recipe", () => {
    const { failures } = auditControllerRecipes(patches());
    const prompt = buildRepairPrompt(failures[0]!);
    expect(prompt).toContain("year, band, pct, households");
    expect(prompt).toContain('"band":"low","pct":48');
    expect(prompt).toContain('"fn":"mean"');
    expect(prompt).toContain('{"pipeline": [...]}');
  });
});
