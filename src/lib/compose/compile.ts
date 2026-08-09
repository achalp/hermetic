/**
 * The dashboard compiler (specs/narrative-compiler-2026-08-09.md):
 * `compile(claims, product, plan, overlay)` → spec patch lines, fully
 * deterministic. Sentences carry `$finding:` bindings; the caller streams
 * the lines through the SAME finalizer as generative compose, so value
 * resolution, unit rendering, and discourse checks are one stack.
 */
import type { FindingEntry, FindingsManifest } from "@/lib/contracts/findings";
import type { AnalysisProduct } from "@/lib/contracts/product";
import type { Plan, PlanOverlay } from "@/lib/contracts/plan";
import type { HeadlineTile } from "@/lib/findings/headline-plan";
import { realizeNode } from "./realizer";
import { failedCheckBanner, tileElement, type SpecPatchLine } from "./scaffold";
import { deriveViews } from "./views";

export interface CompileInput {
  manifest: FindingsManifest;
  product: AnalysisProduct;
  plan: Plan;
  overlay: PlanOverlay;
  headlinePlan: HeadlineTile[];
  question: string;
  /** Output style — scales the shipped view family (views.ts). */
  purpose?: string;
  /** Envelope regime profiles by series id — force evidence views in. */
  regimes?: Record<string, unknown>;
}

/** Deterministic compilation to spec patch lines (JSONL strings). */
export function compileDashboard(input: CompileInput): string[] {
  const { manifest, product, plan, overlay, headlinePlan } = input;
  const byName = new Map(manifest.findings.map((f) => [f.name, f]));
  const hidden = new Set(overlay.hidden ?? []);
  const patches: SpecPatchLine[] = [];
  const children: string[] = [];

  // 1. Failed-check banner first — caveats are not buried.
  const failed = manifest.findings.filter(
    (f) =>
      (f.dtype === "check" || f.dtype === "screen") &&
      f.value !== null &&
      typeof f.value === "object" &&
      (f.value as Record<string, unknown>).passed === false
  );
  const banner = failedCheckBanner(failed);
  if (banner) {
    patches.push(banner);
    children.push("compiled_check_banner");
  }

  // 2. Headline tiles (the deterministic plan — injection has nothing to do).
  headlinePlan.forEach((tile, i) => {
    patches.push(tileElement(tile, i));
  });
  if (headlinePlan.length > 0) {
    patches.push({
      op: "add",
      path: "/elements/tile_grid",
      value: {
        type: "LayoutGrid",
        props: { columns: Math.min(4, Math.max(2, headlinePlan.length)) },
        children: headlinePlan.map((_, i) => `tile_${i}`),
      },
    });
    children.push("tile_grid");
  }

  // 3. Narrative from the plan, one TextBlock per node (identity-keyed so
  //    the overlay survives recompiles).
  for (const node of plan.nodes) {
    if (hidden.has(node.id)) continue;
    const text = realizeNode(node, byName);
    if (!text) continue;
    patches.push({
      op: "add",
      path: `/elements/${node.id}`,
      value: { type: "TextBlock", props: { content: text }, children: [] },
    });
    children.push(node.id);
  }

  // 4. Views from declared series roles (views.ts): unit-split primaries,
  //    regime-forced coverage companions, document-style tables. Every view
  //    is a pure projection of declared rows; the overlay can hide any.
  const views = deriveViews({
    series: product.series,
    regimes: input.regimes,
    purpose: input.purpose,
  });
  for (const v of views) {
    if (!v.shipped || hidden.has(v.id)) continue;
    patches.push(v.patch);
    children.push(v.id);
  }

  // 5. Overlay ordering: listed ids first (in overlay order), rest keep
  //    compiled order. Overlay wins (spec §4.6).
  const order = overlay.order ?? [];
  const ordered = [
    ...order.filter((id) => children.includes(id)),
    ...children.filter((id) => !order.includes(id)),
  ];

  const root: SpecPatchLine = {
    op: "add",
    path: "/elements/compiled_root",
    value: {
      type: "LayoutColumn",
      props: { title: null },
      children: ordered,
    },
  };

  return [
    ...patches.map((p) => JSON.stringify(p)),
    JSON.stringify(root),
    JSON.stringify({ op: "add", path: "/root", value: "compiled_root" }),
  ];
}
