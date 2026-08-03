"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useStateStore, useStateValue } from "@json-render/react";
import { useDrillDispatch } from "@/lib/drill-down-context";
import { formatFilterValue } from "@/lib/drill-resolve";
import type { DrillDownParams, FilterValue } from "@/lib/contracts/spec-types";

/**
 * Shared "Investigate this selection" action bar for both Ask and Investigate
 * dashboards. Charts cross-select by writing the clicked category to
 * `/filters/<column>` (via ChartSelectionBridge). This bar reads the active
 * selection and, on click, re-runs a focused/scoped analysis on that segment by
 * building DrillDownParams and invoking the existing drill callback — exactly
 * how PivotTable drills from a known cell (pivot-table.tsx). The callback
 * already routes Ask → /api/query and Investigate → /api/query/investigate, so
 * the action is identical and correct in both modes.
 *
 * It never recomputes data client-side; the server re-run is the only thing
 * correct for every chart (incl. server-only regressions/correlations).
 */

/** An active selection on one dimension (a value, or a multi-select list). */
interface ActiveSelection {
  column: string;
  value: FilterValue;
}

/**
 * Reduce a `/filters/<col>` value to a categorical selection, or null.
 * Cross-select writes a scalar (single) or an array (multi-select); "All"/empty
 * mean "no selection". A non-empty array becomes `column IN (...)` downstream.
 */
function toSelection(value: unknown): FilterValue | null {
  if (typeof value === "number") return value;
  if (typeof value === "string") return value === "" || value === "All" ? null : value;
  if (Array.isArray(value)) {
    const vals = value
      .filter((v) => typeof v === "string" || typeof v === "number")
      .filter((v) => v !== "All" && v !== "");
    return vals.length > 0 ? (vals as (string | number)[]) : null;
  }
  return null;
}

export function SelectionDrillBar() {
  const drillDispatch = useDrillDispatch();
  const store = useStateStore();
  const filters = useStateValue<Record<string, unknown> | undefined>("/filters");
  // Portal to document.body so the bar floats over the viewport regardless of
  // any ancestor overflow/transform. Mount-gated to avoid SSR document access.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const active: ActiveSelection[] =
    filters && typeof filters === "object"
      ? Object.entries(filters)
          .map(([column, v]) => ({ column, value: toSelection(v) }))
          .filter((f): f is ActiveSelection => f.value != null)
      : [];

  if (active.length === 0 || !mounted) return null;

  const describe = active
    .map((f) =>
      Array.isArray(f.value)
        ? `${f.column} in (${formatFilterValue(f.value)})`
        : `${f.column} = ${f.value}`
    )
    .join(", ");

  const handleClick = () => {
    if (active.length === 0 || !drillDispatch) return;
    const [primary, ...rest] = active;
    const params: DrillDownParams = {
      segment_label: active.map((f) => formatFilterValue(f.value)).join(" · "),
      // segment_value must be scalar; use a readable form of the primary value.
      segment_value: Array.isArray(primary.value)
        ? formatFilterValue(primary.value)
        : primary.value,
      chart_title: null,
      x_key: null,
      y_key: null,
      filter_column: primary.column,
      filter_value: primary.value,
      additional_filters:
        rest.length > 0 ? rest.map((f) => ({ column: f.column, value: f.value })) : null,
    };
    // Clear the selection before dispatching so the drilled view starts clean
    // (the captured params are unaffected).
    for (const f of active) store.set(`/filters/${f.column}`, "All");
    drillDispatch(params);
  };

  return createPortal(
    <div
      className="fixed left-1/2 top-16 flex max-w-[92vw] -translate-x-1/2 flex-wrap items-center justify-center gap-3 border border-accent/40 bg-accent-subtle px-4 py-2"
      style={{
        // Sit just below the fixed 56px (h-14) TopBar, beneath it in the stack
        // (--z-topbar is 250) but above dashboard content.
        zIndex: 200,
        borderRadius: "var(--radius-card)",
        boxShadow: "var(--shadow-elevated)",
      }}
      role="status"
      aria-live="polite"
    >
      <span className="text-sm text-t-secondary">
        Selected: <span className="font-medium text-t-primary">{describe}</span>
      </span>
      <button
        type="button"
        onClick={handleClick}
        className="bg-accent px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90"
        style={{ borderRadius: "var(--radius-badge)" }}
      >
        Investigate this selection →
      </button>
    </div>,
    document.body
  );
}
