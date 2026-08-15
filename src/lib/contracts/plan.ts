/**
 * Narrative plan contract (specs/narrative-compiler-2026-08-09.md §1).
 *
 * The plan is the model's ONLY generative act in compiled composition: a
 * typed program of speech-acts referencing claims by name. The overlay is
 * the user's layout preference, keyed by stable ids so it survives
 * recompiles and data refreshes. Both are small documents — the mutation
 * grammar over them is the single governed edit channel shared by the web
 * UI, MCP tools, and LLM-assist.
 */

export type PlanOp =
  | "ANSWER" // the answer in words — exactly one required
  | "TREND"
  | "SHAPE" // comparison / split structure
  | "PEAK"
  | "ENDPOINT" // current state
  | "CONTRAST"
  | "NOTE"
  | "CAVEAT" // must reference a check/screen; renders ONLY its fields
  | "INSIGHT" // cross-claim synthesis (findings-bound, linted, audited)
  // Document grammar (spec §14) — the report apparatus:
  | "SECTION" // heading (short title, no refs needed)
  | "EXPLAIN" // chart explainer — usually anchored to a view
  | "CALLOUT" // attention block (renders as a flagged annotation)
  | "METHOD" // how the analysis was done (grounded in claim definitions)
  | "CONCLUSION" // closing summary (figures bound)
  | "NEXT_STEPS" // suggested follow-ups (framed as actions, never findings)
  | "LIMITS" // what this analysis does NOT cover
  | "VIEW"; // a requested visualization (compiled-view-parity spec §2)

export interface PlanNode {
  /** Stable id (ULID-ish) — the overlay and mutations key on it. */
  id: string;
  op: PlanOp;
  /** Claim names this node renders/references (finding manifest names). */
  refs: string[];
  /** Authored narrative (narrated mode): figures must be $finding:
   *  bindings — validateNodeText rejects literal digits. CAVEAT never
   *  carries text. */
  text?: string;
  /** Element id (chart_/table_/tile_grid) to render IMMEDIATELY AFTER
   *  this node — how explainers sit above their chart and caveats sit at
   *  the position they caveat. Unknown anchors are ignored (the element
   *  stays in the evidence block). */
  anchor?: string;
  /** VIEW nodes only (compiled-view-parity spec §2): the requested catalog
   *  component. Licensed against COMPONENT_ROLE_SIGNATURES at validation;
   *  props are compiled deterministically — never authored. */
  component?: string;
  /** VIEW nodes only: the DECLARED series the view renders (series-fed
   *  components). Claim-fed components use refs instead. */
  series?: string;
  /** VIEW nodes only: the DECLARED payload id (payload-fed components —
   *  non-tidy structures declared via declare_payload). */
  payload?: string;
}

export interface Plan {
  nodes: PlanNode[];
}

/** User layout preferences; identity-keyed, overlay-wins on conflict. */
export interface PlanOverlay {
  /** Node/claim ids in display order (unlisted ids follow, compiled order). */
  order?: string[];
  /** Node ids hidden from render (claims stay in the manifest/Verify). */
  hidden?: string[];
  /** View ids FORCE-SHIPPED from the derived catalog (views.ts) — the "add
   *  chart" affordance: a derived-but-unshipped view (coverage companion,
   *  precision table, unit split) the user opted in. Every shown view is
   *  still a pure projection of declared rows. */
  shown?: string[];
  /** Per-element layout width: "half" elements pair with their next half
   *  neighbor into a two-column row at compile time (the one-column-to-
   *  two-column edit); absent/"full" spans the column. */
  widths?: Record<string, "half" | "full">;
}

export interface PlanDocument {
  plan: Plan;
  overlay: PlanOverlay;
  /** Compose mode that produced the current spec. */
  mode: "generative" | "compiled";
  /** Output style the run was composed with — recompiles (edit path) keep
   *  the same plan budget and view family. Absent on pre-purpose docs. */
  purpose?: string;
  /** chart_data key holding the run's GeoJSON FeatureCollection at compose
   *  time ("geojson" on the ask path, step-prefixed under Investigate's
   *  merge, e.g. "step_2_geojson"). Persisted so the edit-path recompile
   *  can re-inject the compiled_geo_map and bind a MapView's polygons to the
   *  SAME key — without it the recompiled spec falls back to $chartData:geojson
   *  and the map silently vanishes forever. Absent when the run had no
   *  geometry. */
  geojsonKey?: string;
}

export type PlanMutation =
  | { kind: "move"; id: string; before?: string }
  | { kind: "hide"; id: string }
  | { kind: "show"; id: string }
  | {
      kind: "add_node";
      node: { op: PlanOp; refs: string[]; text?: string; anchor?: string };
      before?: string;
    }
  | { kind: "remove_node"; id: string }
  | { kind: "set_insight"; text: string }
  | { kind: "set_width"; id: string; width: "half" | "full" }
  /** Restore a whole {plan, overlay} snapshot — the UNDO primitive. Still
   *  governed: the restored plan passes the same validator as any edit
   *  (mode/purpose are preserved from the current document). */
  | { kind: "restore_document"; plan: Plan; overlay: PlanOverlay };
