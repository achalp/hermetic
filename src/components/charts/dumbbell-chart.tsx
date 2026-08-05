"use client";

import type { Data, Layout } from "plotly.js";
import { PlotlyChart } from "./plotly-wrapper";
import { resolveColor, unwrapChartData } from "@/components/theme/chart-theme";
import { useThemeConfig } from "@/components/theme/theme-config";
import { useChartExpanded } from "./chart-expand-wrapper";
import { ChartEmptyState } from "./chart-empty-state";

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
  const isExpanded = useChartExpanded();
  const data = unwrapChartData(props.data) as unknown as DumbbellChartProps["data"];

  if (data.length === 0) return <ChartEmptyState height={chart.height} />;

  const isHorizontal = props.orientation !== "vertical";
  const sColor = resolveColor(props.start_color ?? "#6366f1");
  const eColor = resolveColor(props.end_color ?? "#f43f5e");

  // Build a single connecting-lines trace using null separators so Plotly
  // sees all category labels in one trace and builds a unified axis.
  const lineX: (number | string | null)[] = [];
  const lineY: (number | string | null)[] = [];
  for (const d of data) {
    if (lineX.length > 0) {
      lineX.push(null);
      lineY.push(null);
    }
    if (isHorizontal) {
      lineX.push(d.start, d.end);
      lineY.push(d.label, d.label);
    } else {
      lineX.push(d.label, d.label);
      lineY.push(d.start, d.end);
    }
  }

  const traces: Data[] = [
    // Connecting lines (single trace)
    {
      type: "scatter" as const,
      x: lineX,
      y: lineY,
      mode: "lines" as const,
      line: { color: "#9ca3af", width: 2 },
      showlegend: false,
      hoverinfo: "skip" as const,
      connectgaps: false,
    } as Data,
    // Start dots
    {
      type: "scatter" as const,
      x: isHorizontal ? data.map((d) => d.start) : data.map((d) => d.label),
      y: isHorizontal ? data.map((d) => d.label) : data.map((d) => d.start),
      mode: "markers" as const,
      name: props.start_label ?? "Start",
      marker: { color: sColor, size: 12 },
    },
    // End dots
    {
      type: "scatter" as const,
      x: isHorizontal ? data.map((d) => d.end) : data.map((d) => d.label),
      y: isHorizontal ? data.map((d) => d.label) : data.map((d) => d.end),
      mode: "markers" as const,
      name: props.end_label ?? "End",
      marker: { color: eColor, size: 12 },
    },
  ];

  const layout: Partial<Layout> = {
    showlegend: true,
  };

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
        <PlotlyChart data={traces} layout={layout} height={isExpanded ? undefined : chart.height} />
      </div>
    </div>
  );
}
