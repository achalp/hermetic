"use client";

import type { Data, Layout } from "plotly.js";
import { PlotlyChart } from "./plotly-wrapper";
import { useChartColors, resolveColor, unwrapChartData, formatAxisNumber } from "@/lib/chart-theme";
import { useThemeConfig } from "@/lib/theme-config";
import { useChartExpanded } from "./chart-expand-wrapper";

interface PopulationPyramidProps {
  title?: string | null;
  data: Record<string, unknown>[];
  /** Category column (e.g. age band), drawn on the y-axis. */
  category_key: string;
  /** Value plotted to the left (drawn as negative). */
  left_key: string;
  /** Value plotted to the right. */
  right_key: string;
  left_label?: string | null;
  right_label?: string | null;
  left_color?: string | null;
  right_color?: string | null;
  x_label?: string | null;
  height?: number | null;
}

export function PopulationPyramidComponent({ props }: { props: PopulationPyramidProps }) {
  const { chart } = useThemeConfig();
  const isExpanded = useChartExpanded();
  const palette = useChartColors();
  const rows = unwrapChartData(props.data);

  if (rows.length === 0) return <div style={{ height: chart.height }} />;

  const categories = rows.map((r) => String(r[props.category_key] ?? ""));
  const leftVals = rows.map((r) => Math.abs(Number(r[props.left_key]) || 0));
  const rightVals = rows.map((r) => Math.abs(Number(r[props.right_key]) || 0));

  const leftColor = props.left_color ? resolveColor(props.left_color) : palette[0];
  const rightColor = props.right_color
    ? resolveColor(props.right_color)
    : (palette[1] ?? palette[0]);

  const traces: Data[] = [
    {
      type: "bar" as const,
      orientation: "h" as const,
      y: categories,
      x: leftVals.map((v) => -v),
      name: props.left_label ?? props.left_key,
      marker: { color: leftColor },
      customdata: leftVals,
      hovertemplate: "%{y}: %{customdata}<extra></extra>",
    },
    {
      type: "bar" as const,
      orientation: "h" as const,
      y: categories,
      x: rightVals,
      name: props.right_label ?? props.right_key,
      marker: { color: rightColor },
      hovertemplate: "%{y}: %{x}<extra></extra>",
    },
  ];

  const maxAbs = Math.max(1, ...leftVals, ...rightVals);
  const layout: Partial<Layout> = {
    barmode: "overlay",
    bargap: 0.12,
    xaxis: {
      title: props.x_label ? { text: props.x_label } : undefined,
      range: [-maxAbs * 1.05, maxAbs * 1.05],
      tickvals: [-maxAbs, -maxAbs / 2, 0, maxAbs / 2, maxAbs],
      ticktext: [maxAbs, maxAbs / 2, 0, maxAbs / 2, maxAbs].map((v) => formatAxisNumber(v)),
    },
    yaxis: { automargin: true },
    legend: { orientation: "h", y: -0.15 },
    showlegend: true,
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
