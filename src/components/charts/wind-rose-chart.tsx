"use client";

import type { Data, Layout } from "plotly.js";
import { PlotlyPolarChart } from "./plotly-polar-wrapper";
import { useColorMap, useChartColors, unwrapChartData } from "@/lib/chart-theme";
import { useThemeConfig } from "@/lib/theme-config";
import { useChartExpanded } from "./chart-expand-wrapper";

interface WindRoseProps {
  title?: string | null;
  /**
   * Either LONG rows {direction, bucket, frequency} or WIDE rows
   * {direction, <band1>: freq, <band2>: freq, ...}. Both are accepted.
   */
  data: Record<string, unknown>[];
  /** Compass direction column — degrees (0–360) or labels like N/NE/E. */
  direction_key: string;
  /** LONG only: magnitude-bucket column (e.g. speed band). */
  bucket_key?: string | null;
  /** LONG only: frequency / count column (the petal length). */
  value_key?: string | null;
  color_map?: Record<string, string> | null;
  height?: number | null;
}

const COMPASS: Record<string, number> = {
  N: 0,
  NNE: 22.5,
  NE: 45,
  ENE: 67.5,
  E: 90,
  ESE: 112.5,
  SE: 135,
  SSE: 157.5,
  S: 180,
  SSW: 202.5,
  SW: 225,
  WSW: 247.5,
  W: 270,
  WNW: 292.5,
  NW: 315,
  NNW: 337.5,
};

function toTheta(v: unknown): number | null {
  if (typeof v === "number") return ((v % 360) + 360) % 360;
  if (typeof v === "string") {
    const up = v.trim().toUpperCase();
    if (up in COMPASS) return COMPASS[up];
    const n = Number(v);
    return Number.isFinite(n) ? ((n % 360) + 360) % 360 : null;
  }
  return null;
}

const isNumericLike = (v: unknown): boolean => v != null && v !== "" && Number.isFinite(Number(v));

/**
 * Resolve the direction column robustly: the declared key if present, else a
 * directionally-named column, else the column whose values mostly parse as
 * compass/degrees. The LLM sometimes mis-declares direction_key, so we don't
 * trust it blindly.
 */
function pickDirectionColumn(
  rows: Record<string, unknown>[],
  declared?: string | null
): string | null {
  const keys = Object.keys(rows[0] ?? {});
  if (keys.length === 0) return null;
  if (declared && keys.includes(declared)) return declared;
  const byName =
    keys.find((k) => /^(direction|dir|bearing|heading|azimuth)$/i.test(k)) ??
    keys.find((k) => /(direction|bearing|heading|azimuth|wind.?dir)/i.test(k));
  if (byName) return byName;
  for (const k of keys) {
    const vals = rows.map((r) => r[k]);
    const ok = vals.filter((v) => toTheta(v) != null).length;
    if (ok / vals.length > 0.6) return k;
  }
  return keys[0];
}

export interface WindRoseSeries {
  buckets: string[];
  /** Per bucket: parallel theta (degrees) and radial (summed frequency) arrays. */
  petals: { theta: number[]; radial: number[] }[];
  /** Total number of (direction × bucket) cells plotted. */
  plotted: number;
}

/**
 * Aggregate wind-rose data into stacked petals, tolerant of how the LLM shapes
 * it: long ({direction, bucket, frequency}) or wide ({direction, band1, band2,
 * ...}), with the direction column auto-detected when direction_key is wrong.
 */
export function buildWindRoseSeries(
  rows: Record<string, unknown>[],
  opts: { direction_key?: string | null; bucket_key?: string | null; value_key?: string | null }
): WindRoseSeries {
  if (rows.length === 0) return { buckets: [], petals: [], plotted: 0 };

  const dirCol = pickDirectionColumn(rows, opts.direction_key);
  const allKeys = Object.keys(rows[0]);
  const hasLong =
    !!opts.bucket_key &&
    !!opts.value_key &&
    allKeys.includes(opts.bucket_key) &&
    allKeys.includes(opts.value_key);

  // bucketLabel -> (theta -> summed frequency)
  const series = new Map<string, Map<number, number>>();
  const add = (bucket: string, theta: number, value: number) => {
    let m = series.get(bucket);
    if (!m) series.set(bucket, (m = new Map()));
    m.set(theta, (m.get(theta) ?? 0) + value);
  };

  if (dirCol) {
    if (hasLong) {
      for (const r of rows) {
        const t = toTheta(r[dirCol]);
        if (t == null) continue;
        add(String(r[opts.bucket_key!] ?? "—"), t, Number(r[opts.value_key!]) || 0);
      }
    } else {
      // WIDE: every numeric column other than the direction column is a band.
      // Exclude an obvious degrees-mirror column so it isn't treated as a band.
      const bandCols = allKeys.filter(
        (k) => k !== dirCol && !/_deg$|degrees?$/i.test(k) && rows.some((r) => isNumericLike(r[k]))
      );
      for (const r of rows) {
        const t = toTheta(r[dirCol]);
        if (t == null) continue;
        for (const b of bandCols) add(b, t, Number(r[b]) || 0);
      }
    }
  }

  const buckets = Array.from(series.keys());
  let plotted = 0;
  const petals = buckets.map((b) => {
    const m = series.get(b)!;
    const theta = Array.from(m.keys());
    const radial = theta.map((t) => m.get(t)!);
    plotted += theta.length;
    return { theta, radial };
  });
  return { buckets, petals, plotted };
}

export function WindRoseComponent({ props }: { props: WindRoseProps }) {
  const { chart } = useThemeConfig();
  const isExpanded = useChartExpanded();
  const palette = useChartColors();
  const rows = unwrapChartData(props.data);

  const { buckets, petals, plotted } = buildWindRoseSeries(rows, props);
  const colors = useColorMap(buckets, props.color_map);

  const traces: Data[] = buckets.map((b, i) => ({
    type: "barpolar" as const,
    r: petals[i].radial,
    theta: petals[i].theta,
    name: b === "—" ? "Frequency" : b,
    marker: { color: colors[i] ?? palette[i % palette.length] },
  })) as Data[];

  // Visible empty-state: distinguishes "no/mismatched data" from a render
  // failure so a blank cell is never ambiguous.
  if (plotted === 0) {
    return (
      <div
        className="flex items-center justify-center text-t-tertiary"
        style={{ height: chart.height, fontSize: 13 }}
      >
        No directional data to plot — need a direction column (degrees or compass) plus frequency
        values.
      </div>
    );
  }

  const layout: Partial<Layout> = {
    barmode: "stack",
    polar: {
      // Compass orientation: 0° at top (North), going clockwise.
      angularaxis: { direction: "clockwise", rotation: 90 },
      radialaxis: { ticksuffix: "", angle: 45 },
    },
    showlegend: buckets.length > 1,
    legend: { orientation: "v" },
  } as Partial<Layout>;

  const chartHeight = props.height ?? chart.height;

  return (
    <div className={`w-full${isExpanded ? " h-full flex flex-col" : ""}`}>
      {props.title && (
        <h3
          className="mb-2 text-t-secondary"
          style={{ fontSize: "var(--chart-title-size)", fontWeight: "var(--chart-title-weight)" }}
        >
          {props.title}
        </h3>
      )}
      <div className={isExpanded ? "flex-1" : ""}>
        <PlotlyPolarChart
          data={traces}
          layout={layout}
          height={isExpanded ? undefined : chartHeight}
        />
      </div>
    </div>
  );
}
