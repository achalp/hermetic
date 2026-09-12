/**
 * Targeted repair for DataController recipes that failed baseline replay —
 * the generative half of controller-recipe-audit (the audit's strip is the
 * floor; this tries to KEEP interactivity by asking the model to correct the
 * one failing recipe, validated by the same replay before anything ships).
 *
 * Flow per failing output (capped, one attempt each): build a small prompt
 * carrying the dataset shape, the seed the recipe must reproduce, and the
 * wrong recipe → parse the corrected pipeline → validate with
 * validateRecipeRepair → repaired outputs keep their (fixed) pipeline,
 * unrepairable ones strip to the static seed. Static still beats wrong; a
 * validated repair beats static.
 *
 * Pure logic + an injected `generate` edge, so the loop is unit-testable
 * without an LLM.
 */
import type { PipelineStep } from "@/lib/data-transforms/client-pipeline";
import type { PatchLike } from "./computed-key-audit";
import {
  buildControllerCorrection,
  validateRecipeRepair,
  type ControllerRecipeFailure,
} from "./controller-recipe-audit";

/** At most this many failing outputs get a repair call per compose. */
export const REPAIR_CAP = 3;

export function buildRepairPrompt(f: ControllerRecipeFailure): string {
  const seedPreview = f.seed.slice(0, 5);
  return [
    `A dashboard chart recomputes its data client-side with this JSON pipeline over the dataset below, ` +
      `but the pipeline does NOT reproduce the correct precomputed rows. Fix the pipeline.`,
    ``,
    `Dataset columns: ${f.datasetColumns.join(", ")}`,
    `Dataset sample rows: ${JSON.stringify(f.datasetSample)}`,
    `Correct target rows (${f.seed.length} total; the pipeline must reproduce these` +
      (f.requiredCols.length ? ` — at minimum the columns ${f.requiredCols.join(", ")}` : "") +
      `): ${JSON.stringify(seedPreview)}`,
    ``,
    `Current (wrong) pipeline: ${JSON.stringify(f.pipeline)}`,
    ``,
    `Available ops: {"op":"filter"} (applies the user's filter selections), ` +
      `{"op":"groupBy","columns":[...],"aggregations":[{"column","fn","as"}]} with fn one of ` +
      `sum/avg/min/max/count/countDistinct/median, {"op":"sort","column","direction"}, ` +
      `{"op":"limit","count"}, {"op":"topN","column","n","direction"}, ` +
      `{"op":"compute","column","expression"} (percent(a,b)/diff(a,b)/ratio(a,b)/round(col,d)).`,
    `A common cause: the target rows are a SUBSET slice (e.g. the latest year) but the pipeline ` +
      `aggregates everything — reproduce the slice with a filter/topN step, keeping {"op":"filter"} ` +
      `first so user filter selections still apply.`,
    ``,
    `Reply with ONLY a JSON object: {"pipeline": [...]}`,
  ].join("\n");
}

/** Parse the model's corrected pipeline; null when unusable. */
export function parseRepairReply(raw: string): PipelineStep[] | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as { pipeline?: unknown };
    if (!Array.isArray(parsed.pipeline) || parsed.pipeline.length === 0) return null;
    if (
      !parsed.pipeline.every(
        (s) => s && typeof s === "object" && typeof (s as { op?: unknown }).op === "string"
      )
    ) {
      return null;
    }
    return parsed.pipeline as PipelineStep[];
  } catch {
    return null;
  }
}

export interface RecipeRepairResult {
  /** Validated repairs that keep interactivity. */
  repaired: { elementId: string; statePath: string }[];
  /** Outputs stripped after a failed (or capped-out) repair. */
  stripped: { elementId: string; statePath: string }[];
  /** One corrective element patch per affected controller. */
  patches: PatchLike[];
}

export async function repairControllerRecipes(
  patches: PatchLike[],
  failures: ControllerRecipeFailure[],
  generate: (prompt: string) => Promise<string>
): Promise<RecipeRepairResult> {
  const repaired: RecipeRepairResult["repaired"] = [];
  const stripped: RecipeRepairResult["stripped"] = [];
  const decisionsByElement = new Map<string, Map<string, PipelineStep[] | null>>();

  let attempts = 0;
  for (const f of failures) {
    let decision: PipelineStep[] | null = null;
    if (attempts < REPAIR_CAP) {
      attempts++;
      try {
        const candidate = parseRepairReply(await generate(buildRepairPrompt(f)));
        if (candidate && validateRecipeRepair(patches, f, candidate)) decision = candidate;
      } catch {
        // Repair is best-effort; the strip floor below still applies.
      }
    }
    (decision ? repaired : stripped).push({ elementId: f.elementId, statePath: f.statePath });
    if (!decisionsByElement.has(f.elementId)) decisionsByElement.set(f.elementId, new Map());
    decisionsByElement.get(f.elementId)!.set(f.statePath, decision);
  }

  const out: PatchLike[] = [];
  for (const [elementId, decisions] of decisionsByElement) {
    const patch = buildControllerCorrection(patches, elementId, decisions);
    if (patch) out.push(patch);
  }
  return { repaired, stripped, patches: out };
}
