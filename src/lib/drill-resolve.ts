import type { DrillDownParams } from "@/lib/types";

/**
 * A record of the dimension values for the chart mark the user clicked, keyed
 * by the REAL underlying dataset column where the chart knows it (e.g.
 * `{ region: "West", month: "2025-05" }`). Every chart also sets the sentinel
 * key {@link CLICK_PRIMARY} to the primary clicked category value, which acts
 * as the fallback when a column-named lookup misses (e.g. a pie slice whose
 * underlying column name the component doesn't know).
 */
export type ClickedRecord = Record<string, string | number> | null;

/** Sentinel key on a {@link ClickedRecord} holding the primary clicked value. */
export const CLICK_PRIMARY = "__value";

export interface ResolvedDrill {
  filterValue: string | number;
  segmentLabel: string;
  additionalFilters: { column: string; value: string | number }[];
}

/**
 * Build a {@link ClickedRecord} from a Nivo line/area `onClick` datum, which is
 * either a single Point (`.data.x`) or, when `enableSlices` is on, an x-slice
 * (`.points[0].data.x`). The x value is the drillable dimension for a line.
 * Returns null when no x can be read.
 */
export function lineClickRecord(
  datum: {
    data?: { x?: unknown };
    points?: readonly { data?: { x?: unknown } }[];
  },
  xKey: string
): ClickedRecord {
  const rawX = datum.points && datum.points.length > 0 ? datum.points[0]?.data?.x : datum.data?.x;
  if (rawX == null) return null;
  const x = typeof rawX === "number" ? rawX : String(rawX);
  return { [xKey]: x, [CLICK_PRIMARY]: x };
}

/**
 * Build a {@link ClickedRecord} from a clicked map feature's properties bag.
 * A map has no single defined join column, so capture every scalar property
 * keyed by its real name (lets `clicked[filter_column]` match whichever the
 * composer named) plus a name-like primary fallback. Returns null when the
 * feature carries no scalar properties.
 */
export function featureClickRecord(properties: Record<string, unknown>): ClickedRecord {
  const record: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(properties)) {
    if (typeof v === "string" || typeof v === "number") record[k] = v;
  }
  const keys = Object.keys(record);
  if (keys.length === 0) return null;
  const nameKey = keys.find((k) => /^(name|label|id|title)$/i.test(k));
  record[CLICK_PRIMARY] = nameKey != null ? record[nameKey] : record[keys[0]];
  return record;
}

/** True when `v` is an unresolved json-render binding like `{"$item": "region"}`. */
function isBinding(v: unknown): v is { $item: string } {
  return !!v && typeof v === "object" && "$item" in (v as object);
}

/**
 * Resolve the effective value for one filter, in priority order:
 *   1. the clicked mark's value under the real column name,
 *   2. the field a `{"$item": field}` binding points at, looked up in the click,
 *   3. the clicked primary value (sentinel) — covers charts that emit a binding
 *      but whose component doesn't know the real column name,
 *   4. a plain static value (legacy Ask drills, PivotTable cells).
 * Returns null when nothing usable is available (e.g. a binding with no click).
 */
function resolveFilterValue(
  value: unknown,
  column: string | null,
  clicked: ClickedRecord,
  // The primary (sentinel) fallback only makes sense for the chart's main
  // breakdown dimension. A secondary filter that can't be matched to a real
  // column must NOT silently collapse onto the primary clicked value.
  allowPrimaryFallback: boolean
): string | number | null {
  if (clicked && column && clicked[column] != null) return clicked[column];
  if (isBinding(value)) {
    if (clicked && clicked[value.$item] != null) return clicked[value.$item];
    if (allowPrimaryFallback && clicked && clicked[CLICK_PRIMARY] != null) {
      return clicked[CLICK_PRIMARY];
    }
    return null;
  }
  if (typeof value === "string" || typeof value === "number") return value;
  if (allowPrimaryFallback && clicked && clicked[CLICK_PRIMARY] != null) {
    return clicked[CLICK_PRIMARY];
  }
  return null;
}

/**
 * Translate a drill action's params (which may carry unresolved `{"$item": …}`
 * bindings, since charts aren't json-render list contexts) plus the clicked
 * mark's captured values into the concrete filter the drill should apply.
 *
 * Returns null when the click can't identify a segment (value-less click on a
 * bound chart, or a binding with nothing captured) — the caller should not
 * drill in that case.
 */
export function resolveDrillValues(
  params: DrillDownParams,
  clicked: ClickedRecord
): ResolvedDrill | null {
  const filterValue = resolveFilterValue(params.filter_value, params.filter_column, clicked, true);
  if (filterValue == null) return null;

  // Did the value come from the click (vs. a static composer/pivot value)? If
  // so the human label is the clicked value, not the composer's dimension name.
  const fromClick =
    !!(clicked && params.filter_column && clicked[params.filter_column] != null) ||
    isBinding(params.filter_value);

  const additionalFilters = (params.additional_filters ?? [])
    .map((f) => {
      const value = resolveFilterValue(f.value, f.column, clicked, false);
      return value == null ? null : { column: f.column, value };
    })
    .filter((f): f is { column: string; value: string | number } => f != null);

  let segmentLabel: string;
  if (fromClick || isBinding(params.segment_label)) {
    segmentLabel = String(filterValue);
  } else if (typeof params.segment_label === "string" && params.segment_label.length > 0) {
    segmentLabel = params.segment_label;
  } else {
    segmentLabel = String(filterValue);
  }

  return { filterValue, segmentLabel, additionalFilters };
}
