"use client";

import type { Data, Layout } from "plotly.js";
import { PlotlyChart } from "./plotly-wrapper";
import { resolveColor } from "@/lib/chart-theme";
import { useThemeConfig } from "@/lib/theme-config";

interface DumbbellChartProps {
  title: string | null;
  data: { label: string; start: number; end: number }[];
  start_label: string | null;
  end_label: string | null;
  start_color: string | null;
  end_color: string | null;
  orientation: "vertical" | "horizontal" | null;
}

export function DumbbellChartComponent({ props }: { props: DumbbellChartProps }) {
  const { chart } = useThemeConfig();
  const data = Array.isArray(props.data) ? props.data : [];

  if (data.length === 0) return <div style={{ height: chart.height }} />;

  const isHorizontal = props.orientation !== "vertical";
  const sColor = resolveColor(props.start_color ?? "#6366f1");
  const eColor = resolveColor(props.end_color ?? "#f43f5e");

  const traces: Data[] = [];

  // Connecting lines
  for (const d of data) {
    traces.push({
      type: "scatter" as const,
      x: isHorizontal ? [d.start, d.end] : [d.label, d.label],
      y: isHorizontal ? [d.label, d.label] : [d.start, d.end],
      mode: "lines" as const,
      line: { color: "#9ca3af", width: 2 },
      showlegend: false,
      hoverinfo: "skip" as const,
    });
  }

  // Start dots
  traces.push({
    type: "scatter" as const,
    x: isHorizontal ? data.map((d) => d.start) : data.map((d) => d.label),
    y: isHorizontal ? data.map((d) => d.label) : data.map((d) => d.start),
    mode: "markers" as const,
    name: props.start_label ?? "Start",
    marker: { color: sColor, size: 12 },
  });

  // End dots
  traces.push({
    type: "scatter" as const,
    x: isHorizontal ? data.map((d) => d.end) : data.map((d) => d.label),
    y: isHorizontal ? data.map((d) => d.label) : data.map((d) => d.end),
    mode: "markers" as const,
    name: props.end_label ?? "End",
    marker: { color: eColor, size: 12 },
  });

  const layout: Partial<Layout> = {
    showlegend: true,
  };

  return (
    <div className="w-full">
      {props.title && (
        <h3
          className="mb-2 text-t-secondary"
          style={{ fontSize: "var(--chart-title-size)", fontWeight: "var(--chart-title-weight)" }}
        >
          {props.title}
        </h3>
      )}
      <PlotlyChart data={traces} layout={layout} height={chart.height} />
    </div>
  );
}
