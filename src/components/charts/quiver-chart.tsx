"use client";

import type { Data, Layout } from "plotly.js";
import { PlotlyChart } from "./plotly-wrapper";
import { useChartColors, unwrapChartData } from "@/lib/chart-theme";
import { useThemeConfig } from "@/lib/theme-config";
import { useChartExpanded } from "./chart-expand-wrapper";

interface QuiverChartProps {
  title?: string | null;
  /** Rows of {x, y, u, v}: position and vector components. */
  data: Record<string, unknown>[];
  x_key: string;
  y_key: string;
  u_key: string;
  v_key: string;
  /** Multiplier on vector length (default 1). */
  scale?: number | null;
  x_label?: string | null;
  y_label?: string | null;
  color?: string | null;
  height?: number | null;
}

export function QuiverChartComponent({ props }: { props: QuiverChartProps }) {
  const { chart } = useThemeConfig();
  const isExpanded = useChartExpanded();
  const palette = useChartColors();
  const rows = unwrapChartData(props.data);

  const vecs = rows
    .map((r) => ({
      x: Number(r[props.x_key]),
      y: Number(r[props.y_key]),
      u: Number(r[props.u_key]),
      v: Number(r[props.v_key]),
    }))
    .filter((p) => [p.x, p.y, p.u, p.v].every(Number.isFinite));

  if (vecs.length === 0) return <div style={{ height: chart.height }} />;

  const scale = props.scale ?? 1;
  const color = props.color ?? palette[0];

  // Line segments (null-gap between vectors) plus oriented arrowhead markers.
  const sx: (number | null)[] = [];
  const sy: (number | null)[] = [];
  const tipX: number[] = [];
  const tipY: number[] = [];
  const angles: number[] = [];
  for (const p of vecs) {
    const ex = p.x + p.u * scale;
    const ey = p.y + p.v * scale;
    sx.push(p.x, ex, null);
    sy.push(p.y, ey, null);
    tipX.push(ex);
    tipY.push(ey);
    // Plotly marker.angle is clockwise from "up"; vector angle is CCW from +x.
    angles.push(90 - (Math.atan2(p.v, p.u) * 180) / Math.PI);
  }

  const traces: Data[] = [
    {
      type: "scatter" as const,
      mode: "lines" as const,
      x: sx,
      y: sy,
      line: { color, width: 1.2 },
      hoverinfo: "skip" as const,
      showlegend: false,
    },
    {
      type: "scatter" as const,
      mode: "markers" as const,
      x: tipX,
      y: tipY,
      marker: { color, size: 8, symbol: "triangle-up", angle: angles },
      hoverinfo: "skip" as const,
      showlegend: false,
    } as Data,
  ];

  const layout: Partial<Layout> = {
    xaxis: { title: props.x_label ? { text: props.x_label } : undefined, zeroline: false },
    yaxis: {
      title: props.y_label ? { text: props.y_label } : undefined,
      zeroline: false,
      scaleanchor: "x",
    },
    showlegend: false,
  };

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
        <PlotlyChart data={traces} layout={layout} height={isExpanded ? undefined : chartHeight} />
      </div>
    </div>
  );
}
