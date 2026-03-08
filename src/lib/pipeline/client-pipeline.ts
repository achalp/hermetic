/**
 * Client-side data pipeline engine.
 * Pure functions — no React dependency. Runs entirely in the browser.
 */

// ── Types ──────────────────────────────────────────────────────────

export interface FilterDef {
  key: string;
  column: string;
  bindTo: string;
  label: string;
  allowAll: boolean;
  dependsOn: string[] | null;
}

export interface Aggregation {
  column: string;
  fn: AggFn;
  as: string;
}

export type AggFn = "sum" | "avg" | "min" | "max" | "count" | "countDistinct" | "median";

export type PipelineStep =
  | { op: "filter" }
  | { op: "groupBy"; columns: string[]; aggregations: Aggregation[] }
  | { op: "sort"; column: string; direction: "asc" | "desc" }
  | { op: "limit"; count: number }
  | { op: "pivot"; rowKey: string; columnKey: string; valueKey: string; aggFn: AggFn }
  | { op: "compute"; column: string; expression: string }
  | { op: "topN"; column: string; n: number; direction: "asc" | "desc" };

export interface OutputDef {
  statePath: string;
  format?:
    | "rows"
    | "pieData"
    | "scatterData"
    | "stats"
    | "geojson"
    | "globeData"
    | "sankeyData" // Pattern A: filter structured data
    | "matrix"
    | "chordMatrix" // Pattern B: derive from pivoted rows
    | null;
  sourceStatePath?: string | null; // state path to base data (Pattern A formats)
  pipeline?: Record<string, unknown>[] | null;
  labelColumn?: string | null;
  valueColumn?: string | null;
  xColumn?: string | null;
  yColumn?: string | null;
  groupColumn?: string | null;
}

type Row = Record<string, unknown>;

// ── Helpers ────────────────────────────────────────────────────────

function toNumber(v: unknown): number {
  if (typeof v === "number") return v;
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

function compare(a: unknown, b: unknown, dir: "asc" | "desc"): number {
  const aNum = Number(a);
  const bNum = Number(b);
  const aIsNum = !isNaN(aNum) && a !== "" && a !== null;
  const bIsNum = !isNaN(bNum) && b !== "" && b !== null;

  let result: number;
  if (aIsNum && bIsNum) {
    result = aNum - bNum;
  } else {
    result = String(a ?? "").localeCompare(String(b ?? ""));
  }
  return dir === "desc" ? -result : result;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function aggregate(values: unknown[], fn: AggFn): number {
  const nums = values.map(toNumber);
  switch (fn) {
    case "sum":
      return nums.reduce((a, b) => a + b, 0);
    case "avg":
      return nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
    case "min":
      return nums.length > 0 ? Math.min(...nums) : 0;
    case "max":
      return nums.length > 0 ? Math.max(...nums) : 0;
    case "count":
      return values.length;
    case "countDistinct":
      return new Set(values.map(String)).size;
    case "median":
      return median(nums);
  }
}

// ── Pipeline Operations ────────────────────────────────────────────

export function applyFilter(
  data: Row[],
  filterValues: Record<string, unknown>,
  filterDefs: FilterDef[]
): Row[] {
  let result = data;
  for (const def of filterDefs) {
    const val = filterValues[def.key];
    if (val === undefined || val === null || val === "" || val === "All") continue;
    result = result.filter((row) => String(row[def.column]) === String(val));
  }
  return result;
}

// ── Pattern A: Structured Data Filters ─────────────────────────────

/** Filter GeoJSON FeatureCollection features by their properties. */
export function filterGeoJSON(
  geojson: Record<string, unknown>,
  filterValues: Record<string, unknown>,
  filterDefs: FilterDef[]
): Record<string, unknown> {
  const features = geojson.features;
  if (!Array.isArray(features)) return geojson;

  const filtered = features.filter((f) => {
    const props = f?.properties ?? {};
    for (const def of filterDefs) {
      const val = filterValues[def.key];
      if (val === undefined || val === null || val === "" || val === "All") continue;
      if (String(props[def.column] ?? "") !== String(val)) return false;
    }
    return true;
  });

  return { ...geojson, features: filtered };
}

/** Filter Globe3D data: points by properties, arcs by endpoint membership. */
export function filterGlobeData(
  data: Record<string, unknown>,
  filterValues: Record<string, unknown>,
  filterDefs: FilterDef[]
): Record<string, unknown> {
  const points = Array.isArray(data.points) ? data.points : [];
  const arcs = Array.isArray(data.arcs) ? data.arcs : [];

  const filteredPoints = points.filter((pt: Record<string, unknown>) => {
    for (const def of filterDefs) {
      const val = filterValues[def.key];
      if (val === undefined || val === null || val === "" || val === "All") continue;
      if (String(pt[def.column] ?? "") !== String(val)) return false;
    }
    return true;
  });

  // Build set of surviving point locations for arc filtering
  const pointSet = new Set(
    filteredPoints.map((pt: Record<string, unknown>) => `${pt.lat},${pt.lng}`)
  );
  const filteredArcs = arcs.filter(
    (arc: Record<string, unknown>) =>
      pointSet.has(`${arc.startLat},${arc.startLng}`) && pointSet.has(`${arc.endLat},${arc.endLng}`)
  );

  return { ...data, points: filteredPoints, arcs: filteredArcs };
}

/** Filter SankeyChart data: nodes by properties, links by endpoint membership. */
export function filterSankeyData(
  data: Record<string, unknown>,
  filterValues: Record<string, unknown>,
  filterDefs: FilterDef[]
): Record<string, unknown> {
  const nodes = Array.isArray(data.nodes) ? data.nodes : [];
  const links = Array.isArray(data.links) ? data.links : [];

  const filteredNodes = nodes.filter((node: Record<string, unknown>) => {
    for (const def of filterDefs) {
      const val = filterValues[def.key];
      if (val === undefined || val === null || val === "" || val === "All") continue;
      if (String(node[def.column] ?? "") !== String(val)) return false;
    }
    return true;
  });

  const nodeIds = new Set(filteredNodes.map((n: Record<string, unknown>) => n.id));
  const filteredLinks = links.filter(
    (link: Record<string, unknown>) => nodeIds.has(link.source) && nodeIds.has(link.target)
  );

  return { ...data, nodes: filteredNodes, links: filteredLinks };
}

export function applyGroupBy(data: Row[], columns: string[], aggregations: Aggregation[]): Row[] {
  const groups = new Map<string, Row[]>();

  for (const row of data) {
    const key = columns.map((c) => String(row[c] ?? "")).join("|||");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }

  const result: Row[] = [];
  for (const [, groupRows] of groups) {
    const out: Row = {};
    // Copy group key columns from first row
    for (const col of columns) {
      out[col] = groupRows[0][col];
    }
    // Run aggregations
    for (const agg of aggregations) {
      const values = groupRows.map((r) => r[agg.column]);
      out[agg.as] = aggregate(values, agg.fn);
    }
    result.push(out);
  }
  return result;
}

export function applySort(data: Row[], column: string, direction: "asc" | "desc"): Row[] {
  return [...data].sort((a, b) => compare(a[column], b[column], direction));
}

export function applyLimit(data: Row[], count: number): Row[] {
  return data.slice(0, count);
}

export function applyPivot(
  data: Row[],
  rowKey: string,
  columnKey: string,
  valueKey: string,
  aggFn: AggFn
): Row[] {
  // Collect unique column values
  const colValues = [...new Set(data.map((r) => String(r[columnKey])))];

  // Group by rowKey
  const groups = new Map<string, Row[]>();
  for (const row of data) {
    const key = String(row[rowKey] ?? "");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }

  const result: Row[] = [];
  for (const [key, groupRows] of groups) {
    const out: Row = { [rowKey]: key };
    for (const cv of colValues) {
      const matching = groupRows.filter((r) => String(r[columnKey]) === cv);
      const values = matching.map((r) => r[valueKey]);
      out[cv] = aggregate(values, aggFn);
    }
    result.push(out);
  }
  return result;
}

export function applyCompute(data: Row[], column: string, expression: string): Row[] {
  // Parse expression: percent(a, b), diff(a, b), ratio(a, b), round(col, decimals)
  const match = expression.match(/^(\w+)\((.+)\)$/);
  if (!match) return data;

  const [, fn, argsStr] = match;
  const args = argsStr.split(",").map((s) => s.trim());

  return data.map((row) => {
    const out = { ...row };
    switch (fn) {
      case "percent": {
        const num = toNumber(row[args[0]]);
        const den = toNumber(row[args[1]]);
        out[column] = den !== 0 ? (num / den) * 100 : 0;
        break;
      }
      case "diff": {
        out[column] = toNumber(row[args[0]]) - toNumber(row[args[1]]);
        break;
      }
      case "ratio": {
        const den = toNumber(row[args[1]]);
        out[column] = den !== 0 ? toNumber(row[args[0]]) / den : 0;
        break;
      }
      case "round": {
        const decimals = parseInt(args[1]) || 0;
        out[column] = Number(toNumber(row[args[0]]).toFixed(decimals));
        break;
      }
      case "multiply": {
        out[column] = args.reduce((acc, col) => acc * toNumber(row[col]), 1);
        break;
      }
      case "add": {
        out[column] = args.reduce((acc, col) => acc + toNumber(row[col]), 0);
        break;
      }
      case "subtract": {
        out[column] = toNumber(row[args[0]]) - toNumber(row[args[1]]);
        break;
      }
      case "percentOf": {
        // a * b / 100 — "b percent of a"
        out[column] = (toNumber(row[args[0]]) * toNumber(row[args[1]])) / 100;
        break;
      }
    }
    return out;
  });
}

export function applyTopN(
  data: Row[],
  column: string,
  n: number,
  direction: "asc" | "desc"
): Row[] {
  return applyLimit(applySort(data, column, direction), n);
}

// ── Pipeline Orchestrator ──────────────────────────────────────────

export function executePipeline(
  data: Row[],
  steps: PipelineStep[],
  filterValues: Record<string, unknown>,
  filterDefs: FilterDef[]
): Row[] {
  let result = data;

  for (const step of steps) {
    switch (step.op) {
      case "filter":
        result = applyFilter(result, filterValues, filterDefs);
        break;
      case "groupBy":
        result = applyGroupBy(result, step.columns, step.aggregations);
        break;
      case "sort":
        result = applySort(result, step.column, step.direction);
        break;
      case "limit":
        result = applyLimit(result, step.count);
        break;
      case "pivot":
        result = applyPivot(result, step.rowKey, step.columnKey, step.valueKey, step.aggFn);
        break;
      case "compute":
        result = applyCompute(result, step.column, step.expression);
        break;
      case "topN":
        result = applyTopN(result, step.column, step.n, step.direction);
        break;
    }
  }

  return result;
}

// ── Output Formatting ──────────────────────────────────────────────

export function formatOutput(data: Row[], outputDef: OutputDef): unknown {
  if (!outputDef.format || outputDef.format === "rows") {
    return data;
  }

  if (outputDef.format === "pieData") {
    const labelCol = outputDef.labelColumn;
    const valueCol = outputDef.valueColumn;
    if (!labelCol || !valueCol) return data;
    return data.map((row) => ({
      label: String(row[labelCol] ?? ""),
      value: toNumber(row[valueCol]),
    }));
  }

  if (outputDef.format === "scatterData") {
    const xCol = outputDef.xColumn;
    const yCol = outputDef.yColumn;
    if (!xCol || !yCol) return data;
    return data.map((row) => ({
      x: toNumber(row[xCol]),
      y: toNumber(row[yCol]),
      label: outputDef.labelColumn ? String(row[outputDef.labelColumn] ?? "") : null,
      group: outputDef.groupColumn ? String(row[outputDef.groupColumn] ?? "") : null,
    }));
  }

  if (outputDef.format === "stats") {
    // Extract the first row as a flat key→value object so StatCards can
    // bind to individual fields via $state, e.g. "/computed/stats/total".
    return data.length > 0 ? data[0] : {};
  }

  // Pattern B: convert pivoted rows → matrix structure for HeatMap/Surface3D
  if (outputDef.format === "matrix") {
    if (data.length === 0) return { z: [], x_labels: [], y_labels: [] };
    const keys = Object.keys(data[0]);
    const rowKeyCol = keys[0]; // first column is the row key
    const valueCols = keys.slice(1);
    const x_labels = data.map((row) => String(row[rowKeyCol] ?? ""));
    const y_labels = valueCols;
    const z = data.map((row) => valueCols.map((col) => toNumber(row[col])));
    return { z, x_labels, y_labels };
  }

  // Pattern B: convert pivoted rows → chord matrix structure
  if (outputDef.format === "chordMatrix") {
    if (data.length === 0) return { matrix: [], keys: [] };
    const cols = Object.keys(data[0]);
    const rowKeyCol = cols[0];
    const valueCols = cols.slice(1);
    const keys = data.map((row) => String(row[rowKeyCol] ?? ""));
    const matrix = data.map((row) => valueCols.map((col) => toNumber(row[col])));
    return { matrix, keys };
  }

  return data;
}

// ── Filter Option Computation ──────────────────────────────────────

/**
 * Compute available options for each filter, respecting cascading dependencies.
 * Root filters show all distinct values from the full dataset.
 * Dependent filters show values from the parent-filtered subset.
 */
export function computeFilterOptions(
  data: Row[],
  filterDefs: FilterDef[],
  currentValues: Record<string, unknown>
): Record<string, string[]> {
  const result: Record<string, string[]> = {};

  for (const def of filterDefs) {
    let subset = data;

    // If this filter depends on others, narrow the dataset by parent filter values
    if (def.dependsOn && def.dependsOn.length > 0) {
      for (const parentKey of def.dependsOn) {
        const parentDef = filterDefs.find((f) => f.key === parentKey);
        if (!parentDef) continue;
        const parentVal = currentValues[parentKey];
        if (parentVal && parentVal !== "All") {
          subset = subset.filter((row) => String(row[parentDef.column]) === String(parentVal));
        }
      }
    }

    const values = [...new Set(subset.map((row) => String(row[def.column] ?? "")))].filter(
      (v) => v !== ""
    );
    values.sort();
    result[def.key] = values;
  }

  return result;
}
