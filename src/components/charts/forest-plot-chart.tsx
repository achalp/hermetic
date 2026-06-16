"use client";

import type { Data, Layout } from "plotly.js";
import { PlotlyChart } from "./plotly-wrapper";
import { useChartColors, unwrapChartData } from "@/lib/chart-theme";
import { useThemeConfig } from "@/lib/theme-config";
import { useChartExpanded } from "./chart-expand-wrapper";

interface ForestRow {
  label: string;
  estimate: number;
  lower: number;
  upper: number;
}

interface ForestPlotProps {
  title?: string | null;
  data: ForestRow[];
  /** Vertical reference line (e.g. 0 for differences, 1 for ratios). null hides it. */
  reference_value?: number | null;
  x_label?: string | null;
  /** Log x-axis — common for odds/hazard/risk ratios. */
  x_log?: boolean | null;
  color?: string | null;
  height?: number | null;
}

export function ForestPlotComponent({ props }: { props: ForestPlotProps }) {
  const { chart } = useThemeConfig();
  const isExpanded = useChartExpanded();
  const palette = useChartColors();
  const rows = unwrapChartData(props.data) as unknown as ForestRow[];

  const items = (Array.isArray(rows) ? rows : []).filter(
    (r) => r && r.label != null && Number.isFinite(Number(r.estimate))
  );
  if (items.length === 0) return <div style={{ height: chart.height }} />;

  const color = props.color ?? palette[0];
  // Reverse so the first row appears at the top.
  const ordered = [...items].reverse();
  const labels = ordered.map((r) => String(r.label));
  const estimates = ordered.map((r) => Number(r.estimate));

  const trace: Data = {
    type: "scatter" as const,
    mode: "markers" as const,
    x: estimates,
    y: labels,
    marker: { color, size: 9, symbol: "diamond" },
    error_x: {
      type: "data" as const,
      symmetric: false,
      array: ordered.map((r) => Math.max(0, Number(r.upper) - Number(r.estimate))),
      arrayminus: ordered.map((r) => Math.max(0, Number(r.estimate) - Number(r.lower))),
      color,
      thickness: 1.5,
      width: 5,
    },
    name: "Estimate",
  };

  const refValue = props.reference_value;
  const layout: Partial<Layout> = {
    xaxis: {
      title: props.x_label ? { text: props.x_label } : undefined,
      type: props.x_log ? "log" : "linear",
    },
    yaxis: { automargin: true },
    showlegend: false,
    margin: { l: 140, r: 24, t: 10, b: 40 },
    shapes:
      refValue != null
        ? [
            {
              type: "line",
              yref: "paper",
              y0: 0,
              y1: 1,
              xref: "x",
              x0: refValue,
              x1: refValue,
              line: { color: "#9ca3af", width: 1, dash: "dash" },
            },
          ]
        : undefined,
  };

  const chartHeight = props.height ?? Math.max(chart.height, 60 + items.length * 28);

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
        <PlotlyChart data={[trace]} layout={layout} height={isExpanded ? undefined : chartHeight} />
      </div>
    </div>
  );
}
