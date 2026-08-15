/**
 * Family-level VIEW props compilers (compiled-view-parity spec §3, P3).
 *
 * A VIEW plan node is the planner's REQUEST for a component; everything
 * about the element itself is compiled HERE, deterministically, from the
 * declared series' roles or the referenced claim's value — the planner
 * never authors props. Series-fed views bind their rows via `$chartData:`
 * where the component takes keyed records, and inline PURE PROJECTIONS of
 * the declared rows where the component wants a transformed shape (pivots,
 * trees, curves) — the same trust level as every derived view. Claim-fed
 * views inline values computed host-side from the declared claim.
 *
 * The conformance test (views-parity) compiles ONE fixture per compilable
 * component and parses the output against the component's OWN zod schema
 * (lib/catalog) — compiler and component cannot drift.
 *
 * Not compilable (licensed, rejected with alternatives): Dendrogram and
 * DecisionTree (scipy coordinate arrays / opaque trees no declarable shape
 * carries), MarimekkoChart and PivotTable (prop contracts too bespoke for
 * a deterministic mapping today), ShapBeeswarm (model-explanation payloads
 * beyond the matrix contract). They remain generative-only until a shape
 * exists for them.
 */
import type { FindingEntry } from "@/lib/contracts/findings";
import type { PlanNode } from "@/lib/contracts/plan";
import type { SeriesEntry } from "@/lib/contracts/product";
import { COMPONENT_ROLE_SIGNATURES } from "@/lib/product/signatures";
import kindContract from "@/lib/product/series-kind-contract.json";
import { humanizeId, type SpecPatchLine } from "./scaffold";

/** Components the family compilers can build — the planner catalog and the
 *  VIEW validator both consume this set; the signatures closure test
 *  asserts it stays inside the registry. */
export const COMPILABLE_VIEWS = new Set([
  // axis
  "BarChart",
  "LineChart",
  "AreaChart",
  "ScatterChart",
  "DualAxisChart",
  "ParetoChart",
  "Sparkline",
  "ControlChart",
  "ErrorBarChart",
  "PopulationPyramid",
  "SlopeChart",
  "DumbbellChart",
  "BumpChart",
  "StreamChart",
  "RadarChart",
  "ParallelCoordinates",
  "CalendarChart",
  "Scatter3D",
  "TernaryChart",
  // distribution
  "Histogram",
  "BoxPlot",
  "ViolinChart",
  "BeeswarmChart",
  "ECDFChart",
  "QQPlot",
  "RidgelineChart",
  "SilhouettePlot",
  // geo
  "MapView",
  "Map3D",
  "Globe3D",
  // matrix
  "HeatMap",
  "ConfusionMatrix",
  "CohortGrid",
  "Surface3D",
  "ContourChart",
  "Correlogram",
  // hierarchy / flow
  "SunburstChart",
  "SankeyChart",
  "ChordChart",
  "NetworkGraph",
  // curve
  "RocCurve",
  "LiftChart",
  "CalibrationCurve",
  "SurvivalChart",
  "ForestPlot",
  "PartialDependence",
  // ohlc / span / vector
  "CandlestickChart",
  "GanttChart",
  "QuiverChart",
  "WindRose",
  // composition (claim-fed)
  "PieChart",
  "TreemapChart",
  "FunnelChart",
  "WaterfallChart",
  // stat / table
  "TrendIndicator",
  "GaugeChart",
  "BulletChart",
  "DefinitionList",
  "DataTable",
]);

/** Back-compat alias (P1 name). */
export const P1_COMPILABLE = COMPILABLE_VIEWS;

const KIND_SLOTS = (kindContract as { kinds: Record<string, string[][]> }).kinds;

const fv = (f: FindingEntry): Record<string, unknown> =>
  f.value !== null && typeof f.value === "object" && !Array.isArray(f.value)
    ? (f.value as Record<string, unknown>)
    : {};

function measureCols(s: SeriesEntry): string[] {
  return s.roles.measures.map((m) => m.column);
}

function rowKeys(s: SeriesEntry): string[] {
  return Object.keys((s.rows[0] ?? {}) as Record<string, unknown>);
}

/** Resolve the actual column satisfying one kind-contract slot (the alias
 *  list from series-kind-contract.json), case-insensitively. */
function slotCol(s: SeriesEntry, kind: string, slotIndex: number): string | null {
  const slot = KIND_SLOTS[kind]?.[slotIndex];
  if (!slot) return null;
  const keys = rowKeys(s);
  for (const alias of slot) {
    const hit = keys.find((k) => k.toLowerCase() === alias);
    if (hit) return hit;
  }
  return null;
}

const num = (v: unknown): number | null => (typeof v === "number" && isFinite(v) ? v : null);

/** Strict pivot of {row, col, value} rows into a complete matrix — null on
 *  any hole (the catalog draws nothing the analysis didn't declare; same
 *  rule as views.ts pivotGroupMatrix). Label orders are first-seen. */
function pivotMatrix(
  s: SeriesEntry,
  opts?: { fillHoles?: number }
): { z: number[][]; rowLabels: string[]; colLabels: string[] } | null {
  const rCol = slotCol(s, "matrix", 0);
  const cCol = slotCol(s, "matrix", 1);
  const vCol = slotCol(s, "matrix", 2);
  if (!rCol || !cCol || !vCol) return null;
  const rowLabels: string[] = [];
  const colLabels: string[] = [];
  const cells = new Map<string, number>();
  for (const raw of s.rows) {
    const row = raw as Record<string, unknown>;
    const r = String(row[rCol]);
    const c = String(row[cCol]);
    const v = num(row[vCol]);
    if (v === null) return null;
    if (!rowLabels.includes(r)) rowLabels.push(r);
    if (!colLabels.includes(c)) colLabels.push(c);
    cells.set(`${r}\u0000${c}`, v);
  }
  if (rowLabels.length === 0 || colLabels.length === 0) return null;
  const z: number[][] = [];
  for (const r of rowLabels) {
    const line: number[] = [];
    for (const c of colLabels) {
      const v = cells.get(`${r}\u0000${c}`);
      if (v === undefined) {
        if (opts?.fillHoles === undefined) return null;
        line.push(opts.fillHoles);
      } else line.push(v);
    }
    z.push(line);
  }
  return { z, rowLabels, colLabels };
}

/** Group curve-kind rows into per-group point lists (single group when the
 *  series declares no group role). Points keep declaration order. */
function curveGroups(
  s: SeriesEntry
):
  | { label: string; x: number[]; y: number[]; lo: (number | null)[]; hi: (number | null)[] }[]
  | null {
  const xCol = slotCol(s, "curve", 0);
  const yCol = slotCol(s, "curve", 1);
  if (!xCol || !yCol) return null;
  const keys = rowKeys(s);
  const loCol = keys.find((k) => /^(lo|lower)$/i.test(k)) ?? null;
  const hiCol = keys.find((k) => /^(hi|upper)$/i.test(k)) ?? null;
  const gCol = s.roles.group?.column ?? null;
  const groups = new Map<
    string,
    { x: number[]; y: number[]; lo: (number | null)[]; hi: (number | null)[] }
  >();
  for (const raw of s.rows) {
    const row = raw as Record<string, unknown>;
    const x = num(row[xCol]);
    const y = num(row[yCol]);
    if (x === null || y === null) return null;
    const label = gCol ? String(row[gCol]) : humanizeId(s.id);
    const g = groups.get(label) ?? { x: [], y: [], lo: [], hi: [] };
    groups.set(label, g);
    g.x.push(x);
    g.y.push(y);
    g.lo.push(loCol ? num(row[loCol]) : null);
    g.hi.push(hiCol ? num(row[hiCol]) : null);
  }
  return [...groups.entries()].map(([label, g]) => ({ label, ...g }));
}

/** Share-claim entries as ranked {label, value} rows. */
function shareRows(f: FindingEntry): { label: string; value: number }[] {
  const shares = fv(f).shares_pct;
  if (shares === null || typeof shares !== "object" || Array.isArray(shares)) return [];
  return Object.entries(shares as Record<string, unknown>)
    .filter((e): e is [string, number] => typeof e[1] === "number")
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value);
}

/** Decomposition-claim terms as waterfall rows: each term relative, the
 *  residual (when nonzero) relative, and the summed total closing. */
function waterfallRows(
  f: FindingEntry
): { label: string; value: number; type: "absolute" | "relative" | "total" }[] {
  const v = fv(f);
  const rows: { label: string; value: number; type: "absolute" | "relative" | "total" }[] = [];
  let total = 0;
  for (const [k, val] of Object.entries(v)) {
    if (k === "dominant" || k === "residual" || k === "detected") continue;
    if (typeof val !== "number") continue;
    rows.push({ label: humanizeId(k), value: val, type: "relative" });
    total += val;
  }
  const residual = v.residual;
  if (typeof residual === "number" && residual !== 0) {
    rows.push({ label: "Residual", value: residual, type: "relative" });
    total += residual;
  }
  if (rows.length === 0) return [];
  rows.push({ label: "Total", value: total, type: "total" });
  return rows;
}

/** Hierarchy rows (parent/child/value) as the nested tree Sunburst wants.
 *  Roots (parents that are nobody's child) hang under a synthetic top node. */
function buildTree(s: SeriesEntry, title: string): Record<string, unknown> | null {
  const pCol = slotCol(s, "hierarchy", 0);
  const cCol = slotCol(s, "hierarchy", 1);
  const vCol = slotCol(s, "hierarchy", 2);
  if (!pCol || !cCol || !vCol) return null;
  interface TreeNode {
    name: string;
    value?: number;
    children?: TreeNode[];
  }
  const nodes = new Map<string, TreeNode>();
  const isChild = new Set<string>();
  const nodeFor = (name: string): TreeNode => {
    let n = nodes.get(name);
    if (!n) {
      n = { name };
      nodes.set(name, n);
    }
    return n;
  };
  for (const raw of s.rows) {
    const row = raw as Record<string, unknown>;
    const parent = nodeFor(String(row[pCol]));
    const child = nodeFor(String(row[cCol]));
    const v = num(row[vCol]);
    if (v !== null) child.value = v;
    (parent.children ??= []).push(child);
    isChild.add(child.name);
  }
  const roots = [...nodes.values()].filter((n) => !isChild.has(n.name));
  if (roots.length === 0) return null;
  return { name: title, children: roots } as unknown as Record<string, unknown>;
}

function claimScalarItems(f: FindingEntry): { term: string; definition: string }[] {
  return Object.entries(fv(f))
    .filter(([k, v]) => k !== "detected" && (typeof v === "number" || typeof v === "string"))
    .map(([k, v]) => ({ term: humanizeId(k), definition: String(v) }));
}

/**
 * Compile one VIEW node to its spec element. Assumes the node passed
 * validatePlan (component compilable, series/claim licensed); returns null
 * defensively when the inputs it was validated against don't carry what
 * the component needs — the node then drops and the derived floor ships.
 */
export function compileViewNode(
  node: PlanNode,
  series: SeriesEntry | undefined,
  byName: Map<string, FindingEntry>
): SpecPatchLine | null {
  const component = node.component;
  if (!component || !COMPILABLE_VIEWS.has(component)) return null;
  const sig = COMPONENT_ROLE_SIGNATURES[component];
  const title = node.text?.trim() || (series ? humanizeId(series.id) : humanizeId(node.id));
  const el = (props: Record<string, unknown>): SpecPatchLine => ({
    op: "add",
    path: `/elements/${node.id}`,
    value: { type: component, props, children: [] },
  });

  // ── Claim-fed components ─────────────────────────────────────────
  if (sig.feeds === "claim") {
    const claim = node.refs.map((r) => byName.get(r)).find((f) => f !== undefined);
    if (!claim) return null;
    const v = fv(claim);
    switch (component) {
      case "WaterfallChart": {
        const data = waterfallRows(claim);
        return data.length > 0 ? el({ title, data }) : null;
      }
      case "TreemapChart": {
        const data = shareRows(claim);
        return data.length > 0
          ? el({
              title,
              data: { name: title, children: data.map((r) => ({ name: r.label, value: r.value })) },
            })
          : null;
      }
      case "TrendIndicator": {
        const current = num(v.late_median) ?? num(v.latest_total);
        const previous = num(v.early_median) ?? num(v.prior_total);
        if (current === null || previous === null) return null;
        return el({ label: title, current, previous });
      }
      case "GaugeChart": {
        const value = num(v.value);
        const peak = num(v.peak_value);
        if (value === null || peak === null || peak <= 0) return null;
        return el({ title, value, min: 0, max: peak });
      }
      case "BulletChart": {
        const value = num(v.value);
        const peak = num(v.peak_value);
        if (value === null || peak === null) return null;
        return el({ title, data: [{ label: title, value, target: peak, ranges: [peak] }] });
      }
      case "DefinitionList": {
        const items = claimScalarItems(claim);
        return items.length > 0 ? el({ title, items }) : null;
      }
      default: {
        // PieChart / FunnelChart share the {label, value} row contract.
        const data = shareRows(claim);
        return data.length > 0 ? el({ title, data }) : null;
      }
    }
  }

  // ── Series-fed components ────────────────────────────────────────
  if (!series) return null;
  const dataBinding = `$chartData:${series.id}`;
  const ms = measureCols(series);
  const groupCol = series.roles.group?.column ?? null;
  const xCol = series.roles.x.column;
  const rows = series.rows as Record<string, unknown>[];

  switch (sig.family) {
    case "geo": {
      const keys = rowKeys(series);
      const latKey = keys.find((k) => /^lat(itude)?$/i.test(k));
      const lngKey = keys.find((k) => /^(lng|lon|longitude)$/i.test(k));
      if (!latKey || !lngKey) return null;
      if (component === "Map3D") {
        return el({
          title,
          data: dataBinding,
          lat_key: latKey,
          lng_key: lngKey,
          layer_type: "scatterplot",
        });
      }
      if (component === "Globe3D") {
        // Strict point objects — project only the contract fields.
        const labelKey = keys.find((k) => /^(name|label)$/i.test(k)) ?? null;
        const points = rows
          .map((r) => ({
            lat: num(r[latKey]),
            lng: num(r[lngKey]),
            label: labelKey ? (r[labelKey] === null ? null : String(r[labelKey])) : null,
            color: null,
            size: null,
          }))
          .filter(
            (p): p is { lat: number; lng: number; label: string | null; color: null; size: null } =>
              p.lat !== null && p.lng !== null
          );
        return points.length > 0 ? el({ title, points, arcs: null }) : null;
      }
      // MapView markers: contract fields normalized (lat/lng/label/color)
      // with every OTHER scalar row field riding along — the click popup
      // renders those attributes (rank, distance, id...), the same
      // property table geojson features get. A pin the reader cannot
      // interrogate hides the declared row behind it.
      const labelKey = keys.find((k) => /^(name|label)$/i.test(k)) ?? null;
      const markers = rows
        .map((r) => {
          const extras: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(r)) {
            if (k === latKey || k === lngKey || k === labelKey) continue;
            if (v === null || typeof v !== "object") extras[k] = v;
          }
          return {
            ...extras,
            lat: num(r[latKey]),
            lng: num(r[lngKey]),
            label: labelKey && r[labelKey] !== null ? String(r[labelKey]) : null,
            color: null,
          };
        })
        .filter((m) => m.lat !== null && m.lng !== null);
      // Polygon/region geometry rides along when the analysis produced it
      // (chart_data.geojson is the pinned convention); the binding sweeps
      // to null harmlessly when absent.
      return markers.length > 0 ? el({ title, markers, geojson: "$chartData:geojson" }) : null;
    }

    case "distribution": {
      if (ms.length === 0) return null;
      if (component === "SilhouettePlot") {
        if (!groupCol) return null;
        return el({ title, data: dataBinding, cluster_key: groupCol, value_key: ms[0] });
      }
      if (component === "RidgelineChart") {
        // Ridgeline's group_key is REQUIRED — one distribution per group.
        if (!groupCol) return null;
        return el({ title, data: dataBinding, value_key: ms[0], group_key: groupCol });
      }
      return el({ title, data: dataBinding, value_key: ms[0], group_key: groupCol });
    }

    case "matrix": {
      if (component === "Correlogram") {
        // Axis-shaped: lag (x) + one measure.
        if (ms.length === 0) return null;
        const data = rows
          .map((r) => ({ lag: num(r[xCol]), value: num(r[ms[0]]) }))
          .filter((d): d is { lag: number; value: number } => d.lag !== null && d.value !== null);
        return data.length > 0
          ? el({ title, data, n: series.rows_total ?? series.rows.length })
          : null;
      }
      const pv = pivotMatrix(
        series,
        component === "ConfusionMatrix" ? { fillHoles: 0 } : undefined
      );
      if (!pv) return null;
      switch (component) {
        case "HeatMap":
          return el({ title, z: pv.z, x_labels: pv.colLabels, y_labels: pv.rowLabels });
        case "CohortGrid":
          return el({ title, z: pv.z, row_labels: pv.rowLabels, col_labels: pv.colLabels });
        case "Surface3D":
          return el({ title, z: pv.z, x_labels: pv.colLabels, y_labels: pv.rowLabels });
        case "ConfusionMatrix": {
          // Square over the union of labels, absent pairs = 0 counts.
          const labels = [...new Set([...pv.rowLabels, ...pv.colLabels])];
          const idx = new Map(labels.map((l, i) => [l, i]));
          const matrix = labels.map(() => labels.map(() => 0));
          pv.rowLabels.forEach((r, ri) =>
            pv.colLabels.forEach((c, ci) => {
              matrix[idx.get(r)!][idx.get(c)!] = pv.z[ri][ci];
            })
          );
          return el({ title, matrix, labels });
        }
        case "ContourChart": {
          const xs = pv.colLabels.map((l) => Number(l));
          const ys = pv.rowLabels.map((l) => Number(l));
          return el({
            title,
            z: pv.z,
            x: xs.every((n) => isFinite(n)) ? xs : null,
            y: ys.every((n) => isFinite(n)) ? ys : null,
          });
        }
        default:
          return null;
      }
    }

    case "hierarchy": {
      if (component !== "SunburstChart") return null;
      const tree = buildTree(series, title);
      return tree ? el({ title, data: tree }) : null;
    }

    case "flow": {
      const sCol = slotCol(series, "flow", 0);
      const tCol = slotCol(series, "flow", 1);
      const wCol = slotCol(series, "flow", 2);
      if (!sCol || !tCol || !wCol) return null;
      const links = rows
        .map((r) => ({ source: String(r[sCol]), target: String(r[tCol]), value: num(r[wCol]) }))
        .filter((l): l is { source: string; target: string; value: number } => l.value !== null);
      if (links.length === 0) return null;
      const ids = [...new Set(links.flatMap((l) => [l.source, l.target]))];
      switch (component) {
        case "SankeyChart":
          return el({ title, nodes: ids.map((id) => ({ id, label: null })), links });
        case "NetworkGraph":
          return el({
            title,
            nodes: ids.map((id) => ({ id, x: null, y: null, label: id, size: null, group: null })),
            edges: links.map((l) => ({ source: l.source, target: l.target, weight: l.value })),
          });
        case "ChordChart": {
          const idx = new Map(ids.map((id, i) => [id, i]));
          const matrix = ids.map(() => ids.map(() => 0));
          for (const l of links) matrix[idx.get(l.source)!][idx.get(l.target)!] += l.value;
          return el({ title, matrix, keys: ids });
        }
        default:
          return null;
      }
    }

    case "curve": {
      if (component === "ForestPlot") {
        // Per-row estimates with intervals; the x slot carries the LABEL
        // (non-numeric — handled before the numeric curve grouping).
        const yCol = slotCol(series, "curve", 1);
        const keys = rowKeys(series);
        const loCol = keys.find((k) => /^(lo|lower)$/i.test(k));
        const hiCol = keys.find((k) => /^(hi|upper)$/i.test(k));
        if (!yCol || !loCol || !hiCol) return null;
        const data = rows
          .map((r) => ({
            label: String(r[xCol]),
            estimate: num(r[yCol]),
            lower: num(r[loCol]),
            upper: num(r[hiCol]),
          }))
          .filter(
            (d): d is { label: string; estimate: number; lower: number; upper: number } =>
              d.estimate !== null && d.lower !== null && d.upper !== null
          );
        return data.length > 0 ? el({ title, data }) : null;
      }
      const groups = curveGroups(series);
      if (!groups || groups.length === 0) return null;
      switch (component) {
        case "RocCurve":
          return el({
            title,
            curves: groups.map((g) => ({ label: g.label, fpr: g.x, tpr: g.y, auc: null })),
          });
        case "LiftChart":
          return el({ title, curves: groups.map((g) => ({ label: g.label, x: g.x, y: g.y })) });
        case "CalibrationCurve":
          return el({
            title,
            curves: groups.map((g) => ({ label: g.label, predicted: g.x, observed: g.y })),
          });
        case "SurvivalChart": {
          const hasCI = groups.every(
            (g) => g.lo.every((v) => v !== null) && g.hi.every((v) => v !== null)
          );
          return el({
            title,
            curves: groups.map((g) => ({
              label: g.label,
              points: g.x.map((x, i) => ({
                time: x,
                survival: g.y[i],
                lower: hasCI ? (g.lo[i] as number) : g.y[i],
                upper: hasCI ? (g.hi[i] as number) : g.y[i],
              })),
            })),
            show_ci: hasCI,
          });
        }
        case "PartialDependence": {
          const g = groups[0];
          return el({ title, x_values: g.x, pdp: g.y, ice: null, feature_name: title });
        }
        default:
          return null;
      }
    }

    case "ohlc": {
      const keys = rowKeys(series);
      const key = (name: string) => keys.find((k) => k.toLowerCase() === name);
      const [o, h, l, c] = [key("open"), key("high"), key("low"), key("close")];
      if (!o || !h || !l || !c) return null;
      return el({
        title,
        data: dataBinding,
        date_key: xCol,
        open_key: o,
        high_key: h,
        low_key: l,
        close_key: c,
      });
    }

    case "span": {
      const lCol = slotCol(series, "span", 0);
      const sCol = slotCol(series, "span", 1);
      const eCol = slotCol(series, "span", 2);
      if (!lCol || !sCol || !eCol) return null;
      const tasks = rows.map((r) => ({
        task: String(r[lCol]),
        start: r[sCol] as string | number,
        end: r[eCol] as string | number,
        group: groupCol ? String(r[groupCol]) : null,
      }));
      return tasks.length > 0 ? el({ title, tasks }) : null;
    }

    case "vector": {
      const keys = rowKeys(series);
      const key = (re: RegExp) => keys.find((k) => re.test(k));
      if (component === "WindRose") {
        const dir = key(/^(angle|direction)$/i);
        const mag = key(/^(magnitude|value|v)$/i);
        if (!dir || !mag) return null;
        return el({
          title,
          data: dataBinding,
          direction_key: dir,
          bucket_key: null,
          value_key: mag,
        });
      }
      // QuiverChart: u/v components, computed from angle/magnitude when the
      // rows carry polar form (a pure projection).
      const xK = key(/^x$/i);
      const yK = key(/^y$/i);
      if (!xK || !yK) return null;
      const uK = key(/^u$/i);
      const vK = key(/^v$/i);
      if (uK && vK) {
        return el({ title, data: dataBinding, x_key: xK, y_key: yK, u_key: uK, v_key: vK });
      }
      const aK = key(/^angle$/i);
      const mK = key(/^magnitude$/i);
      if (!aK || !mK) return null;
      const data = rows
        .map((r) => {
          const x = num(r[xK]);
          const y = num(r[yK]);
          const a = num(r[aK]);
          const m = num(r[mK]);
          if (x === null || y === null || a === null || m === null) return null;
          const rad = (a * Math.PI) / 180;
          return { x, y, u: m * Math.cos(rad), v: m * Math.sin(rad) };
        })
        .filter((d): d is { x: number; y: number; u: number; v: number } => d !== null);
      return data.length > 0
        ? el({ title, data, x_key: "x", y_key: "y", u_key: "u", v_key: "v" })
        : null;
    }

    case "table": {
      if (component !== "DataTable") return null;
      const columns = rowKeys(series);
      const cellRows = rows.map((r) =>
        columns.map((c) => (r[c] === null || r[c] === undefined ? "" : String(r[c])))
      );
      return cellRows.length > 0 ? el({ columns, rows: cellRows, caption: title }) : null;
    }

    case "axis": {
      switch (component) {
        case "ScatterChart":
          if (ms.length < 2) return null;
          return el({ title, data: dataBinding, x_key: ms[0], y_key: ms[1] });
        case "Scatter3D":
          if (ms.length < 3) return null;
          return el({ title, data: dataBinding, x_key: ms[0], y_key: ms[1], z_key: ms[2] });
        case "TernaryChart":
          if (ms.length < 3) return null;
          return el({ title, data: dataBinding, a_key: ms[0], b_key: ms[1], c_key: ms[2] });
        case "DualAxisChart":
          if (ms.length < 2) return null;
          return el({
            title,
            data: dataBinding,
            x_key: xCol,
            left_series: [{ key: ms[0], label: humanizeId(ms[0]), type: "bar", color: null }],
            right_series: [{ key: ms[1], label: humanizeId(ms[1]), type: "line", color: null }],
          });
        case "ErrorBarChart":
          if (ms.length < 2) return null;
          return el({ title, data: dataBinding, x_key: xCol, y_key: ms[0], error_key: ms[1] });
        case "PopulationPyramid":
          if (ms.length < 2) return null;
          return el({
            title,
            data: dataBinding,
            category_key: xCol,
            left_key: ms[0],
            right_key: ms[1],
            left_label: humanizeId(ms[0]),
            right_label: humanizeId(ms[1]),
          });
        case "SlopeChart":
        case "DumbbellChart": {
          if (ms.length < 2) return null;
          const data = rows
            .map((r) => ({ label: String(r[xCol]), start: num(r[ms[0]]), end: num(r[ms[1]]) }))
            .filter(
              (d): d is { label: string; start: number; end: number } =>
                d.start !== null && d.end !== null
            );
          if (data.length === 0) return null;
          return el({
            title,
            data,
            start_label: humanizeId(ms[0]),
            end_label: humanizeId(ms[1]),
          });
        }
        case "BumpChart": {
          if (!groupCol || ms.length === 0) return null;
          const byGroup = new Map<string, { x: string | number; y: number }[]>();
          for (const r of rows) {
            const y = num(r[ms[0]]);
            if (y === null) continue;
            const g = String(r[groupCol]);
            const list = byGroup.get(g) ?? [];
            byGroup.set(g, list);
            list.push({ x: r[xCol] as string | number, y });
          }
          const data = [...byGroup.entries()].map(([id, pts]) => ({ id, data: pts }));
          return data.length > 0 ? el({ title, data }) : null;
        }
        case "StreamChart": {
          // Wide pivot: one row per x, one column per group value.
          if (!groupCol || ms.length === 0) return null;
          const xOrder: (string | number)[] = [];
          const groups: string[] = [];
          const wide = new Map<string | number, Record<string, unknown>>();
          for (const r of rows) {
            const x = r[xCol] as string | number;
            const g = String(r[groupCol]);
            const y = num(r[ms[0]]);
            if (y === null) continue;
            if (!wide.has(x)) {
              wide.set(x, { [xCol]: x });
              xOrder.push(x);
            }
            if (!groups.includes(g)) groups.push(g);
            wide.get(x)![g] = y;
          }
          // Complete rows only — a hole would render as fabricated zero.
          const data = xOrder
            .map((x) => wide.get(x)!)
            .filter((row) => groups.every((g) => typeof row[g] === "number"));
          return data.length > 0 ? el({ title, data, keys: groups }) : null;
        }
        case "RadarChart":
          if (ms.length === 0) return null;
          return el({ title, data: dataBinding, index_key: xCol, keys: ms });
        case "ParallelCoordinates":
          if (ms.length < 3) return null;
          return el({ title, data: dataBinding, dimensions: ms, group_key: groupCol });
        case "CalendarChart": {
          if (ms.length === 0) return null;
          const data = rows
            .map((r) => ({ day: String(r[xCol]), value: num(r[ms[0]]) }))
            .filter((d): d is { day: string; value: number } => d.value !== null)
            .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.day));
          if (data.length === 0) return null;
          const days = data.map((d) => d.day).sort();
          return el({ title, data, from: days[0], to: days[days.length - 1] });
        }
        case "ParetoChart": {
          if (ms.length === 0) return null;
          const data = rows
            .map((r) => ({ label: String(r[xCol]), value: num(r[ms[0]]) }))
            .filter((d): d is { label: string; value: number } => d.value !== null);
          return data.length > 0 ? el({ title, data }) : null;
        }
        case "Sparkline":
          if (ms.length === 0) return null;
          return el({ title: null, data: dataBinding, value_key: ms[0], label: title });
        case "ControlChart":
          if (ms.length === 0) return null;
          return el({ title, data: dataBinding, value_key: ms[0], x_key: xCol });
        default:
          // BarChart / LineChart / AreaChart: the shared axis contract.
          return el({
            title,
            data: dataBinding,
            x_key: xCol,
            y_keys: ms,
            ...(component === "LineChart" ? { show_dots: false, curve: "monotone" } : {}),
          });
      }
    }
    default:
      return null;
  }
}
