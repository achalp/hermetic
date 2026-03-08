"use client";

import type { Data, Layout } from "plotly.js";
import { PlotlyChart } from "./plotly-wrapper";
import { useThemeConfig } from "@/lib/theme-config";

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
  if (!props.z || props.z.length === 0 || !props.x_labels || !props.y_labels)
    return <div style={{ height: chart.height }} />;

  const traces: Data[] = [
    {
      type: "heatmap" as const,
      z: props.z,
      x: props.x_labels,
      y: props.y_labels,
      colorscale: (props.color_scale as Plotly.ColorScale) ?? "RdBu",
      zmin: props.z_min ?? undefined,
      zmax: props.z_max ?? undefined,
      hoverongaps: false,
    },
  ];

  const annotations: Partial<Layout>["annotations"] = [];
  if (props.show_values) {
    for (let i = 0; i < props.y_labels.length; i++) {
      for (let j = 0; j < props.x_labels.length; j++) {
        const val = props.z[i]?.[j];
        if (val != null) {
          annotations.push({
            x: props.x_labels[j],
            y: props.y_labels[i],
            text: typeof val === "number" ? val.toFixed(2) : String(val),
            showarrow: false,
            font: { size: 10 },
          });
        }
      }
    }
  }

  const layout: Partial<Layout> = {
    annotations: annotations.length > 0 ? annotations : undefined,
  };

  return (
    <div className="w-full min-w-0">
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
