"use client";

import type { Data, Layout } from "plotly.js";
import { PlotlyPolarChart } from "./plotly-polar-wrapper";
import { useColorMap, useChartColors, unwrapChartData } from "@/lib/chart-theme";
import { useThemeConfig } from "@/lib/theme-config";
import { useChartExpanded } from "./chart-expand-wrapper";

interface WindRoseProps {
  title?: string | null;
  /** Rows of {direction, bucket, frequency}: a frequency per direction × magnitude bucket. */
  data: Record<string, unknown>[];
  /** Compass direction column — degrees (0–360) or labels like N/NE/E. */
  direction_key: string;
  /** Magnitude-bucket column (e.g. speed band); each becomes a stacked colour. */
  bucket_key: string;
  /** Frequency / count column (the petal length). */
  value_key: string;
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

export function WindRoseComponent({ props }: { props: WindRoseProps }) {
  const { chart } = useThemeConfig();
  const isExpanded = useChartExpanded();
  const palette = useChartColors();
  const rows = unwrapChartData(props.data);

  const buckets = Array.from(new Set(rows.map((r) => String(r[props.bucket_key] ?? "—"))));
  const colors = useColorMap(buckets, props.color_map);

  // One stacked barpolar trace per magnitude bucket.
  let plotted = 0;
  const traces: Data[] = buckets.map((b, i) => {
    const br = rows.filter((r) => String(r[props.bucket_key] ?? "—") === b);
    const theta: number[] = [];
    const radial: number[] = [];
    for (const r of br) {
      const t = toTheta(r[props.direction_key]);
      if (t == null) continue;
      theta.push(t);
      radial.push(Number(r[props.value_key]) || 0);
      plotted++;
    }
    return {
      type: "barpolar" as const,
      r: radial,
      theta,
      name: b === "—" ? "Frequency" : b,
      marker: { color: colors[i] ?? palette[i % palette.length] },
    } as Data;
  });

  // Visible empty-state: distinguishes "no/mismatched data" from a render
  // failure so a blank cell is never ambiguous.
  if (plotted === 0) {
    return (
      <div
        className="flex items-center justify-center text-t-tertiary"
        style={{ height: chart.height, fontSize: 13 }}
      >
        No directional data to plot — expected columns:{" "}
        <code className="mx-1">{props.direction_key}</code>,
        <code className="mx-1">{props.bucket_key}</code>,
        <code className="mx-1">{props.value_key}</code>.
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
