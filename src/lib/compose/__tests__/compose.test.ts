import { describe, it, expect } from "vitest";
import {
  validatePlan,
  validateNodeText,
  defaultPlan,
  nextPlanNodeId,
  planBudget,
  salvagePlan as salvage,
  PLAN_OPS,
} from "@/lib/compose/plan";
import { buildPlannerSystem } from "@/lib/compose/planner";
import { deriveViews, viewDefaultWidths } from "@/lib/compose/views";
import { getEditSurface, resolvePreviewText } from "@/lib/compose/edit";
import { cacheArtifacts } from "@/lib/pipeline/artifacts-cache";
import { realizeClaim, realizeNode } from "@/lib/compose/realizer";
import { applyMutations } from "@/lib/compose/mutations";
import { compileDashboard } from "@/lib/compose/compile";
import { componentForSeries } from "@/lib/compose/scaffold";
import type { FindingEntry, FindingsManifest } from "@/lib/contracts/findings";
import type { PlanDocument } from "@/lib/contracts/plan";
import type { AnalysisProduct } from "@/lib/contracts/product";

const F = (name: string, dtype: string, value: unknown, extra: Partial<FindingEntry> = {}) =>
  ({
    name,
    dtype,
    definition: `${name} over the observed period`,
    value,
    ...extra,
  }) as FindingEntry;

const FINDINGS: FindingEntry[] = [
  F("price_trend", "direction", {
    direction: "rising",
    slope_per_period: 0.0616,
    p_value: 1.9e-12,
    slope_ci95: [0.0465, 0.0767],
  }),
  F("price_peak", "superlative", {
    period: "1998",
    value: 10,
    n: 731,
    raw_period: "2012",
    raw_value: 26,
    raw_n: 382,
    thin_periods_skipped: 47,
    thin_bar: 635.1,
  }),
  F("price_current_state", "current_state", {
    period: 1998,
    value: 10,
    pct_from_peak: 0,
    excluded_trailing: 9,
    excluded_reason: "attestation",
    latest_period: 2012,
    latest_value: 26,
    latest_n: 382,
  }),
  F("zero_screen", "check", {
    passed: false,
    evidence: { n_excluded: 12, zero_share: 0.09 },
  }),
];

const MANIFEST: FindingsManifest = {
  manifest_version: "1",
  findings: FINDINGS,
} as FindingsManifest;

const PRODUCT: AnalysisProduct = {
  series: [
    {
      id: "annual_prices",
      rows: [{ year: 1900, median: 0.3, median_raw: 0.3, n: 5000 }],
      roles: {
        x: { column: "year", kind: "temporal" },
        measures: [
          { column: "median", unit: "usd", screened_by: "zero_screen", variant_of: "median_raw" },
        ],
        count: { column: "n" },
      },
    },
  ],
  values: [],
};

describe("validatePlan — structural invariants as parse errors", () => {
  it("requires exactly one ANSWER (no-narrative is unrepresentable)", () => {
    const v = validatePlan({ nodes: [{ id: "a", op: "NOTE", refs: ["price_trend"] }] }, FINDINGS);
    expect(v.ok).toBe(false);
    expect(v.errors.join()).toContain("ANSWER");
  });

  it("CAVEAT may only reference checks — a fabricated mechanism has no syntax", () => {
    const v = validatePlan(
      {
        nodes: [
          { id: "a", op: "ANSWER", refs: ["price_trend"] },
          { id: "b", op: "CAVEAT", refs: ["price_peak"] },
        ],
      },
      FINDINGS
    );
    expect(v.ok).toBe(false);
    expect(v.errors.join()).toContain("checks/screens");
    // Free text off INSIGHT is also unrepresentable.
    const v2 = validatePlan(
      {
        nodes: [
          { id: "a", op: "ANSWER", refs: ["price_trend"] },
          { id: "b", op: "CAVEAT", refs: ["zero_screen"], text: "currency coverage collapsed" },
        ],
      },
      FINDINGS
    );
    expect(v2.ok).toBe(false);
    expect(v2.errors.join()).toContain("unrepresentable on caveats");
  });

  it("accepts a valid plan; dangling refs rejected", () => {
    const ok = validatePlan(
      {
        nodes: [
          { id: "a", op: "ANSWER", refs: ["price_trend"] },
          { id: "b", op: "CAVEAT", refs: ["zero_screen"] },
        ],
      },
      FINDINGS
    );
    expect(ok.ok).toBe(true);
    const bad = validatePlan({ nodes: [{ id: "a", op: "ANSWER", refs: ["ghost"] }] }, FINDINGS);
    expect(bad.ok).toBe(false);
  });

  it("defaultPlan always validates (the compiled pipeline cannot fail)", () => {
    const p = defaultPlan(FINDINGS);
    expect(validatePlan(p, FINDINGS).ok).toBe(true);
  });

  it("plan budgets scale with purpose; the planner prompt carries them", () => {
    // The observed gap: a compiled deep-dive computed deep-dive-sized
    // findings, then told a dashboard-sized (4-9 node) story.
    expect(planBudget("brief").maxNodes).toBeLessThan(planBudget("dashboard").maxNodes);
    expect(planBudget("report").maxNodes).toBeGreaterThan(planBudget("dashboard").maxNodes);
    expect(planBudget("deep-dive").maxNodes).toBeGreaterThan(planBudget("report").maxNodes);
    // Legacy alias + unknown resolve through the same table as every consumer.
    expect(planBudget("executive-summary").maxNodes).toBe(planBudget("brief").maxNodes);
    expect(planBudget(undefined).maxNodes).toBe(planBudget("dashboard").maxNodes);
    expect(buildPlannerSystem("deep-dive")).toContain("14-28 nodes");
    expect(buildPlannerSystem("deep-dive")).toContain("EVERY non-check claim");
    expect(buildPlannerSystem()).toContain("6-12 nodes");
    // Credibility floor: EVERY style closes with METHOD + CONCLUSION — an
    // answer with no visible method reads as unsourced at any depth.
    for (const style of ["brief", "dashboard", "report", "deep-dive"]) {
      expect(planBudget(style).guidance).toContain("METHOD");
      expect(planBudget(style).guidance).toContain("CONCLUSION");
    }
  });

  it("defaultPlan fills to the purpose budget; caveats never cut", () => {
    const deep = defaultPlan(FINDINGS, "deep-dive");
    expect(validatePlan(deep, FINDINGS).ok).toBe(true);
    // All three non-check claims narrated (ANSWER + PEAK + ENDPOINT) + caveat.
    const refs = deep.nodes.flatMap((n) => n.refs);
    expect(refs).toContain("price_peak");
    expect(refs).toContain("price_current_state");
    expect(deep.nodes.some((n) => n.op === "CAVEAT")).toBe(true);
    // Brief keeps the caveat even at its tight budget.
    const brief = defaultPlan(FINDINGS, "brief");
    expect(brief.nodes.some((n) => n.op === "CAVEAT")).toBe(true);
    expect(brief.nodes.length).toBeLessThanOrEqual(7);
  });
});

describe("narrated compiled mode — authored prose, figures must bind", () => {
  it("validateNodeText: literal digits reject; bindings must resolve and be ref'd", () => {
    // The core rule: an analyst-written sentence whose every figure binds.
    expect(
      validateNodeText(
        "Churn climbs steadily, reaching $finding:price_peak.value in $finding:price_peak.period.",
        ["price_peak"],
        FINDINGS
      )
    ).toEqual([]);
    // A literal figure anywhere is a fabrication vector — rejected.
    expect(
      validateNodeText("Churn reached 13.08 in late 2024.", ["price_peak"], FINDINGS).join()
    ).toContain("literal figures");
    // A binding to an undeclared claim, a missing field, or an un-ref'd
    // claim each reject with a repairable message.
    expect(validateNodeText("$finding:ghost.value", ["price_peak"], FINDINGS).join()).toContain(
      "no declared claim"
    );
    expect(
      validateNodeText("$finding:price_peak.nonexistent", ["price_peak"], FINDINGS).join()
    ).toContain("does not exist");
    expect(
      validateNodeText("$finding:price_trend.direction", ["price_peak"], FINDINGS).join()
    ).toContain("add it to the node's refs");
  });

  it("validatePlan accepts authored text on narrative ops, never on CAVEAT", () => {
    const ok = validatePlan(
      {
        nodes: [
          {
            id: "a",
            op: "ANSWER",
            refs: ["price_trend"],
            text: "Prices are $finding:price_trend.direction across the period.",
          },
          { id: "b", op: "CAVEAT", refs: ["zero_screen"] },
        ],
      },
      FINDINGS
    );
    expect(ok.ok).toBe(true);
    const digits = validatePlan(
      {
        nodes: [
          { id: "a", op: "ANSWER", refs: ["price_trend"], text: "Prices rose 62% since 1950." },
        ],
      },
      FINDINGS
    );
    expect(digits.ok).toBe(false);
    expect(digits.errors.join()).toContain("literal figures");
  });

  it("realizeNode prefers authored narrative; templates are the fallback", () => {
    const byName = new Map(FINDINGS.map((f) => [f.name, f]));
    const authored = realizeNode(
      {
        id: "n1",
        op: "TREND",
        refs: ["price_trend"],
        text: "The climb is steady at $finding:price_trend.slope_per_period per year.",
      },
      byName
    );
    expect(authored).toContain("The climb is steady");
    // No text → template realization, unchanged.
    const templated = realizeNode({ id: "n2", op: "TREND", refs: ["price_trend"] }, byName);
    expect(templated).toContain("per period");
    // CAVEAT ignores any text — checks speak in their own declared fields.
    const caveat = realizeNode(
      { id: "n3", op: "CAVEAT", refs: ["zero_screen"], text: "ignore me" },
      byName
    );
    expect(caveat).not.toContain("ignore me");
  });
});

describe("edit grammar — views, shown overlay, purpose survival", () => {
  const DOC = {
    mode: "compiled" as const,
    purpose: "deep-dive",
    plan: {
      nodes: [
        { id: "n_a", op: "ANSWER" as const, refs: ["price_trend"] },
        { id: "n_i", op: "INSIGHT" as const, refs: [], text: "Synthesis." },
      ],
    },
    overlay: {},
  };
  const VIEW_IDS = new Set(["chart_annual_prices__counts", "table_annual_prices", "tile_grid"]);

  it("show on a catalog view force-ships it; hide retracts; purpose survives the copy", () => {
    const shown = applyMutations(DOC, [{ kind: "show", id: "table_annual_prices" }], VIEW_IDS);
    expect(shown.errors).toEqual([]);
    expect(shown.doc.overlay.shown).toContain("table_annual_prices");
    expect(shown.doc.purpose).toBe("deep-dive"); // the depth budget must not reset on edit
    const hidden = applyMutations(
      shown.doc,
      [{ kind: "hide", id: "table_annual_prices" }],
      VIEW_IDS
    );
    expect(hidden.doc.overlay.shown).not.toContain("table_annual_prices");
    expect(hidden.doc.overlay.hidden).toContain("table_annual_prices");
  });

  it("set_width pairs consecutive halves into a two-column row at compile", () => {
    const withWidths = applyMutations(
      DOC,
      [
        { kind: "set_width", id: "chart_annual_prices", width: "half" },
        { kind: "set_width", id: "table_annual_prices", width: "half" },
      ],
      new Set(["chart_annual_prices", "table_annual_prices"])
    );
    expect(withWidths.errors).toEqual([]);
    expect(withWidths.doc.overlay.widths).toEqual({
      chart_annual_prices: "half",
      table_annual_prices: "half",
    });
    // Back to full removes the entry (absent = full).
    const back = applyMutations(
      withWidths.doc,
      [{ kind: "set_width", id: "chart_annual_prices", width: "full" }],
      new Set(["chart_annual_prices"])
    );
    expect(back.doc.overlay.widths).toEqual({ table_annual_prices: "half" });
    // Compile: halves pair into a LayoutGrid row; a lone half spans full.
    const plan = { nodes: [{ id: "n_answer", op: "ANSWER" as const, refs: ["price_trend"] }] };
    const lines = compileDashboard({
      manifest: MANIFEST,
      product: PRODUCT,
      plan,
      overlay: {
        shown: ["table_annual_prices"],
        widths: { chart_annual_prices: "half", table_annual_prices: "half" },
      },
      headlinePlan: [],
      question: "q",
    });
    const joined = lines.join("\n");
    expect(joined).toContain("compiled_row_chart_annual_prices");
    const root = JSON.parse(lines[lines.length - 2]) as { value: { children: string[] } };
    expect(root.value.children).toContain("compiled_row_chart_annual_prices");
    expect(root.value.children).not.toContain("chart_annual_prices"); // inside the row
    // Lone half (pair broken): renders full, no row wrapper, no hole.
    const lone = compileDashboard({
      manifest: MANIFEST,
      product: PRODUCT,
      plan,
      overlay: { widths: { chart_annual_prices: "half" } },
      headlinePlan: [],
      question: "q",
    });
    const loneRoot = JSON.parse(lone[lone.length - 2]) as { value: { children: string[] } };
    expect(loneRoot.value.children).toContain("chart_annual_prices");
    expect(lone.join("\n")).not.toContain("compiled_row_");
  });

  it("restore_document replays a snapshot — the undo primitive, still governed", () => {
    const removed = applyMutations(DOC, [{ kind: "remove_node", id: "n_i" }]);
    expect(removed.doc.plan.nodes).toHaveLength(1);
    // Undo: restore the pre-edit snapshot; even a destructive remove_node
    // comes back, and mode/purpose ride the live document.
    const undone = applyMutations(removed.doc, [
      { kind: "restore_document", plan: DOC.plan, overlay: DOC.overlay },
    ]);
    expect(undone.errors).toEqual([]);
    expect(undone.doc.plan.nodes).toHaveLength(2);
    expect(undone.doc.plan.nodes.map((n) => n.id)).toContain("n_i");
    expect(undone.doc.purpose).toBe("deep-dive");
  });

  it("the FIRST move on a fresh dashboard anchors to non-node elements via baseOrder", () => {
    // The shipped "drag and drop doesn't work": with overlay.order empty
    // (every new run), move's fallback base was plan nodes only, so a drag
    // anchored to tiles/charts — most of the page — failed "unknown
    // anchor" while the API returned 200.
    const baseOrder = ["tile_grid", "n_a", "n_i", "table_annual_prices"];
    const moved = applyMutations(
      DOC,
      [{ kind: "move", id: "table_annual_prices", before: "tile_grid" }],
      VIEW_IDS,
      baseOrder
    );
    expect(moved.errors).toEqual([]);
    expect(moved.doc.overlay.order).toEqual(["table_annual_prices", "tile_grid", "n_a", "n_i"]);
    // Without baseOrder the same move errors — and the caller must FAIL
    // the edit rather than 200 a silent no-op (editDashboard does).
    const broken = applyMutations(
      DOC,
      [{ kind: "move", id: "table_annual_prices", before: "tile_grid" }],
      VIEW_IDS
    );
    expect(broken.errors).toHaveLength(1);
  });

  it("view ids are movable with knownElementIds; typos still error", () => {
    const ok = applyMutations(
      DOC,
      [{ kind: "move", id: "chart_annual_prices__counts", before: "n_a" }],
      VIEW_IDS
    );
    expect(ok.errors).toEqual([]);
    expect(ok.doc.overlay.order?.[0]).toBe("chart_annual_prices__counts");
    const typo = applyMutations(DOC, [{ kind: "hide", id: "chart_nope" }], VIEW_IDS);
    expect(typo.errors).toHaveLength(1);
  });

  it("compile ships a shown catalog view that would not ship by default", () => {
    const plan = {
      nodes: [{ id: "n_answer", op: "ANSWER" as const, refs: ["price_trend"] }],
    };
    const base = {
      manifest: MANIFEST,
      product: PRODUCT,
      plan,
      overlay: {},
      headlinePlan: [],
      question: "q",
    };
    expect(compileDashboard(base).join("\n")).not.toContain("table_annual_prices");
    const withShown = compileDashboard({
      ...base,
      overlay: { shown: ["table_annual_prices"] },
    }).join("\n");
    expect(withShown).toContain("table_annual_prices");
  });
});

describe("edit surface — one read for the editing UI (web panel + MCP)", () => {
  it("exposes sections in render order, uncited claims, and the view catalog", async () => {
    cacheArtifacts("csv-edit-surface-1", {
      code: "",
      question: "How have prices changed?",
      results: {},
      chart_data: {},
      datasets: {},
      execution_ms: 0,
      findings: MANIFEST,
      series: PRODUCT.series,
      plan: {
        mode: "compiled",
        purpose: "report",
        plan: { nodes: [{ id: "n_a", op: "ANSWER", refs: ["price_trend"] }] },
        overlay: {},
      },
    });
    const s = await getEditSurface("csv-edit-surface-1");
    expect(s).not.toBeNull();
    const ids = s!.sections.map((x) => x.id);
    expect(ids).toContain("compiled_check_banner"); // zero_screen failed
    expect(ids).toContain("n_a");
    expect(ids).toContain("chart_annual_prices");
    expect(ids).toContain("table_annual_prices"); // report purpose ships the table
    // Un-narrated claims are offered with a suggested op; checks are not
    // (caveats stay grammar-governed).
    const uncited = s!.claims.filter((c) => !c.cited).map((c) => c.name);
    expect(uncited).toContain("price_peak");
    expect(s!.claims.map((c) => c.name)).not.toContain("zero_screen");
    expect(s!.claims.find((c) => c.name === "price_peak")?.suggestedOp).toBe("PEAK");
    // The unshipped coverage companion is the add-chart affordance, with
    // its reason attached.
    const cov = s!.views.find((v) => v.kind === "coverage");
    expect(cov?.shipped).toBe(false);
    expect(cov?.reason.length).toBeGreaterThan(10);
    // Previews are RESOLVED sentences — real numbers, never binding syntax
    // (the panel mirrors what the reader sees, not the IR).
    const answer = s!.sections.find((x) => x.id === "n_a");
    expect(answer?.preview).not.toContain("$finding:");
    expect(answer?.preview).toContain("rising"); // price_trend.direction resolved
    const peakClaim = s!.claims.find((c) => c.name === "price_peak");
    expect(peakClaim?.preview).not.toContain("$finding:");
    expect(peakClaim?.preview).toContain("1998"); // its period, resolved
  });

  it("preview formatting: tiny p-values keep their exponent; identifiers read as prose", () => {
    // Live E2E caught "(p = 0)" for p=1.08e-12 — the p-value sin in
    // preview form — and "rate_effect" leaking into a sentence.
    const fs = [F("t", "direction", { p: 1.9e-12, dom: "rate_effect" })];
    expect(resolvePreviewText("p = $finding:t.p", fs)).toBe("p = 1.90e-12");
    expect(resolvePreviewText("driven by $finding:t.dom", fs)).toBe("driven by rate effect");
    // Unresolvable tokens stay intact — never guessed.
    expect(resolvePreviewText("$finding:ghost.x", fs)).toBe("$finding:ghost.x");
  });
});

describe("planner salvage — one bad node degrades one node, never the document", () => {
  const authored = (text: string) => text;
  const basePlan = {
    nodes: [
      {
        id: "s1",
        op: "ANSWER" as const,
        refs: ["price_trend"],
        text: authored("Prices are $finding:price_trend.direction across the window."),
      },
      {
        id: "s2",
        op: "PEAK" as const,
        refs: ["price_peak"],
        text: authored("The peak arrived in 1998 with force."), // literal year → invalid
      },
      { id: "s3", op: "CAVEAT" as const, refs: ["zero_screen"], text: "coverage collapsed" },
      { id: "s4", op: "NOTE" as const, refs: ["ghost_claim"] },
      {
        id: "s5",
        op: "METHOD" as const,
        refs: ["price_trend"],
        text: authored("Slopes were fit per period and screened."),
      },
      { id: "s6", op: "SECTION" as const, refs: [] }, // text-required, none → dropped
    ],
  };

  it("strips invalid text, keeps the node; drops only irreparable nodes", () => {
    const vp = validatePlan;
    const { plan, repairs } = salvage(basePlan, FINDINGS);
    const byId = new Map(plan.nodes.map((n) => [n.id, n]));
    // Valid authored text survives untouched.
    expect(byId.get("s1")?.text).toContain("$finding:price_trend.direction");
    // Literal-digit text is stripped — the node falls back to its template.
    expect(byId.get("s2")).toBeDefined();
    expect(byId.get("s2")?.text).toBeUndefined();
    // CAVEAT free text stripped, caveat kept.
    expect(byId.get("s3")).toBeDefined();
    expect(byId.get("s3")?.text).toBeUndefined();
    // Unknown-ref node and textless SECTION dropped.
    expect(byId.has("s4")).toBe(false);
    expect(byId.has("s6")).toBe(false);
    // METHOD with valid text survives.
    expect(byId.get("s5")?.text).toContain("Slopes were fit");
    // The salvaged plan validates — the document ships authored.
    expect(vp(plan, FINDINGS).ok).toBe(true);
    expect(repairs.length).toBeGreaterThan(0);
  });

  it("injects a template ANSWER when none survives; demotes extras", () => {
    const noAnswer = salvage(
      { nodes: [{ id: "n1", op: "TREND" as const, refs: ["price_trend"] }] },
      FINDINGS
    );
    expect(noAnswer.plan.nodes.some((n) => n.op === "ANSWER")).toBe(true);
    expect(validatePlan(noAnswer.plan, FINDINGS).ok).toBe(true);
    const twoAnswers = salvage(
      {
        nodes: [
          { id: "a1", op: "ANSWER" as const, refs: ["price_trend"] },
          { id: "a2", op: "ANSWER" as const, refs: ["price_peak"] },
        ],
      },
      FINDINGS
    );
    expect(twoAnswers.plan.nodes.filter((n) => n.op === "ANSWER").length).toBe(1);
    expect(twoAnswers.plan.nodes.find((n) => n.id === "a2")?.op).toBe("NOTE");
  });
});

describe("group-series views — the matrix is the honest primary", () => {
  const GROUPED: AnalysisProduct = {
    series: [
      {
        id: "segment_churn",
        rows: [
          { month: "2024-01", segment: "A", rate: 1.5 },
          { month: "2024-01", segment: "B", rate: 2.5 },
          { month: "2024-02", segment: "A", rate: 1.7 },
          { month: "2024-02", segment: "B", rate: 2.9 },
        ],
        roles: {
          x: { column: "month", kind: "temporal" },
          group: { column: "segment" },
          measures: [{ column: "rate", unit: "pct" }],
        },
      },
    ],
    values: [],
  };

  it("pivots a complete group series into a HeatMap primary", () => {
    const views = deriveViews({ series: GROUPED.series });
    const matrix = views.find((v) => v.kind === "group_matrix");
    expect(matrix?.id).toBe("chart_segment_churn");
    expect(matrix?.shipped).toBe(true);
    const props = (matrix?.patch.value as { props: Record<string, unknown> }).props;
    expect(props.z).toEqual([
      [1.5, 1.7],
      [2.5, 2.9],
    ]);
    expect(props.x_labels).toEqual(["2024-01", "2024-02"]);
    expect(props.y_labels).toEqual(["A", "B"]);
    // The flat single-line chart is NOT derived for this series — a grouped
    // long series through a flat line is the sawtooth defect.
    expect(views.some((v) => v.seriesId === "segment_churn" && v.kind === "primary")).toBe(false);
  });

  it("an incomplete pivot falls through to the flat family, never invents holes", () => {
    const holey = {
      ...GROUPED.series[0],
      rows: GROUPED.series[0].rows.slice(0, 3), // B missing in 2024-02
    };
    const views = deriveViews({ series: [holey] });
    expect(views.some((v) => v.kind === "group_matrix")).toBe(false);
    expect(views.some((v) => v.kind === "primary")).toBe(true);
  });

  it("two or more charts default to half width and pair into rows; overlay wins", () => {
    const twoCharts: AnalysisProduct = {
      series: [PRODUCT.series[0], GROUPED.series[0]],
      values: [],
    };
    const views = deriveViews({ series: twoCharts.series }).filter((v) => v.shipped);
    const defaults = viewDefaultWidths(views);
    expect(defaults["chart_annual_prices"]).toBe("half");
    expect(defaults["chart_segment_churn"]).toBe("half");
    // A single shipped chart stays full — nothing to pair with.
    expect(viewDefaultWidths(views.filter((v) => v.id === "chart_annual_prices"))).toEqual({});
    // Compile pairs the two default-half charts into one two-column row.
    const lines = compileDashboard({
      manifest: MANIFEST,
      product: twoCharts,
      plan: { nodes: [{ id: "a", op: "ANSWER", refs: ["price_trend"] }] },
      overlay: {},
      headlinePlan: [],
      question: "q",
    });
    const rows = lines.filter((l) => l.includes("compiled_row_"));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toContain("chart_annual_prices");
    // Overlay full-width overrides the catalog default.
    const overridden = compileDashboard({
      manifest: MANIFEST,
      product: twoCharts,
      plan: { nodes: [{ id: "a", op: "ANSWER", refs: ["price_trend"] }] },
      overlay: { widths: { chart_annual_prices: "full", chart_segment_churn: "full" } },
      headlinePlan: [],
      question: "q",
    });
    expect(overridden.filter((l) => l.includes("compiled_row_")).length).toBe(0);
  });

  it("catalog charts carry a deterministic color map (not default red)", () => {
    const views = deriveViews({ series: [PRODUCT.series[0]] });
    const primary = views.find((v) => v.kind === "primary");
    const props = (primary?.patch.value as { props: Record<string, unknown> }).props;
    expect(props.color_map).toMatchObject({ median: "indigo" });
  });
});

describe("view catalog — deterministic derivation from roles + regimes", () => {
  const SERIES = PRODUCT.series[0]; // annual_prices: median(usd)/median_raw + count n

  it("primary keeps its stable id; coverage and table exist unshipped by default", () => {
    const views = deriveViews({ series: [SERIES] });
    const byId = new Map(views.map((v) => [v.id, v]));
    expect(byId.get("chart_annual_prices")?.shipped).toBe(true);
    expect(byId.get("chart_annual_prices__counts")?.shipped).toBe(false);
    expect(byId.get("table_annual_prices")?.shipped).toBe(false);
  });

  it("thin-data regimes force the coverage companion for every purpose", () => {
    const views = deriveViews({
      series: [SERIES],
      regimes: { annual_prices: { flags: ["COUNT_SKEWED", "THIN_EDGE"] } },
      purpose: "brief",
    });
    const cov = views.find((v) => v.kind === "coverage");
    expect(cov?.shipped).toBe(true);
    expect(cov?.reason).toContain("COUNT_SKEWED");
    const patch = cov!.patch.value as { type: string; props: { y_keys: string[] } };
    expect(patch.type).toBe("BarChart");
    expect(patch.props.y_keys).toEqual(["n"]);
  });

  it("deep-dive ships coverage + table; report ships the table", () => {
    const deep = deriveViews({ series: [SERIES], purpose: "deep-dive" });
    expect(deep.find((v) => v.kind === "coverage")?.shipped).toBe(true);
    expect(deep.find((v) => v.kind === "table")?.shipped).toBe(true);
    const report = deriveViews({ series: [SERIES], purpose: "report" });
    expect(report.find((v) => v.kind === "table")?.shipped).toBe(true);
    expect(report.find((v) => v.kind === "coverage")?.shipped).toBe(false);
  });

  it("mixed units split into separate charts — never one y axis", () => {
    const mixed = {
      ...SERIES,
      roles: {
        ...SERIES.roles,
        measures: [
          { column: "median", unit: "usd" },
          { column: "n_items", unit: "count" },
        ],
      },
    };
    const views = deriveViews({ series: [mixed] });
    const primary = views.find((v) => v.kind === "primary")!;
    const split = views.find((v) => v.kind === "unit_split")!;
    expect((primary.patch.value as { props: { y_keys: string[] } }).props.y_keys).toEqual([
      "median",
    ]);
    expect(split.shipped).toBe(true);
    expect((split.patch.value as { props: { y_keys: string[] } }).props.y_keys).toEqual([
      "n_items",
    ]);
  });
});

describe("realizer — honesty clauses live IN the templates", () => {
  it("every claim dtype in the taxonomy has a dedicated template (exhaustiveness)", () => {
    // A taxonomy dtype falling through to the generic template would render
    // "<label> — <definition>: $finding:<name>." — assert none do.
    const samples: Array<[string, unknown]> = [
      ["direction", { direction: "rising", slope_per_period: 1, p_value: 0.01 }],
      ["superlative", { period: "x", value: 1, n: 5 }],
      ["current_state", { period: "x", value: 1, pct_from_peak: -5 }],
      [
        "comparison",
        { early_median: 1, late_median: 2, multiplier: 2, early_span: "a", late_span: "b" },
      ],
      ["step_change", { period: "x", delta: 1, direction: "up", baseline_spread: 0.1 }],
      ["distribution", { median: 1, mean: 2, skew: 3 }],
      [
        "correlation",
        { pearson_r: 0.5, pearson_p: 0.01, spearman_rho: 0.4, spearman_p: 0.02, n: 10 },
      ],
      ["share", { shares_pct: {}, residual_pct: 1 }],
      ["check", { passed: true, evidence: {} }],
      ["screen", { passed: false, evidence: { n_flagged: 2 } }],
    ];
    for (const [dtype, value] of samples) {
      const text = realizeClaim(F(`claim_${dtype}`, dtype, value));
      expect(text, dtype).not.toContain("over the observed period:");
    }
  });

  it("superlative renders the raw extreme beside the attested value", () => {
    const text = realizeClaim(FINDINGS[1]);
    expect(text).toContain("$finding:price_peak.value");
    expect(text).toContain("$finding:price_peak.raw_value");
    expect(text).toContain("$finding:price_peak.thin_bar");
  });

  it("current_state binds excluded_reason and latest_* — mechanisms cannot be invented", () => {
    const text = realizeClaim(FINDINGS[2]);
    expect(text).toContain("$finding:price_current_state.excluded_reason");
    expect(text).toContain("$finding:price_current_state.latest_value");
  });

  it("trend renders the CI beside the slope", () => {
    const text = realizeClaim(FINDINGS[0]);
    expect(text).toContain("slope_ci95.0");
    expect(text).toContain("$finding:price_trend.p_value");
  });

  it("renders n_zero_excluded when the claim-layer zero screen fired, silent otherwise", () => {
    // Claim-layer totalization (regime-matrix amendment): a policy the
    // helper applied must be visible in the sentence it produced.
    const screened = realizeClaim(
      F("price_trend_z", "trend", {
        direction: "rising",
        slope_per_period: 1,
        p_value: 0.01,
        n_zero_excluded: 12,
      })
    );
    expect(screened).toContain("$finding:price_trend_z.n_zero_excluded");
    expect(screened).toContain("unrecorded-value sentinels");
    // n_zero_excluded 0 (or absent — pre-totalization payloads) adds nothing.
    const clean = realizeClaim(
      F("price_trend_c", "trend", {
        direction: "rising",
        slope_per_period: 1,
        p_value: 0.01,
        n_zero_excluded: 0,
      })
    );
    expect(clean).not.toContain("n_zero_excluded");
    expect(realizeClaim(FINDINGS[0])).not.toContain("n_zero_excluded");
    // The clause spans the unit=-threaded templates, not just trend.
    const sup = realizeClaim(
      F("peak_z", "superlative", { period: "x", value: 1, n: 5, n_zero_excluded: 3 })
    );
    expect(sup).toContain("$finding:peak_z.n_zero_excluded");
    const dist = realizeClaim(
      F("dist_z", "distribution", { median: 1, mean: 2, skew: 3, n_zero_excluded: 2 })
    );
    expect(dist).toContain("$finding:dist_z.n_zero_excluded");
  });

  it("renders the weighted-fit and preferred-coefficient dispatches when present", () => {
    const wls = realizeClaim(
      F("price_trend_w", "trend", {
        direction: "flat",
        slope_per_period: 0.03,
        p_value: 0.92,
        weighted: true,
      })
    );
    expect(wls).toContain("(count-weighted fit)");
    expect(realizeClaim(FINDINGS[0])).not.toContain("count-weighted");
    const corr = realizeClaim(
      F("price_vs_n", "correlation", {
        pearson_r: 0.5,
        pearson_p: 0.01,
        spearman_rho: 0.7,
        spearman_p: 0.001,
        n: 40,
        preferred: "spearman",
      })
    );
    expect(corr).toContain("$finding:price_vs_n.preferred");
  });

  it("templates are shape-guarded: a dtype whose value doesn't fit falls back to generic", () => {
    // First compiled run shipped "Segment heterogeneity: at per period,
    // p = 2.33e-8" — dtype "direction" with a per-segment dict value bound
    // trend fields that don't exist. The guard sends it to the generic
    // definition rendering instead.
    const het = realizeClaim(
      F("segment_heterogeneity", "direction", { segments: { smb: 4.8, enterprise: 2.3 } })
    );
    expect(het).not.toContain("per period");
    expect(het).toContain("over the observed period"); // the definition
    expect(het).toContain("$finding:segment_heterogeneity");
    // A well-shaped trend still gets its dedicated template.
    expect(realizeClaim(FINDINGS[0])).toContain("per period");
  });

  it("step and split sentences are grammatical (no 'a up step', no doubled span)", () => {
    const step = realizeClaim(
      F("churn_step", "step_change", {
        period: "2024-08",
        delta: 4.4,
        direction: "up",
        baseline_spread: 0.46,
      })
    );
    expect(step).toContain("the level steps $finding:churn_step.direction by");
    expect(step).not.toContain("a $finding:churn_step.direction step");
    const split = realizeClaim(
      F("churn_split", "comparison", {
        early_median: 4.6,
        late_median: 10.9,
        early_span: "2024-01-2024-06",
        late_span: "2024-07-2024-12",
        multiplier: 2.4,
      })
    );
    expect(split).not.toContain("Split at");
    expect(split).toContain("across $finding:churn_split.early_span");
    // A null multiplier (signed medians) drops the ratio clause entirely.
    const signed = realizeClaim(
      F("signed_split", "comparison", {
        early_median: -5,
        late_median: 5,
        early_span: "a",
        late_span: "b",
        multiplier: null,
      })
    );
    expect(signed).not.toContain("×");
  });

  it("checks render definition + scalar evidence bindings, never booleans inline", () => {
    const text = realizeClaim(FINDINGS[3]);
    expect(text).toContain("⚠ FAILED");
    expect(text).toContain("$finding:zero_screen.evidence.n_excluded");
    expect(text).not.toContain("$finding:zero_screen.passed");
  });

  it("INSIGHT nodes pass their text through; empty nodes render null", () => {
    const byName = new Map(FINDINGS.map((f) => [f.name, f]));
    expect(realizeNode({ id: "i", op: "INSIGHT", refs: [], text: "Synthesis." }, byName)).toBe(
      "Synthesis."
    );
    expect(realizeNode({ id: "x", op: "NOTE", refs: ["ghost"] }, byName)).toBeNull();
  });
});

describe("compileDashboard — deterministic, identity-keyed, overlay-aware", () => {
  const plan = {
    nodes: [
      { id: "n_answer", op: "ANSWER" as const, refs: ["price_trend"] },
      { id: "n_peak", op: "PEAK" as const, refs: ["price_peak"] },
      { id: "n_caveat", op: "CAVEAT" as const, refs: ["zero_screen"] },
    ],
  };
  const input = {
    manifest: MANIFEST,
    product: PRODUCT,
    plan,
    overlay: {},
    headlinePlan: [{ binding: "$finding:price_peak.value", label: "Peak", reason: "peak" }],
    question: "How have prices changed?",
  };

  it("compiles banner + tiles + narrative + charts + root, byte-deterministic", () => {
    const lines = compileDashboard(input);
    const again = compileDashboard(input);
    expect(lines).toEqual(again); // same input, same bytes
    const joined = lines.join("\n");
    expect(joined).toContain("compiled_check_banner"); // failed check first
    expect(joined).toContain('"tile_0"');
    expect(joined).toContain("/elements/n_answer");
    expect(joined).toContain("chart_annual_prices");
    // Chart carries screened measure AND its raw sibling.
    expect(joined).toContain('"median","median_raw"');
    expect(lines[lines.length - 1]).toContain('"compiled_root"');
  });

  it("form carries the story: answer callout, caveat annotations, evidence seam", () => {
    const withCaveat = {
      ...input,
      plan: {
        nodes: [
          { id: "n_answer", op: "ANSWER" as const, refs: ["price_trend"] },
          { id: "n_caveat", op: "CAVEAT" as const, refs: ["zero_screen"] },
        ],
      },
    };
    const lines = compileDashboard(withCaveat);
    const byPath = new Map(
      lines
        .map(
          (l) =>
            JSON.parse(l) as {
              path: string;
              value?: { type?: string; props?: Record<string, unknown> };
            }
        )
        .map((p) => [p.path, p])
    );
    // ANSWER leads as a styled insight callout, not undifferentiated body text.
    expect(byPath.get("/elements/n_answer")?.value?.props?.variant).toBe("insight");
    // CAVEATs are visually distinct annotations; zero_screen failed → warning.
    const caveat = byPath.get("/elements/n_caveat")?.value;
    expect(caveat?.type).toBe("Annotation");
    expect(caveat?.props?.severity).toBe("warning");
    // A seam separates narrative from the chart block.
    expect(byPath.get("/elements/compiled_evidence_break")?.value?.type).toBe("SectionBreak");
  });

  it("purpose + regimes govern the shipped view family; overlay can hide any view", () => {
    const flagged = {
      ...input,
      purpose: "report",
      regimes: { annual_prices: { flags: ["THIN_PERIODS"] } },
    };
    const joined = compileDashboard(flagged).join("\n");
    expect(joined).toContain("chart_annual_prices__counts"); // regime-forced evidence
    expect(joined).toContain("table_annual_prices"); // document style
    // Dashboard default with no flags ships neither — byte-compatible depth.
    const plain = compileDashboard(input).join("\n");
    expect(plain).not.toContain("__counts");
    expect(plain).not.toContain("table_annual_prices");
    // The overlay grammar governs views like every other element.
    const hiddenCov = compileDashboard({
      ...flagged,
      overlay: { hidden: ["chart_annual_prices__counts"] },
    }).join("\n");
    expect(hiddenCov).not.toContain("__counts");
  });

  it("overlay hides and reorders by stable id, surviving recompiles", () => {
    const lines = compileDashboard({
      ...input,
      overlay: { hidden: ["n_peak"], order: ["chart_annual_prices", "n_answer"] },
    });
    const joined = lines.join("\n");
    expect(joined).not.toContain("/elements/n_peak");
    const root = JSON.parse(lines[lines.length - 2]) as { value: { children: string[] } };
    expect(root.value.children[0]).toBe("chart_annual_prices");
  });

  it("temporal x compiles to LineChart, categorical to BarChart", () => {
    expect(componentForSeries(PRODUCT.series[0])).toBe("LineChart");
    expect(
      componentForSeries({
        ...PRODUCT.series[0],
        roles: { ...PRODUCT.series[0].roles, x: { column: "cuisine", kind: "categorical" } },
      })
    ).toBe("BarChart");
  });
});

describe("document grammar — sections, explainers, anchors (spec §14)", () => {
  const docPlan = {
    nodes: [
      {
        id: "d_method",
        op: "METHOD" as const,
        refs: ["price_trend"],
        text: "Prices were fit per period and screened for sentinel zeros.",
      },
      { id: "d_answer", op: "ANSWER" as const, refs: ["price_trend"] },
      { id: "d_section", op: "SECTION" as const, refs: [], text: "The long arc" },
      {
        id: "d_explain",
        op: "EXPLAIN" as const,
        refs: ["price_trend"],
        text: "The line climbs steadily; the slope is $finding:price_trend.slope_per_period per period.",
        anchor: "chart_annual_prices",
      },
      {
        id: "d_callout",
        op: "CALLOUT" as const,
        refs: ["price_peak"],
        text: "The raw extreme sits on thin coverage — read the attested peak instead.",
      },
      {
        id: "d_conclusion",
        op: "CONCLUSION" as const,
        refs: ["price_trend"],
        text: "Prices rose across the observed window.",
      },
      {
        id: "d_next",
        op: "NEXT_STEPS" as const,
        refs: [],
        text: "Would a per-category split change the story?",
      },
      { id: "d_limits", op: "LIMITS" as const, refs: [], text: "No causal claims are made here." },
    ],
  };

  it("validatePlan: refless ops stand alone; text-required ops must be authored", () => {
    const ok = validatePlan(docPlan, FINDINGS);
    expect(ok.ok).toBe(true);
    const noText = validatePlan(
      {
        nodes: [
          { id: "a", op: "ANSWER", refs: ["price_trend"] },
          { id: "s", op: "SECTION", refs: [] },
        ],
      },
      FINDINGS
    );
    expect(noText.ok).toBe(false);
    expect(noText.errors.join()).toContain("requires authored text");
    // EXPLAIN is not refless — an explainer must say WHICH claims it narrates.
    const orphanExplain = validatePlan(
      {
        nodes: [
          { id: "a", op: "ANSWER", refs: ["price_trend"] },
          { id: "e", op: "EXPLAIN", refs: [], text: "The chart shows the rise." },
        ],
      },
      FINDINGS
    );
    expect(orphanExplain.ok).toBe(false);
    expect(orphanExplain.errors.join()).toContain("references no claim");
  });

  it("compile maps document ops to distinct forms: heading, flag callout, insight close", () => {
    const lines = compileDashboard({
      manifest: MANIFEST,
      product: PRODUCT,
      plan: docPlan,
      overlay: {},
      headlinePlan: [],
      question: "How have prices changed?",
    });
    const byPath = new Map(
      lines
        .map(
          (l) =>
            JSON.parse(l) as {
              path: string;
              value?: { type?: string; props?: Record<string, unknown>; children?: string[] };
            }
        )
        .map((p) => [p.path, p])
    );
    expect(byPath.get("/elements/d_section")?.value?.props?.variant).toBe("heading");
    const callout = byPath.get("/elements/d_callout")?.value;
    expect(callout?.type).toBe("Annotation");
    expect(callout?.props?.icon).toBe("flag");
    expect(callout?.props?.severity).toBe("info");
    expect(byPath.get("/elements/d_conclusion")?.value?.props?.variant).toBe("insight");
    expect(byPath.get("/elements/d_method")?.value?.props?.variant).toBeUndefined();
  });

  it("anchors weave the chart in AFTER its explainer and out of the evidence block", () => {
    const lines = compileDashboard({
      manifest: MANIFEST,
      product: PRODUCT,
      plan: docPlan,
      overlay: {},
      headlinePlan: [],
      question: "How have prices changed?",
    });
    const root = JSON.parse(lines[lines.length - 2]) as { value: { children: string[] } };
    const kids = root.value.children;
    expect(kids.indexOf("chart_annual_prices")).toBe(kids.indexOf("d_explain") + 1);
    // The only shipped view is anchored — no dangling "Evidence" seam.
    expect(kids).not.toContain("compiled_evidence_break");
    // The chart's patch is emitted exactly once.
    expect(lines.filter((l) => l.includes('"/elements/chart_annual_prices"')).length).toBe(1);
  });

  it("unknown anchors are ignored; unanchored views keep the evidence seam", () => {
    const plan = {
      nodes: [
        { id: "a", op: "ANSWER" as const, refs: ["price_trend"] },
        {
          id: "e",
          op: "EXPLAIN" as const,
          refs: ["price_trend"],
          text: "The trend explained.",
          anchor: "chart_does_not_exist",
        },
      ],
    };
    const lines = compileDashboard({
      manifest: MANIFEST,
      product: PRODUCT,
      plan,
      overlay: {},
      headlinePlan: [],
      question: "q",
    });
    const root = JSON.parse(lines[lines.length - 2]) as { value: { children: string[] } };
    expect(root.value.children).not.toContain("chart_does_not_exist");
    // Chart still ships, below the seam.
    expect(root.value.children.indexOf("compiled_evidence_break")).toBeLessThan(
      root.value.children.indexOf("chart_annual_prices")
    );
  });

  it("realizeNode: document ops without authored text render nothing", () => {
    const byName = new Map(FINDINGS.map((f) => [f.name, f]));
    expect(realizeNode({ id: "x", op: "METHOD", refs: ["price_trend"] }, byName)).toBeNull();
    expect(realizeNode({ id: "y", op: "SECTION", refs: [] }, byName)).toBeNull();
    // EXPLAIN is narrative-first but falls back to the claim template.
    expect(realizeNode({ id: "z", op: "EXPLAIN", refs: ["price_trend"] }, byName)).toContain(
      "$finding:price_trend"
    );
  });

  it("planner prompt teaches the document vocabulary and chart anchoring", () => {
    const sys = buildPlannerSystem("report");
    for (const word of [
      "SECTION",
      "EXPLAIN",
      "CALLOUT",
      "METHOD",
      "CONCLUSION",
      "NEXT_STEPS",
      "LIMITS",
      "anchor",
    ]) {
      expect(sys).toContain(word);
    }
    expect(planBudget("report").guidance).toContain("METHOD");
    expect(planBudget("deep-dive").guidance).toContain("CALLOUT");
  });
});

describe("mutations — one governed edit channel", () => {
  const doc: PlanDocument = {
    mode: "compiled",
    plan: {
      nodes: [
        { id: "a", op: "ANSWER", refs: ["price_trend"] },
        { id: "b", op: "PEAK", refs: ["price_peak"] },
      ],
    },
    overlay: {},
  };

  it("move/hide/add/remove/set_insight round-trip and re-validate", () => {
    const r1 = applyMutations(doc, [
      { kind: "move", id: "b", before: "a" },
      { kind: "hide", id: "b" },
      // Note the digit-free text: authored prose with a literal figure is
      // now a validation error (every figure must bind) — the old fixture
      // "after 1950" fails by design.
      { kind: "set_insight", text: "The rise concentrates after the split point." },
      { kind: "add_node", node: { op: "CAVEAT", refs: ["zero_screen"] } },
    ]);
    expect(r1.errors).toEqual([]);
    expect(r1.applied).toBe(4);
    expect(r1.doc.overlay.order![0]).toBe("b");
    expect(r1.doc.overlay.hidden).toContain("b");
    expect(validatePlan(r1.doc.plan, FINDINGS).ok).toBe(true);
    // Original untouched (pure).
    expect(doc.plan.nodes).toHaveLength(2);
    const r2 = applyMutations(r1.doc, [{ kind: "remove_node", id: "zzz" }]);
    expect(r2.errors[0]).toContain("unknown node");
  });

  it("unique ids for added nodes", () => {
    const ids = new Set([nextPlanNodeId(), nextPlanNodeId(), nextPlanNodeId()]);
    expect(ids.size).toBe(3);
    expect(PLAN_OPS).toContain("INSIGHT");
  });
});
