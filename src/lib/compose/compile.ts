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
import { failedCheckBanner, tileElement, humanizeId, type SpecPatchLine } from "./scaffold";
import { deriveViews, viewDefaultWidths } from "./views";

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

  // 3. Narrative from the plan, one element per node (identity-keyed so
  //    the overlay survives recompiles). FORM is part of honesty's
  //    legibility: headings, callouts, annotations, and body prose are
  //    visually distinct — a caveat indistinguishable from a sentence is
  //    a caveat unread. Nodes may ANCHOR an element (chart/table): the
  //    anchored element renders immediately after the node — explainers
  //    sit above their chart, caveats sit where they apply — and leaves
  //    the trailing evidence block.
  const anchored = new Set<string>();
  const pendingAnchors: { afterNodeId: string; elementId: string }[] = [];
  for (const node of plan.nodes) {
    if (hidden.has(node.id)) continue;
    const text = realizeNode(node, byName);
    if (!text) continue;
    let value: SpecPatchLine["value"];
    if (node.op === "SECTION") {
      value = {
        type: "TextBlock",
        props: { content: text, variant: "heading" },
        children: [],
      };
    } else if (node.op === "CALLOUT") {
      value = {
        type: "Annotation",
        props: { title: "Worth attention", content: text, severity: "info", icon: "flag" },
        children: [],
      };
    } else if (node.op === "CAVEAT") {
      const failed = node.refs.some((r) => {
        const f = byName.get(r);
        return (
          f?.value !== null &&
          typeof f?.value === "object" &&
          (f.value as Record<string, unknown>).passed === false
        );
      });
      value = {
        type: "Annotation",
        props: {
          title: `Data check: ${humanizeId(node.refs[0] ?? "caveat")}`,
          content: text,
          severity: failed ? "warning" : "info",
          icon: failed ? "alert" : "check",
        },
        children: [],
      };
    } else {
      const insightLike = node.op === "ANSWER" || node.op === "INSIGHT" || node.op === "CONCLUSION";
      value = {
        type: "TextBlock",
        props: { content: text, ...(insightLike ? { variant: "insight" } : {}) },
        children: [],
      };
    }
    patches.push({ op: "add", path: `/elements/${node.id}`, value });
    children.push(node.id);
    if (node.anchor && !hidden.has(node.anchor) && !anchored.has(node.anchor)) {
      anchored.add(node.anchor);
      pendingAnchors.push({ afterNodeId: node.id, elementId: node.anchor });
    }
  }

  // 4. Views from declared series roles (views.ts): unit-split primaries,
  //    regime-forced coverage companions, document-style tables. Every view
  //    is a pure projection of declared rows; the overlay can hide any.
  const shown = new Set(overlay.shown ?? []);
  const views = deriveViews({
    series: product.series,
    regimes: input.regimes,
    purpose: input.purpose,
  });
  const shippedViews = views.filter((v) => (v.shipped || shown.has(v.id)) && !hidden.has(v.id));
  // Anchored views render at their node's position: emit their patches,
  // splice their ids in after the anchoring node, and drop them from the
  // evidence block. Anchors naming unknown/unshipped elements are ignored.
  const shippedIds = new Set(shippedViews.map((v) => v.id));
  for (const a of pendingAnchors) {
    if (!shippedIds.has(a.elementId)) continue;
    const view = shippedViews.find((v) => v.id === a.elementId)!;
    patches.push(view.patch);
    const at = children.indexOf(a.afterNodeId);
    if (at === -1) continue;
    children.splice(at + 1, 0, a.elementId);
  }
  // A visual seam between the story and its evidence — without it the
  // narrative reads as a preamble to "a boring list of charts" (first
  // compiled-run review). Identity-keyed so the overlay can hide/move it.
  // Skipped when every view was anchored into the narrative: a seam with
  // nothing under it is a dangling label.
  const evidenceViews = shippedViews.filter((v) => !children.includes(v.id));
  if (evidenceViews.length > 0 && !hidden.has("compiled_evidence_break")) {
    patches.push({
      op: "add",
      path: "/elements/compiled_evidence_break",
      value: {
        type: "SectionBreak",
        props: { variant: "line", label: "Evidence" },
        children: [],
      },
    });
    children.push("compiled_evidence_break");
  }
  for (const v of evidenceViews) {
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

  // 6. Widths (the one-column-to-two-column edit): consecutive "half"
  //    elements pair into a two-column LayoutGrid row; a lone half spans
  //    full (never a hole). Row ids derive from their FIRST member so the
  //    grouping is stable across recompiles.
  // Catalog layout defaults under the user's overlay: charts pair into
  // two-column rows by default (viewDefaultWidths); an explicit
  // overlay.widths entry always wins, in either direction.
  const widths: Record<string, string> = {
    ...viewDefaultWidths(shippedViews),
    ...(overlay.widths ?? {}),
  };
  const finalChildren: string[] = [];
  let pendingHalf: string[] = [];
  const flushRow = () => {
    if (pendingHalf.length === 1) finalChildren.push(pendingHalf[0]);
    else if (pendingHalf.length === 2) {
      const rowId = `compiled_row_${pendingHalf[0]}`;
      patches.push({
        op: "add",
        path: `/elements/${rowId}`,
        value: { type: "LayoutGrid", props: { columns: 2 }, children: [...pendingHalf] },
      });
      finalChildren.push(rowId);
    }
    pendingHalf = [];
  };
  for (const id of ordered) {
    if (widths[id] === "half") {
      pendingHalf.push(id);
      if (pendingHalf.length === 2) flushRow();
    } else {
      flushRow();
      finalChildren.push(id);
    }
  }
  flushRow();

  const root: SpecPatchLine = {
    op: "add",
    path: "/elements/compiled_root",
    value: {
      type: "LayoutColumn",
      props: { title: null },
      children: finalChildren,
    },
  };

  return [
    ...patches.map((p) => JSON.stringify(p)),
    JSON.stringify(root),
    JSON.stringify({ op: "add", path: "/root", value: "compiled_root" }),
  ];
}
