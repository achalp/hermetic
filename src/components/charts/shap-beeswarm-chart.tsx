"use client";

import type { Data, Layout } from "plotly.js";
import { PlotlyChart } from "./plotly-wrapper";
import { useThemeConfig } from "@/lib/theme-config";

interface ShapBeeswarmProps {
  title: string | null;
  data: { feature: string; shap_value: number; feature_value: number }[];
  color_scale: string | null;
  marker_size: number | null;
}

export function ShapBeeswarmComponent({ props }: { props: ShapBeeswarmProps }) {
  const { chart } = useThemeConfig();
  const data = Array.isArray(props.data) ? props.data : [];

  if (data.length === 0) return <div style={{ height: chart.height }} />;

  // Group by feature and sort by mean absolute SHAP value
  const featureMap = new Map<string, { shap: number[]; feat: number[] }>();
  for (const d of data) {
    if (!featureMap.has(d.feature)) featureMap.set(d.feature, { shap: [], feat: [] });
    const entry = featureMap.get(d.feature)!;
    entry.shap.push(d.shap_value);
    entry.feat.push(d.feature_value);
  }

  const sortedFeatures = [...featureMap.entries()]
    .sort(
      (a, b) =>
        a[1].shap.reduce((s, v) => s + Math.abs(v), 0) / a[1].shap.length -
        b[1].shap.reduce((s, v) => s + Math.abs(v), 0) / b[1].shap.length
    )
    .map(([name]) => name);

  const featureIndexMap = new Map(sortedFeatures.map((f, i) => [f, i]));

  // Deterministic jitter based on index
  const yValues = data.map((d, i) => {
    const baseY = featureIndexMap.get(d.feature) ?? 0;
    const hash = ((i * 2654435761) >>> 0) / 4294967296;
    return baseY + (hash - 0.5) * 0.4;
  });

  const traces: Data[] = [
    {
      type: "scatter" as const,
      x: data.map((d) => d.shap_value),
      y: yValues,
      mode: "markers" as const,
      marker: {
        color: data.map((d) => d.feature_value),
        colorscale: (props.color_scale as Plotly.ColorScale) ?? "RdBu",
        size: props.marker_size ?? 5,
        opacity: 0.7,
        colorbar: {
          title: { text: "Feature value" },
          thickness: 15,
          len: 0.5,
        },
      },
      text: data.map(
        (d) =>
          `${d.feature}<br>SHAP: ${d.shap_value.toFixed(3)}<br>Value: ${d.feature_value.toFixed(3)}`
      ),
      hoverinfo: "text" as const,
      showlegend: false,
    },
  ];

  const layout: Partial<Layout> = {
    xaxis: { title: { text: "SHAP value" }, zeroline: true },
    yaxis: {
      tickvals: sortedFeatures.map((_, i) => i),
      ticktext: sortedFeatures,
      automargin: true,
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
