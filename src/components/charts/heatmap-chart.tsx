"use client";

import type { Data, Layout } from "plotly.js";
import { PlotlyChart } from "./plotly-wrapper";
import { useThemeConfig } from "@/lib/theme-config";
import { useChartExpanded } from "./chart-expand-wrapper";

interface HeatMapChartProps {
  title?: string | null;
  z: number[][];
  x_labels: string[];
  y_labels: string[];
  color_scale?: string | null;
  show_values?: boolean | null;
  z_min?: number | null;
  z_max?: number | null;
}

export function HeatMapChartComponent({ props }: { props: HeatMapChartProps }) {
  const { chart } = useThemeConfig();
  const isExpanded = useChartExpanded();
  if (!props.z || props.z.length === 0 || !props.x_labels || !props.y_labels)
    return <div style={{ height: chart.height }} />;

  // Truncate long y-labels in inline mode to give more space to the heatmap
  const MAX_Y_LABEL_LEN = isExpanded ? 80 : 30;
  const displayYLabels = props.y_labels.map((l) =>
    l.length > MAX_Y_LABEL_LEN ? l.slice(0, MAX_Y_LABEL_LEN - 1) + "\u2026" : l
  );

  // Similarly for x-labels
  const MAX_X_LABEL_LEN = isExpanded ? 60 : 20;
  const displayXLabels = props.x_labels.map((l) =>
    l.length > MAX_X_LABEL_LEN ? l.slice(0, MAX_X_LABEL_LEN - 1) + "\u2026" : l
  );

  // Compute left margin based on longest visible y-label
  const maxYLen = Math.max(...displayYLabels.map((l) => l.length));
  const leftMargin = Math.min(isExpanded ? 500 : 300, Math.max(80, maxYLen * 7 + 16));

  const traces: Data[] = [
    {
      type: "heatmap" as const,
      z: props.z,
      x: displayXLabels,
      y: displayYLabels,
      // Show full labels on hover
      customdata: props.y_labels.map((y, i) => props.x_labels.map((x) => `${y} / ${x}`)),
      hovertemplate: "%{customdata}<br>Value: %{z}<extra></extra>",
      colorscale: (props.color_scale as Plotly.ColorScale) ?? "RdBu",
      zmin: props.z_min ?? undefined,
      zmax: props.z_max ?? undefined,
      hoverongaps: false,
    },
  ];

  const annotations: Partial<Layout>["annotations"] = [];
  if (props.show_values) {
    for (let i = 0; i < displayYLabels.length; i++) {
      for (let j = 0; j < displayXLabels.length; j++) {
        const val = props.z[i]?.[j];
        if (val != null) {
          annotations.push({
            x: displayXLabels[j],
            y: displayYLabels[i],
            text: typeof val === "number" ? val.toFixed(2) : String(val),
            showarrow: false,
            font: { size: 10 },
          });
        }
      }
    }
  }

  const layout: Partial<Layout> = {
    margin: { l: leftMargin, r: 80, t: 10, b: isExpanded ? 120 : 80 },
    annotations: annotations.length > 0 ? annotations : undefined,
  };

  return (
    <div className={`w-full min-w-0${isExpanded ? " h-full flex flex-col" : ""}`}>
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
