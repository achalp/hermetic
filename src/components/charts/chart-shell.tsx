"use client";

/**
 * Shared chart scaffold (FE-12): the title block (with drill/select hints)
 * and the expand-aware body wrapper that every chart had copy-pasted — the
 * copies had already drifted (bar's legend width capped at 200 vs line/area's
 * 180; map3d's title lost the hint spans).
 *
 * Adoption is incremental: bar/line/area/map3d (the charts the review cited)
 * use it now; convert others as they're touched rather than in one risky
 * 59-file sweep — the scaffold has no visual test coverage.
 *
 * Companion helpers `truncateLabel`/`legendItemWidth` live in chart-theme.ts.
 */
import type { ReactNode } from "react";

export function ChartShell({
  title,
  height,
  isExpanded = false,
  isDrillable = false,
  isSelectable = false,
  showSelectHint = false,
  bodyClassName,
  children,
}: {
  title?: string | null;
  /** Body height when NOT expanded (expanded fills the flex column). */
  height?: number | string;
  /** From useChartExpanded(): fill the expand modal instead of fixed height. */
  isExpanded?: boolean;
  /** Adds the pointer cursor + "Click to drill down" hint. */
  isDrillable?: boolean;
  /** Adds the pointer cursor (hint controlled separately — it hides once a selection exists). */
  isSelectable?: boolean;
  /** Show the "Click to filter" hint (typically isSelectable && nothing selected yet). */
  showSelectHint?: boolean;
  /** Extra classes on the chart body (e.g. map3d's rounded border). */
  bodyClassName?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`w-full${isDrillable || isSelectable ? " cursor-pointer" : ""}${
        isExpanded ? " h-full flex flex-col" : ""
      }`}
    >
      {title && (
        <h3
          className="mb-2 text-t-secondary"
          style={{ fontSize: "var(--chart-title-size)", fontWeight: "var(--chart-title-weight)" }}
        >
          {title}
          {isDrillable && (
            <span className="ml-2 text-xs font-normal text-accent">Click to drill down</span>
          )}
          {showSelectHint && (
            <span className="ml-2 text-xs font-normal text-t-tertiary">Click to filter</span>
          )}
        </h3>
      )}
      {/* One labeled graphic for assistive tech — the SVG internals a chart
          library emits are noise to a screen reader (FE-8). */}
      <div
        className={`${isExpanded ? "flex-1" : ""}${bodyClassName ? ` ${bodyClassName}` : ""}`}
        style={{ height: isExpanded ? undefined : height }}
        role="img"
        aria-label={title || "Chart"}
      >
        {children}
      </div>
    </div>
  );
}
