/**
 * The edit grammar (specs/narrative-compiler-2026-08-09.md §2): ONE
 * governed mutation channel over {plan, overlay}, shared by the web UI,
 * the MCP edit_dashboard tool, and LLM-assist. Humans and models edit the
 * same typed documents through the same validator — nobody has a path
 * around the invariants.
 *
 * Pure: applyMutations never touches I/O; callers re-validate the plan
 * against the manifest and recompile.
 */
import type { PlanDocument, PlanMutation } from "@/lib/contracts/plan";
import { nextPlanNodeId } from "./plan";

export interface MutationResult {
  doc: PlanDocument;
  applied: number;
  errors: string[];
}

export function applyMutations(
  doc: PlanDocument,
  mutations: PlanMutation[],
  /** Element ids valid as move/hide/show targets BEYOND plan nodes — the
   *  derived view ids and structural ids (tile grid, banner). Callers that
   *  know the compile surface pass them so typos still error; absent, only
   *  plan-node ids validate (legacy behavior). */
  knownElementIds?: Set<string>,
  /** The FULL compiled element order (banner, tiles, nodes, views) — the
   *  base a move starts from when overlay.order is still empty. Without
   *  it, the first drag on a fresh dashboard anchored to any non-node
   *  element (tiles, charts — most of the page) failed "unknown anchor". */
  baseOrder?: string[]
): MutationResult {
  const next: PlanDocument = {
    mode: doc.mode,
    // The purpose rides the document — dropping it on copy silently reset
    // every recompile's depth budget and view family to dashboard defaults.
    ...(doc.purpose !== undefined ? { purpose: doc.purpose } : {}),
    // Same for the geometry channel: geojsonKey is a run-level constant the
    // edit-path recompile needs to re-bind the map — dropping it here made
    // the map vanish on the FIRST edit (contracts/plan.ts).
    ...(doc.geojsonKey !== undefined ? { geojsonKey: doc.geojsonKey } : {}),
    plan: { nodes: doc.plan.nodes.map((n) => ({ ...n, refs: [...n.refs] })) },
    overlay: {
      order: [...(doc.overlay.order ?? [])],
      hidden: [...(doc.overlay.hidden ?? [])],
      shown: [...(doc.overlay.shown ?? [])],
      widths: { ...(doc.overlay.widths ?? {}) },
    },
  };
  const errors: string[] = [];
  let applied = 0;
  const ids = () => new Set(next.plan.nodes.map((n) => n.id));
  const targetable = (id: string) => ids().has(id) || (knownElementIds?.has(id) ?? false);

  for (const m of mutations) {
    switch (m.kind) {
      case "move": {
        if (!targetable(m.id)) {
          errors.push(`move: unknown node ${m.id}`);
          break;
        }
        const order = (next.overlay.order ?? []).filter((x) => x !== m.id);
        // Overlay order lists every element explicitly once a move happens —
        // deterministic and stable across recompiles (identity-keyed). The
        // first move seeds from the full compiled order when provided.
        const base = order.length > 0 ? order : (baseOrder ?? next.plan.nodes.map((n) => n.id));
        const withu = base.filter((x) => x !== m.id);
        const at = m.before ? withu.indexOf(m.before) : withu.length;
        if (m.before && at === -1) {
          errors.push(`move: unknown anchor ${m.before}`);
          break;
        }
        withu.splice(at === -1 ? withu.length : at, 0, m.id);
        next.overlay.order = withu;
        applied++;
        break;
      }
      case "hide": {
        if (!targetable(m.id)) {
          errors.push(`hide: unknown node ${m.id}`);
          break;
        }
        if (!next.overlay.hidden!.includes(m.id)) next.overlay.hidden!.push(m.id);
        next.overlay.shown = next.overlay.shown!.filter((x) => x !== m.id);
        applied++;
        break;
      }
      case "show": {
        next.overlay.hidden = next.overlay.hidden!.filter((x) => x !== m.id);
        // Showing a derived-but-unshipped view opts it in (force-ship);
        // for plan nodes the entry is inert — compile ships un-hidden
        // nodes regardless.
        if (knownElementIds?.has(m.id) && !next.overlay.shown!.includes(m.id)) {
          next.overlay.shown!.push(m.id);
        }
        applied++;
        break;
      }
      case "add_node": {
        const node = {
          id: nextPlanNodeId(),
          op: m.node.op,
          refs: m.node.refs,
          ...(m.node.text !== undefined ? { text: m.node.text } : {}),
        };
        const at = m.before ? next.plan.nodes.findIndex((n) => n.id === m.before) : -1;
        if (at === -1) next.plan.nodes.push(node);
        else next.plan.nodes.splice(at, 0, node);
        applied++;
        break;
      }
      case "remove_node": {
        const before = next.plan.nodes.length;
        next.plan.nodes = next.plan.nodes.filter((n) => n.id !== m.id);
        if (next.plan.nodes.length === before) errors.push(`remove_node: unknown node ${m.id}`);
        else applied++;
        break;
      }
      case "set_width": {
        if (!targetable(m.id)) {
          errors.push(`set_width: unknown element ${m.id}`);
          break;
        }
        if (m.width === "full") delete next.overlay.widths![m.id];
        else next.overlay.widths![m.id] = m.width;
        applied++;
        break;
      }
      case "restore_document": {
        // Undo: replace plan+overlay wholesale from a snapshot. mode and
        // purpose stay from the live document; the caller's re-validation
        // applies to the restored plan like any other edit.
        next.plan = { nodes: m.plan.nodes.map((n) => ({ ...n, refs: [...n.refs] })) };
        next.overlay = {
          order: [...(m.overlay.order ?? [])],
          hidden: [...(m.overlay.hidden ?? [])],
          shown: [...(m.overlay.shown ?? [])],
          widths: { ...(m.overlay.widths ?? {}) },
        };
        applied++;
        break;
      }
      case "set_insight": {
        const existing = next.plan.nodes.find((n) => n.op === "INSIGHT");
        if (existing) existing.text = m.text;
        else next.plan.nodes.push({ id: nextPlanNodeId(), op: "INSIGHT", refs: [], text: m.text });
        applied++;
        break;
      }
    }
  }
  return { doc: next, applied, errors };
}
