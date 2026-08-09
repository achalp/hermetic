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
import {
  loadArtifactsByCsvId,
  loadArtifactsByHistoryId,
  updateArtifactsByCsvId,
  updateArtifactsByHistoryId,
} from "@/lib/history/storage";
import { createSpecFinalizer } from "@/lib/llm/finalize-spec-stream";
import { planHeadlineTiles } from "@/lib/findings/headline-plan";
import { declaredUnitMap, parseProduct } from "@/lib/product";
import { validatePlan, opForDtype } from "./plan";
import { applyMutations } from "./mutations";
import { compileDashboard } from "./compile";
import { deriveViews, type DerivedView } from "./views";
import { realizeClaim, realizeNode } from "./realizer";
import { humanizeId } from "./scaffold";
import type { FindingEntry } from "@/lib/contracts/findings";

/** Resolve `$finding:` tokens into readable values for PREVIEW text — the
 *  edit surface shows users the actual sentences on their dashboard, not
 *  binding syntax. Display-only (the live spec still resolves through the
 *  full finalizer); unresolvable tokens are left intact rather than
 *  guessed. Finding names may themselves be dotted (step_2.churn_rate), so
 *  resolution matches the LONGEST declared name prefix. */
export function resolvePreviewText(text: string, findings: FindingEntry[]): string {
  const names = [...findings].sort((a, b) => b.name.length - a.name.length);
  const fmt = (v: unknown): string => {
    if (typeof v === "number") {
      if (Number.isInteger(v)) return String(v);
      // Tiny magnitudes keep their exponent — rounding 1.08e-12 to "0"
      // is the p-value sin the contract forbids, in preview form.
      if (Math.abs(v) < 1e-4) return v.toExponential(2);
      return String(Math.abs(v) < 1 ? +v.toFixed(4) : +v.toFixed(2));
    }
    if (v === null || v === undefined) return "—";
    if (typeof v === "object") return JSON.stringify(v);
    // Identifier-shaped strings read as prose in a preview ("rate_effect"
    // → "rate effect").
    if (typeof v === "string" && /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(v)) {
      return v.replace(/_/g, " ");
    }
    return String(v);
  };
  return text.replace(/\$finding:([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*)/g, (token, path: string) => {
    const f = names.find((x) => path === x.name || path.startsWith(x.name + "."));
    if (!f) return token;
    const rest = path.slice(f.name.length).replace(/^\./, "");
    let v: unknown = f.value;
    for (const field of rest ? rest.split(".") : []) {
      if (v === null || typeof v !== "object") return token;
      v = (v as Record<string, unknown>)[field];
    }
    return fmt(v);
  });
}

export interface EditDashboardResult {
  ok: boolean;
  errors: string[];
  spec?: Spec;
  doc?: PlanDocument;
}

/** Structural element ids the overlay may also target. */
const STRUCTURAL_IDS = ["compiled_check_banner", "tile_grid", "compiled_evidence_break"];

function viewsFor(artifacts: CachedArtifacts): DerivedView[] {
  const { product } = parseProduct(artifacts.series, undefined);
  return deriveViews({
    series: product.series,
    regimes: artifacts.regimes,
    purpose: artifacts.plan?.purpose,
  });
}

/** The compiled element order for a doc — the move mutation's base on a
 *  fresh overlay. Deterministic recompile of the CURRENT doc with row
 *  wrappers expanded to their real members. */
function compileOrder(artifacts: CachedArtifacts, doc: PlanDocument): string[] {
  if (!artifacts.findings) return doc.plan.nodes.map((n) => n.id);
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
    purpose: doc.purpose,
    regimes: artifacts.regimes,
  });
  const rowChildren = new Map<string, string[]>();
  for (const line of lines) {
    const p = JSON.parse(line) as { path?: string; value?: { children?: string[] } };
    if (p.path?.startsWith("/elements/compiled_row_")) {
      rowChildren.set(p.path.slice("/elements/".length), p.value?.children ?? []);
    }
  }
  const root = JSON.parse(lines[lines.length - 2]) as { value?: { children?: string[] } };
  return (root.value?.children ?? []).flatMap((id) => rowChildren.get(id) ?? [id]);
}

/** Artifacts for a dataset: live cache first, then the history record —
 *  by the entry's OWN id when the caller has one (the ?restore= flow runs
 *  under a fresh csvId that maps to no record), else by csvId. */
async function resolveArtifacts(
  csvId: string,
  historyId?: string | null
): Promise<CachedArtifacts | undefined> {
  return (
    getCachedArtifacts(csvId) ??
    (historyId ? await loadArtifactsByHistoryId(historyId) : undefined) ??
    (await loadArtifactsByCsvId(csvId))
  );
}

export async function editDashboard(
  csvId: string,
  mutations: PlanMutation[],
  historyId?: string | null
): Promise<EditDashboardResult> {
  const artifacts = await resolveArtifacts(csvId, historyId);
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
  // The full compiled order seeds the FIRST move on a fresh dashboard
  // (empty overlay.order): compile the current doc and expand row wrappers.
  const baseOrder = compileOrder(artifacts, artifacts.plan);
  const { doc, errors } = applyMutations(artifacts.plan, mutations, knownIds, baseOrder);
  // Mutation errors FAIL the edit — a 200 that silently applied nothing is
  // how "drag and drop doesn't work" shipped twice.
  if (errors.length > 0) return { ok: false, errors };
  const v = validatePlan(doc.plan, artifacts.findings.findings);
  if (!v.ok) return { ok: false, errors: v.errors };

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
  // Persist to the record: by the entry's own id when known (restored
  // sessions — the fresh csvId matches no record), else by csvId.
  if (historyId) await updateArtifactsByHistoryId(historyId, next);
  else await updateArtifactsByCsvId(csvId, next).catch(() => false);
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
  /** Layout width (overlay.widths) — "half" pairs into two-column rows. */
  width: "half" | "full";
}

export interface EditSurface {
  doc: PlanDocument;
  sections: EditSection[];
  /** Declared claims: cited = referenced by some plan node; suggestedOp for
   *  one-click add_node; preview = the exact resolved sentence adding the
   *  claim would put on the dashboard. Checks are omitted (caveats are
   *  grammar-governed). */
  claims: {
    name: string;
    dtype: string;
    cited: boolean;
    suggestedOp: string;
    preview: string;
  }[];
  /** Full derived view family with reasons — shipped:false entries are the
   *  add-chart picker. */
  views: { id: string; kind: string; seriesId: string; reason: string; shipped: boolean }[];
}

export async function getEditSurface(
  csvId: string,
  historyId?: string | null
): Promise<EditSurface | null> {
  const artifacts = await resolveArtifacts(csvId, historyId);
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
  // Half-width elements compile inside compiled_row_* grid wrappers —
  // expand them so the edit surface always lists the REAL elements.
  const rowChildren = new Map<string, string[]>();
  for (const line of lines) {
    const p = JSON.parse(line) as { path?: string; value?: { children?: string[] } };
    if (p.path?.startsWith("/elements/compiled_row_")) {
      rowChildren.set(p.path.slice("/elements/".length), p.value?.children ?? []);
    }
  }
  const visible = (root.value?.children ?? []).flatMap((id) => rowChildren.get(id) ?? [id]);

  const widthOf = (id: string): "half" | "full" => doc.overlay.widths?.[id] ?? "full";
  const sectionFor = (id: string, isHidden: boolean): EditSection | null => {
    if (id === "compiled_check_banner")
      return {
        id,
        kind: "banner",
        label: "Failed-check banner",
        hidden: isHidden,
        width: widthOf(id),
      };
    if (id === "tile_grid")
      return { id, kind: "tiles", label: "Headline tiles", hidden: isHidden, width: widthOf(id) };
    if (id === "compiled_evidence_break")
      return {
        id,
        kind: "banner",
        label: "Evidence divider",
        hidden: isHidden,
        width: widthOf(id),
      };
    const node = doc.plan.nodes.find((n) => n.id === id);
    if (node) {
      const text = realizeNode(node, byName) ?? node.text ?? "";
      return {
        id,
        kind: "node",
        op: node.op,
        label: node.op === "INSIGHT" ? "Insight" : `${node.op}: ${node.refs.join(", ")}`,
        // The preview is the SENTENCE the reader sees — resolved values,
        // never binding syntax (the panel's rows mirror the dashboard).
        preview: resolvePreviewText(text, findings).slice(0, 200),
        hidden: isHidden,
        width: widthOf(id),
      };
    }
    const view = viewById.get(id);
    if (view) {
      return {
        id,
        kind: "view",
        label: `${view.kind === "table" ? "Table" : "Chart"}: ${humanizeId(view.seriesId)}${view.kind === "coverage" ? " (coverage)" : view.kind === "unit_split" ? " (unit split)" : ""}`,
        hidden: isHidden,
        width: widthOf(id),
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
        preview: resolvePreviewText(realizeClaim(f), findings).slice(0, 200),
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
