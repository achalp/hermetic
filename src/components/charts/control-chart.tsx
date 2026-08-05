"use client";

import type { Data, Layout } from "plotly.js";
import { PlotlyChart } from "./plotly-wrapper";
import { useChartColors, unwrapChartData } from "@/components/theme/chart-theme";
import { useThemeConfig } from "@/components/theme/theme-config";
import { useChartExpanded } from "./chart-expand-wrapper";
import { mean, stddev } from "@/lib/chart-stats";
import { ChartEmptyState } from "./chart-empty-state";

interface ControlChartProps {
  title?: string | null;
  data: Record<string, unknown>[];
  value_key: string;
  /** Optional sequence/time column for the x-axis (defaults to index). */
  x_key?: string | null;
  /** Center line; computed as the mean when omitted. */
  center?: number | null;
  /** Upper/lower control limits; computed as center ± sigma_multiple·σ when omitted. */
  ucl?: number | null;
  lcl?: number | null;
  sigma_multiple?: number | null;
  x_label?: string | null;
  y_label?: string | null;
  color?: string | null;
  height?: number | null;
}

export function ControlChartComponent({ props }: { props: ControlChartProps }) {
  const { chart } = useThemeConfig();
  const isExpanded = useChartExpanded();
  const palette = useChartColors();
  const rows = unwrapChartData(props.data);

  const values = rows.map((r) => Number(r[props.value_key]));
  const valid = values.filter((v) => Number.isFinite(v));
  if (valid.length === 0) return <ChartEmptyState height={chart.height} />;

  const x = props.x_key
    ? rows.map((r) => r[props.x_key!] as string | number)
    : rows.map((_, i) => i + 1);

  const center = props.center ?? mean(valid);
  const sigma = stddev(valid);
  const k = props.sigma_multiple ?? 3;
  const ucl = props.ucl ?? center + k * sigma;
  const lcl = props.lcl ?? center - k * sigma;

  const color = props.color ?? palette[0];
  const outColor = "#dc2626";
  const pointColors = values.map((v) => (v > ucl || v < lcl ? outColor : color));

  const traces: Data[] = [
    {
      type: "scatter" as const,
      mode: "lines+markers" as const,
      x,
      y: values,
      line: { color, width: 1.5 },
      marker: { color: pointColors, size: 7 },
      name: props.value_key,
    },
  ];

  const limitLine = (y: number, label: string, dash: "solid" | "dash", lineColor: string) => ({
    type: "line" as const,
    xref: "paper" as const,
    x0: 0,
    x1: 1,
    yref: "y" as const,
    y0: y,
    y1: y,
    line: { color: lineColor, width: 1, dash },
    label: { text: label, font: { size: 10, color: lineColor } },
  });

  const layout: Partial<Layout> = {
    xaxis: { title: props.x_label ? { text: props.x_label } : undefined },
    yaxis: { title: props.y_label ? { text: props.y_label } : undefined },
    showlegend: false,
    shapes: [
      limitLine(center, "CL", "solid", "#16a34a"),
      limitLine(ucl, "UCL", "dash", "#9ca3af"),
      limitLine(lcl, "LCL", "dash", "#9ca3af"),
    ],
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
