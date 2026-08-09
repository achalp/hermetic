"use client";

/**
 * Direct manipulation on the dashboard itself (design review follow-up:
 * "why can't I just move the charts by dragging them?"). In edit mode,
 * hovering any top-level dashboard element shows a floating toolbar —
 * grab to drag it to a new position (a live insertion line tracks the
 * drop point), eye to hide, columns to toggle half/full width. Pointer
 * events end to end: no HTML5 dnd, nothing for Chrome to cancel.
 *
 * Elements are located via the renderer's data-spec-element stamps; all
 * behavior routes through the SAME usePlanEdit instance as the side
 * panel — one optimistic state, one undo history.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { PlanEdit } from "@/hooks/use-plan-edit";
import { Icon } from "./rows";

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** Union rect of a display:contents wrapper's rendered children. */
function rectOf(el: Element): Rect | null {
  const kids = [...el.children];
  const rects = (kids.length ? kids : [el]).map((k) => k.getBoundingClientRect());
  const good = rects.filter((r) => r.width > 0 && r.height > 0);
  if (good.length === 0) return null;
  const top = Math.min(...good.map((r) => r.top));
  const left = Math.min(...good.map((r) => r.left));
  const right = Math.max(...good.map((r) => r.right));
  const bottom = Math.max(...good.map((r) => r.bottom));
  return { top, left, width: right - left, height: bottom - top };
}

export function DashboardEditOverlay({ edit, enabled }: { edit: PlanEdit; enabled: boolean }) {
  const [hover, setHover] = useState<{ id: string; rect: Rect } | null>(null);
  const hoverRef = useRef<{ id: string; rect: Rect } | null>(null);
  hoverRef.current = hover;
  const [dragging, setDragging] = useState<string | null>(null);
  const [insertLine, setInsertLine] = useState<{ y: number; left: number; width: number } | null>(
    null
  );
  const dropBefore = useRef<string | null>(null);
  const sectionIds = edit.sections.filter((s) => !s.hidden).map((s) => s.id);
  const idsRef = useRef(sectionIds);
  idsRef.current = sectionIds;

  const nodeFor = useCallback(
    (id: string) => document.querySelector(`[data-spec-element="${CSS.escape(id)}"]`),
    []
  );

  // Hover tracking over the dashboard's stamped elements.
  useEffect(() => {
    if (!enabled) {
      setHover(null);
      return;
    }
    const onMove = (e: MouseEvent) => {
      if (dragging) return;
      const t = e.target as Element | null;
      // Pointer over the overlay's own chrome (toolbar) must NOT clear the
      // hover — otherwise the toolbar despawns on approach and its buttons
      // can never be clicked.
      if (t?.closest?.("[data-edit-overlay]")) return;
      let el = t?.closest?.("[data-spec-element]") as Element | null;
      let id: string | null = null;
      // Walk up to the TOP-LEVEL section (hover on a nested element must
      // select the section that is actually movable).
      while (el) {
        const candidate = el.getAttribute("data-spec-element");
        if (candidate && idsRef.current.includes(candidate)) id = candidate;
        el = el.parentElement?.closest?.("[data-spec-element]") ?? null;
      }
      if (!id) {
        // Grace zone: the toolbar floats ABOVE the element, and the path to
        // it crosses unstamped pixels — clearing on those intermediate
        // moves despawned the toolbar before it could be clicked. Keep the
        // hover while the pointer stays near the element (44px above for
        // the toolbar band, 16px around).
        const h = hoverRef.current;
        if (h) {
          const { rect } = h;
          const inGrace =
            e.clientX >= rect.left - 16 &&
            e.clientX <= rect.left + rect.width + 16 &&
            e.clientY >= rect.top - 44 &&
            e.clientY <= rect.top + rect.height + 16;
          if (inGrace) return;
        }
        setHover((prev) => (prev ? null : prev));
        return;
      }
      const node = nodeFor(id);
      const rect = node ? rectOf(node) : null;
      if (rect) setHover({ id, rect });
    };
    document.addEventListener("mousemove", onMove, { passive: true });
    const clear = () => setHover(null);
    document.addEventListener("scroll", clear, { capture: true, passive: true });
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("scroll", clear, { capture: true });
    };
  }, [enabled, dragging, nodeFor]);

  // Pointer-based drag: track the gap nearest the pointer, drop = reorder.
  const beginDrag = useCallback(
    (id: string) => (downEvent: React.PointerEvent) => {
      downEvent.preventDefault();
      setDragging(id);
      const ids = idsRef.current;
      const selfIdx = ids.indexOf(id);
      // Gaps adjacent to the dragged element are no-ops (dropping an
      // element back beside itself) — exclude them so "nearest gap" is
      // always a REAL move.
      const noop = new Set([id, ids[selfIdx + 1]].filter(Boolean));
      const gaps: { y: number; before: string | null; left: number; width: number }[] = [];
      for (let i = 0; i < ids.length; i++) {
        const n = ids[i] === id ? null : nodeFor(ids[i]);
        if (!n) continue;
        const r = rectOf(n);
        if (!r) continue;
        if (!noop.has(ids[i])) {
          gaps.push({ y: r.top, before: ids[i], left: r.left, width: r.width });
        }
        const below = ids[i + 1] ?? null;
        if (!below || !noop.has(below)) {
          gaps.push({ y: r.top + r.height, before: below, left: r.left, width: r.width });
        }
      }
      const onMove = (e: PointerEvent) => {
        if (gaps.length === 0) return;
        const nearest = gaps.reduce((a, b) =>
          Math.abs(b.y - e.clientY) < Math.abs(a.y - e.clientY) ? b : a
        );
        dropBefore.current = nearest.before;
        setInsertLine({ y: nearest.y, left: nearest.left, width: nearest.width });
      };
      const onUp = () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        const before = dropBefore.current;
        setDragging(null);
        setInsertLine(null);
        setHover(null);
        if (before !== id) edit.reorder(id, before);
      };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    },
    [edit, nodeFor]
  );

  if (!enabled || !edit.surface) return null;
  const section = hover ? edit.sections.find((s) => s.id === hover.id) : null;

  return (
    <>
      {hover && section && (
        <>
          {/* Outline of the hovered element. */}
          <div
            className="pointer-events-none fixed rounded-md"
            style={{
              top: hover.rect.top - 4,
              left: hover.rect.left - 4,
              width: hover.rect.width + 8,
              height: hover.rect.height + 8,
              border: "1.5px dashed var(--color-accent)",
              opacity: dragging ? 0.9 : 0.55,
              zIndex: 160,
            }}
          />
          {/* Floating toolbar at the element's top-right. */}
          <div
            data-edit-overlay
            className="fixed flex items-center gap-1 rounded-md border border-border-default px-1.5 py-1 text-t-secondary shadow-lg"
            style={{
              top: hover.rect.top - 14,
              left: hover.rect.left + hover.rect.width - 96,
              background: "var(--color-surface-1)",
              zIndex: 165,
            }}
          >
            <button
              title="Drag to move"
              onPointerDown={beginDrag(hover.id)}
              className="cursor-grab hover:text-t-primary active:cursor-grabbing"
            >
              <Icon.grip />
            </button>
            {section.kind !== "banner" && (
              <button
                title={section.width === "half" ? "Make full width" : "Make half width"}
                onClick={() => edit.setWidth(hover.id, section.width === "half" ? "full" : "half")}
                className="hover:text-t-primary"
              >
                {section.width === "half" ? <Icon.fullWidth /> : <Icon.columns />}
              </button>
            )}
            <button
              title="Hide from dashboard (restore from the Edit panel)"
              onClick={() => {
                setHover(null);
                edit.toggleHidden(hover.id, false);
              }}
              className="hover:text-t-primary"
            >
              <Icon.eye />
            </button>
          </div>
        </>
      )}
      {insertLine && (
        <div
          className="pointer-events-none fixed rounded"
          style={{
            top: insertLine.y - 2,
            left: insertLine.left,
            width: insertLine.width,
            height: 3,
            background: "var(--color-accent)",
            zIndex: 165,
          }}
        />
      )}
    </>
  );
}
