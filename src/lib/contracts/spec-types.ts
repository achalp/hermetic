/**
 * Render-adjacent types: drill-down parameters, filters, pipeline stages.
 * Split from lib/types.ts (fan-in 85) — modularization M1-1a, spec S3.3.
 */

export type PipelineStage =
  | "generating_code"
  | "reviewing_code"
  | "revising_code"
  | "executing"
  | "retrying"
  | "composing_ui"
  | "done"
  | "error";

/**
 * A drill filter value. A single category (string/number) pins one segment; an
 * array pins a multi-select (the server filters `column IN (...)`).
 */

/**
 * A drill filter value. A single category (string/number) pins one segment; an
 * array pins a multi-select (the server filters `column IN (...)`).
 */
export type FilterValue = string | number | (string | number)[];

export interface DrillDownParams {
  segment_label: string;
  segment_value: string | number;
  chart_title: string | null;
  x_key: string | null;
  y_key: string | null;
  filter_column: string;
  filter_value: FilterValue;
  /**
   * Additional filters AND-combined with the primary filter. Used by 2D
   * drill-downs (e.g. PivotTable cell = rowDim × colDim) and multi-dimension
   * selections where a single filter isn't enough to pin the segment.
   */
  additional_filters?: { column: string; value: FilterValue }[] | null;
}
