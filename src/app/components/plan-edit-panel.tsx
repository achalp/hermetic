"use client";

/**
 * Dashboard edit panel (narrative-compiler spec §3, revived per design
 * review): the web UI over the governed mutation grammar. A side sheet
 * listing the compiled dashboard's sections in render order — drag to
 * reorder, toggle visibility, edit the INSIGHT paragraph, narrate
 * un-cited claims, and add derived views from the catalog. Every action
 * maps to the SAME PlanMutation grammar the MCP edit_dashboard tool uses;
 * the server re-validates and recompiles deterministically (no LLM).
 *
 * Only compiled dashboards are editable (the user decision: compiled-only
 * — generative output has no plan document); the panel explains otherwise.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Spec } from "@/lib/contracts/spec";
import type { PlanMutation, PlanOp } from "@/lib/contracts/plan";
import { getPlanSurface, patchPlan, type PlanEditSurface, ApiError } from "@/app/lib/api";

export interface PlanEditPanelProps {
  csvId: string | null;
  open: boolean;
  onClose: () => void;
  /** Receives the recompiled spec after every applied mutation batch. */
  onSpecUpdated: (spec: Spec) => void;
}

export function PlanEditPanel({ csvId, open, onClose, onSpecUpdated }: PlanEditPanelProps) {
  const [surface, setSurface] = useState<PlanEditSurface | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A failed surface FETCH is not "this dashboard isn't compiled" — the two
  // states render differently (retry vs. the composer-setting explainer).
  const [loadFailed, setLoadFailed] = useState(false);
  const [insightDraft, setInsightDraft] = useState<string | null>(null);
  const dragId = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    if (!csvId) return;
    try {
      const s = await getPlanSurface(csvId);
      setSurface(s);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
    setLoaded(true);
  }, [csvId]);

  useEffect(() => {
    if (open) {
      setLoaded(false);
      setError(null);
      setLoadFailed(false);
      setInsightDraft(null);
      void refresh();
    }
  }, [open, refresh]);

  const apply = useCallback(
    async (mutations: PlanMutation[]) => {
      if (!csvId || busy) return;
      setBusy(true);
      setError(null);
      try {
        const result = await patchPlan(csvId, mutations);
        onSpecUpdated(result.spec);
        await refresh();
      } catch (e) {
        setError(e instanceof ApiError ? e.message : "Edit failed");
      } finally {
        setBusy(false);
      }
    },
    [csvId, busy, onSpecUpdated, refresh]
  );

  if (!open) return null;

  const insightNode = surface?.doc.plan.nodes.find((n) => n.op === "INSIGHT");
  const unshippedViews = surface?.views.filter((v) => !v.shipped) ?? [];
  const uncitedClaims = surface?.claims.filter((c) => !c.cited) ?? [];

  return (
    <div
      className="fixed top-14 bottom-0 w-[22rem] overflow-y-auto border-l border-border-default bg-surface-primary p-4 shadow-xl"
      // BESIDE the data rail's collapsed icon strip (48px at right-0,
      // z 180), never over or under it: offset by the strip's width, and
      // stacked below the rail so expanding it takes precedence. (v1 sat
      // under the strip and clipped; v2 covered it.)
      style={{ right: 48, zIndex: 170 }}
      data-testid="plan-edit-panel"
    >
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-t-primary">Edit dashboard</h3>
        <button
          onClick={onClose}
          className="text-xs text-t-tertiary hover:text-t-primary"
          aria-label="Close editor"
        >
          ✕
        </button>
      </div>

      {!loaded ? (
        <p className="text-xs text-t-tertiary">Loading…</p>
      ) : loadFailed ? (
        <div className="flex flex-col gap-2">
          <p className="text-xs" style={{ color: "var(--color-error-text)" }}>
            Couldn&apos;t load the dashboard&apos;s plan (server error) — this says nothing about
            whether it&apos;s editable.
          </p>
          <button
            onClick={() => {
              setLoaded(false);
              void refresh();
            }}
            className="self-start rounded border border-border-default px-2 py-1 text-xs text-t-primary"
          >
            Retry
          </button>
        </div>
      ) : !surface ? (
        <p className="text-xs text-t-secondary">
          This dashboard isn&apos;t editable — editing needs the compiled composer. Switch Settings
          → Composer Architecture to &quot;Compiled&quot; and re-run the question.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {error && (
            <p className="text-xs" style={{ color: "var(--color-error-text)" }}>
              {error}
            </p>
          )}

          {/* Sections: drag to reorder, eye to hide/show, trash on nodes. */}
          <div className="flex flex-col gap-1">
            <h4 className="text-[11px] font-medium uppercase tracking-wide text-t-tertiary">
              Sections — drag to reorder
            </h4>
            {surface.sections.map((s) => (
              <div
                key={s.id}
                draggable={!s.hidden}
                onDragStart={() => (dragId.current = s.id)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const from = dragId.current;
                  dragId.current = null;
                  if (from && from !== s.id) {
                    void apply([{ kind: "move", id: from, before: s.id }]);
                  }
                }}
                className={`group flex items-center gap-2 rounded border border-border-default px-2 py-1.5 text-xs ${
                  s.hidden ? "opacity-50" : "cursor-grab"
                }`}
              >
                <span className="select-none text-t-tertiary">⠿</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-t-primary">{s.label}</div>
                  {s.preview && <div className="truncate text-t-tertiary">{s.preview}</div>}
                </div>
                <button
                  title={s.hidden ? "Show" : "Hide"}
                  disabled={busy}
                  onClick={() => void apply([{ kind: s.hidden ? "show" : "hide", id: s.id }])}
                  className="text-t-tertiary hover:text-t-primary"
                >
                  {s.hidden ? "◌" : "◉"}
                </button>
                {s.kind === "node" && s.op !== "ANSWER" && (
                  <button
                    title="Remove"
                    disabled={busy}
                    onClick={() => void apply([{ kind: "remove_node", id: s.id }])}
                    className="text-t-tertiary hover:text-t-primary"
                  >
                    🗑
                  </button>
                )}
              </div>
            ))}
          </div>

          {/* Insight: the one free-prose node — directly editable. */}
          <div className="flex flex-col gap-1">
            <h4 className="text-[11px] font-medium uppercase tracking-wide text-t-tertiary">
              Insight (free text)
            </h4>
            <textarea
              rows={3}
              className="w-full rounded border border-border-default bg-transparent p-2 text-xs text-t-primary"
              placeholder={insightNode ? "" : "Add a synthesis paragraph…"}
              value={insightDraft ?? insightNode?.text ?? ""}
              onChange={(e) => setInsightDraft(e.target.value)}
            />
            {insightDraft !== null && insightDraft !== (insightNode?.text ?? "") && (
              <button
                disabled={busy}
                onClick={() => {
                  void apply([{ kind: "set_insight", text: insightDraft }]);
                  setInsightDraft(null);
                }}
                className="self-end rounded border border-border-default px-2 py-1 text-xs text-t-primary"
              >
                Save insight
              </button>
            )}
          </div>

          {/* Add: un-narrated claims + unshipped catalog views. */}
          {uncitedClaims.length > 0 && (
            <div className="flex flex-col gap-1">
              <h4 className="text-[11px] font-medium uppercase tracking-wide text-t-tertiary">
                Narrate a claim
              </h4>
              {uncitedClaims.map((c) => (
                <button
                  key={c.name}
                  disabled={busy}
                  onClick={() =>
                    void apply([
                      { kind: "add_node", node: { op: c.suggestedOp as PlanOp, refs: [c.name] } },
                    ])
                  }
                  className="flex items-center justify-between rounded border border-dashed border-border-default px-2 py-1.5 text-left text-xs text-t-secondary hover:text-t-primary"
                >
                  <span className="truncate">{c.name.replace(/_/g, " ")}</span>
                  <span className="ml-2 shrink-0 text-t-tertiary">+ {c.suggestedOp}</span>
                </button>
              ))}
            </div>
          )}

          {unshippedViews.length > 0 && (
            <div className="flex flex-col gap-1">
              <h4 className="text-[11px] font-medium uppercase tracking-wide text-t-tertiary">
                Add a chart
              </h4>
              {unshippedViews.map((v) => (
                <button
                  key={v.id}
                  disabled={busy}
                  title={v.reason}
                  onClick={() => void apply([{ kind: "show", id: v.id }])}
                  className="flex flex-col rounded border border-dashed border-border-default px-2 py-1.5 text-left text-xs hover:border-border-strong"
                >
                  <span className="font-medium text-t-secondary">
                    {v.kind === "table" ? "Table" : "Chart"}: {v.seriesId.replace(/_/g, " ")}
                    {v.kind === "coverage" ? " — observations per period" : ""}
                  </span>
                  <span className="truncate text-t-tertiary">{v.reason}</span>
                </button>
              ))}
            </div>
          )}

          <p className="text-[11px] leading-relaxed text-t-tertiary">
            Edits recompile deterministically through the same validator as the original dashboard —
            sentences stay bound to declared findings, and added charts are projections of declared
            data only.
          </p>
        </div>
      )}
    </div>
  );
}
