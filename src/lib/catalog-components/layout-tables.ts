/**
 * Component catalog entries — one slice of the former catalog.ts god
 * module (L7). Merged by spread in ../catalog.ts; order is irrelevant.
 */
import { z } from "zod";

export const catalogLayoutTables = {
  LayoutRow: {
    props: z.object({
      gap: z.number().nullable(),
      align: z.enum(["start", "center", "end", "stretch"]).nullable(),
    }),
    slots: ["default"],
    description: "Horizontal flex container for arranging children in a row",
  },
  LayoutColumn: {
    props: z.object({
      gap: z.number().nullable(),
    }),
    slots: ["default"],
    description: "Vertical flex container for stacking children",
  },
  LayoutGrid: {
    props: z.object({
      columns: z.number(),
      gap: z.number().nullable(),
    }),
    slots: ["default"],
    description: "CSS grid for card arrangements. Use columns 2-4 for stat cards.",
  },
  StatCard: {
    props: z.object({
      label: z.string(),
      value: z.unknown(),
      change: z.string().nullable(),
      trend: z.enum(["up", "down", "flat"]).nullable(),
      description: z.string().nullable(),
      format: z.enum(["currency", "percent", "number"]).nullable(),
      precision: z.number().nullable(),
    }),
    description:
      'A single KPI or metric with optional trend indicator. Group in LayoutGrid. Value can be a string ("1,234") or a $state reference for reactive updates. Use format "currency" for $-prefixed values (precision default: 2), "percent" for %-suffixed (precision default: 1), "number" for locale-formatted with custom precision.',
  },
  TextBlock: {
    props: z.object({
      content: z.string(),
      variant: z.enum(["body", "insight", "warning", "heading"]).nullable(),
    }),
    description: 'Narrative text. Use variant "heading" for titles, "insight" for analysis.',
  },
  SectionBreak: {
    props: z.object({
      variant: z.enum(["line", "space", "dotted"]).nullable(),
      label: z.string().nullable(),
    }),
    description:
      'Visual section divider. Use between major sections in presentation and report modes. Variant "line" (default) draws a horizontal rule, "space" adds whitespace, "dotted" draws a dotted line. Optional label appears centered on the line.',
  },
  DataTable: {
    props: z.object({
      columns: z.array(z.string()),
      rows: z.array(z.array(z.string())),
      caption: z.string().nullable(),
      highlight_max: z.boolean().nullable(),
      highlight_min: z.boolean().nullable(),
      max_rows: z.number().nullable(),
      delta_columns: z.array(z.string()).nullable(),
    }),
    description:
      "Tabular data view with optional highlighting of extremes. For a comparison report, pass `delta_columns` (the header names of signed Δ columns) to color positives green / negatives red — e.g. a Metric | A | B | Δ | Assessment table.",
  },
  DefinitionList: {
    props: z.object({
      title: z.string().nullable(),
      items: z.array(z.object({ term: z.string(), definition: z.string() })),
    }),
    description:
      "A clean key-value / definition block (term → definition) laid out as a two-column definition list — NOT a table. Use for a report's provenance header (Source / Analysis window / Data scope) and its glossary of metric definitions, where a DataTable's search/sort/export chrome would look out of place.",
  },
  PivotTable: {
    props: z.object({
      rows: z.array(z.record(z.string(), z.unknown())),
      rowDim: z.string(),
      colDim: z.string(),
      // Single-measure API (back-compat) — provide value + aggregator
      value: z.string().nullable(),
      aggregator: z.enum(["sum", "count", "mean", "min", "max"]).nullable(),
      // Multi-measure API — provide measures[]; overrides value/aggregator
      measures: z
        .array(
          z.object({
            value: z.string(),
            aggregator: z.enum(["sum", "count", "mean", "min", "max"]).nullable(),
            label: z.string().nullable(),
            format: z.enum(["currency", "percent", "number"]).nullable(),
            precision: z.number().nullable(),
          })
        )
        .nullable(),
      showRowTotals: z.boolean().nullable(),
      showColTotals: z.boolean().nullable(),
      caption: z.string().nullable(),
      valueFormat: z.enum(["currency", "percent", "number"]).nullable(),
      precision: z.number().nullable(),
      /**
       * Cross-filter bindings. When `selectsRow.bindTo` is set, clicking a
       * row header writes the row value to that state path; when
       * `selectsCol.bindTo` is set, clicking a column header writes the
       * column value to that path. Pair with a DataController upstream so
       * the rest of the dashboard refilters when a header is clicked.
       */
      selectsRow: z
        .object({
          column: z.string(),
          bindTo: z.string(),
        })
        .nullable(),
      selectsCol: z
        .object({
          column: z.string(),
          bindTo: z.string(),
        })
        .nullable(),
      /** Color-grade cells low → high based on cell value (per measure). */
      heatmap: z.boolean().nullable(),
      /**
       * When true, each measure column header gets a small dropdown to
       * switch the aggregator (sum/count/mean/min/max) inline.
       */
      editableAggregator: z.boolean().nullable(),
    }),
    description:
      'Two-dimensional crosstab. Provide LONG-FORMAT rows (one row per (rowDim, colDim) combination); the component pivots client-side. Use when the question is "X by Y" with both dimensions categorical/discrete (e.g. revenue by region by quarter, count of orders by category by status). For a single measure, set value + aggregator (sum/count/mean/min/max). For MULTIPLE measures (e.g. "show me revenue, units, and avg discount by region by quarter"), set measures: [{value, aggregator, label?, format?, precision?}, ...] — each measure becomes a sub-column under each colDim header. Optional total row + column.\n\nINTERACTIVITY: PivotTable supports four interactive features. (1) Sort: column-header clicks sort rows; the row-dim header sorts alphabetically; the Total column sorts by row total. No prop required. (2) Drill-through: hovering a cell reveals a small "↗" button that opens a modal listing the source rows aggregated into that cell. No prop required. (3) Drill-down (re-analysis): bind on.click with the drillDown action; clicking a cell will re-analyze the segment with BOTH rowDim and colDim filters applied (uses additional_filters). (4) Cross-filter via selectsRow/selectsCol: clicking a row or column header writes the dimension value to a state path so a DataController upstream can refilter the rest of the dashboard. (5) heatmap: true shades cells low→high. (6) editableAggregator: true adds an inline aggregator dropdown to each measure header.\n\nWhen the source dataset is on /datasets/main (DataController is in the dashboard), prefer reading rows from a /computed/* path so dashboard-level filters cascade into the pivot.',
  },
};
