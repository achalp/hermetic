"use client";

import type { Data, Layout } from "plotly.js";
import { PlotlyChart } from "./plotly-wrapper";
import { useColorMap } from "@/lib/chart-theme";
import { useThemeConfig } from "@/lib/theme-config";

interface SlopeChartProps {
  title: string | null;
  data: { label: string; start: number; end: number }[];
  start_label: string | null;
  end_label: string | null;
  color_map: Record<string, string> | null;
}

export function SlopeChartComponent({ props }: { props: SlopeChartProps }) {
  const { chart } = useThemeConfig();
  const data = Array.isArray(props.data) ? props.data : [];
  const labels = data.map((d) => d.label);
  const colors = useColorMap(labels, props.color_map);

  if (data.length === 0) return <div style={{ height: chart.height }} />;

  const startLabel = props.start_label ?? "Start";
  const endLabel = props.end_label ?? "End";

  const traces: Data[] = data.map((d, i) => ({
    type: "scatter" as const,
    x: [startLabel, endLabel],
    y: [d.start, d.end],
    mode: "text+lines+markers" as const,
    name: d.label,
    text: [d.label, d.label],
    textposition: "middle right" as const,
    line: { color: colors[i], width: 2 },
    marker: { color: colors[i], size: 8 },
  }));

  const layout: Partial<Layout> = {
    showlegend: false,
    xaxis: {
      fixedrange: true,
      type: "category" as const,
    },
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
