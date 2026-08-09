"use client";

/**
 * All state and behavior for the dashboard edit panel (narrative-compiler
 * spec §3) — the components render, this hook decides. Owns:
 *
 *  - the edit surface (fetch, retryable failure distinct from not-compiled);
 *  - OPTIMISTIC section state: reorders and visibility changes apply to the
 *    list immediately, then reconcile with the server's authoritative
 *    surface (a failed write resyncs — the settings-mirror lesson);
 *  - the UNDO stack: every successful edit pushes the prior {plan, overlay}
 *    snapshot; undo replays it through the governed restore_document
 *    mutation, so even remove_node is safe;
 *  - per-action pending (pendingId) so one busy row never freezes the panel.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Spec } from "@/lib/contracts/spec";
import type { PlanMutation, PlanOp } from "@/lib/contracts/plan";
import { getPlanSurface, patchPlan, type PlanEditSurface, ApiError } from "@/app/lib/api";

type Sections = PlanEditSurface["sections"];

export function usePlanEdit(args: {
  csvId: string | null;
  historyId?: string | null;
  open: boolean;
  onSpecUpdated: (spec: Spec) => void;
}) {
  const { csvId, historyId, open, onSpecUpdated } = args;
  const [surface, setSurface] = useState<PlanEditSurface | null>(null);
  const [sections, setSections] = useState<Sections>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const undoStack = useRef<
    { plan: PlanEditSurface["doc"]["plan"]; overlay: PlanEditSurface["doc"]["overlay"] }[]
  >([]);
  const [undoDepth, setUndoDepth] = useState(0);

  const refresh = useCallback(async () => {
    if (!csvId) return;
    try {
      const s = await getPlanSurface(csvId, historyId);
      setSurface(s);
      setSections(s?.sections ?? []);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
    setLoaded(true);
  }, [csvId, historyId]);

  useEffect(() => {
    if (open) {
      setLoaded(false);
      setError(null);
      setLoadFailed(false);
      undoStack.current = [];
      setUndoDepth(0);
      void refresh();
    }
  }, [open, refresh]);

  /** Apply a mutation batch. `snapshot` (default) records the pre-edit doc
   *  for undo; undo itself passes false. */
  const apply = useCallback(
    async (mutations: PlanMutation[], opts?: { pendingId?: string; snapshot?: boolean }) => {
      if (!csvId || !surface) return false;
      const prev = structuredClone({ plan: surface.doc.plan, overlay: surface.doc.overlay });
      setPendingId(opts?.pendingId ?? "__panel__");
      setError(null);
      try {
        const result = await patchPlan(csvId, mutations, historyId);
        if (opts?.snapshot !== false) {
          undoStack.current.push(prev);
          if (undoStack.current.length > 20) undoStack.current.shift();
        }
        setUndoDepth(undoStack.current.length);
        onSpecUpdated(result.spec);
        await refresh();
        return true;
      } catch (e) {
        setError(e instanceof ApiError ? e.message : "That change didn't save — try again.");
        await refresh(); // resync optimistic state with server truth
        return false;
      } finally {
        setPendingId(null);
      }
    },
    [csvId, historyId, surface, onSpecUpdated, refresh]
  );

  const undo = useCallback(async () => {
    const snap = undoStack.current.pop();
    setUndoDepth(undoStack.current.length);
    if (!snap) return;
    await apply([{ kind: "restore_document", plan: snap.plan, overlay: snap.overlay }], {
      snapshot: false,
      pendingId: "__undo__",
    });
  }, [apply]);

  /** Optimistic reorder: move `id` before `beforeId` (null = end) in the
   *  visible list immediately, then persist. PAIRING INTELLIGENCE: dropping
   *  an element right after a half-width one auto-halves it — the drop
   *  completes the two-column pair instead of stranding a lone half. */
  const reorder = useCallback(
    (id: string, beforeId: string | null) => {
      const visible = sections.filter((s) => !s.hidden && s.id !== id);
      const at = beforeId ? visible.findIndex((s) => s.id === beforeId) : visible.length;
      const preceding = at > 0 ? visible[at - 1] : undefined;
      const dragged = sections.find((s) => s.id === id);
      const autoHalf = preceding?.width === "half" && dragged?.width !== "half";
      setSections((prev) => {
        const next = prev.filter((s) => s.id !== id);
        const moved = prev.find((s) => s.id === id);
        if (!moved) return prev;
        const placed = autoHalf ? { ...moved, width: "half" as const } : moved;
        const idx = beforeId ? next.findIndex((s) => s.id === beforeId) : -1;
        if (idx === -1) next.push(placed);
        else next.splice(idx, 0, placed);
        return next;
      });
      void apply(
        [
          { kind: "move", id, ...(beforeId ? { before: beforeId } : {}) },
          ...(autoHalf ? [{ kind: "set_width", id, width: "half" } as const] : []),
        ],
        { pendingId: id }
      );
    },
    [apply, sections]
  );

  const toggleHidden = useCallback(
    (id: string, hidden: boolean) => {
      setSections((prev) => prev.map((s) => (s.id === id ? { ...s, hidden: !hidden } : s)));
      void apply([{ kind: hidden ? "show" : "hide", id }], { pendingId: id });
    },
    [apply]
  );

  const removeNode = useCallback(
    (id: string) => void apply([{ kind: "remove_node", id }], { pendingId: id }),
    [apply]
  );

  const saveInsight = useCallback(
    (text: string) => apply([{ kind: "set_insight", text }], { pendingId: "__insight__" }),
    [apply]
  );

  const addClaim = useCallback(
    (name: string, op: string) =>
      apply([{ kind: "add_node", node: { op: op as PlanOp, refs: [name] } }], {
        pendingId: `claim:${name}`,
      }),
    [apply]
  );

  const addView = useCallback(
    (id: string) => apply([{ kind: "show", id }], { pendingId: id }),
    [apply]
  );

  /** The one-column-to-two-column edit: half elements pair into rows. */
  const setWidth = useCallback(
    (id: string, width: "half" | "full") => {
      setSections((prev) => prev.map((s) => (s.id === id ? { ...s, width } : s)));
      void apply([{ kind: "set_width", id, width }], { pendingId: id });
    },
    [apply]
  );

  return {
    surface,
    sections,
    loaded,
    loadFailed,
    pendingId,
    error,
    canUndo: undoDepth > 0,
    refresh,
    undo,
    reorder,
    toggleHidden,
    removeNode,
    saveInsight,
    addClaim,
    addView,
    setWidth,
  };
}

export type PlanEdit = ReturnType<typeof usePlanEdit>;
