"use client";

/**
 * The dashboard edit panel — redesigned around four jobs (design review
 * 2026-08-09): tidy the story (drag between rows, hide), fix the words
 * (inline insight editing), complete the story (add claims and charts,
 * each previewed as the exact sentence/benefit it delivers), and recover
 * (header Undo over the governed restore_document mutation).
 *
 * Rows mirror the dashboard 1:1 and speak in RESOLVED sentences — the
 * things the reader actually sees — never op codes or binding syntax.
 * All behavior lives in usePlanEdit (optimistic ordering, undo stack,
 * per-row pending); this file is composition and copy.
 */
import { useCallback, useRef, useState } from "react";
import type { PlanEdit } from "@/hooks/use-plan-edit";
import { Icon, RowGap, SectionRow } from "./rows";
import { viewBenefit, viewTitle } from "./copy";

export interface PlanEditPanelProps {
  /** The page-owned edit state — shared with the dashboard edit overlay so
   *  panel and direct manipulation are one undo history, one truth. */
  edit: PlanEdit;
  open: boolean;
  onClose: () => void;
}

export function PlanEditPanel({ edit, open, onClose }: PlanEditPanelProps) {
  // One pointer-based drag loop for the list (same mechanism as the
  // dashboard overlay — no HTML5 dnd anywhere): pointerdown on a grip
  // captures the drag, each move picks the nearest row gap, pointerup
  // applies the reorder.
  const [dragId, setDragId] = useState<string | null>(null);
  const [insertBefore, setInsertBefore] = useState<string | null | undefined>(undefined);
  const listRef = useRef<HTMLDivElement | null>(null);
  const beginRowDrag = useCallback(
    (id: string) => (down: React.PointerEvent) => {
      down.preventDefault();
      setDragId(id);
      let before: string | null | undefined = undefined;
      const onMove = (e: PointerEvent) => {
        const rows = [
          ...(listRef.current?.querySelectorAll("[data-row-id]") ?? []),
        ] as HTMLElement[];
        const ids = rows.map((r) => r.getAttribute("data-row-id")!);
        const selfIdx = ids.indexOf(id);
        const noop = new Set([id, ids[selfIdx + 1]].filter(Boolean));
        // Mutable holder (not a narrowed union — TS can't track closure
        // assignments through forEach).
        const best = { d: Infinity, before: undefined as string | null | undefined };
        rows.forEach((r, i) => {
          const rect = r.getBoundingClientRect();
          if (!noop.has(ids[i])) {
            const d = Math.abs(rect.top - e.clientY);
            if (d < best.d) {
              best.d = d;
              best.before = ids[i];
            }
          }
          const below = ids[i + 1] ?? null;
          if (below === null || !noop.has(below)) {
            const d = Math.abs(rect.bottom - e.clientY);
            if (d < best.d) {
              best.d = d;
              best.before = below;
            }
          }
        });
        before = best.before;
        setInsertBefore(before);
      };
      const onUp = () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        setDragId(null);
        setInsertBefore(undefined);
        if (before !== undefined) edit.reorder(id, before);
      };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    },
    [edit]
  );
  const [editingInsight, setEditingInsight] = useState(false);
  const [insightDraft, setInsightDraft] = useState("");

  if (!open) return null;

  const insightNode = edit.surface?.doc.plan.nodes.find((n) => n.op === "INSIGHT");
  const visible = edit.sections.filter((s) => !s.hidden);
  const hidden = edit.sections.filter((s) => s.hidden);
  const addableClaims = edit.surface?.claims.filter((c) => !c.cited) ?? [];
  const addableViews = edit.surface?.views.filter((v) => !v.shipped) ?? [];

  const beginInsightEdit = () => {
    setInsightDraft(insightNode?.text ?? "");
    setEditingInsight(true);
  };

  return (
    <div
      className="fixed top-14 bottom-0 flex w-[24rem] flex-col border-l border-border-default bg-surface-1 shadow-xl"
      // Beside the data rail's collapsed strip (48px, z 180); an expanded
      // rail takes precedence. Solid theme surface — an undefined bg class
      // shipped a see-through panel with the dashboard bleeding between rows.
      style={{ right: 48, zIndex: 170, background: "var(--color-surface-1)" }}
      data-testid="plan-edit-panel"
    >
      {/* Header: title + undo + close. Undo appears once there is history. */}
      <div className="flex items-center justify-between border-b border-border-default px-4 py-2.5">
        <h3 className="text-sm font-semibold text-t-primary">Edit dashboard</h3>
        <div className="flex items-center gap-3">
          {edit.canUndo && (
            <button
              onClick={() => void edit.undo()}
              className="flex items-center gap-1 text-xs text-t-secondary hover:text-t-primary"
              title="Undo the last change"
            >
              <Icon.undo /> Undo
            </button>
          )}
          <button
            onClick={onClose}
            className="text-xs text-t-tertiary hover:text-t-primary"
            aria-label="Close editor"
          >
            ✕
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {!edit.loaded ? (
          // Skeleton rows — the panel's shape appears instantly.
          <div className="flex flex-col gap-2">
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-10 animate-pulse rounded-md bg-surface-2"
                style={{ opacity: 0.6 - i * 0.12 }}
              />
            ))}
          </div>
        ) : edit.loadFailed ? (
          <div className="flex flex-col gap-2">
            <p className="text-xs" style={{ color: "var(--color-error-text)" }}>
              Couldn&apos;t load this dashboard&apos;s structure — that&apos;s a server hiccup, not
              a property of the dashboard.
            </p>
            <button
              onClick={() => void edit.refresh()}
              className="self-start rounded border border-border-default px-2 py-1 text-xs text-t-primary"
            >
              Try again
            </button>
          </div>
        ) : !edit.surface ? (
          <p className="text-xs leading-relaxed text-t-secondary">
            This dashboard was composed free-form, so there&apos;s no structure to edit. Switch
            Settings → Composer Architecture to <b>Compiled</b> and re-run the question — compiled
            dashboards are fully editable.
          </p>
        ) : (
          <div className="flex flex-col gap-5">
            {edit.error && (
              <p className="text-xs" style={{ color: "var(--color-error-text)" }}>
                {edit.error}
              </p>
            )}

            {/* The dashboard, as a list. Order here IS order there. */}
            <div className="flex flex-col" ref={listRef}>
              <h4 className="mb-1 text-[11px] font-medium uppercase tracking-wide text-t-tertiary">
                On the dashboard ({visible.length}) — drag the dots, or use the arrows
              </h4>
              {visible.map((s, i) => (
                <div key={s.id}>
                  <RowGap highlighted={dragId !== null && insertBefore === s.id} />
                  <SectionRow
                    section={s}
                    pending={edit.pendingId === s.id}
                    editable={s.op === "INSIGHT"}
                    onGripPointerDown={beginRowDrag(s.id)}
                    beingDragged={dragId === s.id}
                    onToggleHidden={() => edit.toggleHidden(s.id, s.hidden)}
                    onRemove={
                      s.kind === "node" && s.op !== "ANSWER" && s.op !== "INSIGHT"
                        ? () => edit.removeNode(s.id)
                        : undefined
                    }
                    onEdit={s.op === "INSIGHT" ? beginInsightEdit : undefined}
                    onMoveUp={i > 0 ? () => edit.reorder(s.id, visible[i - 1].id) : undefined}
                    onMoveDown={
                      i < visible.length - 1
                        ? () => edit.reorder(s.id, visible[i + 2]?.id ?? null)
                        : undefined
                    }
                    onToggleWidth={
                      // Charts, tables, tiles, AND text blocks — a sentence
                      // beside a half-width chart is a natural pairing. Only
                      // the alert banner and divider stay full-width.
                      s.kind !== "banner"
                        ? () => edit.setWidth(s.id, s.width === "half" ? "full" : "half")
                        : undefined
                    }
                  />
                  {s.op === "INSIGHT" && editingInsight && (
                    <div className="mt-1 flex flex-col gap-1 rounded-md border border-border-default p-2">
                      <textarea
                        rows={4}
                        autoFocus
                        className="w-full resize-y rounded bg-transparent text-xs text-t-primary outline-none"
                        value={insightDraft}
                        onChange={(e) => setInsightDraft(e.target.value)}
                      />
                      <p className="text-[10px] text-t-tertiary">
                        Pieces like <code>$finding:…</code> fill in live numbers from the analysis —
                        keep them to keep the numbers real.
                      </p>
                      <div className="flex justify-end gap-2">
                        <button
                          onClick={() => setEditingInsight(false)}
                          className="px-2 py-1 text-xs text-t-tertiary hover:text-t-primary"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={() => {
                            void edit.saveInsight(insightDraft);
                            setEditingInsight(false);
                          }}
                          className="rounded border border-border-default px-2 py-1 text-xs font-medium text-t-primary"
                        >
                          Save
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
              {/* Drop-at-end gap. */}
              <RowGap highlighted={dragId !== null && insertBefore === null} />
            </div>

            {hidden.length > 0 && (
              <div className="flex flex-col gap-1">
                <h4 className="text-[11px] font-medium uppercase tracking-wide text-t-tertiary">
                  Hidden ({hidden.length}) — click the eye to bring back
                </h4>
                {hidden.map((s) => (
                  <SectionRow
                    key={s.id}
                    section={s}
                    pending={edit.pendingId === s.id}
                    editable={false}
                    onToggleHidden={() => edit.toggleHidden(s.id, s.hidden)}
                  />
                ))}
              </div>
            )}

            {addableClaims.length > 0 && (
              <div className="flex flex-col gap-1">
                <h4 className="text-[11px] font-medium uppercase tracking-wide text-t-tertiary">
                  Not on the dashboard yet — findings ({addableClaims.length})
                </h4>
                <p className="mb-1 text-[10px] text-t-tertiary">
                  The analysis computed these; one click adds the sentence shown.
                </p>
                {addableClaims.map((c) => (
                  <button
                    key={c.name}
                    disabled={edit.pendingId !== null}
                    onClick={() => void edit.addClaim(c.name, c.suggestedOp)}
                    className="group flex items-start gap-2 rounded-md border border-dashed border-border-default px-2 py-1.5 text-left text-xs transition-colors hover:border-border-strong"
                  >
                    <span className="mt-0.5 shrink-0 text-t-tertiary group-hover:text-t-primary">
                      {edit.pendingId === `claim:${c.name}` ? <Icon.spinner /> : <Icon.plus />}
                    </span>
                    <span className="line-clamp-2 text-t-secondary group-hover:text-t-primary">
                      {c.preview || c.name.replace(/_/g, " ")}
                    </span>
                  </button>
                ))}
              </div>
            )}

            {addableViews.length > 0 && (
              <div className="flex flex-col gap-1">
                <h4 className="text-[11px] font-medium uppercase tracking-wide text-t-tertiary">
                  Not on the dashboard yet — charts ({addableViews.length})
                </h4>
                {addableViews.map((v) => (
                  <button
                    key={v.id}
                    disabled={edit.pendingId !== null}
                    onClick={() => void edit.addView(v.id)}
                    className="group flex items-start gap-2 rounded-md border border-dashed border-border-default px-2 py-1.5 text-left text-xs transition-colors hover:border-border-strong"
                  >
                    <span className="mt-0.5 shrink-0 text-t-tertiary group-hover:text-t-primary">
                      {edit.pendingId === v.id ? <Icon.spinner /> : <Icon.plus />}
                    </span>
                    <span className="min-w-0">
                      <span className="block font-medium capitalize text-t-secondary group-hover:text-t-primary">
                        {viewTitle(v)}
                      </span>
                      <span className="block text-t-tertiary">{viewBenefit(v)}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}

            <p className="text-[10px] leading-relaxed text-t-tertiary">
              Every sentence stays tied to the analysis&apos; declared findings — edits rearrange
              and reveal, they can&apos;t invent numbers.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
