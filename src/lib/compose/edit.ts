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
import type { CachedArtifacts } from "@/lib/contracts/investigation";
import { cacheArtifacts, getCachedArtifacts } from "@/lib/pipeline/artifacts-cache";
import { loadArtifactsByCsvId, updateArtifactsByCsvId } from "@/lib/history/storage";
import { createSpecFinalizer } from "@/lib/llm/finalize-spec-stream";
import { planHeadlineTiles } from "@/lib/findings/headline-plan";
import { declaredUnitMap, parseProduct } from "@/lib/product";
import { validatePlan, opForDtype } from "./plan";
import { applyMutations } from "./mutations";
import { compileDashboard } from "./compile";
import { deriveViews, type DerivedView } from "./views";
import { realizeNode } from "./realizer";
import { humanizeId } from "./scaffold";

export interface EditDashboardResult {
  ok: boolean;
  errors: string[];
  spec?: Spec;
  doc?: PlanDocument;
}

/** Structural element ids the overlay may also target. */
const STRUCTURAL_IDS = ["compiled_check_banner", "tile_grid"];

function viewsFor(artifacts: CachedArtifacts): DerivedView[] {
  const { product } = parseProduct(artifacts.series, undefined);
  return deriveViews({
    series: product.series,
    regimes: artifacts.regimes,
    purpose: artifacts.plan?.purpose,
  });
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
  const knownIds = new Set([...viewsFor(artifacts).map((v) => v.id), ...STRUCTURAL_IDS]);
  const { doc, errors } = applyMutations(artifacts.plan, mutations, knownIds);
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
    // Recompiles keep the live compile's depth: same style budget (the plan
    // doc records what the run was composed with) and same regime-forced
    // evidence views (profiles ride the artifacts).
    purpose: doc.purpose,
    regimes: artifacts.regimes,
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

// ── The edit surface: everything the editing UI (web panel / MCP) needs
// in one read — sections in effective order, the un-narrated claims
// available for add_node, and the derived view catalog with reasons for
// the add-chart picker. Pure projection of the cached artifacts.

export interface EditSection {
  id: string;
  kind: "banner" | "tiles" | "node" | "view";
  /** Plan-node op when kind=node. */
  op?: string;
  label: string;
  /** Realized sentence preview for nodes (truncated). */
  preview?: string;
  hidden: boolean;
}

export interface EditSurface {
  doc: PlanDocument;
  sections: EditSection[];
  /** Declared claims: cited = referenced by some plan node; suggestedOp for
   *  one-click add_node. Checks are omitted (caveats are grammar-governed). */
  claims: { name: string; dtype: string; cited: boolean; suggestedOp: string }[];
  /** Full derived view family with reasons — shipped:false entries are the
   *  add-chart picker. */
  views: { id: string; kind: string; seriesId: string; reason: string; shipped: boolean }[];
}

export async function getEditSurface(csvId: string): Promise<EditSurface | null> {
  const artifacts = getCachedArtifacts(csvId) ?? (await loadArtifactsByCsvId(csvId));
  if (!artifacts?.plan || !artifacts.findings) return null;
  const doc = artifacts.plan;
  const findings = artifacts.findings.findings;
  const byName = new Map(findings.map((f) => [f.name, f]));
  const views = viewsFor(artifacts);
  const viewById = new Map(views.map((v) => [v.id, v]));
  const shown = new Set(doc.overlay.shown ?? []);
  const hidden = new Set(doc.overlay.hidden ?? []);

  // Effective render order comes from the compiler itself — one source.
  const { product } = parseProduct(artifacts.series, undefined);
  const lines = compileDashboard({
    manifest: artifacts.findings,
    product,
    plan: doc.plan,
    overlay: doc.overlay,
    headlinePlan: planHeadlineTiles(findings, artifacts.results ?? {}, artifacts.question),
    question: artifacts.question,
    purpose: doc.purpose,
    regimes: artifacts.regimes,
  });
  const root = JSON.parse(lines[lines.length - 2]) as { value?: { children?: string[] } };
  const visible = root.value?.children ?? [];

  const sectionFor = (id: string, isHidden: boolean): EditSection | null => {
    if (id === "compiled_check_banner")
      return { id, kind: "banner", label: "Failed-check banner", hidden: isHidden };
    if (id === "tile_grid") return { id, kind: "tiles", label: "Headline tiles", hidden: isHidden };
    const node = doc.plan.nodes.find((n) => n.id === id);
    if (node) {
      const text = realizeNode(node, byName) ?? node.text ?? "";
      return {
        id,
        kind: "node",
        op: node.op,
        label: node.op === "INSIGHT" ? "Insight" : `${node.op}: ${node.refs.join(", ")}`,
        preview: text.slice(0, 160),
        hidden: isHidden,
      };
    }
    const view = viewById.get(id);
    if (view) {
      return {
        id,
        kind: "view",
        label: `${view.kind === "table" ? "Table" : "Chart"}: ${humanizeId(view.seriesId)}${view.kind === "coverage" ? " (coverage)" : view.kind === "unit_split" ? " (unit split)" : ""}`,
        hidden: isHidden,
      };
    }
    return null;
  };

  const sections: EditSection[] = [];
  for (const id of visible) {
    const s = sectionFor(id, false);
    if (s) sections.push(s);
  }
  // Hidden elements append at the end, marked — visible in the panel so
  // hiding is reversible without remembering ids.
  for (const id of hidden) {
    if (visible.includes(id)) continue;
    const s = sectionFor(id, true);
    if (s) sections.push(s);
  }

  const cited = new Set(doc.plan.nodes.flatMap((n) => n.refs));
  return {
    doc,
    sections,
    claims: findings
      .filter((f) => f.dtype !== "check" && f.dtype !== "screen")
      .map((f) => ({
        name: f.name,
        dtype: f.dtype,
        cited: cited.has(f.name),
        suggestedOp: opForDtype(f.dtype),
      })),
    views: views.map((v) => ({
      id: v.id,
      kind: v.kind,
      seriesId: v.seriesId,
      reason: v.reason,
      shipped: v.shipped || shown.has(v.id),
    })),
  };
}
