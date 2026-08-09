/**
 * Dashboard editing service (narrative-compiler spec §3): load the cached
 * plan document, apply mutations through the governed grammar, re-validate,
 * recompile deterministically (NO LLM), persist, and return the assembled
 * spec. One library function — the web /api/plan route and the MCP
 * edit_dashboard tool are thin adapters over it, so conversational editing
 * and UI editing are the identical code path.
 */
import { applySpecPatch, parseSpecStreamLine, type Spec } from "@/spec/core";
import type { PlanDocument, PlanMutation } from "@/lib/contracts/plan";
import { cacheArtifacts, getCachedArtifacts } from "@/lib/pipeline/artifacts-cache";
import { loadArtifactsByCsvId, updateArtifactsByCsvId } from "@/lib/history/storage";
import { createSpecFinalizer } from "@/lib/llm/finalize-spec-stream";
import { planHeadlineTiles } from "@/lib/findings/headline-plan";
import { declaredUnitMap, parseProduct } from "@/lib/product";
import { validatePlan } from "./plan";
import { applyMutations } from "./mutations";
import { compileDashboard } from "./compile";

export interface EditDashboardResult {
  ok: boolean;
  errors: string[];
  spec?: Spec;
  doc?: PlanDocument;
}

export async function editDashboard(
  csvId: string,
  mutations: PlanMutation[]
): Promise<EditDashboardResult> {
  const artifacts = getCachedArtifacts(csvId) ?? (await loadArtifactsByCsvId(csvId));
  if (!artifacts) return { ok: false, errors: ["no cached analysis for this dataset"] };
  if (!artifacts.plan || !artifacts.findings) {
    return {
      ok: false,
      errors: [
        "this dashboard was not compiled (no plan document) — editing requires composer.mode=compiled",
      ],
    };
  }
  const { doc, errors } = applyMutations(artifacts.plan, mutations);
  const v = validatePlan(doc.plan, artifacts.findings.findings);
  if (!v.ok) return { ok: false, errors: [...errors, ...v.errors] };

  const { product } = parseProduct(artifacts.series, undefined);
  const lines = compileDashboard({
    manifest: artifacts.findings,
    product,
    plan: doc.plan,
    overlay: doc.overlay,
    headlinePlan: planHeadlineTiles(
      artifacts.findings.findings,
      artifacts.results ?? {},
      artifacts.question
    ),
    question: artifacts.question,
  });

  // Assemble through the SAME finalizer (values, units) as live compose.
  const findingValues = Object.fromEntries(
    artifacts.findings.findings.map((f) => [f.name, f.value])
  );
  const finalize = createSpecFinalizer({
    results: artifacts.results ?? {},
    chartData: artifacts.chart_data ?? {},
    findings: findingValues,
    findingUnits: Object.fromEntries(
      artifacts.findings.findings
        .filter((f) => typeof f.unit === "string")
        .map((f) => [f.name, f.unit as string])
    ),
    declaredUnits: declaredUnitMap([], artifacts.findings.findings),
  });
  const spec: Spec = { root: "", elements: {}, state: {} };
  for (const line of lines) {
    const r = finalize(line);
    if (r.skip) continue;
    const patch = parseSpecStreamLine(r.line);
    if (!patch) continue;
    try {
      applySpecPatch(spec, patch);
    } catch {
      // best-effort assembly (same posture as recompose)
    }
  }

  const next = { ...artifacts, plan: doc };
  cacheArtifacts(csvId, next);
  await updateArtifactsByCsvId(csvId, next).catch(() => false);
  return { ok: true, errors, spec, doc };
}

export function getDashboardPlan(csvId: string): PlanDocument | undefined {
  return getCachedArtifacts(csvId)?.plan;
}
