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
import type { SeriesEntry } from "@/lib/contracts/product";
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
