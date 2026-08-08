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
