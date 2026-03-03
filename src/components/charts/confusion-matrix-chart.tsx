"use client";

import type { Data, Layout } from "plotly.js";
import { PlotlyChart } from "./plotly-wrapper";
import { useThemeConfig } from "@/lib/theme-config";

interface ConfusionMatrixProps {
  title: string | null;
  matrix: number[][];
  labels: string[];
  color_scale: string | null;
  normalize: boolean | null;
}

export function ConfusionMatrixComponent({ props }: { props: ConfusionMatrixProps }) {
  const { chart } = useThemeConfig();

  if (!props.matrix || props.matrix.length === 0 || !props.labels || props.labels.length === 0) {
    return <div style={{ height: chart.height }} />;
  }

  let z = props.matrix;
  if (props.normalize) {
    z = props.matrix.map((row) => {
      const sum = row.reduce((a, b) => a + b, 0);
      return sum > 0 ? row.map((v) => v / sum) : row;
    });
  }

  // Reverse for Plotly heatmap (y-axis goes bottom-to-top)
  const reversedZ = [...z].reverse();
  const reversedLabels = [...props.labels].reverse();

  const annotations: Partial<Layout>["annotations"] = [];
  for (let i = 0; i < reversedLabels.length; i++) {
    for (let j = 0; j < props.labels.length; j++) {
      const val = reversedZ[i]?.[j];
      if (val != null) {
        annotations.push({
          x: props.labels[j],
          y: reversedLabels[i],
          text: props.normalize ? (val * 100).toFixed(1) + "%" : String(val),
          showarrow: false,
          font: { size: 12 },
        });
      }
    }
  }

  const traces: Data[] = [
    {
      type: "heatmap" as const,
      z: reversedZ,
      x: props.labels,
      y: reversedLabels,
      colorscale: (props.color_scale as Plotly.ColorScale) ?? "Blues",
      showscale: true,
      hoverongaps: false,
    },
  ];

  const layout: Partial<Layout> = {
    annotations,
    xaxis: { title: { text: "Predicted" }, side: "bottom" as const },
    yaxis: { title: { text: "Actual" } },
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
