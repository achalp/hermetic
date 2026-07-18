"use client";

import type { Data, Layout } from "plotly.js";
import { PlotlyChart } from "./plotly-wrapper";
import { useChartColors } from "@/lib/chart-theme";
import { useThemeConfig } from "@/lib/theme-config";
import { useChartExpanded } from "./chart-expand-wrapper";
import { ChartEmptyState } from "./chart-empty-state";

interface PartialDependenceProps {
  title?: string | null;
  /** Grid of feature values (x-axis). */
  x_values: number[];
  /** Average partial dependence at each x (the PDP line). */
  pdp: number[];
  /** Optional ICE curves — one per instance, each aligned to x_values. */
  ice?: number[][] | null;
  feature_name?: string | null;
  y_label?: string | null;
  color?: string | null;
  height?: number | null;
}

export function PartialDependenceComponent({ props }: { props: PartialDependenceProps }) {
  const { chart } = useThemeConfig();
  const isExpanded = useChartExpanded();
  const palette = useChartColors();
  const x = Array.isArray(props.x_values) ? props.x_values : [];
  const pdp = Array.isArray(props.pdp) ? props.pdp : [];

  if (x.length === 0 || pdp.length === 0) return <ChartEmptyState height={chart.height} />;

  const color = props.color ?? palette[0];
  const traces: Data[] = [];

  // ICE curves first (faint), so the PDP line draws on top.
  const ice = Array.isArray(props.ice) ? props.ice : [];
  // Cap rendered ICE curves to keep the plot legible / fast.
  const MAX_ICE = 200;
  const step = ice.length > MAX_ICE ? Math.ceil(ice.length / MAX_ICE) : 1;
  for (let i = 0; i < ice.length; i += step) {
    if (!Array.isArray(ice[i])) continue;
    traces.push({
      type: "scatter" as const,
      mode: "lines" as const,
      x,
      y: ice[i],
      line: { color: "rgba(120,130,145,0.18)", width: 1 },
      hoverinfo: "skip" as const,
      showlegend: false,
    });
  }

  traces.push({
    type: "scatter" as const,
    mode: "lines" as const,
    x,
    y: pdp,
    name: "Average (PDP)",
    line: { color, width: 3 },
  });

  const layout: Partial<Layout> = {
    xaxis: { title: { text: props.feature_name ?? "Feature value" } },
    yaxis: { title: { text: props.y_label ?? "Partial dependence" } },
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
