"use client";

import type { Data, Layout } from "plotly.js";
import { PlotlyChart } from "./plotly-wrapper";
import { useChartColors, unwrapChartData } from "@/lib/chart-theme";
import { useThemeConfig } from "@/lib/theme-config";
import { useChartExpanded } from "./chart-expand-wrapper";
import { ChartEmptyState } from "./chart-empty-state";

interface ParetoChartProps {
  title?: string | null;
  data: { label: string; value: number }[];
  /** Draw a horizontal reference line at this cumulative % (default 80). null hides it. */
  threshold_percent?: number | null;
  bar_color?: string | null;
  line_color?: string | null;
  height?: number | null;
}

export function ParetoChartComponent({ props }: { props: ParetoChartProps }) {
  const { chart } = useThemeConfig();
  const isExpanded = useChartExpanded();
  const palette = useChartColors();
  const rows = unwrapChartData(props.data) as unknown as { label: string; value: number }[];

  const items = (Array.isArray(rows) ? rows : [])
    .filter((r) => r && r.label != null)
    .map((r) => ({ label: String(r.label), value: Math.max(0, Number(r.value) || 0) }))
    .sort((a, b) => b.value - a.value);

  if (items.length === 0) return <ChartEmptyState height={chart.height} />;

  const total = items.reduce((s, r) => s + r.value, 0) || 1;
  let running = 0;
  const cumulative = items.map((r) => {
    running += r.value;
    return (running / total) * 100;
  });

  const barColor = props.bar_color ?? palette[0];
  const lineColor = props.line_color ?? palette[1] ?? "#dc2626";
  const labels = items.map((r) => r.label);

  const traces: Data[] = [
    {
      type: "bar" as const,
      x: labels,
      y: items.map((r) => r.value),
      name: "Value",
      marker: { color: barColor },
    },
    {
      type: "scatter" as const,
      mode: "lines+markers" as const,
      x: labels,
      y: cumulative,
      name: "Cumulative %",
      yaxis: "y2",
      line: { color: lineColor, width: 2 },
      marker: { color: lineColor, size: 6 },
    },
  ];

  const threshold = props.threshold_percent === undefined ? 80 : props.threshold_percent;
  const layout: Partial<Layout> = {
    yaxis: { title: { text: "Value" } },
    yaxis2: {
      title: { text: "Cumulative %" },
      overlaying: "y",
      side: "right",
      range: [0, 105],
      showgrid: false,
    },
    showlegend: true,
    legend: { orientation: "h", y: -0.2 },
    shapes:
      threshold != null
        ? [
            {
              type: "line",
              xref: "paper",
              x0: 0,
              x1: 1,
              yref: "y2",
              y0: threshold,
              y1: threshold,
              line: { color: "#9ca3af", width: 1, dash: "dash" },
            },
          ]
        : undefined,
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
