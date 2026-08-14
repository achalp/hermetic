/**
 * Analysis Product contract (specs/analysis-product-2026-08-08.md §1) — the
 * structured envelope layer: series with declared roles, values with
 * mandatory context. chart_data/results are synthesized VIEWS of these; when
 * a series entry exists for a chart key, the roles here are authoritative
 * and downstream consumers must not re-infer structure from column names.
 */

export type SeriesXKind = "temporal" | "ordinal" | "categorical";

export interface SeriesXRole {
  column: string;
  kind: SeriesXKind;
}

/**
 * How a measure rebuilds from the raw table (analysis-product §1.4).
 *
 * A declared series ships already-aggregated rows; nothing in them records
 * how they were computed. Without this, re-aggregating a filtered subset is
 * a guess — and for a ratio the natural guess (averaging per-group rates) is
 * wrong. With it, the compiled composer can offer honest client-side
 * filtering: it replays the recipe at the unfiltered baseline and only ships
 * interactivity when the replay reproduces the declared rows.
 */
export type MeasureAggregation =
  | { fn: "sum" | "avg" | "min" | "max" | "count"; column: string; from: string }
  | { fn: "ratio"; numerator: string; denominator: string; from: string };

export interface SeriesMeasureRole {
  column: string;
  /** Display/semantic unit ("usd", "pct") — the composer renders it, never prose. */
  unit?: string;
  /** Finding name this measure is the series view of. */
  of?: string;
  /** Check name of the screen that produced this measure's nulls. */
  screened_by?: string;
  /** Raw sibling column this measure is a screened/transformed variant of. */
  variant_of?: string;
  /** Recipe to rebuild this measure from the raw table under a filter. */
  aggregates?: MeasureAggregation;
}

export interface SeriesRoles {
  x: SeriesXRole;
  measures: SeriesMeasureRole[];
  /** Attestation column: observations behind each row. */
  count?: { column: string };
  /** Category column for grouped/faceted series. */
  group?: { column: string };
}

export interface SeriesEntry {
  id: string;
  /** Series SHAPE (compiled-view-parity §4): "geo" | "distribution" |
   *  "hierarchy" | "flow" | "matrix" | "curve" | "ohlc" | "span" |
   *  "vector"; absent = "axis". Declared via declare_series(kind=...) and
   *  validated against series-kind-contract.json by the runtime; the
   *  licensing layer (seriesKindOf) reads it to decide which components a
   *  VIEW may bind. */
  kind?: string;
  rows: Record<string, unknown>[];
  roles: SeriesRoles;
  /** True row count when rows were capped at declaration time. */
  rows_total?: number;
}

export interface ValueEntry {
  key: string;
  value: unknown;
  /** Human description — mandatory unless `of` names the owning finding field. */
  label?: string;
  unit?: string;
  /** "finding.field" reference when this value restates a declared finding. */
  of?: string;
}

export interface AnalysisProduct {
  series: SeriesEntry[];
  values: ValueEntry[];
}
