/**
 * Deterministic view catalog (narrative-compiler spec §10): the compiled
 * composer's answer to "one series → one chart". A declared series' roles
 * (x kind, measures with units and raw variants, count) plus its regime
 * profile derive a FAMILY of candidate views, each a pure projection of the
 * declared rows — nothing here can draw data the analysis didn't declare.
 * Selection is deterministic: purpose sets the depth budget, regime flags
 * force the evidence views in. No LLM anywhere in this file.
 *
 * View kinds (v1):
 *  - primary     — the series' main chart. When measures span MULTIPLE
 *                  units, the primary carries only the first unit-group:
 *                  two units on one y axis is a defect, not a style.
 *  - unit_split  — one additional chart per further unit-group (ships for
 *                  every purpose — it exists only when the merged chart
 *                  would be invalid).
 *  - coverage    — observations-per-period companion (count role). Ships
 *                  whenever thin-data regimes fired (COUNT_SKEWED /
 *                  THIN_PERIODS / THIN_EDGE) — it is the evidence behind
 *                  every attestation decision the claims made — and for
 *                  deep-dive whenever a count role exists.
 *  - table       — precision DataTable over the series rows; ships for
 *                  report / deep-dive, where exact figures matter.
 *
 * Ids are stable derivations of the series id (chart_<sid>,
 * chart_<sid>__u<i>, chart_<sid>__counts, table_<sid>) so overlays and
 * mutations survive recompiles. Group-split and scatter views are deferred:
 * Line/Bar take flat wide-format data and the compiler does not pivot rows
 * (spec §10 records the deferral).
 */
import type { SeriesEntry } from "@/lib/contracts/product";
import { resolvePurpose } from "@/lib/purpose-prompts";
import { componentForSeries, humanizeId, type SpecPatchLine } from "./scaffold";

export interface DerivedView {
  /** Stable element id (also the overlay/mutation handle). */
  id: string;
  kind: "primary" | "unit_split" | "coverage" | "table" | "group_matrix";
  seriesId: string;
  /** Why this view exists / shipped — legibility for Verify surfaces. */
  reason: string;
  /** Deterministic selection verdict for this purpose + regime profile. */
  shipped: boolean;
  /** Catalog layout default — "half" charts pair into two-column rows.
   *  overlay.widths always wins over this. */
  defaultWidth?: "half";
  patch: SpecPatchLine;
}

/** Layout defaults for the shipped family: when two or more CHARTS ship,
 *  they default to half width so the width machinery pairs them into
 *  two-column rows (the generative side-by-side reading the compiled
 *  stack lacked). Tables always span. overlay.widths overrides per id. */
export function viewDefaultWidths(shipped: DerivedView[]): Record<string, "half"> {
  const charts = shipped.filter((v) => v.kind !== "table");
  if (charts.length < 2) return {};
  return Object.fromEntries(charts.map((v) => [v.id, "half" as const]));
}

const THIN_FLAGS = ["COUNT_SKEWED", "THIN_PERIODS", "THIN_EDGE"];

/** Measures grouped by declared unit, first-seen order; unitless measures
 *  join the FIRST group (nothing to contradict). */
function unitGroups(s: SeriesEntry): { unit: string | null; columns: string[] }[] {
  const groups: { unit: string | null; columns: string[] }[] = [];
  for (const m of s.roles.measures) {
    const unit = m.unit ?? null;
    const cols = [m.column, ...(m.variant_of ? [m.variant_of] : [])];
    const g = unit === null ? groups[0] : groups.find((x) => x.unit === unit);
    if (g) {
      for (const c of cols) if (!g.columns.includes(c)) g.columns.push(c);
    } else {
      groups.push({ unit, columns: cols });
    }
  }
  return groups;
}

/** Deterministic series palette (same named colors the generative composer
 *  reaches for) — the catalog's charts should not all read alarm-red. */
const PALETTE = ["indigo", "emerald", "amber", "rose", "violet", "cyan", "orange", "pink"];

function colorMap(yKeys: string[]): Record<string, string> {
  return Object.fromEntries(yKeys.map((k, i) => [k, PALETTE[i % PALETTE.length]]));
}

/** Display names for a series' columns: the legend is prose, not schema.
 *  A screened measure's raw sibling says so in words ("(unscreened)")
 *  rather than wearing a "_raw" suffix the reader has to decode. */
export function measureLabels(s: SeriesEntry): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const m of s.roles.measures) {
    labels[m.column] = humanizeId(m.column);
    if (m.variant_of) labels[m.variant_of] = `${humanizeId(m.column)} (unscreened)`;
  }
  const countCol = s.roles.count?.column;
  if (countCol) labels[countCol] = "Observations";
  return labels;
}

function chartPatch(s: SeriesEntry, id: string, title: string, yKeys: string[]): SpecPatchLine {
  const type = componentForSeries(s);
  return {
    op: "add",
    path: `/elements/${id}`,
    value: {
      type,
      props: {
        title,
        data: `$chartData:${s.id}`,
        x_key: s.roles.x.column,
        y_keys: yKeys,
        color_map: colorMap(yKeys),
        label_map: measureLabels(s),
        ...(type === "LineChart" ? { show_dots: false, curve: "monotone" } : {}),
      },
      children: [],
    },
  };
}

/** Pivot a group series' declared rows into a complete matrix, or null when
 *  any (group × x) cell is missing — an incomplete pivot would have to
 *  invent values for the holes, and the catalog draws nothing the analysis
 *  didn't declare. Orders are first-seen (the analysis' own ordering). */
function pivotGroupMatrix(
  s: SeriesEntry,
  groupCol: string,
  measure: string
): { z: number[][]; xLabels: string[]; yLabels: string[] } | null {
  const xCol = s.roles.x.column;
  const xLabels: string[] = [];
  const yLabels: string[] = [];
  const cells = new Map<string, number>();
  for (const row of s.rows) {
    const x = row[xCol];
    const g = row[groupCol];
    const v = row[measure];
    if (x === null || x === undefined || g === null || g === undefined) return null;
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
    const xs = String(x);
    const gs = String(g);
    if (!xLabels.includes(xs)) xLabels.push(xs);
    if (!yLabels.includes(gs)) yLabels.push(gs);
    cells.set(`${gs}\u0000${xs}`, v);
  }
  if (xLabels.length === 0 || yLabels.length === 0) return null;
  const z: number[][] = [];
  for (const g of yLabels) {
    const rowVals: number[] = [];
    for (const x of xLabels) {
      const v = cells.get(`${g}\u0000${x}`);
      if (v === undefined) return null; // incomplete pivot — no holes invented
      rowVals.push(v);
    }
    z.push(rowVals);
  }
  return { z, xLabels, yLabels };
}

/** Human title for a view in the PLANNER prompt — what the model anchors
 *  EXPLAIN/CAVEAT nodes to. Mirrors the edit panel's viewTitle so the same
 *  chart has the same name everywhere. */
export function viewPromptTitle(v: DerivedView): string {
  const name = v.seriesId.replace(/^step_\d+_/, "").replace(/_/g, " ");
  switch (v.kind) {
    case "coverage":
      return `Coverage of ${name} (observations per period)`;
    case "table":
      return `Table of ${name}`;
    case "unit_split":
      return `${name} (separate axis)`;
    case "group_matrix":
      return `${name} (heatmap by group and period)`;
    default:
      return `${name} (primary chart)`;
  }
}

/** Derive the full view family for the product's series. Callers emit only
 *  `shipped` views; the rest document what COULD ship (future UI affordance,
 *  Verify legibility). */
export function deriveViews(args: {
  series: SeriesEntry[];
  /** Envelope regime profiles keyed by series id (write_output ships them;
   *  investigate merges under step_N_ prefixes matching the merged ids). */
  regimes?: Record<string, unknown>;
  purpose?: string;
}): DerivedView[] {
  const purpose = resolvePurpose(args.purpose);
  const deep = purpose === "deep-dive";
  const tabular = purpose === "report" || deep;
  const views: DerivedView[] = [];

  for (const s of args.series) {
    const profile = (args.regimes?.[s.id] ?? {}) as { flags?: unknown };
    const flags = new Set(Array.isArray(profile.flags) ? (profile.flags as string[]) : []);
    const groups = unitGroups(s);

    // Group series (declared group role): the honest primary is the group
    // MATRIX — one cell per (group × period), the same view the generative
    // composer reaches for. Drawing a grouped long-format series through a
    // flat single-line chart interleaves the groups into a sawtooth (the
    // observed "Segment Churn Rate" defect). Pivot is a pure projection of
    // declared rows; an incomplete pivot falls through to the flat path
    // rather than inventing hole values.
    const groupCol = s.roles.group?.column;
    const groupMeasure = s.roles.measures[0]?.column;
    if (groupCol && groupMeasure) {
      const pivot = pivotGroupMatrix(s, groupCol, groupMeasure);
      if (pivot) {
        views.push({
          id: `chart_${s.id}`,
          kind: "group_matrix",
          seriesId: s.id,
          reason: `group series (${groupCol}) — one cell per group and period; a flat line would interleave the groups`,
          shipped: true,
          patch: {
            op: "add",
            path: `/elements/chart_${s.id}`,
            value: {
              type: "HeatMap",
              props: {
                title: humanizeId(s.id),
                z: pivot.z,
                x_labels: pivot.xLabels,
                y_labels: pivot.yLabels,
                show_values: pivot.z.length * (pivot.z[0]?.length ?? 0) <= 60,
              },
              children: [],
            },
          },
        });
        continue; // matrix replaces the flat chart family for this series
      }
    }

    // Primary: first unit-group only — the merged all-measures chart is
    // only valid when every measure shares a unit.
    const primaryKeys = groups[0]?.columns ?? [];
    if (primaryKeys.length > 0) {
      views.push({
        id: `chart_${s.id}`,
        kind: "primary",
        seriesId: s.id,
        reason:
          groups.length > 1
            ? `primary view restricted to ${groups[0].unit ?? "unitless"} measures — mixed units cannot share a y axis`
            : "primary view of the declared series",
        shipped: true,
        patch: chartPatch(s, `chart_${s.id}`, humanizeId(s.id), primaryKeys),
      });
    }

    // Unit splits: each further unit-group is its own chart, every purpose —
    // these exist exactly when merging them would be invalid.
    groups.slice(1).forEach((g, i) => {
      const id = `chart_${s.id}__u${i + 1}`;
      views.push({
        id,
        kind: "unit_split",
        seriesId: s.id,
        reason: `measures in ${g.unit ?? "unitless"} cannot share the primary's y axis`,
        shipped: true,
        patch: chartPatch(s, id, `${humanizeId(s.id)} (${g.unit ?? "other units"})`, g.columns),
      });
    });

    // Coverage companion: the n-per-period evidence behind attestation.
    const countCol = s.roles.count?.column;
    if (countCol) {
      const thin = THIN_FLAGS.some((f) => flags.has(f));
      const id = `chart_${s.id}__counts`;
      views.push({
        id,
        kind: "coverage",
        seriesId: s.id,
        reason: thin
          ? `thin-data regimes fired (${THIN_FLAGS.filter((f) => flags.has(f)).join(", ")}) — the reader must see where the observations live`
          : "observations per period (no thin-data regime fired)",
        shipped: thin || deep,
        patch: {
          op: "add",
          path: `/elements/${id}`,
          value: {
            type: "BarChart",
            props: {
              title: `${humanizeId(s.id)}: observations per period`,
              data: `$chartData:${s.id}`,
              x_key: s.roles.x.column,
              y_keys: [countCol],
              label_map: measureLabels(s),
            },
            children: [],
          },
        },
      });
    }

    // Precision table: exact figures for document styles.
    const tableCols = [
      s.roles.x.column,
      ...groups.flatMap((g) => g.columns),
      ...(countCol ? [countCol] : []),
    ];
    views.push({
      id: `table_${s.id}`,
      kind: "table",
      seriesId: s.id,
      reason: "exact figures for document styles (report/deep-dive)",
      shipped: tabular,
      patch: {
        op: "add",
        path: `/elements/table_${s.id}`,
        value: {
          type: "DataTable",
          props: {
            caption: humanizeId(s.id),
            columns: tableCols,
            rows: `$chartData:${s.id}`,
            max_rows: 30,
          },
          children: [],
        },
      },
    });
  }
  return views;
}
