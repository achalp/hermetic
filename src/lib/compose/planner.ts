/**
 * The plan call (specs/narrative-compiler-2026-08-09.md §2) — the ONE LLM
 * invocation in compiled composition: manifest projection in, {plan,
 * insight} JSON out (~hundreds of tokens). Invalid plan → one retry with
 * the validator's errors; then the deterministic default plan. The
 * compiled pipeline cannot fail to produce a dashboard.
 */
import { generateText } from "ai";
import { z } from "zod";
import { getModel, cachedSystem } from "@/lib/llm/client";
import { withPhase } from "@/lib/cost/accumulator";
import { projectManifestForPrompt } from "@/lib/findings/project";
import { logger, errMessage } from "@/lib/logger";
import type { FindingEntry } from "@/lib/contracts/findings";
import type { Plan } from "@/lib/contracts/plan";
import {
  PLAN_OPS,
  defaultPlan,
  nextPlanNodeId,
  planBudget,
  salvagePlan,
  validatePlan,
  type PlanContext,
} from "./plan";
import { COMPONENT_ROLE_SIGNATURES, seriesKindOf } from "@/lib/product/signatures";
import { P1_COMPILABLE } from "./view-compilers";
import type { SeriesEntry } from "@/lib/contracts/product";

const PlannerResponse = z.object({
  nodes: z
    .array(
      z.object({
        op: z.enum(PLAN_OPS),
        refs: z.array(z.string()).default([]),
        text: z.string().optional(),
        anchor: z.string().optional(),
        component: z.string().optional(),
        series: z.string().optional(),
        payload: z.string().optional(),
      })
    )
    .min(1)
    .max(32),
});

/** Series summary the planner sees (values-blind: ids, kinds, column NAMES,
 *  and row counts — never values). */
export interface PlannerSeriesInfo {
  id: string;
  kind: string;
  xKind: string;
  columns: string[];
  measures: number;
  rows: number;
}

/** The VIEW catalog — GENERATED from the signature registry so the prompt
 *  and the licensing rules cannot drift (compiled-view-parity §5). Only
 *  compilable components are offered. */
export function buildViewCatalog(): string {
  const lines: string[] = [];
  for (const name of [...P1_COMPILABLE].sort()) {
    const sig = COMPONENT_ROLE_SIGNATURES[name];
    if (!sig || sig.feeds === "none") continue;
    const needs: string[] = [];
    if (sig.feeds === "claim") needs.push(`${(sig.dtypes ?? []).join("/")} claim via refs`);
    else if (sig.feeds === "payload")
      needs.push(`${(sig.payloadFormats ?? []).join("/")} payload via "payload"`);
    else {
      needs.push(`${(sig.seriesKinds ?? ["axis"]).join("/")} series`);
      if (sig.xKinds) needs.push(`${sig.xKinds.join("/")} x`);
      if (sig.minMeasures) needs.push(`${sig.minMeasures}+ measures`);
    }
    lines.push(`- ${name} (${needs.join(", ")}): ${sig.when ?? ""}`);
  }
  return lines.join("\n");
}

/** Planner system prompt for a style — the node budget and depth directive
 *  are the PURPOSE dimension of compiled composition (plan.ts
 *  PLAN_BUDGETS); everything else is the fixed grammar. */
export function buildPlannerSystem(purpose?: string): string {
  const budget = planBudget(purpose);
  return `You are WRITING a data dashboard's narrative — an analyst telling the story, not a template printing fields. You receive the analysis' declared claims (findings with definitions and value_fields — no raw data). Respond with ONLY a JSON object:
{"nodes":[{"op":"ANSWER|TREND|SHAPE|PEAK|ENDPOINT|CONTRAST|NOTE|CAVEAT|INSIGHT","refs":["<claim name>", ...],"text":"..."}]}
Rules:
- Every node's "text" IS the prose the reader sees: flowing sentences (2-4 for document styles) that interpret and CONNECT its claims — carry the thread from the previous node, vary sentence shape, subordinate the less important figure to the more important one. Never write label-colon-value ("Churn trend: rising at X").
- EVERY figure — number, year, month, count, percentage — MUST be a binding: $finding:<claim>.<field> (fields are listed per claim as value_fields). Literal digits anywhere in text are REJECTED. A node's bindings may only use claims listed in its refs.
- EXACTLY ONE ANSWER node at the TOP (only an opening METHOD may precede it): the direct answer to the user's question in plain words, figures bound. METHOD may instead close the document where the style's guidance says so.
- Document ops: SECTION (short heading, no refs) titles what follows. EXPLAIN narrates a chart — set "anchor" to that chart's id (listed under Charts) and the chart renders right below your words; every anchored chart needs its EXPLAIN. CALLOUT flags what deserves the reader's attention. METHOD explains how the analysis was done, grounded ONLY in the claims' stated definitions. CONCLUSION closes with the answer restated and its strongest figures (bound). NEXT_STEPS suggests follow-up QUESTIONS/ACTIONS (never phrased as findings). LIMITS states plainly what this analysis does not cover.
- CAVEAT nodes carry NO text (the system renders the check's own declared fields verbatim — a caveat is not yours to phrase); include one for every FAILED check, and set its "anchor" to the chart/section it qualifies so it sits WHERE it applies. CAVEATs may reference ONLY checks/screens.
- When a check/screen answers a part of the user's QUESTION (the question says "identify outliers" and an outlier screen exists), the caveat alone is not an answer: ALSO state its result in prose — a NOTE or the ANSWER binding its evidence fields ("the screen flagged $finding:<screen>.evidence.n_flagged of the transactions"). A question component answered only by a warning box is unanswered.
- A shares/decomposition claim OFFERING no residual field is exhaustive — its parts fully account for the total. Say that in words if it matters; never invent a remainder figure.
- At most one INSIGHT node: synthesis ACROSS claims that no single node states.
- NEVER assert a mechanism, cause, coverage change, or data-collection story no check reports ("currency coverage collapsed", "reporting still arriving" are fabrications unless a check's definition literally states them). Describe what the data shows; do not explain why it happened.
- A claim carrying "detected": false found NOTHING — no step change, no peak, no correlation. It has no value_fields and nothing to bind. Either leave it out, or state the non-detection in words ("no persistent step change survived the gates"). NEVER narrate it as though the event occurred.
- NEVER bind a yes/no field (passed, significant, sums_to_100, weighted...) — a flag is not a word. Each claim's boolean verdicts appear under "verdicts": state them in WORDS and never contradict them — "significant": false means the difference is NOT statistically significant (say so, or stay silent on significance; asserting it is fabrication). A binding to a flag field is REJECTED.
- NEVER guess the BASIS of a share/percentage binding: "of spend", "of transactions", "of revenue" may be written ONLY when the field's name or its claim's definition states that basis. A field named "other_share_pct" states no basis — a count share narrated as "34.6% of spend" is a fabrication when the spend share is 23.5%. With no stated basis, call it a share plain ("34.6% share") and let the claim's definition carry the meaning.
- A MAPPING field (shares_pct, group_ns, per-group dicts) renders as a full ranked enumeration — "Other at 23.5%, ..., down to Utilities at 1.1%". Bind one ONLY where an enumeration belongs ("spend breaks down as $finding:x.shares_pct"), never in a slot expecting a single figure ("the leading category holds ___ of spend" needs prose or a scalar field, not the whole map), and never twice in one document — say it once, reference it in words after.
- A VIEW node REQUESTS a visualization: {"op":"VIEW","component":"<from the catalog>","series":"<declared series id>","text":"Plain-words title"} for series-fed components, or {"op":"VIEW","component":"PieChart","refs":["<claim>"],"text":"..."} for claim-fed ones. You choose the FORM; the system compiles the chart from declared data — you never write props or data. At most ${budget.maxViews} VIEW nodes, ONE per series; a VIEW replaces that series' auto-derived chart, so pick a component that tells the story BETTER than a bar/line would (a geo series deserves a map; a distribution claim deserves its histogram; a share claim its pie/treemap; a decomposition its waterfall). Place each VIEW where the reader should meet it, with an EXPLAIN beside it. A series of kind "distribution" carries the RAW VALUES behind a distribution claim — when the question involves spread, shape, or outliers, give it its Histogram or BoxPlot VIEW rather than leaving it prose-only. A geo-kind series likewise deserves a map — but READ THE QUESTION to pick which: MapView pins a handful of nameable places to click one by one, while Map3D renders a density heatmap for the CONCENTRATION of many points (a "where are things densest / hotspots / clustering" question is Map3D, not a pin map — pins would hide the very pattern asked about).
- refs use claim names exactly as given. ${budget.guidance}

## View catalog (VIEW components and what they consume)
${buildViewCatalog()}`;
}

/** The default-style prompt (kept for compatibility/tests). */
export const PLANNER_SYSTEM = buildPlannerSystem();

export async function generatePlan(args: {
  findings: FindingEntry[];
  question: string;
  model: string;
  /** Output style (purpose id) — scales the plan's node budget. */
  purpose?: string;
  /** Shipped views the plan may anchor EXPLAIN/CAVEAT nodes to. */
  views?: { id: string; title: string }[];
  /** Declared series (compiled-view-parity §5) — VIEW licensing context and
   *  the values-blind series summary the planner chooses views against. */
  series?: SeriesEntry[];
  /** Declared non-tidy payloads (id + format) — payload-fed VIEW context. */
  payloads?: { id: string; format: string }[];
  /** True when chart_data carries a geojson FeatureCollection — the
   *  document ships a map of it, and the planner must not claim the data
   *  lacks geography (run 8df300b3 did exactly that). */
  hasGeojson?: boolean;
  /** Severe post-compose lint advisories from a FIRST compiled pass (perf/
   *  quality P13). Without these the bounded recompose was a BLIND re-roll:
   *  the realizer is deterministic, so an uninformed identical plan reproduces
   *  the identical defective prose. Present only on the single repair pass. */
  repairAdvisories?: string[];
}): Promise<{ plan: Plan; plannerErrors: string[] }> {
  const { projections } = projectManifestForPrompt(args.findings);
  const ctx: PlanContext = {
    series: args.series,
    payloads: args.payloads,
    maxViews: planBudget(args.purpose).maxViews,
  };
  const viewsSection =
    args.views && args.views.length > 0
      ? `\n\n## Charts (anchor EXPLAIN/CAVEAT nodes to these ids)\n${JSON.stringify(args.views)}`
      : "";
  const seriesSection =
    args.series && args.series.length > 0
      ? `\n\n## Series (VIEW nodes bind these by id)\n${JSON.stringify(
          args.series.map((s) => ({
            id: s.id,
            kind: seriesKindOf(s),
            x: s.roles.x.column,
            xKind: s.roles.x.kind,
            measures: s.roles.measures.map((m) => m.column),
            ...(s.roles.group ? { group: s.roles.group.column } : {}),
            rows: s.rows.length,
          }))
        )}`
      : "";
  const payloadsSection =
    args.payloads && args.payloads.length > 0
      ? `\n\n## Payloads (payload-fed VIEW nodes bind these by id)\n${JSON.stringify(args.payloads)}`
      : "";
  const geometrySection = args.hasGeojson
    ? `\n\n## Geometry\nA GeoJSON FeatureCollection of region/polygon geometry is available and the dashboard WILL include a map of it. Never state that the data lacks geographic information; an EXPLAIN about the map is welcome.`
    : "";
  const repairSection =
    args.repairAdvisories && args.repairAdvisories.length > 0
      ? `\n\n## Repair (a prior plan produced these DEFECTS — write a plan that avoids each)\n${args.repairAdvisories.map((a) => `- ${a}`).join("\n")}`
      : "";
  const prompt = `## Question\n${args.question}\n\n## Claims\n${JSON.stringify(projections)}${viewsSection}${seriesSection}${payloadsSection}${geometrySection}${repairSection}\n\nWrite the narrative.`;
  const errors: string[] = [];
  let feedback = "";
  let lastParsed: Plan | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await withPhase("compose", () =>
        generateText({
          model: getModel(args.model),
          system: cachedSystem(buildPlannerSystem(args.purpose)),
          prompt: prompt + feedback,
          temperature: 0,
          maxOutputTokens: 4500,
        })
      );
      const start = res.text.indexOf("{");
      const end = res.text.lastIndexOf("}");
      const parsed = PlannerResponse.safeParse(JSON.parse(res.text.slice(start, end + 1)));
      if (!parsed.success) {
        errors.push(`attempt ${attempt}: ${parsed.error.issues[0]?.message ?? "malformed"}`);
        feedback = `\n\nYour previous plan was malformed: ${errors[errors.length - 1]}. Respond with only the JSON object.`;
        continue;
      }
      const plan: Plan = {
        nodes: parsed.data.nodes.map((n) => ({ id: nextPlanNodeId(), ...n })),
      };
      lastParsed = plan;
      const v = validatePlan(plan, args.findings, ctx);
      if (v.ok) return { plan, plannerErrors: errors };
      errors.push(...v.errors.map((e) => `attempt ${attempt}: ${e}`));
      feedback = `\n\nYour previous plan was INVALID:\n- ${v.errors.join("\n- ")}\nFix these and respond with only the JSON object.`;
    } catch (err) {
      errors.push(`attempt ${attempt}: ${errMessage(err)}`);
      feedback = "";
    }
  }
  // Per-node salvage (plan.ts): a failed validation degrades the offending
  // nodes, never the document — the all-or-nothing fallback was the quality
  // cliff (one literal year anywhere collapsed the whole authored narrative
  // to templates). Only schema-level wreckage still reaches defaultPlan.
  if (lastParsed) {
    const { plan: salvaged, repairs } = salvagePlan(lastParsed, args.findings, ctx);
    if (salvaged.nodes.length > 0 && validatePlan(salvaged, args.findings, ctx).ok) {
      logger.warn("Planner plan salvaged node-by-node", {
        repairs: repairs.slice(0, 6),
        kept: salvaged.nodes.length,
        of: lastParsed.nodes.length,
      });
      return { plan: salvaged, plannerErrors: [...errors, ...repairs.map((r) => `salvage: ${r}`)] };
    }
  }
  logger.warn("Planner failed validation twice — using the deterministic default plan", {
    errors: errors.slice(0, 4),
  });
  return { plan: defaultPlan(args.findings, args.purpose), plannerErrors: errors };
}
