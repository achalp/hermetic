"use client";

/**
 * Presentational pieces of the edit panel: consistent SVG icons (same
 * stroke style as the toolbar), the between-row DropZone with its
 * insertion line, and the SectionRow. No state here beyond hover — the
 * usePlanEdit hook owns behavior.
 */
import { useState } from "react";
import type { PlanEditSurface } from "@/app/lib/api";
import { sectionTag, sectionTitle } from "./copy";

type Section = PlanEditSurface["sections"][number];

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export const Icon = {
  grip: () => (
    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor">
      {[5, 12, 19].flatMap((y) =>
        [9, 15].map((x) => <circle key={`${x}${y}`} cx={x} cy={y} r="1.6" />)
      )}
    </svg>
  ),
  eye: () => (
    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" {...stroke}>
      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ),
  eyeOff: () => (
    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" {...stroke}>
      <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94" />
      <path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  ),
  undo: () => (
    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" {...stroke}>
      <polyline points="9 14 4 9 9 4" />
      <path d="M4 9h10a6 6 0 010 12h-3" />
    </svg>
  ),
  trash: () => (
    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" {...stroke}>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
    </svg>
  ),
  pencil: () => (
    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" {...stroke}>
      <path d="M17 3a2.85 2.85 0 114 4L7.5 20.5 2 22l1.5-5.5z" />
    </svg>
  ),
  plus: () => (
    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" {...stroke}>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  ),
  columns: () => (
    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" {...stroke}>
      <rect x="3" y="5" width="8" height="14" rx="1" />
      <rect x="13" y="5" width="8" height="14" rx="1" />
    </svg>
  ),
  fullWidth: () => (
    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" {...stroke}>
      <rect x="3" y="5" width="18" height="14" rx="1" />
    </svg>
  ),
  up: () => (
    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" {...stroke}>
      <polyline points="18 15 12 9 6 15" />
    </svg>
  ),
  down: () => (
    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" {...stroke}>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  ),
  spinner: () => (
    <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" {...stroke}>
      <path d="M21 12a9 9 0 11-6.2-8.56" />
    </svg>
  ),
};

/** Drop target BETWEEN rows: invisible until a drag hovers it, then an
 *  accent insertion line — you always see exactly where it will land.
 *  The last zone (beforeId null) accepts drop-at-end. */
export function DropZone({
  beforeId,
  active,
  onDropItem,
}: {
  beforeId: string | null;
  active: boolean;
  onDropItem: (beforeId: string | null) => void;
}) {
  const [over, setOver] = useState(false);
  // ALWAYS mounted with a constant shape: swapping this element in/out when
  // a drag starts mutates the DOM mid-dragstart, and Chrome CANCELS the
  // native drag session — the "reorder does not work" bug. `active` only
  // gates behavior and paint, never structure.
  return (
    <div
      className="flex h-2 items-center"
      data-dropzone={beforeId ?? "end"}
      onDragOver={(e) => {
        if (!active) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        if (!active) return;
        e.preventDefault();
        setOver(false);
        onDropItem(beforeId);
      }}
    >
      <div
        className="w-full rounded transition-all"
        style={{
          height: over && active ? 3 : 1,
          background: over && active ? "var(--color-accent)" : "transparent",
        }}
      />
    </div>
  );
}

export function SectionRow({
  section,
  pending,
  editable,
  onDragStart,
  onDragEnd,
  onToggleHidden,
  onRemove,
  onEdit,
  onMoveUp,
  onMoveDown,
  onToggleWidth,
}: {
  section: Section;
  pending: boolean;
  /** INSIGHT rows get the pencil. */
  editable: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onToggleHidden: () => void;
  onRemove?: () => void;
  onEdit?: () => void;
  /** Keyboard/click reorder — the always-reliable fallback beside drag. */
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  /** Half/full layout toggle (charts, tables, tiles). */
  onToggleWidth?: () => void;
}) {
  const s = section;
  return (
    <div
      draggable={!s.hidden}
      onDragStart={(e) => {
        // Chrome needs data + a DEFERRED state update: a synchronous React
        // re-render during dragstart cancels the native drag.
        e.dataTransfer.setData("text/plain", s.id);
        e.dataTransfer.effectAllowed = "move";
        setTimeout(onDragStart, 0);
      }}
      onDragEnd={onDragEnd}
      className={`group flex items-start gap-2 rounded-md border border-border-default px-2 py-1.5 text-xs transition-colors hover:border-border-strong ${
        s.hidden ? "opacity-45" : "cursor-grab active:cursor-grabbing"
      }`}
      style={{ background: "var(--color-surface-2)" }}
    >
      <span className="mt-0.5 shrink-0 text-t-tertiary">
        {pending ? <Icon.spinner /> : <Icon.grip />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="line-clamp-2 text-t-primary">{sectionTitle(s)}</div>
        <div className="mt-0.5 text-[10px] uppercase tracking-wide text-t-tertiary">
          {sectionTag(s)}
          {s.hidden ? " · hidden" : ""}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5 pt-0.5 text-t-tertiary opacity-0 transition-opacity group-hover:opacity-100">
        {onMoveUp && (
          <button title="Move up" onClick={onMoveUp} className="hover:text-t-primary">
            <Icon.up />
          </button>
        )}
        {onMoveDown && (
          <button title="Move down" onClick={onMoveDown} className="hover:text-t-primary">
            <Icon.down />
          </button>
        )}
        {onToggleWidth && (
          <button
            title={s.width === "half" ? "Make full width" : "Make half width (pairs side-by-side)"}
            onClick={onToggleWidth}
            className="hover:text-t-primary"
          >
            {s.width === "half" ? <Icon.fullWidth /> : <Icon.columns />}
          </button>
        )}
        {editable && onEdit && (
          <button title="Edit text" onClick={onEdit} className="hover:text-t-primary">
            <Icon.pencil />
          </button>
        )}
        <button
          title={s.hidden ? "Show on dashboard" : "Hide from dashboard"}
          onClick={onToggleHidden}
          className="hover:text-t-primary"
        >
          {s.hidden ? <Icon.eyeOff /> : <Icon.eye />}
        </button>
        {onRemove && (
          <button
            title="Remove from story (undoable)"
            onClick={onRemove}
            className="hover:text-t-primary"
          >
            <Icon.trash />
          </button>
        )}
      </div>
    </div>
  );
}
