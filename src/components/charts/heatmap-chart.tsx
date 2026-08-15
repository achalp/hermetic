"use client";

import type { Data, Layout } from "plotly.js";
import { PlotlyChart } from "./plotly-wrapper";
import { useThemeConfig } from "@/components/theme/theme-config";
import { useChartExpanded } from "./chart-expand-wrapper";
import { ChartEmptyState } from "./chart-empty-state";

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
  // Guard array-ness, not just truthiness: a misbound placeholder can deliver
  // a non-array (object/string) for any of these, which would crash on .map.
  if (
    !Array.isArray(props.z) ||
    props.z.length === 0 ||
    !Array.isArray(props.x_labels) ||
    props.x_labels.length === 0 ||
    !Array.isArray(props.y_labels) ||
    props.y_labels.length === 0
  )
    return <ChartEmptyState height={chart.height} />;

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

  // Resolve the colorscale. Plotly.js named scales don't include a red→green
  // diverging one, but a delta grid (negative = bad/red, positive = good/green)
  // wants exactly that. Map the friendly aliases the composer may emit to an
  // explicit diverging array; otherwise pass the value straight to Plotly.
  const resolveColorscale = (name: string | null | undefined): Plotly.ColorScale => {
    const RED_GREEN: Plotly.ColorScale = [
      [0, "#d73027"],
      [0.5, "#ffffbf"],
      [1, "#1a9850"],
    ];
    if (!name) return "RdBu";
    if (/^(rdylgn|red[-_ ]?green|green[-_ ]?red|delta)$/i.test(name.trim())) return RED_GREEN;
    return name as Plotly.ColorScale;
  };

  const traces: Data[] = [
    {
      type: "heatmap" as const,
      z: props.z,
      x: displayXLabels,
      y: displayYLabels,
      // Show full labels on hover
      customdata: props.y_labels.map((y, i) => props.x_labels.map((x) => `${y} / ${x}`)),
      hovertemplate: "%{customdata}<br>Value: %{z}<extra></extra>",
      colorscale: resolveColorscale(props.color_scale),
      zmin: props.z_min ?? undefined,
      zmax: props.z_max ?? undefined,
      hoverongaps: false,
      // In-cell values via texttemplate, not annotations: Plotly picks a
      // contrasting text color per cell (annotations inherit the layout font
      // color, which vanishes on dark cells).
      ...(props.show_values ? { texttemplate: "%{z:.2f}", textfont: { size: 10 } } : {}),
    },
  ];

  const layout: Partial<Layout> = {
    margin: { l: leftMargin, r: 80, t: 10, b: isExpanded ? 120 : 80 },
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
