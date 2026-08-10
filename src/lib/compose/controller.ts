/**
 * Deterministic interactivity (narrative-compiler spec §14.3): the compiled
 * composer's DataController.
 *
 * The generative composer offers the reader filters — "Segment: All",
 * "Month: All" — and every chart under them re-aggregates client-side. The
 * compiled composer shipped static pictures, which is the last piece of
 * layout parity the user named. Nothing about interactivity requires an
 * LLM: a series that DECLARES a group role has named its filterable
 * dimension, and the client pipeline (data-transforms/client-pipeline) has
 * the ops. So the controller is derived, not written.
 *
 * Rules (all deterministic):
 *  - A series qualifies when it declares a `group` role, its rows fit the
 *    interactive cap, and the group has 2..GROUP_CARDINALITY_CAP values.
 *    Group role = "the analysis itself named this a dimension" — the same
 *    roles-first filter rule the generative path uses (dashboard-compose
 *    analyzeDatasets), not a cardinality guess over raw columns.
 *  - Filters: the group column always; the x column too when its distinct
 *    count fits the cap (the reader's "which month?").
 *  - Outputs: one per view of that series — a pivot+matrix for the group
 *    matrix, filtered rows for everything else — written to /computed/*,
 *    which the views then read via {$state} instead of inline data.
 *  - Initial state carries the EXACT values the static catalog computed, so
 *    first paint equals the static dashboard and interactivity is additive.
 *
 * The controller is HEADLESS (no children): it writes global state, so the
 * charts stay top-level elements the overlay grammar can move, hide, and
 * pair exactly as before. Its own id (`controls_<sid>`) is a first-class
 * element the reader can hide like anything else.
 */
import type { MeasureAggregation, SeriesEntry } from "@/lib/contracts/product";
import { executePipeline } from "@/lib/data-transforms/client-pipeline";
import { logger } from "@/lib/logger";
import { humanizeId, type SpecPatchLine } from "./scaffold";
import type { DerivedView } from "./views";

/** Rows past this and client-side filtering is re-aggregating a sample. */
const INTERACTIVE_ROW_CAP = 5000;
/** A dropdown past this is a scroll, not a control. */
const CARDINALITY_CAP = 50;

export interface DerivedController {
  /** Element id — a stable overlay/mutation handle like any view. */
  id: string;
  seriesId: string;
  /** Why this controller exists (Verify legibility, edit-panel copy). */
  reason: string;
  element: SpecPatchLine;
  /** State fragment: datasets, initial filter values, pre-computed outputs. */
  state: {
    datasets: Record<string, unknown>;
    filters: Record<string, unknown>;
    computed: Record<string, unknown>;
  };
  /** View id → the state path its data now reads from. */
  rebind: Record<string, string>;
}

const distinct = (rows: Record<string, unknown>[], col: string): number =>
  new Set(rows.map((r) => String(r[col] ?? ""))).size;

/** A control's label is prose: "month_str" is a storage detail, "Month" is
 *  the dimension. Strips the formatting suffixes analyses add to keys. */
export function filterLabel(column: string): string {
  return humanizeId(column.replace(/_(str|id|key|code)$/i, "")) || humanizeId(column);
}

/**
 * Derive the controller for one series, or null when the series declares no
 * filterable dimension. `views` are the SHIPPED views of that series (their
 * patches are rebound by the caller through `rebind`).
 */
export function deriveController(s: SeriesEntry, views: DerivedView[]): DerivedController | null {
  const groupCol = s.roles.group?.column;
  if (!groupCol) return null;
  if (s.rows.length === 0 || s.rows.length > INTERACTIVE_ROW_CAP) return null;
  const groupCount = distinct(s.rows, groupCol);
  if (groupCount < 2 || groupCount > CARDINALITY_CAP) return null;
  if (views.length === 0) return null;

  const xCol = s.roles.x.column;
  const filters = [
    {
      key: `${s.id}__${groupCol}`,
      column: groupCol,
      bindTo: `/filters/${s.id}__${groupCol}`,
      label: filterLabel(groupCol),
      allowAll: true,
      dependsOn: null,
    },
  ];
  const xCount = distinct(s.rows, xCol);
  if (xCount >= 2 && xCount <= CARDINALITY_CAP) {
    filters.push({
      key: `${s.id}__${xCol}`,
      column: xCol,
      bindTo: `/filters/${s.id}__${xCol}`,
      label: filterLabel(xCol),
      allowAll: true,
      dependsOn: null,
    });
  }

  const measure = s.roles.measures[0]?.column;
  const outputs: Record<string, unknown>[] = [];
  const computed: Record<string, unknown> = {};
  const rebind: Record<string, string> = {};

  for (const v of views) {
    const statePath = `/computed/${v.id}`;
    rebind[v.id] = statePath;
    if (v.kind === "group_matrix" && measure) {
      outputs.push({
        statePath,
        // Pivot rowKey = group → z rows are groups (y), columns are periods
        // (x): the orientation heatmap-chart.tsx reads (z[y][x]).
        pipeline: [
          { op: "pivot", rowKey: groupCol, columnKey: xCol, valueKey: measure, aggFn: "avg" },
        ],
        format: "matrix",
        labelColumn: null,
        valueColumn: null,
        xColumn: null,
        yColumn: null,
        groupColumn: null,
      });
      // Pre-populate with the static pivot the catalog already computed, so
      // first paint is identical to (and as verifiable as) the static view.
      const props = (v.patch.value as { props?: Record<string, unknown> }).props ?? {};
      computed[v.id] = { z: props.z, x_labels: props.x_labels, y_labels: props.y_labels };
    } else {
      outputs.push({
        statePath,
        pipeline: null,
        format: "rows",
        labelColumn: null,
        valueColumn: null,
        xColumn: null,
        yColumn: null,
        groupColumn: null,
      });
      computed[v.id] = `$chartData:${s.id}`;
    }
  }

  return {
    id: `controls_${s.id}`,
    seriesId: s.id,
    reason: `series declares a "${groupCol}" group role — the reader can filter by it and every view re-aggregates client-side`,
    element: {
      op: "add",
      path: `/elements/controls_${s.id}`,
      value: {
        type: "DataController",
        props: {
          source: { statePath: `/datasets/${s.id}` },
          // Scope is stated, not implied: these filters re-aggregate THIS
          // series' views. Other charts read other declared series and do
          // not respond — saying so is cheaper than a confused reader.
          scope_note: `Filters ${humanizeId(s.id)}. Other charts on this page read different series and are unaffected.`,
          filters,
          pipeline: [{ op: "filter" }],
          outputs,
        },
        children: [],
      },
    },
    state: {
      datasets: { [s.id]: `$chartData:${s.id}` },
      filters: Object.fromEntries(filters.map((f) => [f.key, "All"])),
      computed,
    },
    rebind,
  };
}

/**
 * Rebind a view's patch to read from controller state instead of carrying
 * inline data — the ONE place the static/interactive difference lives.
 * Non-destructive: returns a new patch.
 */
export function rebindViewPatch(patch: SpecPatchLine, statePath: string): SpecPatchLine {
  const value = patch.value as { type?: string; props?: Record<string, unknown> };
  const props = { ...(value.props ?? {}) };
  if (value.type === "HeatMap") {
    props.z = { $state: `${statePath}/z` };
    props.x_labels = { $state: `${statePath}/x_labels` };
    props.y_labels = { $state: `${statePath}/y_labels` };
  } else if ("rows" in props) {
    props.rows = { $state: statePath };
  } else {
    props.data = { $state: statePath };
  }
  return { ...patch, value: { ...value, props } };
}

// ── Re-aggregating controllers (spec §14.4) ────────────────────────────
//
// A series whose measures declare `aggregates` can be rebuilt from the RAW
// table for any filtered subset — which is how the reader filters a chart by
// a dimension the aggregated series doesn't even carry (an overall monthly
// rate filtered by segment). The recipe comes from the analysis that
// computed the number, never from inference: averaging per-group rates is
// not the pooled rate, and a composer that guesses ships a plausible wrong
// figure on every dropdown change.
//
// Trust but VERIFY: the recipe is replayed here at the unfiltered baseline
// and must reproduce the declared rows before any controller ships. A
// mis-declared recipe costs interactivity, never correctness.

/** Relative tolerance for baseline replay — float arithmetic, two engines. */
const BASELINE_TOLERANCE = 1e-6;

const closeEnough = (a: number, b: number): boolean =>
  Math.abs(a - b) <= BASELINE_TOLERANCE * Math.max(1, Math.abs(a), Math.abs(b));

/** Build the groupBy/compute steps that rebuild a series' measures. */
function aggregationPipeline(
  s: SeriesEntry,
  measures: { column: string; aggregates: MeasureAggregation; unit?: string }[]
): Record<string, unknown>[] {
  const aggregations: Record<string, unknown>[] = [];
  const computes: Record<string, unknown>[] = [];
  for (const m of measures) {
    const a = m.aggregates;
    if (a.fn === "ratio") {
      // A ratio is rebuilt from its PARTS: sum the numerator and denominator
      // over the filtered rows, then divide. This is the whole reason the
      // recipe must be declared rather than inferred.
      const num = `${m.column}__num`;
      const den = `${m.column}__den`;
      aggregations.push({ column: a.numerator, fn: "sum", as: num });
      aggregations.push({ column: a.denominator, fn: "sum", as: den });
      const pct = m.unit === "pct" || m.unit === "pp" || /_pct$/.test(m.column);
      computes.push({
        op: "compute",
        column: m.column,
        expression: `${pct ? "percent" : "ratio"}(${num}, ${den})`,
      });
    } else {
      aggregations.push({ column: a.column, fn: a.fn, as: m.column });
    }
  }
  return [
    { op: "groupBy", columns: [s.roles.x.column], aggregations },
    ...computes,
    { op: "sort", column: s.roles.x.column, direction: "asc" },
  ];
}

/** Replay the recipe over the WHOLE raw table and compare to the declared
 *  rows. Returns the first disagreement, or null when they match. */
export function verifyBaseline(
  s: SeriesEntry,
  rawRows: Record<string, unknown>[],
  pipeline: Record<string, unknown>[],
  measureColumns: string[]
): string | null {
  let replayed: Record<string, unknown>[];
  try {
    replayed = executePipeline(rawRows, pipeline as never, {}, []) as Record<string, unknown>[];
  } catch (err) {
    return `replay threw: ${err instanceof Error ? err.message : String(err)}`;
  }
  const xCol = s.roles.x.column;
  if (replayed.length !== s.rows.length) {
    return `replay produced ${replayed.length} rows, the series declares ${s.rows.length}`;
  }
  const byX = new Map(replayed.map((r) => [String(r[xCol]), r]));
  for (const declared of s.rows) {
    const key = String(declared[xCol]);
    const got = byX.get(key);
    if (!got) return `replay has no row at ${xCol}=${key}`;
    for (const col of measureColumns) {
      const want = declared[col];
      if (typeof want !== "number" || !Number.isFinite(want)) continue;
      const have = Number(got[col]);
      if (!Number.isFinite(have) || !closeEnough(want, have)) {
        return `at ${xCol}=${key}, ${col} replays as ${have} but the analysis declared ${want}`;
      }
    }
  }
  return null;
}

/**
 * Derive a controller that RE-AGGREGATES from the raw table. Returns null
 * (with no side effects) whenever the recipe is absent, incomplete, or fails
 * baseline replay — the series then stays static, which is always safe.
 *
 * `allSeries` supplies the roles-first filter vocabulary: any column another
 * series declared as its `group` is a dimension the ANALYSIS named, so it is
 * offered as a filter when the raw table carries it.
 */
export function deriveAggregatingController(
  s: SeriesEntry,
  views: DerivedView[],
  datasets: Record<string, unknown> | undefined,
  allSeries: SeriesEntry[]
): DerivedController | null {
  if (!datasets || views.length === 0) return null;
  if (s.rows_total !== undefined && s.rows_total > s.rows.length) return null; // capped rows
  const withAgg = s.roles.measures.filter(
    (m): m is typeof m & { aggregates: MeasureAggregation } => !!m.aggregates
  );
  if (withAgg.length === 0) return null;
  const from = withAgg[0].aggregates.from;
  if (withAgg.some((m) => m.aggregates.from !== from)) return null; // one source per series
  const rawRows = datasets[from];
  if (!Array.isArray(rawRows) || rawRows.length === 0) return null;
  const raw = rawRows as Record<string, unknown>[];
  const rawColumns = new Set(Object.keys(raw[0] ?? {}));
  if (!rawColumns.has(s.roles.x.column)) return null;

  const sourceCols = withAgg.flatMap((m) =>
    m.aggregates.fn === "ratio"
      ? [m.aggregates.numerator, m.aggregates.denominator]
      : [m.aggregates.column]
  );
  if (sourceCols.some((c) => !rawColumns.has(c))) return null;

  const pipeline = aggregationPipeline(s, withAgg);
  const measureColumns = withAgg.map((m) => m.column);
  const mismatch = verifyBaseline(s, raw, pipeline, measureColumns);
  if (mismatch) {
    logger.warn("Declared aggregation failed baseline replay — series stays static", {
      series: s.id,
      mismatch,
    });
    return null;
  }

  // Filter vocabulary, roles-first: dimensions the analysis NAMED (any
  // series' group role) that this raw table carries. The series' own x is
  // the groupBy key — filtering it would collapse the series to a point.
  const dimensions = [
    ...new Set(
      allSeries
        .map((o) => o.roles.group?.column)
        .filter((c): c is string => !!c && rawColumns.has(c) && c !== s.roles.x.column)
    ),
  ];
  if (dimensions.length === 0) return null; // nothing to filter by
  const filters = dimensions
    .filter((col) => {
      const n = distinct(raw, col);
      return n >= 2 && n <= CARDINALITY_CAP;
    })
    .map((col) => ({
      key: `${s.id}__${col}`,
      column: col,
      bindTo: `/filters/${s.id}__${col}`,
      label: filterLabel(col),
      allowAll: true,
      dependsOn: null,
    }));
  if (filters.length === 0) return null;

  // Only rebind views whose every column this recipe reproduces: a coverage
  // chart bound to a count column the recipe does not rebuild would render
  // empty. Those views keep their static data.
  const produced = new Set([s.roles.x.column, ...measureColumns]);
  const rebindable = views.filter((v) => v.kind === "primary" || v.kind === "unit_split");
  const outputs: Record<string, unknown>[] = [];
  const computed: Record<string, unknown> = {};
  const rebind: Record<string, string> = {};
  for (const v of rebindable) {
    const yKeys = ((v.patch.value as { props?: { y_keys?: string[] } }).props?.y_keys ??
      []) as string[];
    const unproduced = yKeys.filter((k) => !produced.has(k));
    if (unproduced.length > 0) {
      // Partial recomputation is worse than none: a filtered screened line
      // beside an unfiltered raw sibling is two different populations on one
      // axis. Say why, so a half-declared analysis is diagnosable rather
      // than silently non-interactive.
      logger.warn("View stays static — charted columns have no declared aggregation", {
        view: v.id,
        missing: unproduced,
        hint: "declare an `aggregates` role for every charted measure, raw siblings included",
      });
      continue;
    }
    const statePath = `/computed/${v.id}`;
    rebind[v.id] = statePath;
    outputs.push({
      statePath,
      pipeline,
      format: "rows",
      labelColumn: null,
      valueColumn: null,
      xColumn: null,
      yColumn: null,
      groupColumn: null,
    });
    computed[v.id] = `$chartData:${s.id}`;
  }
  if (outputs.length === 0) return null;

  return {
    id: `controls_${s.id}`,
    seriesId: s.id,
    reason: `measures declare how they aggregate from "${from}" and the recipe reproduces the declared rows at baseline — the reader can filter by ${dimensions.join(", ")} and the series is recomputed, not re-averaged`,
    element: {
      op: "add",
      path: `/elements/controls_${s.id}`,
      value: {
        type: "DataController",
        props: {
          source: { statePath: `/datasets/${from}` },
          scope_note: `Filters ${humanizeId(s.id)}, recomputed from the source table on every change.`,
          filters,
          pipeline: [{ op: "filter" }],
          outputs,
        },
        children: [],
      },
    },
    state: {
      datasets: { [from]: raw },
      filters: Object.fromEntries(filters.map((f) => [f.key, "All"])),
      computed,
    },
    rebind,
  };
}
