"use client";

import { useMemo, useCallback, useState } from "react";
import { downloadTableAsCsv, downloadTableAsXlsx, sanitizeFilename } from "@/lib/export-utils";
import { useThemeConfig } from "@/lib/theme-config";
import { useDrillDispatch } from "@/lib/drill-down-context";

export type PivotAggregator = "sum" | "count" | "mean" | "min" | "max";

export interface PivotMeasure {
  value: string;
  aggregator?: PivotAggregator | null;
  label?: string | null;
  format?: "currency" | "percent" | "number" | null;
  precision?: number | null;
}

interface PivotTableProps {
  rows: Record<string, unknown>[];
  rowDim: string;
  colDim: string;
  // Single-measure API (back-compat)
  value?: string | null;
  aggregator?: PivotAggregator | null;
  // Multi-measure API
  measures?: PivotMeasure[] | null;
  showRowTotals?: boolean | null;
  showColTotals?: boolean | null;
  caption?: string | null;
  valueFormat?: "currency" | "percent" | "number" | null;
  precision?: number | null;
  // Cross-filter bindings (set by the LLM in the spec)
  selectsRow?: { column: string; bindTo: string } | null;
  selectsCol?: { column: string; bindTo: string } | null;
  // Heatmap shading on cells
  heatmap?: boolean | null;
  // Inline aggregator dropdown on each measure header
  editableAggregator?: boolean | null;
}

interface EventHandle {
  emit: () => void;
  bound: boolean;
  shouldPreventDefault: boolean;
}

interface PivotTableComponentProps {
  props: PivotTableProps;
  emit?: (event: string) => void;
  on?: (event: string) => EventHandle;
  // Selection state injected by the registry's PivotSelectionBridge
  selectedRow?: string | null;
  selectedCol?: string | null;
  onSelectRow?: ((value: string) => void) | null;
  onSelectCol?: ((value: string) => void) | null;
}

// ── Aggregation core (unchanged from prior versions) ─────────────────

function aggregate(values: number[], op: PivotAggregator): number {
  if (values.length === 0) return 0;
  switch (op) {
    case "sum":
      return values.reduce((a, b) => a + b, 0);
    case "count":
      return values.length;
    case "mean":
      return values.reduce((a, b) => a + b, 0) / values.length;
    case "min":
      return Math.min(...values);
    case "max":
      return Math.max(...values);
  }
}

function formatNumber(
  num: number,
  format: PivotTableProps["valueFormat"],
  precision?: number | null
): string {
  if (!isFinite(num)) return "";
  switch (format) {
    case "currency": {
      const p = precision ?? 2;
      return `$${num.toLocaleString(undefined, { minimumFractionDigits: p, maximumFractionDigits: p })}`;
    }
    case "percent": {
      const p = precision ?? 1;
      return `${num.toFixed(p)}%`;
    }
    case "number": {
      const p = precision ?? undefined;
      return num.toLocaleString(undefined, {
        minimumFractionDigits: p,
        maximumFractionDigits: p,
      });
    }
    default: {
      if (Number.isInteger(num)) return num.toLocaleString();
      return num.toLocaleString(undefined, { maximumFractionDigits: 2 });
    }
  }
}

interface MeasureResult {
  measure: ResolvedMeasure;
  rowKeys: string[];
  colKeys: string[];
  cells: Map<string, Map<string, number>>;
  rowTotals: Map<string, number>;
  colTotals: Map<string, number>;
  grandTotal: number;
  /** Min/max of cell values across the grid — used for heatmap shading. */
  cellMin: number;
  cellMax: number;
}

interface PivotResult {
  rowKeys: string[];
  colKeys: string[];
  measures: MeasureResult[];
}

interface ResolvedMeasure {
  value: string;
  aggregator: PivotAggregator;
  label: string;
  format: "currency" | "percent" | "number" | "auto";
  precision: number | null;
}

function resolveMeasures(
  props: PivotTableProps,
  aggregatorOverrides: Record<number, PivotAggregator> = {}
): ResolvedMeasure[] {
  const applyOverride = (idx: number, base: PivotAggregator): PivotAggregator =>
    aggregatorOverrides[idx] ?? base;

  if (!props.measures || props.measures.length === 0) {
    if (!props.value) return [];
    const ag = applyOverride(0, props.aggregator ?? "sum");
    return [
      {
        value: props.value,
        aggregator: ag,
        label: `${ag}(${props.value})`,
        format: (props.valueFormat ?? "auto") as ResolvedMeasure["format"],
        precision: props.precision ?? null,
      },
    ];
  }
  return props.measures.map((m, idx) => {
    const ag = applyOverride(idx, m.aggregator ?? "sum");
    return {
      value: m.value,
      aggregator: ag,
      label: m.label ?? `${ag}(${m.value})`,
      format: (m.format ?? props.valueFormat ?? "auto") as ResolvedMeasure["format"],
      precision: m.precision ?? props.precision ?? null,
    };
  });
}

function pivotMeasure(
  rows: Record<string, unknown>[],
  rowDim: string,
  colDim: string,
  measure: ResolvedMeasure
): MeasureResult {
  const buckets = new Map<string, Map<string, number[]>>();
  const rowKeySet = new Set<string>();
  const colKeySet = new Set<string>();

  for (const row of rows) {
    const rk = String(row[rowDim] ?? "");
    const ck = String(row[colDim] ?? "");
    rowKeySet.add(rk);
    colKeySet.add(ck);

    if (measure.aggregator === "count") {
      let cols = buckets.get(rk);
      if (!cols) {
        cols = new Map();
        buckets.set(rk, cols);
      }
      let arr = cols.get(ck);
      if (!arr) {
        arr = [];
        cols.set(ck, arr);
      }
      arr.push(1);
    } else {
      const num = Number(row[measure.value]);
      if (Number.isNaN(num)) continue;
      let cols = buckets.get(rk);
      if (!cols) {
        cols = new Map();
        buckets.set(rk, cols);
      }
      let arr = cols.get(ck);
      if (!arr) {
        arr = [];
        cols.set(ck, arr);
      }
      arr.push(num);
    }
  }

  const cells = new Map<string, Map<string, number>>();
  const rowTotals = new Map<string, number>();
  const colTotals = new Map<string, number>();
  let cellMin = Infinity;
  let cellMax = -Infinity;

  for (const [rk, cols] of buckets) {
    const aggCols = new Map<string, number>();
    const rowVals: number[] = [];
    for (const [ck, vals] of cols) {
      const v = aggregate(vals, measure.aggregator);
      aggCols.set(ck, v);
      if (v < cellMin) cellMin = v;
      if (v > cellMax) cellMax = v;
      rowVals.push(...vals);
    }
    cells.set(rk, aggCols);
    rowTotals.set(rk, aggregate(rowVals, measure.aggregator));
  }

  const valuesByCol = new Map<string, number[]>();
  for (const row of rows) {
    const ck = String(row[colDim] ?? "");
    if (measure.aggregator === "count") {
      let arr = valuesByCol.get(ck);
      if (!arr) {
        arr = [];
        valuesByCol.set(ck, arr);
      }
      arr.push(1);
    } else {
      const num = Number(row[measure.value]);
      if (Number.isNaN(num)) continue;
      let arr = valuesByCol.get(ck);
      if (!arr) {
        arr = [];
        valuesByCol.set(ck, arr);
      }
      arr.push(num);
    }
  }
  for (const [ck, vals] of valuesByCol) {
    colTotals.set(ck, aggregate(vals, measure.aggregator));
  }

  const allValues: number[] = [];
  for (const arr of valuesByCol.values()) allValues.push(...arr);
  const grandTotal = aggregate(allValues, measure.aggregator);

  return {
    measure,
    rowKeys: [...rowKeySet].sort(),
    colKeys: [...colKeySet].sort(),
    cells,
    rowTotals,
    colTotals,
    grandTotal,
    cellMin: cellMin === Infinity ? 0 : cellMin,
    cellMax: cellMax === -Infinity ? 0 : cellMax,
  };
}

function pivot(
  rows: Record<string, unknown>[],
  rowDim: string,
  colDim: string,
  measures: ResolvedMeasure[]
): PivotResult {
  if (measures.length === 0) {
    return { rowKeys: [], colKeys: [], measures: [] };
  }
  const measureResults = measures.map((m) => pivotMeasure(rows, rowDim, colDim, m));
  const rowKeySet = new Set<string>();
  const colKeySet = new Set<string>();
  for (const r of measureResults) {
    for (const k of r.rowKeys) rowKeySet.add(k);
    for (const k of r.colKeys) colKeySet.add(k);
  }
  return {
    rowKeys: [...rowKeySet].sort(),
    colKeys: [...colKeySet].sort(),
    measures: measureResults,
  };
}

function fmtMeasureCell(measure: ResolvedMeasure, num: number | undefined): string {
  if (num === undefined) return "";
  return formatNumber(num, measure.format === "auto" ? null : measure.format, measure.precision);
}

// ── Sort: derive sorted rowKeys based on the user's click target ──────

type SortTarget =
  | { kind: "rowDim" }
  | { kind: "col"; colKey: string; measureIdx: number }
  | { kind: "total"; measureIdx: number };

interface SortState {
  target: SortTarget;
  dir: "asc" | "desc";
}

function sortRowKeys(
  rowKeys: string[],
  sort: SortState | null,
  measures: MeasureResult[]
): string[] {
  if (!sort) return rowKeys;
  const sign = sort.dir === "asc" ? 1 : -1;

  if (sort.target.kind === "rowDim") {
    return [...rowKeys].sort((a, b) => sign * a.localeCompare(b));
  }
  if (sort.target.kind === "col") {
    const m = measures[sort.target.measureIdx];
    if (!m) return rowKeys;
    return [...rowKeys].sort((a, b) => {
      const va =
        m.cells.get(a)?.get(sort.target.kind === "col" ? sort.target.colKey : "") ?? -Infinity;
      const vb =
        m.cells.get(b)?.get(sort.target.kind === "col" ? sort.target.colKey : "") ?? -Infinity;
      return sign * (va - vb);
    });
  }
  // total
  const m = measures[sort.target.measureIdx];
  if (!m) return rowKeys;
  return [...rowKeys].sort((a, b) => {
    const va = m.rowTotals.get(a) ?? -Infinity;
    const vb = m.rowTotals.get(b) ?? -Infinity;
    return sign * (va - vb);
  });
}

// ── Heatmap shading: linearly interpolate alpha 0..0.4 by cell value ──

function heatmapStyle(value: number | undefined, min: number, max: number): React.CSSProperties {
  if (value === undefined || !isFinite(value) || max <= min) return {};
  const t = Math.max(0, Math.min(1, (value - min) / (max - min)));
  const alpha = (0.05 + t * 0.35).toFixed(3);
  return { background: `rgba(99, 102, 241, ${alpha})` }; // indigo-500 base
}

// ── Component ─────────────────────────────────────────────────────────

const AGGREGATORS: PivotAggregator[] = ["sum", "count", "mean", "min", "max"];

export function PivotTableComponent({
  props,
  on,
  selectedRow,
  selectedCol,
  onSelectRow,
  onSelectCol,
}: PivotTableComponentProps) {
  const drillDispatch = useDrillDispatch();
  const { table: tableConfig } = useThemeConfig();

  // Local state — interactivity that doesn't round-trip to the server
  const [sort, setSort] = useState<SortState | null>(null);
  const [aggregatorOverrides, setAggregatorOverrides] = useState<Record<number, PivotAggregator>>(
    {}
  );
  const [drillThroughCell, setDrillThroughCell] = useState<{
    rowKey: string;
    colKey: string;
  } | null>(null);

  // When the spec re-streams (different rows/dims), reset local state so the
  // user doesn't carry stale sort/overrides over to a fundamentally new pivot.
  // Derived-state-from-props pattern — no effect needed.
  const [prevPivotKey, setPrevPivotKey] = useState<{
    rowDim: typeof props.rowDim;
    colDim: typeof props.colDim;
    rows: typeof props.rows;
  }>({ rowDim: props.rowDim, colDim: props.colDim, rows: props.rows });
  if (
    prevPivotKey.rowDim !== props.rowDim ||
    prevPivotKey.colDim !== props.colDim ||
    prevPivotKey.rows !== props.rows
  ) {
    setPrevPivotKey({ rowDim: props.rowDim, colDim: props.colDim, rows: props.rows });
    setSort(null);
    setAggregatorOverrides({});
    setDrillThroughCell(null);
  }

  const measures = useMemo(
    () => resolveMeasures(props, aggregatorOverrides),
    [props, aggregatorOverrides]
  );
  const isMulti = measures.length > 1;

  const result = useMemo(
    () => pivot(props.rows ?? [], props.rowDim, props.colDim, measures),
    [props.rows, props.rowDim, props.colDim, measures]
  );

  const { colKeys, measures: measureResults } = result;
  const rowKeys = useMemo(
    () => sortRowKeys(result.rowKeys, sort, measureResults),
    [result.rowKeys, sort, measureResults]
  );

  const showColTotals = !!props.showColTotals;
  const showRowTotals = !!props.showRowTotals;
  const heatmap = !!props.heatmap;
  const editableAggregator = !!props.editableAggregator;

  // Drill-down enabled when the spec bound an on.click handler. Per-cell
  // params are computed at click time and dispatched directly via the
  // SpecView's drill dispatch (the static emit/on machinery
  // doesn't carry dynamic per-cell params).
  const drillDownEnabled = on?.("click")?.bound ?? false;

  // ── Export ──
  const exportHeaders = useMemo(() => {
    const headers: string[] = [props.rowDim];
    for (const ck of colKeys) {
      if (isMulti) {
        for (const m of measures) headers.push(`${ck} – ${m.label}`);
      } else {
        headers.push(ck);
      }
    }
    if (showRowTotals) {
      if (isMulti) {
        for (const m of measures) headers.push(`Total – ${m.label}`);
      } else {
        headers.push("Total");
      }
    }
    return headers;
  }, [props.rowDim, colKeys, isMulti, measures, showRowTotals]);

  const exportRows = useMemo(() => {
    const out: string[][] = [];
    for (const rk of rowKeys) {
      const r: string[] = [rk];
      for (const ck of colKeys) {
        for (const mResult of measureResults) {
          const v = mResult.cells.get(rk)?.get(ck);
          r.push(fmtMeasureCell(mResult.measure, v));
        }
      }
      if (showRowTotals) {
        for (const mResult of measureResults) {
          r.push(fmtMeasureCell(mResult.measure, mResult.rowTotals.get(rk) ?? 0));
        }
      }
      out.push(r);
    }
    if (showColTotals) {
      const r: string[] = ["Total"];
      for (const ck of colKeys) {
        for (const mResult of measureResults) {
          r.push(fmtMeasureCell(mResult.measure, mResult.colTotals.get(ck) ?? 0));
        }
      }
      if (showRowTotals) {
        for (const mResult of measureResults) {
          r.push(fmtMeasureCell(mResult.measure, mResult.grandTotal));
        }
      }
      out.push(r);
    }
    return out;
  }, [rowKeys, colKeys, measureResults, showRowTotals, showColTotals]);

  const filename = sanitizeFilename(props.caption ?? `pivot_${props.rowDim}_x_${props.colDim}`);
  const handleExportCsv = useCallback(
    () => downloadTableAsCsv(exportHeaders, exportRows, filename),
    [exportHeaders, exportRows, filename]
  );
  const handleExportXlsx = useCallback(
    () => downloadTableAsXlsx(exportHeaders, exportRows, filename),
    [exportHeaders, exportRows, filename]
  );

  // ── Cell click → drill-down (if bound) ──
  const handleCellClick = useCallback(
    (rk: string, ck: string) => {
      if (!drillDownEnabled || !drillDispatch) {
        // No drill-down bound → fall through to drill-through
        setDrillThroughCell({ rowKey: rk, colKey: ck });
        return;
      }
      drillDispatch({
        segment_label: `${rk} × ${ck}`,
        segment_value: rk,
        chart_title: props.caption ?? null,
        x_key: props.rowDim,
        y_key: props.colDim,
        filter_column: props.rowDim,
        filter_value: rk,
        additional_filters: [{ column: props.colDim, value: ck }],
      });
    },
    [drillDownEnabled, props.rowDim, props.colDim, props.caption]
  );

  // ── Sort header click handlers ──
  const cycleSort = useCallback((target: SortTarget) => {
    setSort((prev) => {
      if (prev && JSON.stringify(prev.target) === JSON.stringify(target)) {
        // same target → toggle direction; third click clears
        if (prev.dir === "desc") return { target, dir: "asc" };
        return null;
      }
      // numeric defaults to descending (most natural for "biggest first"),
      // alphabetical defaults to ascending
      const dir: "asc" | "desc" = target.kind === "rowDim" ? "asc" : "desc";
      return { target, dir };
    });
  }, []);

  // Drill-through: the source rows that fed a given cell
  const drillThroughRows = useMemo(() => {
    if (!drillThroughCell) return [];
    return (props.rows ?? []).filter(
      (r) =>
        String(r[props.rowDim] ?? "") === drillThroughCell.rowKey &&
        String(r[props.colDim] ?? "") === drillThroughCell.colKey
    );
  }, [drillThroughCell, props.rows, props.rowDim, props.colDim]);

  if (rowKeys.length === 0 || colKeys.length === 0 || measures.length === 0) {
    return (
      <div className="text-sm text-t-tertiary">
        Pivot table has no data (rowDim={props.rowDim}, colDim={props.colDim}).
      </div>
    );
  }

  const measureSummary = isMulti
    ? `${measures.length} measures: ${measures.map((m) => m.label).join(", ")}`
    : `${measures[0].aggregator} of ${measures[0].value}`;

  const colSpan = measures.length;

  // ── Sort-indicator helper ──
  const sortIndicator = (target: SortTarget): string => {
    if (!sort || JSON.stringify(sort.target) !== JSON.stringify(target)) return "";
    return sort.dir === "asc" ? " ▲" : " ▼";
  };

  // Single shared style for clickable headers
  const headerCursor = "cursor-pointer select-none hover:opacity-80";

  return (
    <div className="w-full space-y-2">
      {props.caption && (
        <h3
          className="text-t-secondary"
          style={{ fontSize: "var(--chart-title-size)", fontWeight: "var(--chart-title-weight)" }}
        >
          {props.caption}
        </h3>
      )}

      <div className="flex items-center gap-2">
        <button
          onClick={handleExportCsv}
          className="bg-surface-btn px-3 py-1.5 text-xs font-medium text-t-btn hover:bg-surface-btn-hover transition-colors"
          style={{
            borderRadius: "var(--radius-badge)",
            transitionDuration: "var(--transition-speed)",
          }}
        >
          Export CSV
        </button>
        <button
          onClick={handleExportXlsx}
          className="bg-surface-btn px-3 py-1.5 text-xs font-medium text-t-btn hover:bg-surface-btn-hover transition-colors"
          style={{
            borderRadius: "var(--radius-badge)",
            transitionDuration: "var(--transition-speed)",
          }}
        >
          Export XLSX
        </button>
        <span className="ml-2 text-xs text-t-tertiary">{measureSummary}</span>
        {sort && (
          <button
            onClick={() => setSort(null)}
            className="ml-auto text-xs text-t-tertiary hover:text-t-primary"
            title="Clear sort"
          >
            Clear sort
          </button>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-table-divider">
              <th
                rowSpan={isMulti ? 2 : 1}
                scope="col"
                className={`sticky left-0 align-bottom font-semibold text-t-secondary ${tableConfig.cellPadding} ${headerCursor} ${tableConfig.headerBg ? "bg-table-header-bg" : "bg-surface-1"}`}
                onClick={() => cycleSort({ kind: "rowDim" })}
                style={{
                  textTransform: tableConfig.headerTransform,
                  letterSpacing: tableConfig.headerTransform === "uppercase" ? "0.05em" : undefined,
                  borderBottomWidth: tableConfig.headerBorderWidth,
                }}
                title="Click to sort by this dimension"
              >
                {props.rowDim}
                {sortIndicator({ kind: "rowDim" })}
              </th>
              {colKeys.map((ck) => {
                const isSelected = selectedCol === ck;
                return (
                  <th
                    key={ck}
                    scope="col"
                    colSpan={colSpan}
                    onClick={(e) => {
                      // Default: sort by the first measure's value in this column
                      // Cmd/Ctrl-click: cross-filter (when selectsCol bound)
                      if ((e.metaKey || e.ctrlKey) && onSelectCol) {
                        onSelectCol(ck);
                      } else {
                        cycleSort({ kind: "col", colKey: ck, measureIdx: 0 });
                      }
                    }}
                    className={`text-right font-semibold text-t-secondary ${tableConfig.cellPadding} ${headerCursor} ${tableConfig.headerBg ? "bg-table-header-bg" : ""} ${isSelected ? "bg-accent-subtle text-accent-text" : ""}`}
                    style={{
                      textTransform: tableConfig.headerTransform,
                      letterSpacing:
                        tableConfig.headerTransform === "uppercase" ? "0.05em" : undefined,
                      borderBottomWidth: tableConfig.headerBorderWidth,
                    }}
                    title={
                      onSelectCol ? "Click to sort • Cmd/Ctrl+click to filter" : "Click to sort"
                    }
                  >
                    {ck}
                    {sortIndicator({ kind: "col", colKey: ck, measureIdx: 0 })}
                  </th>
                );
              })}
              {showRowTotals && (
                <th
                  scope="col"
                  colSpan={colSpan}
                  rowSpan={isMulti ? 1 : 2}
                  onClick={() => cycleSort({ kind: "total", measureIdx: 0 })}
                  className={`text-right font-semibold text-t-secondary ${tableConfig.cellPadding} ${headerCursor} ${tableConfig.headerBg ? "bg-table-header-bg" : ""}`}
                  style={{
                    textTransform: tableConfig.headerTransform,
                    borderBottomWidth: tableConfig.headerBorderWidth,
                  }}
                  title="Click to sort by row total"
                >
                  Total{sortIndicator({ kind: "total", measureIdx: 0 })}
                </th>
              )}
            </tr>
            {isMulti && (
              <tr className="border-b border-table-divider">
                {colKeys.map((ck) =>
                  measures.map((m, mIdx) => (
                    <th
                      key={`${ck}--${m.label}`}
                      scope="col"
                      onClick={() => cycleSort({ kind: "col", colKey: ck, measureIdx: mIdx })}
                      className={`text-right text-xs font-medium text-t-tertiary ${tableConfig.cellPadding} ${headerCursor}`}
                    >
                      {editableAggregator ? (
                        <AggregatorSelect
                          current={m.aggregator}
                          onChange={(next) =>
                            setAggregatorOverrides((prev) => ({ ...prev, [mIdx]: next }))
                          }
                          label={m.label}
                        />
                      ) : (
                        m.label
                      )}
                      {sortIndicator({ kind: "col", colKey: ck, measureIdx: mIdx })}
                    </th>
                  ))
                )}
                {showRowTotals &&
                  measures.map((m, mIdx) => (
                    <th
                      key={`total--${m.label}`}
                      scope="col"
                      onClick={() => cycleSort({ kind: "total", measureIdx: mIdx })}
                      className={`text-right text-xs font-medium text-t-tertiary ${tableConfig.cellPadding} ${headerCursor}`}
                    >
                      {m.label}
                      {sortIndicator({ kind: "total", measureIdx: mIdx })}
                    </th>
                  ))}
              </tr>
            )}
          </thead>
          <tbody>
            {rowKeys.map((rk) => {
              const isRowSelected = selectedRow === rk;
              return (
                <tr
                  key={rk}
                  className="border-b border-table-divider transition-colors hover:bg-table-row-hover"
                  style={{ transitionDuration: "var(--transition-speed)" }}
                >
                  <th
                    scope="row"
                    onClick={() => onSelectRow?.(rk)}
                    className={`sticky left-0 font-medium text-t-primary ${tableConfig.cellPadding} ${onSelectRow ? headerCursor : ""} ${isRowSelected ? "bg-accent-subtle text-accent-text" : "bg-surface-1"}`}
                    title={onSelectRow ? "Click to filter dashboard" : undefined}
                  >
                    {rk}
                  </th>
                  {colKeys.map((ck) =>
                    measureResults.map((mResult, mIdx) => {
                      const v = mResult.cells.get(rk)?.get(ck);
                      const cellStyle: React.CSSProperties = heatmap
                        ? heatmapStyle(v, mResult.cellMin, mResult.cellMax)
                        : {};
                      return (
                        <td
                          key={`${ck}--${mResult.measure.label}`}
                          onClick={() => handleCellClick(rk, ck)}
                          className={`group relative text-right tabular-nums text-t-secondary ${tableConfig.cellPadding} cursor-pointer hover:bg-table-row-hover`}
                          style={cellStyle}
                          title={
                            drillDownEnabled
                              ? `Click to drill into ${rk} × ${ck}`
                              : `Click to see source rows for ${rk} × ${ck}`
                          }
                        >
                          {fmtMeasureCell(mResult.measure, v)}
                          {/* Drill-through icon: always shown on hover, opens
                              the source-rows modal even when cell click is
                              wired to drill-down */}
                          {mIdx === 0 && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setDrillThroughCell({ rowKey: rk, colKey: ck });
                              }}
                              className="absolute right-1 top-1 opacity-0 group-hover:opacity-100 text-xs text-t-tertiary hover:text-accent transition-opacity"
                              title="View source rows"
                              aria-label="View source rows"
                            >
                              ↗
                            </button>
                          )}
                        </td>
                      );
                    })
                  )}
                  {showRowTotals &&
                    measureResults.map((mResult) => (
                      <td
                        key={`total--${mResult.measure.label}`}
                        className={`text-right tabular-nums font-semibold text-t-primary ${tableConfig.cellPadding}`}
                      >
                        {fmtMeasureCell(mResult.measure, mResult.rowTotals.get(rk) ?? 0)}
                      </td>
                    ))}
                </tr>
              );
            })}
            {showColTotals && (
              <tr className="border-t-2 border-border-default font-semibold">
                <th
                  scope="row"
                  className={`sticky left-0 bg-surface-1 text-t-primary ${tableConfig.cellPadding}`}
                >
                  Total
                </th>
                {colKeys.map((ck) =>
                  measureResults.map((mResult) => (
                    <td
                      key={`coltotal-${ck}--${mResult.measure.label}`}
                      className={`text-right tabular-nums text-t-primary ${tableConfig.cellPadding}`}
                    >
                      {fmtMeasureCell(mResult.measure, mResult.colTotals.get(ck) ?? 0)}
                    </td>
                  ))
                )}
                {showRowTotals &&
                  measureResults.map((mResult) => (
                    <td
                      key={`grand-${mResult.measure.label}`}
                      className={`text-right tabular-nums text-t-primary ${tableConfig.cellPadding}`}
                    >
                      {fmtMeasureCell(mResult.measure, mResult.grandTotal)}
                    </td>
                  ))}
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Hover-help: only show once when the table has data */}
      <p className="text-xs text-t-tertiary">
        Click a column header to sort. Hover a cell and click ↗ to see the source rows.
        {drillDownEnabled && " Click a cell to drill into that segment."}
        {(onSelectRow || onSelectCol) &&
          " Click a row header to filter the dashboard. Cmd/Ctrl-click a column header to filter by that column."}
      </p>

      {/* Drill-through modal */}
      {drillThroughCell && (
        <DrillThroughModal
          rowDim={props.rowDim}
          colDim={props.colDim}
          rowValue={drillThroughCell.rowKey}
          colValue={drillThroughCell.colKey}
          rows={drillThroughRows}
          onClose={() => setDrillThroughCell(null)}
        />
      )}
    </div>
  );
}

// ── Aggregator dropdown (D1) ─────────────────────────────────────────

function AggregatorSelect({
  current,
  onChange,
  label,
}: {
  current: PivotAggregator;
  onChange: (next: PivotAggregator) => void;
  label: string;
}) {
  // Hide the dropdown chrome unless hovered/focused — keeps the header clean
  return (
    <span className="inline-flex items-center gap-1">
      {label.replace(`${current}(`, "").replace(/\)$/, "") /* show just the column name */}
      <select
        value={current}
        onChange={(e) => onChange(e.target.value as PivotAggregator)}
        onClick={(e) => e.stopPropagation()}
        className="text-[10px] bg-transparent border border-border-default rounded px-1 py-0 text-t-tertiary hover:text-t-primary"
        title="Switch aggregator"
        aria-label={`Aggregator for ${label}`}
      >
        {AGGREGATORS.map((a) => (
          <option key={a} value={a}>
            {a}
          </option>
        ))}
      </select>
    </span>
  );
}

// ── Drill-through modal (A2) ─────────────────────────────────────────

function DrillThroughModal({
  rowDim,
  colDim,
  rowValue,
  colValue,
  rows,
  onClose,
}: {
  rowDim: string;
  colDim: string;
  rowValue: string;
  colValue: string;
  rows: Record<string, unknown>[];
  onClose: () => void;
}) {
  // Stable column order: take from first row, fall back to dimensions.
  const columns = useMemo(() => {
    if (rows.length === 0) return [rowDim, colDim];
    return Object.keys(rows[0]);
  }, [rows, rowDim, colDim]);

  const handleExport = useCallback(() => {
    const tabular = rows.map((r) => columns.map((c) => String(r[c] ?? "")));
    downloadTableAsCsv(columns, tabular, `${rowValue}_${colValue}_rows`);
  }, [rows, columns, rowValue, colValue]);

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.4)",
        zIndex: 60,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-surface-1 border border-border-default rounded-lg shadow-xl"
        style={{
          maxWidth: "min(90vw, 900px)",
          maxHeight: "85vh",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div
          className="flex items-center justify-between border-b border-border-default px-4 py-3"
          style={{ flexShrink: 0 }}
        >
          <div>
            <p className="text-sm font-semibold text-t-primary">
              Source rows: {rowDim} = {rowValue}, {colDim} = {colValue}
            </p>
            <p className="text-xs text-t-tertiary mt-0.5">
              {rows.length} row{rows.length !== 1 ? "s" : ""} aggregated into this cell
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleExport}
              className="bg-surface-btn px-3 py-1 text-xs font-medium text-t-btn hover:bg-surface-btn-hover transition-colors"
              style={{ borderRadius: "var(--radius-badge)" }}
            >
              Export CSV
            </button>
            <button
              onClick={onClose}
              className="text-t-tertiary hover:text-t-primary"
              aria-label="Close"
              style={{ fontSize: 20, lineHeight: 1, padding: 4 }}
            >
              ×
            </button>
          </div>
        </div>
        <div className="overflow-auto" style={{ flex: 1 }}>
          {rows.length === 0 ? (
            <p className="text-sm text-t-tertiary p-4">No source rows match this cell.</p>
          ) : (
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 bg-surface-1">
                <tr className="border-b border-table-divider">
                  {columns.map((c) => (
                    <th
                      key={c}
                      className="px-3 py-2 text-xs font-medium text-t-secondary text-left"
                    >
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, ri) => (
                  <tr key={ri} className="border-b border-table-divider">
                    {columns.map((c) => (
                      <td key={c} className="px-3 py-2 text-t-primary whitespace-nowrap">
                        {String(r[c] ?? "")}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Test seams ─────────────────────────────────────────────────

export function __pivotForTesting(
  rows: Record<string, unknown>[],
  rowDim: string,
  colDim: string,
  value: string,
  aggregator: PivotAggregator
): {
  rowKeys: string[];
  colKeys: string[];
  cells: Map<string, Map<string, number>>;
  rowTotals: Map<string, number>;
  colTotals: Map<string, number>;
  grandTotal: number;
} {
  const measure: ResolvedMeasure = {
    value,
    aggregator,
    label: `${aggregator}(${value})`,
    format: "auto",
    precision: null,
  };
  const result = pivotMeasure(rows, rowDim, colDim, measure);
  return {
    rowKeys: result.rowKeys,
    colKeys: result.colKeys,
    cells: result.cells,
    rowTotals: result.rowTotals,
    colTotals: result.colTotals,
    grandTotal: result.grandTotal,
  };
}

export function __pivotMultiForTesting(
  rows: Record<string, unknown>[],
  rowDim: string,
  colDim: string,
  measures: { value: string; aggregator?: PivotAggregator }[]
): PivotResult {
  const resolved: ResolvedMeasure[] = measures.map((m) => ({
    value: m.value,
    aggregator: m.aggregator ?? "sum",
    label: `${m.aggregator ?? "sum"}(${m.value})`,
    format: "auto",
    precision: null,
  }));
  return pivot(rows, rowDim, colDim, resolved);
}

export { sortRowKeys as __sortRowKeysForTesting, heatmapStyle as __heatmapStyleForTesting };
