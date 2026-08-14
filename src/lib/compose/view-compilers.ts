/**
 * Family-level VIEW props compilers (compiled-view-parity spec §3).
 *
 * A VIEW plan node is the planner's REQUEST for a component; everything
 * about the element itself is compiled HERE, deterministically, from the
 * declared series' roles or the referenced claim's value — the planner
 * never authors props. Series-fed views bind their rows via the same
 * `$chartData:` channel the derived views use; claim-fed views inline
 * values computed host-side from the declared claim (the same trust level
 * as headline tiles and realizer sentences).
 *
 * Compilers are per-FAMILY (~12, not 84 — spec review R2): components in a
 * family genuinely share a data contract. P1 implements axis,
 * distribution, geo, and claim-fed composition; the P1_COMPILABLE set
 * below is what validatePlan accepts — a licensed-but-not-yet-compilable
 * component rejects with a message naming the alternatives, and the tail
 * lights up as P2/P3 land series kinds and the remaining families.
 */
import type { FindingEntry } from "@/lib/contracts/findings";
import type { PlanNode } from "@/lib/contracts/plan";
import type { SeriesEntry } from "@/lib/contracts/product";
import { COMPONENT_ROLE_SIGNATURES } from "@/lib/product/signatures";
import { humanizeId, type SpecPatchLine } from "./scaffold";

/** Components the P1 family compilers can build. Kept next to the
 *  compilers so "licensed" and "compilable" cannot drift silently — the
 *  signatures closure test asserts this set ⊆ the registry. */
export const P1_COMPILABLE = new Set([
  // axis
  "BarChart",
  "LineChart",
  "AreaChart",
  "ScatterChart",
  "DualAxisChart",
  "ParetoChart",
  "Sparkline",
  "ControlChart",
  // distribution
  "Histogram",
  "BoxPlot",
  "ViolinChart",
  "BeeswarmChart",
  "ECDFChart",
  "QQPlot",
  // geo
  "MapView",
  "Map3D",
  // composition (claim-fed)
  "PieChart",
  "TreemapChart",
  "FunnelChart",
  "WaterfallChart",
]);

const fv = (f: FindingEntry): Record<string, unknown> =>
  f.value !== null && typeof f.value === "object" && !Array.isArray(f.value)
    ? (f.value as Record<string, unknown>)
    : {};

function measureCols(s: SeriesEntry): string[] {
  return s.roles.measures.map((m) => m.column);
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

/**
 * Compile one VIEW node to its spec element. Assumes the node passed
 * validatePlan (component compilable, series/claim licensed); returns null
 * defensively when the inputs it was validated against are gone.
 */
export function compileViewNode(
  node: PlanNode,
  series: SeriesEntry | undefined,
  byName: Map<string, FindingEntry>
): SpecPatchLine | null {
  const component = node.component;
  if (!component || !P1_COMPILABLE.has(component)) return null;
  const sig = COMPONENT_ROLE_SIGNATURES[component];
  const title = node.text?.trim() || (series ? humanizeId(series.id) : humanizeId(node.id));
  const el = (props: Record<string, unknown>): SpecPatchLine => ({
    op: "add",
    path: `/elements/${node.id}`,
    value: { type: component, props, children: [] },
  });

  if (sig.feeds === "claim") {
    const claim = node.refs.map((r) => byName.get(r)).find((f) => f !== undefined);
    if (!claim) return null;
    if (component === "WaterfallChart") {
      const data = waterfallRows(claim);
      return data.length > 0 ? el({ title, data }) : null;
    }
    const data = shareRows(claim);
    if (data.length === 0) return null;
    if (component === "TreemapChart") {
      return el({
        title,
        data: { name: title, children: data.map((r) => ({ name: r.label, value: r.value })) },
      });
    }
    // PieChart / FunnelChart share the {label, value} row contract.
    return el({ title, data });
  }

  if (!series) return null;
  const dataBinding = `$chartData:${series.id}`;
  const ms = measureCols(series);
  const groupCol = series.roles.group?.column ?? null;

  switch (sig.family) {
    case "geo": {
      if (component === "Map3D") {
        const first = (series.rows[0] ?? {}) as Record<string, unknown>;
        const keys = Object.keys(first);
        const latKey = keys.find((k) => /^lat(itude)?$/i.test(k)) ?? "lat";
        const lngKey = keys.find((k) => /^(lng|lon|longitude)$/i.test(k)) ?? "lng";
        return el({
          title,
          data: dataBinding,
          lat_key: latKey,
          lng_key: lngKey,
          layer_type: "scatterplot",
        });
      }
      // MapView normalizes lat/lng aliases itself.
      return el({ title, markers: dataBinding });
    }
    case "distribution": {
      if (ms.length === 0) return null;
      return el({ title, data: dataBinding, value_key: ms[0], group_key: groupCol });
    }
    case "axis": {
      switch (component) {
        case "ScatterChart":
          if (ms.length < 2) return null;
          return el({ title, data: dataBinding, x_key: ms[0], y_key: ms[1] });
        case "DualAxisChart":
          if (ms.length < 2) return null;
          return el({
            title,
            data: dataBinding,
            x_key: series.roles.x.column,
            left_series: [{ key: ms[0], label: humanizeId(ms[0]), type: "bar", color: null }],
            right_series: [{ key: ms[1], label: humanizeId(ms[1]), type: "line", color: null }],
          });
        case "ParetoChart": {
          // Pareto's contract pins label/value keys — project the declared
          // rows (a pure projection, same trust as every derived view).
          const xCol = series.roles.x.column;
          const data = series.rows
            .map((r) => {
              const row = r as Record<string, unknown>;
              return { label: String(row[xCol]), value: row[ms[0]] };
            })
            .filter((r): r is { label: string; value: number } => typeof r.value === "number");
          return data.length > 0 ? el({ title, data }) : null;
        }
        case "Sparkline":
          if (ms.length === 0) return null;
          return el({ title: null, data: dataBinding, value_key: ms[0], label: title });
        case "ControlChart":
          if (ms.length === 0) return null;
          return el({
            title,
            data: dataBinding,
            value_key: ms[0],
            x_key: series.roles.x.column,
          });
        default:
          // BarChart / LineChart / AreaChart: the shared axis contract.
          return el({
            title,
            data: dataBinding,
            x_key: series.roles.x.column,
            y_keys: ms,
            ...(component === "LineChart" ? { show_dots: false, curve: "monotone" } : {}),
          });
      }
    }
    default:
      return null;
  }
}
