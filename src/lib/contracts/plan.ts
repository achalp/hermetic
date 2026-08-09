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
  | "INSIGHT"; // the one free-prose tier-3 node (linted + audited)

export interface PlanNode {
  /** Stable id (ULID-ish) — the overlay and mutations key on it. */
  id: string;
  op: PlanOp;
  /** Claim names this node renders/references (finding manifest names). */
  refs: string[];
  /** INSIGHT only: the free prose (findings-bound, linted, audited). */
  text?: string;
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
}

export type PlanMutation =
  | { kind: "move"; id: string; before?: string }
  | { kind: "hide"; id: string }
  | { kind: "show"; id: string }
  | { kind: "add_node"; node: { op: PlanOp; refs: string[]; text?: string }; before?: string }
  | { kind: "remove_node"; id: string }
  | { kind: "set_insight"; text: string }
  | { kind: "set_width"; id: string; width: "half" | "full" }
  /** Restore a whole {plan, overlay} snapshot — the UNDO primitive. Still
   *  governed: the restored plan passes the same validator as any edit
   *  (mode/purpose are preserved from the current document). */
  | { kind: "restore_document"; plan: Plan; overlay: PlanOverlay };
