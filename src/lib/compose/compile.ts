/**
 * The dashboard compiler (specs/narrative-compiler-2026-08-09.md):
 * `compile(claims, product, plan, overlay)` → spec patch lines, fully
 * deterministic. Sentences carry `$finding:` bindings; the caller streams
 * the lines through the SAME finalizer as generative compose, so value
 * resolution, unit rendering, and discourse checks are one stack.
 */
import type { FindingsManifest } from "@/lib/contracts/findings";
import type { AnalysisProduct } from "@/lib/contracts/product";
import type { Plan, PlanOverlay } from "@/lib/contracts/plan";
import type { HeadlineTile } from "@/lib/findings/headline-plan";
import { realizeNode } from "./realizer";
import { failedCheckBanner, tileElement, humanizeId, type SpecPatchLine } from "./scaffold";
import { compileViewNode } from "./view-compilers";
import { deriveViews, viewDefaultWidths } from "./views";
import { deriveAggregatingController, deriveController, rebindViewPatch } from "./controller";

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
  /** Raw tables from the run (`datasets`) — the source a declared
   *  `aggregates` recipe re-aggregates from (controller.ts). */
  datasets?: Record<string, unknown>;
  /** chart_data key holding the run's GeoJSON FeatureCollection —
   *  "geojson" on the ask path, step-prefixed under Investigate's merge.
   *  When set, the compiled document always ships a map of it: run
   *  8df300b3 computed zone polygons and the compiled dashboard claimed
   *  the data had no geography because no channel existed for geometry. */
  geojsonKey?: string;
}

/** Deterministic compilation to spec patch lines (JSONL strings). */
export function compileDashboard(input: CompileInput): string[] {
  const { manifest, product, plan, overlay, headlinePlan } = input;
  const byName = new Map(manifest.findings.map((f) => [f.name, f]));
  const hidden = new Set(overlay.hidden ?? []);
  const patches: SpecPatchLine[] = [];
  const children: string[] = [];

  // 1. Failed-check banner first — caveats are not buried.
  // Failed-semantics MUST match realizer.ts (the caveat renderer): a check/
  // screen fails on passed===false, and an `outliers`-dtype screen fails when it
  // FLAGGED offenders (n_flagged>0, no `passed` field). The banner previously
  // saw only passed===false check/screen findings, so an outliers screen that
  // found offenders got a caveat node but was absent from the prominent banner
  // (finding PE-2) — less visible than a passed:false check's caveat.
  const failed = manifest.findings.filter((f) => {
    if (f.dtype !== "check" && f.dtype !== "screen" && f.dtype !== "outliers") return false;
    if (f.value === null || typeof f.value !== "object") return false;
    const v = f.value as Record<string, unknown>;
    return (
      v.passed === false ||
      (v.passed === undefined && typeof v.n_flagged === "number" && v.n_flagged > 0)
    );
  });
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
  // Document-scoped rider tracking (spec finding-field-roles §2.M4): each
  // claim's honesty riders attach at the FIRST node referencing it, so an
  // authored narrative citing one claim from three nodes carries the
  // disclosures once, not thrice.
  const rideredClaims = new Set<string>();
  // VIEW nodes (compiled-view-parity §2): planner-requested components,
  // compiled here from declared roles/claims. A compiled VIEW SUPPRESSES
  // the derived primary of its series below — one chart per series, the
  // planner's choice of form; disclosure variants always survive.
  const seriesById = new Map(product.series.map((s) => [s.id, s]));
  const viewedSeries = new Set<string>();
  // Pre-scan VIEW nodes so an EXPLAIN anchored to a derived primary the
  // VIEW is about to SUPPRESS re-points at the VIEW's element instead of
  // dangling (review 2026-08-15: the anchor was silently ignored and the
  // explainer described a chart that no longer shipped).
  const viewNodeBySeries = new Map<string, string>();
  const rebindableViewPatches: { nodeId: string; seriesId: string; patchIndex: number }[] = [];
  for (const n of plan.nodes) {
    if (n.op === "VIEW" && n.series && !hidden.has(n.id) && !viewNodeBySeries.has(n.series)) {
      viewNodeBySeries.set(n.series, n.id);
    }
  }
  for (const node of plan.nodes) {
    if (hidden.has(node.id)) continue;
    if (node.op === "VIEW") {
      const patch = compileViewNode(
        node,
        node.series ? seriesById.get(node.series) : undefined,
        byName,
        { geojsonKey: input.geojsonKey }
      );
      if (patch) {
        patches.push(patch);
        children.push(node.id);
        if (node.series) {
          viewedSeries.add(node.series);
          // Row-binding VIEW charts (props.data === "$chartData:<sid>")
          // join the series' controller loop below — inline-transformed
          // shapes (pivots, trees, curves) stay static, their transforms
          // cannot re-run client-side.
          const props = (patch.value as { props?: Record<string, unknown> }).props ?? {};
          if (props.data === `$chartData:${node.series}`) {
            rebindableViewPatches.push({
              nodeId: node.id,
              seriesId: node.series,
              patchIndex: patches.length - 1,
            });
          }
        }
      }
      continue;
    }
    const text = realizeNode(node, byName, rideredClaims);
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
    let anchor = node.anchor;
    if (anchor?.startsWith("chart_")) {
      const viewId = viewNodeBySeries.get(anchor.slice("chart_".length));
      if (viewId) anchor = viewId; // the primary will be suppressed
    }
    if (anchor && !hidden.has(anchor) && !anchored.has(anchor)) {
      anchored.add(anchor);
      pendingAnchors.push({ afterNodeId: node.id, elementId: anchor });
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
  let shippedViews = views.filter((v) => (v.shipped || shown.has(v.id)) && !hidden.has(v.id));
  // Planner-viewed series lose their derived PRIMARY only — coverage
  // companions, unit splits, and tables are disclosure, not style, and
  // never compete with the planner's choice. A grouped series' primary is
  // the group_matrix HEATMAP (views.ts §Group series), sharing the same
  // chart_<sid> id as a flat primary — it is a primary for suppression too
  // (finding 08/H1: a VIEW on a grouped series shipped BOTH the VIEW and
  // the derived heatmap, and the anchor re-point above assumes the primary
  // is gone).
  shippedViews = shippedViews.filter(
    (v) => !((v.kind === "primary" || v.kind === "group_matrix") && viewedSeries.has(v.seriesId))
  );

  // Interactivity (controller.ts): a series that DECLARED a group role has
  // named its filterable dimension, so the reader gets the same filter bar
  // the generative composer offers — derived, never written. Views of a
  // controlled series read from /computed/* instead of carrying inline data;
  // initial state carries the exact static values, so first paint is
  // unchanged and interaction is purely additive.
  const controllers = product.series
    .map((s) => {
      const own = [
        ...shippedViews.filter((v) => v.seriesId === s.id),
        // Planner VIEW charts that bind this series' raw rows participate
        // in filtering exactly like derived views (review 2026-08-15:
        // they kept static bindings while the filter bar re-aggregated
        // everything else).
        ...rebindableViewPatches
          .filter((rv) => rv.seriesId === s.id)
          .map(
            (rv) =>
              ({
                id: rv.nodeId,
                kind: "primary",
                seriesId: rv.seriesId,
                shipped: true,
                patch: patches[rv.patchIndex],
              }) as (typeof shippedViews)[number]
          ),
      ];
      // A declared re-aggregation recipe (verified against the series' own
      // rows) wins: it filters by dimensions the aggregated series does not
      // even carry. Otherwise fall back to filtering the series' own rows.
      return (
        deriveAggregatingController(s, own, input.datasets, product.series) ??
        deriveController(s, own)
      );
    })
    .filter((c): c is NonNullable<typeof c> => c !== null)
    .filter((c) => !hidden.has(c.id));
  if (controllers.length > 0) {
    const rebind: Record<string, string> = Object.assign({}, ...controllers.map((c) => c.rebind));
    shippedViews = shippedViews.map((v) =>
      rebind[v.id] ? { ...v, patch: rebindViewPatch(v.patch, rebind[v.id]) } : v
    );
    for (const rv of rebindableViewPatches) {
      if (rebind[rv.nodeId]) {
        patches[rv.patchIndex] = rebindViewPatch(patches[rv.patchIndex], rebind[rv.nodeId]);
      }
    }
    // State FIRST: the finalizer harvests declared state keys as it streams,
    // and repairs element bindings against them — a binding emitted before
    // its key is declared would be "repaired" away.
    const datasets: Record<string, unknown> = {};
    const filters: Record<string, unknown> = {};
    const computed: Record<string, unknown> = {};
    for (const c of controllers) {
      Object.assign(datasets, c.state.datasets);
      Object.assign(filters, c.state.filters);
      Object.assign(computed, c.state.computed);
    }
    patches.push({
      op: "add",
      path: "/state",
      value: { datasets, filters, computed } as unknown as SpecPatchLine["value"],
    });
  }
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
  const controllerFor = new Map(controllers.map((c) => [c.seriesId, c]));
  const emittedControls = new Set<string>();
  /** A controlled series' filter bar leads its views, wherever they land. */
  const emitControlsFor = (seriesId: string, into: string[]): void => {
    const c = controllerFor.get(seriesId);
    if (!c || emittedControls.has(c.id)) return;
    emittedControls.add(c.id);
    patches.push(c.element);
    into.push(c.id);
  };
  for (const a of pendingAnchors) {
    const v = shippedViews.find((x) => x.id === a.elementId);
    if (!v) continue;
    const c = controllerFor.get(v.seriesId);
    if (!c || emittedControls.has(c.id)) continue;
    // The anchored view was spliced into the narrative: put its controls
    // directly above it, not down in the evidence block.
    const at = children.indexOf(v.id);
    if (at === -1) continue;
    emittedControls.add(c.id);
    patches.push(c.element);
    children.splice(at, 0, c.id);
  }
  // A controlled planner VIEW gets its filter bar directly above it.
  for (const rv of rebindableViewPatches) {
    const c = controllerFor.get(rv.seriesId);
    if (!c || emittedControls.has(c.id)) continue;
    const at = children.indexOf(rv.nodeId);
    if (at === -1) continue;
    emittedControls.add(c.id);
    patches.push(c.element);
    children.splice(at, 0, c.id);
  }
  for (const v of evidenceViews) {
    emitControlsFor(v.seriesId, children);
    patches.push(v.patch);
    children.push(v.id);
  }

  // Anchors that name a VIEW node's element (re-pointed above): the element
  // already sits in children at the VIEW's plan position — MOVE it directly
  // after its anchoring node, honoring the explainer-above-chart contract.
  const viewNodeIds = new Set(viewNodeBySeries.values());
  for (const a of pendingAnchors) {
    if (!viewNodeIds.has(a.elementId)) continue;
    const cur = children.indexOf(a.elementId);
    const at = children.indexOf(a.afterNodeId);
    if (cur === -1 || at === -1 || cur === at + 1) continue;
    children.splice(cur, 1);
    children.splice(children.indexOf(a.afterNodeId) + 1, 0, a.elementId);
  }

  // Region geometry always renders (compiled-view-parity follow-up, run
  // 8df300b3): when the analysis produced chart_data.geojson and no map
  // shipped — the planner requested none and no geo series exists to
  // license one — a MapView of the geometry joins the evidence block.
  // The binding resolves through the same finalizer channel as every
  // chart; identity-keyed so the overlay can hide or move it.
  if (input.geojsonKey && !hidden.has("compiled_geo_map")) {
    const mapShipped = plan.nodes.some(
      (n) => n.op === "VIEW" && !hidden.has(n.id) && n.component === "MapView"
    );
    if (!mapShipped) {
      patches.push({
        op: "add",
        path: "/elements/compiled_geo_map",
        value: {
          type: "MapView",
          props: { title: "Map", geojson: `$chartData:${input.geojsonKey}`, markers: null },
          children: [],
        },
      });
      children.push("compiled_geo_map");
    }
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
  const catalogWidths = viewDefaultWidths(shippedViews);
  // A chart anchored to its explainer is that passage's hero — it spans,
  // rather than pairing with an unrelated chart beside the prose.
  for (const id of anchored) delete catalogWidths[id];
  // A controlled chart spans too: its filter bar sits directly above it, and
  // a control strip wedged between two half charts breaks the row anyway.
  for (const c of controllers) for (const id of Object.keys(c.rebind)) delete catalogWidths[id];
  const widths: Record<string, string> = { ...catalogWidths, ...(overlay.widths ?? {}) };
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

  // State leads the stream: the finalizer harvests declared state keys as
  // patches flow and repairs element bindings against what it has seen, so
  // a chart bound to /computed/x must not arrive before /state declares it.
  const ordered_patches = [
    ...patches.filter((p) => p.path === "/state"),
    ...patches.filter((p) => p.path !== "/state"),
  ];
  return [
    ...ordered_patches.map((p) => JSON.stringify(p)),
    JSON.stringify(root),
    JSON.stringify({ op: "add", path: "/root", value: "compiled_root" }),
  ];
}
